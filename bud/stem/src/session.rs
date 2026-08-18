//! The composed public handle: [`Session`] = holder client + ring replay +
//! [`crate::emu::Emu`] + [`crate::semantic::Scanner`] + [`crate::modes`] +
//! DamageQuiet timing, emitting [`crate::events::Event`]s.
//!
//! Attach sequence (design D8 / Phase-1 §1.3): connect → Hello/version check →
//! Stat → replay the retained ring through a fresh Emu/Scanner → Subscribe from
//! replay end → live loop. Replay processes ALL retained bytes for state
//! fidelity, but only bytes/markers at offsets ≥ `resume_from_offset` are
//! emitted as events (backfill the caller hasn't seen); historical mode churn
//! collapses into one post-replay [`Event::ModeChanged`] snapshot.
//!
//! Event ordering per chunk: `Output` first, then semantic events derived from
//! it — so an event's byte references never point past output the consumer has
//! not yet received (the proto §6.7.3 ordering rule holds by construction).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::client::{HolderClient, HolderPush};
use crate::emu::{CursorPos, CursorShapeKind, Emu, FeedReport, MouseModes, StyledRun};
use crate::error::{Result, StemError};
use crate::events::{Event, Mode};
use crate::ipc::HolderMsg;
use crate::modes::ModeMachine;
use crate::semantic::{ScanKind, Scanner};

/// Pending scrollback-push buffer cap between grid-frame takes (grid-sync
/// plan §3): a flood between takes ships at most this many history lines;
/// overflow is counted, never silent.
const SCROLLBACK_PENDING_CAP: usize = 1024;

/// Per-row identity baseline for scroll-shift detection: the geometry it was
/// captured at plus (cell-buffer address, content hash) per viewport row.
type RowIdBaseline = (u16, u16, Vec<(usize, u64)>);

/// One viewport row of a [`GridFrame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridRow {
    pub row: u16,
    pub runs: Vec<StyledRun>,
}

/// What changed on screen since the previous take — the unit the daemon
/// serializes as a proto `terminal_grid` frame (grid-sync plan §3–4).
/// Produced by [`Session::take_grid_frame`]; deltas are always relative to
/// the previously TAKEN frame, so coalescing is inherent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridFrame {
    /// Monotonic per attachment, starting at 1.
    pub generation: u64,
    /// `dirty_rows` covers every row (attach, resize, scroll, alt toggle).
    pub full: bool,
    pub cols: u16,
    pub rows: u16,
    pub alt_screen: bool,
    pub cursor: CursorPos,
    /// Scroll-shift hint (only on non-`full` frames): the client first moves
    /// its viewport content UP by this many rows (negative = down) —
    /// `new[i] = old[i + row_shift]` — then applies `dirty_rows`. Rows the
    /// shift cannot account for (revealed, rewritten, out of range) are
    /// always included in `dirty_rows`; correctness never depends on the
    /// hint, only bandwidth.
    pub row_shift: i32,
    /// DECSCUSR cursor shape + blink (frame-worthy on change: vim's
    /// insert-mode beam paints no cells).
    pub cursor_shape: CursorShapeKind,
    pub cursor_blink: bool,
    /// Application-enabled mouse modes (DECSET facts; clients encode mouse
    /// events only when the app asked, and fall back to arrow keys for
    /// alt-screen wheel otherwise).
    pub mouse: MouseModes,
    /// DECCKM application cursor mode: arrow keys must be sent as SS3
    /// (`ESC O A`) instead of CSI — pagers like `less` ignore CSI arrows.
    pub app_cursor: bool,
    pub dirty_rows: Vec<GridRow>,
    /// Lines pushed into scrollback history since the last take, oldest
    /// first (empty while the alt screen is active — it has no history).
    pub scrollback_push: Vec<Vec<StyledRun>>,
    /// Best-effort count of scrollback lines lost since the last take
    /// (pending-buffer overflow or scroll-tracking loss). Any nonzero value
    /// means the consumer's accumulated scrollback has a seam.
    pub scrollback_dropped: u64,
}

/// Accumulates grid damage between [`Session::take_grid_frame`] calls.
#[derive(Debug)]
struct GridTracker {
    dirty_rows: std::collections::BTreeSet<u16>,
    full_pending: bool,
    scrollback_push: std::collections::VecDeque<Vec<StyledRun>>,
    scrollback_dropped: u64,
    generation: u64,
    last_cursor: Option<CursorPos>,
    last_mouse: Option<(MouseModes, bool, CursorShapeKind, bool)>,
    /// Per-row (address, content-hash) identities captured at the last
    /// emitted frame, with the geometry they were captured at — the baseline
    /// for take-time scroll-shift detection.
    last_row_ids: Option<RowIdBaseline>,
}

impl GridTracker {
    fn new() -> Self {
        Self {
            dirty_rows: std::collections::BTreeSet::new(),
            // First frame a consumer takes is always full.
            full_pending: true,
            scrollback_push: std::collections::VecDeque::new(),
            scrollback_dropped: 0,
            generation: 0,
            last_cursor: None,
            last_mouse: None,
            last_row_ids: None,
        }
    }

    fn observe_feed(&mut self, report: &FeedReport, emu: &Emu) {
        if report.scrolled_lines > 0 {
            let lines = emu.recent_history_runs(report.scrolled_lines);
            self.scrollback_dropped += (report.scrolled_lines - lines.len()) as u64;
            for line in lines {
                if self.scrollback_push.len() == SCROLLBACK_PENDING_CAP {
                    self.scrollback_push.pop_front();
                    self.scrollback_dropped += 1;
                }
                self.scrollback_push.push_back(line);
            }
        }
        if report.scroll_history_lost {
            self.scrollback_dropped += 1;
        }
        if report.full_repaint || report.alt_screen_changed {
            self.full_pending = true;
            self.dirty_rows.clear();
        } else if !self.full_pending {
            self.dirty_rows.extend(report.damaged_rows.iter().copied());
        }
    }
}

pub struct SessionConfig {
    pub session_dir: PathBuf,
    /// Emit `Settled` after this much meaningful-damage silence (Tui/Repl/Unknown).
    pub quiet_ms: u64,
    /// Resume emission from this absolute offset (0 = everything retained).
    pub resume_from_offset: u64,
    pub scrollback_lines: usize,
    pub repl_matcher: Box<dyn crate::modes::ReplMatcher>,
}

/// Shared state between the [`Session`] handle and its event-loop task.
struct Inner {
    emu: Emu,
    scanner: Scanner,
    modes: ModeMachine,
    last_cwd: Option<String>,
    next_command_index: u64,
    /// (index, output_byte_start) of the currently open command (C seen, no D).
    open_command: Option<(u64, u64)>,
    /// Offset after the most recent OSC 133 `A`/`B` (best-effort start for a
    /// `D` that arrives without a `C`, e.g. sentinel-only integration).
    last_region_start: u64,
    /// Meaningful damage seen since the last `Settled` emission.
    settled_pending: bool,
    /// Grid-sync damage accumulation between `take_grid_frame` calls.
    grid: GridTracker,
}

pub struct Session {
    inner: Arc<Mutex<Inner>>,
    client: HolderClient,
    session_dir: PathBuf,
    child_pid: i32,
}

impl Session {
    pub async fn attach(cfg: SessionConfig) -> Result<(Self, mpsc::Receiver<Event>)> {
        let (mut client, hello) = HolderClient::connect(&cfg.session_dir).await?;
        let stat = client.stat().await?;

        let inner = Arc::new(Mutex::new(Inner {
            emu: Emu::new(stat.cols, stat.rows, cfg.scrollback_lines)?,
            scanner: Scanner::new(),
            modes: ModeMachine::new(cfg.repl_matcher),
            last_cwd: None,
            next_command_index: 0,
            open_command: None,
            last_region_start: stat.ring_oldest_offset,
            settled_pending: false,
            grid: GridTracker::new(),
        }));

        // Events channel: replay worst case is ring_cap / 128KiB Output events
        // plus semantic events — 4096 slots absorb it without back-pressure on
        // the pre-receiver phase (attach waits for replay completion below).
        let (tx, rx) = mpsc::channel::<Event>(4096);
        let (replay_done_tx, replay_done_rx) = tokio::sync::oneshot::channel::<Result<u64>>();

        let loop_inner = Arc::clone(&inner);
        let session_dir = cfg.session_dir.clone();
        let quiet_ms = cfg.quiet_ms;
        let resume_from = cfg.resume_from_offset;
        tokio::spawn(async move {
            event_loop(
                loop_inner,
                session_dir,
                quiet_ms,
                resume_from,
                stat.ring_oldest_offset,
                stat.ring_next_offset,
                tx,
                replay_done_tx,
            )
            .await;
        });

        // Deterministic post-attach state: replay has fully fed the emulator
        // before attach returns (subscription races are covered because the
        // event loop subscribes from its replay end offset).
        match replay_done_rx.await {
            Ok(Ok(_end)) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                return Err(StemError::Other(
                    "session event loop died during replay".into(),
                ))
            }
        }

        Ok((
            Self {
                inner,
                client,
                session_dir: cfg.session_dir,
                child_pid: hello.child_pid,
            },
            rx,
        ))
    }

    /// Write literal text (bracketed-paste aware; `\n` → CR outside paste mode).
    pub async fn write_text(&mut self, text: &str) -> Result<()> {
        let bytes = {
            let inner = self.inner.lock().unwrap();
            crate::keys::encode_paste(text, inner.emu.key_modes(), false)
        };
        self.client.write(&bytes).await
    }

    /// Write literal text as an explicit PASTE when the application has
    /// bracketed paste enabled (single-line included). Programmatic text IS a
    /// paste: chat TUIs (codex) use burst/paste heuristics, and unbracketed
    /// burst text can be misclassified, swallowing a following Enter's
    /// submit semantics. Falls back to plain write when the app never enabled
    /// bracketed paste.
    pub async fn paste_text(&mut self, text: &str) -> Result<()> {
        let bytes = {
            let inner = self.inner.lock().unwrap();
            crate::keys::encode_paste(text, inner.emu.key_modes(), true)
        };
        self.client.write(&bytes).await
    }

    /// Send one named key (`enter`, `ctrl+c`, `up`, …), honoring terminal modes.
    pub async fn send_key(&mut self, key_name: &str) -> Result<()> {
        let key = crate::keys::parse_key_name(key_name)
            .ok_or_else(|| StemError::Other(format!("unknown key name: {key_name}")))?;
        let bytes = {
            let inner = self.inner.lock().unwrap();
            crate::keys::encode_key(key, inner.emu.key_modes())
        };
        self.client.write(&bytes).await
    }

    /// Write raw bytes verbatim (escape hatch; prefer write_text/send_key).
    pub async fn write_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.client.write(bytes).await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.client.resize(cols, rows).await?;
        let mut inner = self.inner.lock().unwrap();
        let before = inner.emu.size();
        inner.emu.resize(cols, rows);
        if inner.emu.size() != before {
            // The whole grid reflowed: the next frame must be full.
            inner.grid.full_pending = true;
            inner.grid.dirty_rows.clear();
        }
        Ok(())
    }

    /// Drain accumulated grid damage into a [`GridFrame`] (grid-sync plan
    /// §3). Pull API: the caller owns the cadence, so coalescing is free — a
    /// row overwritten 100× between takes ships once. `force_full` yields a
    /// complete frame regardless of accumulated state (watch start, resync).
    /// `None` when nothing changed (not even the cursor) and full wasn't
    /// forced.
    pub fn take_grid_frame(&self, force_full: bool) -> Option<GridFrame> {
        take_grid_frame_inner(&mut self.inner.lock().unwrap(), force_full)
    }

    pub fn screen_lines(&self) -> Vec<String> {
        self.inner.lock().unwrap().emu.screen_lines()
    }

    /// Visible screen as ANSI (SGR runs + final cursor position) — see
    /// [`crate::emu::Emu::screen_ansi`].
    pub fn screen_ansi(&self) -> String {
        self.inner.lock().unwrap().emu.screen_ansi()
    }

    pub fn scrollback_lines(&self, n: usize) -> Vec<String> {
        self.inner.lock().unwrap().emu.scrollback_lines(n)
    }

    pub fn cursor(&self) -> crate::emu::CursorPos {
        self.inner.lock().unwrap().emu.cursor()
    }

    pub fn mode(&self) -> Mode {
        self.inner.lock().unwrap().modes.mode()
    }

    pub fn alt_screen_active(&self) -> bool {
        self.inner.lock().unwrap().emu.alt_screen_active()
    }

    /// Best-effort cwd: OSC 7 report if seen, else process introspection.
    pub fn cwd(&self) -> Option<String> {
        let from_osc7 = self.inner.lock().unwrap().last_cwd.clone();
        from_osc7.or_else(|| {
            crate::introspect::process_cwd(self.child_pid).map(|p| p.to_string_lossy().into_owned())
        })
    }

    pub fn session_dir(&self) -> &PathBuf {
        &self.session_dir
    }

    pub fn child_pid(&self) -> i32 {
        self.child_pid
    }

    /// PTY termios facts (v2 holders; `None` for surviving v1 holders —
    /// callers degrade, e.g. predictive echo stays off). Cheap local IPC
    /// roundtrip; callers own the polling cadence.
    pub async fn query_termios(&mut self) -> Result<Option<crate::client::TermiosFacts>> {
        self.client.query_termios().await
    }

    /// Caller policy override: commands will carry sentinel exit markers (D6c).
    pub fn mark_sentinel_integration(&self) {
        self.inner.lock().unwrap().modes.mark_sentinel_integration();
    }

    /// Caller's integration-detection window expired with no markers.
    pub fn mark_no_integration(&self) {
        self.inner.lock().unwrap().modes.mark_no_integration();
    }

    pub async fn kill(&mut self) -> Result<()> {
        self.client.kill().await
    }
}

/// Process one output chunk through scanner/emu/modes; push derived events.
/// Returns true if the chunk produced meaningful damage (for quiet timing).
/// `emit_from`: only events at offsets ≥ this are pushed (replay suppression);
/// pass 0 during live operation. `track_grid`: accumulate grid-sync damage
/// (false during replay — the first post-attach frame is full anyway, and
/// replayed scrollback must not be re-pushed).
fn process_chunk(
    inner: &mut Inner,
    offset: u64,
    bytes: &[u8],
    emit_from: u64,
    emit_mode_changes: bool,
    track_grid: bool,
    out: &mut Vec<Event>,
) -> bool {
    let chunk_end = offset + bytes.len() as u64;
    if chunk_end > emit_from {
        // Emit the caller-visible slice (whole chunk if fully in range).
        let skip = emit_from.saturating_sub(offset) as usize;
        out.push(Event::Output {
            offset: offset + skip as u64,
            bytes: bytes[skip..].to_vec(),
        });
    }

    let scan_events = inner.scanner.scan(offset, bytes);
    let report = inner.emu.feed(bytes);
    if track_grid {
        inner.grid.observe_feed(&report, &inner.emu);
    }

    for ev in scan_events {
        let emit = ev.at_offset >= emit_from;
        if let Some(change) = inner.modes.on_scan(&ev.kind) {
            if emit_mode_changes {
                out.push(Event::ModeChanged {
                    mode: change.mode,
                    integration: change.integration,
                });
            }
        }
        match ev.kind {
            ScanKind::PromptStart => {
                inner.last_region_start = ev.at_offset;
                inner.open_command = None;
                // Clear app cursor-style residue (nvim's steady-block exit
                // style); anything set at the prompt itself arrives after
                // this marker and overrides normally.
                inner.emu.reset_cursor_style();
                if emit {
                    out.push(Event::PromptReady {
                        cwd: inner.last_cwd.clone(),
                    });
                }
            }
            ScanKind::CommandInputStart => {
                inner.last_region_start = ev.at_offset;
            }
            ScanKind::CommandOutputStart => {
                let index = inner.next_command_index;
                inner.next_command_index += 1;
                inner.open_command = Some((index, ev.at_offset));
                if emit {
                    out.push(Event::CommandStarted {
                        command_index: index,
                        output_byte_start: ev.at_offset,
                    });
                }
            }
            ScanKind::CommandEnd { exit_code } => {
                let (index, start) = inner.open_command.take().unwrap_or_else(|| {
                    // D without C (sentinel-only): best-effort region start.
                    let index = inner.next_command_index;
                    inner.next_command_index += 1;
                    (index, inner.last_region_start)
                });
                if emit {
                    out.push(Event::CommandFinished {
                        command_index: index,
                        exit_code,
                        output_byte_start: start,
                        output_byte_end: ev.at_offset,
                    });
                }
            }
            ScanKind::Cwd { ref path } => {
                inner.last_cwd = Some(path.clone());
                if emit {
                    out.push(Event::CwdChanged { cwd: path.clone() });
                }
            }
            ScanKind::AltScreenEnter | ScanKind::AltScreenLeave => {}
            ScanKind::BracketedPasteSet { enabled } => {
                if emit {
                    out.push(Event::BracketedPasteChanged { enabled });
                }
            }
        }
    }

    report.meaningful_damage || report.full_repaint
}

/// See [`Session::take_grid_frame`]. Free function so unit tests can drive it
/// against a locally constructed [`Inner`].
fn take_grid_frame_inner(inner: &mut Inner, force_full: bool) -> Option<GridFrame> {
    let cursor = inner.emu.cursor();
    let mouse = inner.emu.mouse_modes();
    let app_cursor = inner.emu.key_modes().application_cursor;
    let (cursor_shape, cursor_blink) = inner.emu.cursor_shape();
    let full = force_full || inner.grid.full_pending;
    let cursor_moved = inner.grid.last_cursor != Some(cursor);
    // Mode toggles (mouse DECSETs, DECCKM, DECSCUSR) usually damage no cells;
    // they are frame-worthy on their own so clients never render or encode
    // against stale modes.
    let mouse_changed =
        inner.grid.last_mouse != Some((mouse, app_cursor, cursor_shape, cursor_blink));
    if !full
        && inner.grid.dirty_rows.is_empty()
        && inner.grid.scrollback_push.is_empty()
        && inner.grid.scrollback_dropped == 0
        && !cursor_moved
        && !mouse_changed
    {
        return None;
    }

    let (cols, rows) = inner.emu.size();
    let current_ids = inner.emu.viewport_row_ids();

    // A pending "full" repaint (scroll, clear, alt toggle) is first offered
    // to the shift detector: diff row identities against the last emitted
    // frame, find the dominant vertical shift, and ship only the rows the
    // shift cannot explain. Ambiguity always degrades to a true full frame.
    let mut row_shift = 0i32;
    let mut emit_full = full;
    let dirty: Vec<u16> = if full {
        let detected = if force_full {
            None
        } else {
            detect_row_shift(&inner.grid.last_row_ids, cols, rows, &current_ids)
        };
        match detected {
            Some((shift, dirty)) => {
                row_shift = shift;
                emit_full = false;
                dirty
            }
            None => (0..rows).collect(),
        }
    } else {
        // Stale rows beyond a shrink are dropped (a resize sets full anyway).
        inner
            .grid
            .dirty_rows
            .iter()
            .copied()
            .filter(|&row| row < rows)
            .collect()
    };
    let dirty_rows = dirty
        .into_iter()
        .map(|row| GridRow {
            row,
            runs: inner.emu.row_runs(row),
        })
        .collect();

    let grid = &mut inner.grid;
    grid.generation += 1;
    grid.dirty_rows.clear();
    grid.full_pending = false;
    grid.last_cursor = Some(cursor);
    grid.last_mouse = Some((mouse, app_cursor, cursor_shape, cursor_blink));
    grid.last_row_ids = Some((cols, rows, current_ids));
    Some(GridFrame {
        generation: grid.generation,
        full: emit_full,
        cols,
        rows,
        alt_screen: inner.emu.alt_screen_active(),
        cursor,
        row_shift,
        cursor_shape,
        cursor_blink,
        mouse,
        app_cursor,
        dirty_rows,
        scrollback_push: grid.scrollback_push.drain(..).collect(),
        scrollback_dropped: std::mem::take(&mut grid.scrollback_dropped),
    })
}

/// Shift detection over row identities: find the vertical offset `k` that
/// explains the most rows (`current[i] == previous[i + k]`, address AND
/// content hash), then mark everything else dirty. Returns `None` (emit a
/// true full frame) when there is no baseline, geometry changed, or too few
/// rows match to be worth a hint.
fn detect_row_shift(
    baseline: &Option<RowIdBaseline>,
    cols: u16,
    rows: u16,
    current: &[(usize, u64)],
) -> Option<(i32, Vec<u16>)> {
    let (prev_cols, prev_rows, prev) = baseline.as_ref()?;
    if *prev_cols != cols || *prev_rows != rows || prev.len() != current.len() {
        return None;
    }
    // Addresses are unique among live rows: map address -> previous index.
    let prev_by_addr: std::collections::HashMap<usize, usize> =
        prev.iter().enumerate().map(|(i, id)| (id.0, i)).collect();
    let mut votes: std::collections::HashMap<i32, u32> = std::collections::HashMap::new();
    for (i, (addr, hash)) in current.iter().enumerate() {
        if let Some(&j) = prev_by_addr.get(addr) {
            if prev[j].1 == *hash {
                *votes.entry(j as i32 - i as i32).or_insert(0) += 1;
            }
        }
    }
    let (&shift, &count) = votes.iter().max_by_key(|(_, &count)| count)?;
    // A hint that explains under a quarter of the viewport isn't worth its
    // bookkeeping — a full frame is simpler and barely bigger.
    if (count as usize) * 4 < rows as usize {
        return None;
    }
    let mut dirty = Vec::new();
    for (i, (addr, hash)) in current.iter().enumerate() {
        let source = i as i32 + shift;
        let matched = source >= 0
            && (source as usize) < prev.len()
            && prev[source as usize] == (*addr, *hash);
        if !matched {
            dirty.push(i as u16);
        }
    }
    Some((shift, dirty))
}

#[allow(clippy::too_many_arguments)]
async fn event_loop(
    inner: Arc<Mutex<Inner>>,
    session_dir: PathBuf,
    quiet_ms: u64,
    resume_from: u64,
    ring_oldest: u64,
    ring_next: u64,
    tx: mpsc::Sender<Event>,
    replay_done: tokio::sync::oneshot::Sender<Result<u64>>,
) {
    // ---- Replay phase -----------------------------------------------------
    let gap = (resume_from < ring_oldest).then_some(Event::OutputGap {
        from_offset: resume_from,
        resume_offset: ring_oldest,
    });
    let mut replay_events: Vec<Event> = Vec::new();

    let replay_result: Result<u64> = async {
        let (mut ctl, _hello) = HolderClient::connect(&session_dir).await?;
        let mut cursor = ring_oldest;
        while cursor < ring_next {
            match ctl.ring_read(cursor, ring_next).await? {
                HolderMsg::RingData { start, bytes, .. } => {
                    if bytes.is_empty() {
                        break;
                    }
                    let mut guard = inner.lock().unwrap();
                    process_chunk(
                        &mut guard,
                        start,
                        &bytes,
                        resume_from,
                        false,
                        false,
                        &mut replay_events,
                    );
                    cursor = start + bytes.len() as u64;
                }
                other => {
                    return Err(StemError::Ipc(format!(
                        "unexpected ring_read reply: {other:?}"
                    )))
                }
            }
        }
        Ok(cursor)
    }
    .await;

    let replay_end = match replay_result {
        Ok(end) => end,
        Err(e) => {
            let _ = replay_done.send(Err(e));
            return;
        }
    };

    // Single mode snapshot instead of historical churn. Sent BEFORE backfill so
    // both paths (replay and live) deliver ModeChanged ahead of the events it
    // contextualizes: state first, then history.
    let snapshot = {
        let guard = inner.lock().unwrap();
        Event::ModeChanged {
            mode: guard.modes.mode(),
            integration: guard.modes.integration(),
        }
    };
    let _ = replay_done.send(Ok(replay_end));
    for ev in gap
        .into_iter()
        .chain(std::iter::once(snapshot))
        .chain(replay_events)
    {
        if tx.send(ev).await.is_err() {
            return;
        }
    }

    // ---- Live phase --------------------------------------------------------
    let mut pushes = match HolderClient::subscribe(&session_dir, replay_end).await {
        Ok(rx) => rx,
        Err(_) => return,
    };

    let quiet = Duration::from_millis(quiet_ms.max(1));
    let mut deadline: Option<tokio::time::Instant> = None;
    // Replayed content counts as recent activity: without this, a session whose
    // output predates attach would never emit its first Settled.
    if replay_end > ring_oldest {
        inner.lock().unwrap().settled_pending = true;
        deadline = Some(tokio::time::Instant::now() + quiet);
    }

    loop {
        let sleep_until =
            deadline.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            push = pushes.recv() => {
                let Some(push) = push else { break };
                match push {
                    HolderPush::Output { offset, bytes } => {
                        let mut out = Vec::new();
                        let damaged = {
                            let mut guard = inner.lock().unwrap();
                            process_chunk(&mut guard, offset, &bytes, 0, true, true, &mut out)
                        };
                        if damaged {
                            inner.lock().unwrap().settled_pending = true;
                            deadline = Some(tokio::time::Instant::now() + quiet);
                        }
                        for ev in out {
                            if tx.send(ev).await.is_err() { return; }
                        }
                    }
                    HolderPush::Truncated { oldest_offset } => {
                        let ev = Event::OutputGap {
                            from_offset: replay_end,
                            resume_offset: oldest_offset,
                        };
                        if tx.send(ev).await.is_err() { return; }
                    }
                    HolderPush::ChildExited { exit_code, signal } => {
                        if tx.send(Event::ChildExited { exit_code, signal }).await.is_err() {
                            return;
                        }
                    }
                    HolderPush::Closed => break,
                }
            }
            _ = tokio::time::sleep_until(sleep_until) => {
                deadline = None;
                let mut out = Vec::new();
                {
                    let mut guard = inner.lock().unwrap();
                    if !guard.settled_pending {
                        continue;
                    }
                    guard.settled_pending = false;
                    // Quiet point: sample the cursor line for REPL detection.
                    let cursor = guard.emu.cursor();
                    let line = guard
                        .emu
                        .screen_lines()
                        .get(cursor.row as usize)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(change) = guard.modes.on_quiet_cursor_line(&line) {
                        out.push(Event::ModeChanged {
                            mode: change.mode,
                            integration: change.integration,
                        });
                    }
                    let mode = guard.modes.mode();
                    // Settled fires outside Shell mode, and ALSO in Shell mode
                    // while a command is mid-flight (open C without D): inline
                    // TUIs that never enter the alternate screen (codex,
                    // ratatui inline viewports) keep the session classified
                    // Shell, yet interactive callers still need a settle
                    // signal. At-prompt Shell stays silent — prompt_ready is
                    // its signal.
                    if mode != Mode::Shell || guard.open_command.is_some() {
                        out.push(Event::Settled { mode, quiet_ms });
                    }
                }
                for ev in out {
                    if tx.send(ev).await.is_err() { return; }
                }
            }
        }
    }
}

#[cfg(test)]
mod grid_tests {
    use super::*;
    use crate::modes::NoRepl;

    fn test_inner(cols: u16, rows: u16, scrollback: usize) -> Inner {
        Inner {
            emu: Emu::new(cols, rows, scrollback).unwrap(),
            scanner: Scanner::new(),
            modes: ModeMachine::new(Box::new(NoRepl)),
            last_cwd: None,
            next_command_index: 0,
            open_command: None,
            last_region_start: 0,
            settled_pending: false,
            grid: GridTracker::new(),
        }
    }

    /// Feed bytes through the live-path processing (grid tracking on).
    fn feed(inner: &mut Inner, offset: &mut u64, bytes: &[u8]) {
        let mut out = Vec::new();
        process_chunk(inner, *offset, bytes, 0, true, true, &mut out);
        *offset += bytes.len() as u64;
    }

    fn row_text(row: &GridRow) -> String {
        row.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn first_frame_is_full_then_deltas_then_none() {
        let mut inner = test_inner(80, 5, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"hello");

        let frame = take_grid_frame_inner(&mut inner, false).expect("first frame");
        assert!(frame.full);
        assert_eq!(frame.generation, 1);
        assert_eq!(frame.dirty_rows.len(), 5);
        assert_eq!(row_text(&frame.dirty_rows[0]), "hello");

        // One row touched → one dirty row.
        feed(&mut inner, &mut off, b"!");
        let frame = take_grid_frame_inner(&mut inner, false).expect("delta frame");
        assert!(!frame.full);
        assert_eq!(frame.generation, 2);
        assert_eq!(frame.dirty_rows.len(), 1);
        assert_eq!(frame.dirty_rows[0].row, 0);
        assert_eq!(row_text(&frame.dirty_rows[0]), "hello!");

        // Nothing changed → no frame; force_full still yields one.
        assert!(take_grid_frame_inner(&mut inner, false).is_none());
        let forced = take_grid_frame_inner(&mut inner, true).expect("forced full");
        assert!(forced.full);
        assert_eq!(forced.generation, 3);
    }

    #[test]
    fn mouse_mode_toggles_emit_frames() {
        use crate::emu::MouseReport;
        let mut inner = test_inner(80, 4, 100);
        let mut off = 0;
        take_grid_frame_inner(&mut inner, false).unwrap(); // seed full

        // DECSET 1000+1006 damages no cells but must ship (clients would
        // otherwise encode mouse events against stale modes).
        feed(&mut inner, &mut off, b"\x1b[?1000h\x1b[?1006h");
        let frame = take_grid_frame_inner(&mut inner, false).expect("mouse-on frame");
        assert_eq!(frame.mouse.report, MouseReport::Click);
        assert!(frame.mouse.sgr);
        // alacritty (like real terminals) defaults alternate-scroll ON.
        assert!(frame.mouse.alt_scroll);
        assert!(take_grid_frame_inner(&mut inner, false).is_none());

        feed(&mut inner, &mut off, b"\x1b[?1002h\x1b[?1007l");
        let frame = take_grid_frame_inner(&mut inner, false).expect("drag frame");
        assert_eq!(frame.mouse.report, MouseReport::Drag);
        assert!(!frame.mouse.alt_scroll);

        feed(&mut inner, &mut off, b"\x1b[?1003h");
        let frame = take_grid_frame_inner(&mut inner, false).expect("motion frame");
        assert_eq!(frame.mouse.report, MouseReport::Motion);

        feed(
            &mut inner,
            &mut off,
            b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1007l",
        );
        let frame = take_grid_frame_inner(&mut inner, false).expect("mouse-off frame");
        assert_eq!(frame.mouse.report, MouseReport::None);
        assert!(!frame.mouse.sgr);
    }

    #[test]
    fn decscusr_shape_changes_emit_frames() {
        use crate::emu::CursorShapeKind;
        let mut inner = test_inner(80, 4, 100);
        let mut off = 0;
        let first = take_grid_frame_inner(&mut inner, false).unwrap();
        assert_eq!(first.cursor_shape, CursorShapeKind::Block);
        assert!(first.cursor_blink, "terminal default is a blinking block");

        // DECSCUSR 6 = steady beam (vim insert mode) — paints nothing but
        // must ship.
        feed(&mut inner, &mut off, b"\x1b[6 q");
        let frame = take_grid_frame_inner(&mut inner, false).expect("beam frame");
        assert_eq!(frame.cursor_shape, CursorShapeKind::Beam);
        assert!(!frame.cursor_blink);
        assert!(take_grid_frame_inner(&mut inner, false).is_none());

        // DECSCUSR 3 = blinking underline.
        feed(&mut inner, &mut off, b"\x1b[3 q");
        let frame = take_grid_frame_inner(&mut inner, false).expect("underline frame");
        assert_eq!(frame.cursor_shape, CursorShapeKind::Underline);
        assert!(frame.cursor_blink);

        // DECSCUSR 0 = reset to default (blinking block again).
        feed(&mut inner, &mut off, b"\x1b[0 q");
        let frame = take_grid_frame_inner(&mut inner, false).expect("reset frame");
        assert_eq!(frame.cursor_shape, CursorShapeKind::Block);
        assert!(frame.cursor_blink);
    }

    #[test]
    fn prompt_return_clears_app_cursor_style_residue() {
        use crate::emu::CursorShapeKind;
        let mut inner = test_inner(80, 4, 100);
        let mut off = 0;
        take_grid_frame_inner(&mut inner, false).unwrap();

        // An app sets a steady beam and exits without resetting (nvim).
        feed(&mut inner, &mut off, b"\x1b[6 q");
        let frame = take_grid_frame_inner(&mut inner, false).expect("app style");
        assert_eq!(frame.cursor_shape, CursorShapeKind::Beam);

        // Prompt return (OSC 133 A) clears the residue back to the default.
        feed(&mut inner, &mut off, b"\x1b]133;A\x07");
        let frame = take_grid_frame_inner(&mut inner, false).expect("prompt reset");
        assert_eq!(frame.cursor_shape, CursorShapeKind::Block);
        assert!(frame.cursor_blink, "default is a blinking block");

        // Prompt-level styling emitted AFTER the marker still wins.
        feed(&mut inner, &mut off, b"\x1b[2 q");
        let frame = take_grid_frame_inner(&mut inner, false).expect("prompt style");
        assert!(!frame.cursor_blink, "explicit steady at the prompt honored");
    }

    #[test]
    fn cursor_only_movement_emits_a_frame() {
        let mut inner = test_inner(80, 5, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"hello");
        take_grid_frame_inner(&mut inner, false).unwrap();

        // Pure cursor reposition: no damage, but clients render the cursor.
        feed(&mut inner, &mut off, b"\x1b[3;7H");
        let frame = take_grid_frame_inner(&mut inner, false).expect("cursor frame");
        assert!(!frame.full);
        assert!(frame.dirty_rows.is_empty());
        assert_eq!((frame.cursor.row, frame.cursor.col), (2, 6));
        assert!(take_grid_frame_inner(&mut inner, false).is_none());
    }

    #[test]
    fn scroll_yields_full_frame_with_scrollback_pushes() {
        let mut inner = test_inner(80, 3, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"one\r\ntwo\r\nthree");
        take_grid_frame_inner(&mut inner, false).unwrap();

        feed(&mut inner, &mut off, b"\r\nfour\r\nfive");
        let frame = take_grid_frame_inner(&mut inner, false).expect("scroll frame");
        // Scroll-hint delta: the viewport shifted up by 2; only the revealed
        // bottom rows ship (row 0 = old row 2 survives by reference).
        assert!(!frame.full, "scrolls ship as shift deltas, not fulls");
        assert_eq!(frame.row_shift, 2);
        let dirty: Vec<u16> = frame.dirty_rows.iter().map(|r| r.row).collect();
        assert_eq!(dirty, vec![1, 2]);
        assert_eq!(row_text(&frame.dirty_rows[0]), "four");
        assert_eq!(row_text(&frame.dirty_rows[1]), "five");
        let pushed: Vec<String> = frame
            .scrollback_push
            .iter()
            .map(|line| line.iter().map(|r| r.text.as_str()).collect())
            .collect();
        assert_eq!(pushed, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(frame.scrollback_dropped, 0);
    }

    #[test]
    fn region_scroll_ships_shift_with_static_rows_dirty_only_if_changed() {
        // vim-style: scroll region 1..3 of a 4-row grid (status row fixed).
        let mut inner = test_inner(80, 4, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"AAA\r\nBBB\r\nCCC\r\nSTATUS");
        take_grid_frame_inner(&mut inner, false).unwrap();

        // Set region rows 1-3, move into it, scroll it by one line.
        feed(&mut inner, &mut off, b"\x1b[1;3r\x1b[3;1H\nNEW\x1b[r");
        let frame = take_grid_frame_inner(&mut inner, false).expect("region frame");
        assert!(!frame.full, "region scroll should also ship as a delta");
        assert_eq!(frame.row_shift, 1, "region rows dominate the vote");
        // The fixed status row did NOT move: the shift cannot explain it, so
        // it re-ships as dirty alongside the revealed region row.
        let dirty: Vec<u16> = frame.dirty_rows.iter().map(|r| r.row).collect();
        assert!(dirty.contains(&2), "revealed region row: {dirty:?}");
        assert!(dirty.contains(&3), "static status row: {dirty:?}");
        assert_eq!(row_text(&frame.dirty_rows[1]), "STATUS");
    }

    #[test]
    fn clear_screen_ships_a_zero_shift_delta_not_a_full() {
        // ED2 marks full damage but most rows end up blank on both sides —
        // identity diffing turns it into a small k=0 delta.
        let mut inner = test_inner(80, 6, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"top");
        take_grid_frame_inner(&mut inner, false).unwrap();
        feed(&mut inner, &mut off, b"\x1b[2J\x1b[H");
        let frame = take_grid_frame_inner(&mut inner, false).expect("clear frame");
        // alacritty implements ED2 as scroll-into-history + clear, so this
        // may arrive as a small rotation shift rather than k=0 — either way
        // the point is that a "full damage" clear ships as a tiny delta.
        assert!(!frame.full);
        assert!(
            frame.dirty_rows.len() <= 2,
            "clear should be a small delta: {} dirty rows (shift {})",
            frame.dirty_rows.len(),
            frame.row_shift,
        );
    }

    #[test]
    fn alt_screen_toggle_forces_full_and_pushes_nothing() {
        let mut inner = test_inner(80, 4, 100);
        let mut off = 0;
        feed(&mut inner, &mut off, b"shell line");
        take_grid_frame_inner(&mut inner, false).unwrap();

        feed(
            &mut inner,
            &mut off,
            b"\x1b[?1049hvim!\r\n1\r\n2\r\n3\r\n4\r\n5",
        );
        let frame = take_grid_frame_inner(&mut inner, false).expect("alt frame");
        assert!(frame.full);
        assert!(frame.alt_screen);
        assert!(
            frame.scrollback_push.is_empty(),
            "alt screen has no history"
        );

        feed(&mut inner, &mut off, b"\x1b[?1049l");
        let frame = take_grid_frame_inner(&mut inner, false).expect("primary frame");
        assert!(frame.full);
        assert!(!frame.alt_screen);
        assert_eq!(row_text(&frame.dirty_rows[0]), "shell line");
    }

    #[test]
    fn pending_scrollback_overflow_is_counted_not_silent() {
        let mut inner = test_inner(10, 2, 4000);
        let mut off = 0;
        take_grid_frame_inner(&mut inner, false).unwrap();
        // Scroll far past the pending cap in many feeds without a take.
        for i in 0..(SCROLLBACK_PENDING_CAP + 100) {
            feed(&mut inner, &mut off, format!("{i}\r\n").as_bytes());
        }
        let frame = take_grid_frame_inner(&mut inner, false).expect("flood frame");
        assert_eq!(frame.scrollback_push.len(), SCROLLBACK_PENDING_CAP);
        assert!(frame.scrollback_dropped > 0);
        // Oldest retained push is contiguous with the drop point.
        let newest: String = frame.scrollback_push.last().unwrap()[0].text.clone();
        assert_eq!(
            newest.parse::<usize>().unwrap(),
            SCROLLBACK_PENDING_CAP + 98
        );
        // Next take is clean again.
        assert!(take_grid_frame_inner(&mut inner, false).is_none());
    }

    /// The drift regression net: feed the bake-off fixture corpus in
    /// deterministic pseudo-random chunks, take frames at arbitrary points,
    /// apply them in a minimal text reducer, and require the reduced grid to
    /// match `screen_lines()` after every take.
    #[test]
    fn parity_frames_reproduce_screen_lines_across_fixture_corpus() {
        let fixtures = [
            "osc133-session.raw",
            "altscreen-vim.raw",
            "repl-python.raw",
            "scroll-regions.raw",
            "utf8-wide.raw",
            "flood.raw",
        ];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut rng: u64 = 0x5eed_cafe_f00d_0001;
        let mut next = move |bound: usize| -> usize {
            // xorshift64* — deterministic across runs/platforms.
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng as usize) % bound
        };

        for fixture in fixtures {
            let bytes = std::fs::read(dir.join(fixture)).unwrap();
            let mut inner = test_inner(80, 24, 200);
            let mut reduced: Vec<String> = Vec::new();
            let mut off = 0u64;
            let mut pos = 0usize;
            let mut chunks = 0usize;
            let mut last_generation = 0u64;
            while pos < bytes.len() {
                let len = (1 + next(257)).min(bytes.len() - pos);
                feed(&mut inner, &mut off, &bytes[pos..pos + len]);
                pos += len;
                chunks += 1;
                if !chunks.is_multiple_of(5) && pos < bytes.len() {
                    continue;
                }
                let Some(frame) = take_grid_frame_inner(&mut inner, false) else {
                    continue;
                };
                assert_eq!(frame.generation, last_generation + 1, "{fixture}: gen gap");
                last_generation = frame.generation;
                reduced.resize(frame.rows as usize, String::new());
                if frame.full {
                    for row in &mut reduced {
                        row.clear();
                    }
                } else if frame.row_shift != 0 {
                    let old_rows = reduced.clone();
                    for (i, slot) in reduced.iter_mut().enumerate() {
                        let src = i as i32 + frame.row_shift;
                        *slot = if src >= 0 && (src as usize) < old_rows.len() {
                            old_rows[src as usize].clone()
                        } else {
                            String::new()
                        };
                    }
                }
                for row in &frame.dirty_rows {
                    reduced[row.row as usize] = row_text(row);
                }
                let screen = inner.emu.screen_lines();
                for (i, expected) in screen.iter().enumerate() {
                    assert_eq!(
                        reduced[i].trim_end(),
                        expected.as_str(),
                        "{fixture}: row {i} diverged at byte {pos}",
                    );
                }
                let cursor = inner.emu.cursor();
                assert_eq!(
                    (frame.cursor.row, frame.cursor.col),
                    (cursor.row, cursor.col)
                );
            }
        }
    }
}
