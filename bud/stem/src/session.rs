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
use crate::emu::Emu;
use crate::error::{Result, StemError};
use crate::events::{Event, Mode};
use crate::ipc::HolderMsg;
use crate::modes::ModeMachine;
use crate::semantic::{ScanKind, Scanner};

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
        self.inner.lock().unwrap().emu.resize(cols, rows);
        Ok(())
    }

    pub fn screen_lines(&self) -> Vec<String> {
        self.inner.lock().unwrap().emu.screen_lines()
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
/// pass 0 during live operation.
fn process_chunk(
    inner: &mut Inner,
    offset: u64,
    bytes: &[u8],
    emit_from: u64,
    emit_mode_changes: bool,
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
        }
    }

    report.meaningful_damage || report.full_repaint
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
                            process_chunk(&mut guard, offset, &bytes, 0, true, &mut out)
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
