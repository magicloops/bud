//! Terminal manager: stem-backed session lifecycle plus the proto 0.3
//! request handlers (`terminal_ensure` / `terminal_send` / `terminal_observe`
//! / `terminal_input` / `terminal_resize` / `terminal_close`).
//!
//! Concurrency model (review finding D-H1): `app.rs` spawns every terminal
//! frame handler instead of awaiting it inline. Ordering within one session
//! comes from the per-session `tokio::sync::Mutex<stem::Session>` (FIFO), and
//! awaited outcomes (`await: "command" | "settled"`) are resolved off the
//! pump's broadcast channel *after* the session lock is released, so a slow
//! command never blocks other sessions, heartbeats, or credits.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Number, Value};
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use stem::client::HolderClient;
use stem::events::Integration;
use stem::registry::{HolderLauncher, Registry};
use stem::session::{Session, SessionConfig};

use crate::protocol::{
    terminal_event_frame, terminal_grid_frame, terminal_observe_result_frame,
    terminal_send_result_frame, terminal_status_frame, TerminalCloseFrame, TerminalEnsureConfig,
    TerminalEnsureFrame, TerminalGridWatchFrame, TerminalInputFrame, TerminalObservation,
    TerminalObserveFrame, TerminalResizeFrame, TerminalSendAwait, TerminalSendFrame,
};
use crate::transport::{send_transport_frame, OutboundSender};

use super::grid::grid_frame_fields;
use super::repl_registry::BudReplRegistry;
use super::session_task::{
    integration_str, mode_str, run_pump, PumpEvent, SessionFacts, SessionShared,
};
use super::shims::prepare_shim;

/// Damage-quiet threshold handed to stem (`settled` events).
const QUIET_MS: u64 = 300;
/// Emulator scrollback retained per session.
const SCROLLBACK_LINES: usize = 5000;
/// A single grid frame shipping this many `scrollback_push` rows is worth a
/// forensic warn (whole-history duplication triage).
const GRID_PUSH_WARN_LINES: usize = 300;
/// Holder output ring capacity (design D8 default).
const RING_CAP_BYTES: u64 = 8 * 1024 * 1024;
/// `terminal_observe view:"history"` defaults and cap.
const HISTORY_DEFAULT_LINES: usize = 200;
const HISTORY_MAX_LINES: usize = 2000;
/// No OSC 133 marker within this window after ensure -> `integration: none`.
const INTEGRATION_DETECT_WINDOW: Duration = Duration::from_secs(5);
/// Daemon-internal safety cap on awaited sends. The service owns real timeout
/// policy; this only prevents leaked waiters.
const AWAIT_SAFETY_CAP: Duration = Duration::from_secs(4 * 60 * 60);
/// `await:"command"` on a genuinely OSC 133-integrated shell: a quiet point
/// (or a fresh prompt) with no `command_started` since dispatch means the
/// text most likely went to a foreground program (or the shell ran nothing).
/// Keep waiting this long for the start marker before concluding
/// `input_absorbed` — the shell's `C` normally follows Enter within
/// milliseconds; this only absorbs slow hooks and stale events from the
/// previous prompt cycle.
const INPUT_ABSORBED_GRACE: Duration = Duration::from_millis(1500);
/// Awaited-observe stall window (the knobless `terminal.wait`): activity that
/// occurs DURING the wait and then stays quiet this long returns control to
/// the caller (`stalled`) — a TUI that painted a question, a build that
/// finished a step. Silent programs never trip it (no activity, no stall).
/// The service may override per request via `terminal_observe.quiet_ms`.
const STALL_QUIET_MS: u64 = 1500;
/// Fresh-session grace: how long a command-await will wait for the shell's
/// FIRST prompt before falling back to the visible sentinel trailer. Only
/// applies when a shim was installed and no marker has arrived yet (the shell
/// is still sourcing rc files) — without it, the first agent command of every
/// fresh session on an integrated shell echoed the wrapper.
const FIRST_PROMPT_GRACE: Duration = Duration::from_secs(3);
/// Beat between pasted text and the submitting Enter keypress: lets TUI
/// input heuristics (paste detection, debouncing) classify the Enter as a
/// deliberate keystroke rather than part of the text burst. NOT an ordering
/// hack — the single writer already guarantees order.
const SUBMIT_ENTER_DELAY: Duration = Duration::from_millis(75);
/// Upper bound on deferring a width shrink while a readline line is pending
/// at an idle shell prompt (see `SessionFacts::input_pending_at_prompt`).
/// Long enough to cover paste→Enter→`command_started`; short enough that a
/// half-typed line never pins another viewer's geometry noticeably.
const RESIZE_DEFER_CAP: Duration = Duration::from_secs(3);
/// Sentinel exit-code trailer (design D6c). Sent as literal shell input.
const SENTINEL_TRAILER: &str = r#"; printf '\033]133;D;%s\a' "$?""#;
/// Grid-sync emission pacing (§6.8.2): event-driven, not a fixed tick. The
/// pump wakes the watch loop on session activity; a short coalescing beat
/// turns a burst of PTY chunks into one frame; a minimum inter-frame gap caps
/// the rate near 60 fps (deltas are relative to the last taken frame, so a
/// slow consumer naturally skips intermediate states); an idle poll covers
/// predict-gate flips that paint nothing (stty toggles around password
/// prompts).
const GRID_COALESCE: Duration = Duration::from_millis(8);
const GRID_MIN_INTERVAL: Duration = Duration::from_millis(16);
const GRID_IDLE_POLL: Duration = Duration::from_millis(100);
/// Ceiling on termios re-query age (predict-gate input; local UDS roundtrip).
const GRID_TERMIOS_REFRESH: Duration = Duration::from_millis(100);

const DEFAULT_TERMINAL_COLORTERM: &str = "truecolor";
const DEFAULT_TERMINAL_COLORFGBG: &str = "15;0";

#[derive(Clone)]
pub struct TerminalConfig {
    pub enabled: bool,
    /// stem registry base (`<bud base dir>/term`), created 0700.
    pub term_base_dir: PathBuf,
    pub default_cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    /// Program re-exec'd as the holder (`<launcher> term-hold ...`); the
    /// daemon passes its own executable, tests pass `CARGO_BIN_EXE_bud`.
    pub launcher_program: PathBuf,
    pub debug_enabled: bool,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Mutex<State>>,
    pub config: TerminalConfig,
}

struct State {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<SessionEntry>>,
    /// Per-session attach serialization (see `attach_lock`): ensure and the
    /// lazy reattach paths race otherwise, and a displaced entry's pump keeps
    /// forwarding — every output frame then arrives twice at the service.
    attach_locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

struct SessionEntry {
    shared: Arc<SessionShared>,
    session: Mutex<Session>,
    pump_tx: broadcast::Sender<PumpEvent>,
    pump: JoinHandle<()>,
    detect: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// Grid-sync watch tick task (§6.8): present while the service has grid
    /// viewers attached. Dies with the entry (re-ensure/reconnect: the
    /// service re-arms with a fresh `terminal_grid_watch`).
    grid_watch: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// Re-arm signal for a LIVE watch loop: `terminal_grid_watch enabled`
    /// while the loop is already running requests one force-full frame
    /// in-place instead of respawning — pending scrollback pushes survive
    /// (they are real deltas for the connected consumers), and only a FRESH
    /// watch starts scrollback-clean (see `reset_grid_scrollback_pending`).
    grid_force_full: std::sync::atomic::AtomicBool,
}

impl SessionEntry {
    fn abort_tasks(&self) {
        self.pump.abort();
        if let Some(detect) = self.detect.lock().unwrap().take() {
            detect.abort();
        }
        if let Some(watch) = self.grid_watch.lock().unwrap().take() {
            watch.abort();
        }
    }
}

enum AwaitResult {
    Outcome(Value),
    Timeout,
    Closed,
}

impl TerminalManager {
    pub fn new(config: TerminalConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(State {
                sender: None,
                sessions: HashMap::new(),
                attach_locks: HashMap::new(),
            })),
            config,
        }
    }

    pub async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    /// Transport gone: drop live attachments (holders survive; the service
    /// re-ensures with its committed `resume_from_offset` after reconnect).
    pub async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        for (_, entry) in inner.sessions.drain() {
            entry.abort_tasks();
        }
        inner.sender = None;
    }

    async fn sender(&self) -> Option<OutboundSender> {
        self.inner.lock().await.sender.clone()
    }

    async fn entry(&self, session_id: &str) -> Option<Arc<SessionEntry>> {
        self.inner.lock().await.sessions.get(session_id).cloned()
    }

    /// Remove the session entry IF it is still the one owning `shared`
    /// (a re-ensure may have replaced it). Called when a pump ends.
    async fn remove_entry_if_current(&self, session_id: &str, shared: &Arc<SessionShared>) {
        let mut inner = self.inner.lock().await;
        let current = inner
            .sessions
            .get(session_id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.shared, shared));
        if current {
            if let Some(entry) = inner.sessions.remove(session_id) {
                entry.abort_tasks();
            }
        }
    }

    /// Best-effort cwd for the file adapter (no session creation).
    pub async fn fresh_pane_cwd_for_session(&self, session_id: &str) -> Option<String> {
        let entry = self.entry(session_id).await?;
        let session = entry.session.lock().await;
        session.cwd()
    }

    // ------------------------------------------------------------------
    // terminal_ensure
    // ------------------------------------------------------------------

    pub async fn handle_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
        if !self.config.enabled {
            info!("terminal support disabled; ignoring terminal_ensure");
            return Ok(());
        }
        let sender = self
            .sender()
            .await
            .ok_or_else(|| anyhow!("no transport sender available"))?;
        let session_id = frame.session_id.clone();

        // Serialize against the lazy reattach paths (entry_or_attach) so two
        // attachments can never coexist for one session.
        let lock = self.attach_lock(&session_id).await;
        let _attach_guard = lock.lock().await;

        // Re-ensure of a live session = reattach semantics: drop the old
        // attachment and attach fresh with the new resume offset.
        if let Some(existing) = self.inner.lock().await.sessions.remove(&session_id) {
            existing.abort_tasks();
        }

        let resume_from_offset = frame.resume_from_offset.unwrap_or(0);
        match self
            .spawn_and_attach(&session_id, frame.config, resume_from_offset, &sender)
            .await
        {
            Ok(entry) => {
                let info = self.entry_status_info(&entry).await;
                self.install_entry(&session_id, &entry).await;
                let grid = entry.session.lock().await.grid_debug();
                info!(
                    session_id = %session_id,
                    resume_from_offset,
                    grid = ?grid,
                    "terminal ensure attached"
                );
                send_transport_frame(
                    &sender,
                    terminal_status_frame(&session_id, "ready", Some(info)),
                )?;
            }
            Err(err) => {
                warn!(session_id = %session_id, error = %err, "terminal_ensure failed");
                send_transport_frame(
                    &sender,
                    terminal_status_frame(
                        &session_id,
                        "none",
                        Some(json!({ "error": format!("{err:#}") })),
                    ),
                )?;
            }
        }
        Ok(())
    }

    /// Ensure a holder exists (spawn or reuse) and attach to it.
    async fn spawn_and_attach(
        &self,
        session_id: &str,
        config: Option<TerminalEnsureConfig>,
        resume_from_offset: u64,
        sender: &OutboundSender,
    ) -> Result<Arc<SessionEntry>> {
        let registry = self.registry()?;
        let dir = registry.session_dir(session_id)?;
        std::fs::create_dir_all(&dir).context("create session dir")?;

        let config = config.unwrap_or_default();
        let cols = config.cols.filter(|c| *c > 0).unwrap_or(self.config.cols);
        let rows = config.rows.filter(|r| *r > 0).unwrap_or(self.config.rows);
        let cols = if cols == 0 { 200 } else { cols };
        let rows = if rows == 0 { 50 } else { rows };
        let shell = config.shell.unwrap_or_else(|| self.config.shell.clone());
        let cwd = config
            .cwd
            .unwrap_or_else(|| self.config.default_cwd.clone());

        let shim = prepare_shim(&shell, &dir.join("shim")).unwrap_or_else(|err| {
            warn!(session_id, error = %err, "shell integration shim write failed; continuing without");
            None
        });
        let mut env = build_session_env(config.env);
        let mut args = Vec::new();
        if let Some(shim) = shim {
            args = shim.args;
            env.extend(shim.env);
        }

        let launcher = HolderLauncher {
            program: self.config.launcher_program.clone(),
            args_prefix: vec!["term-hold".into()],
        };
        let spec = stem::pty::SpawnSpec {
            shell,
            args,
            cwd,
            env,
            cols,
            rows,
        };
        registry
            .ensure(session_id, &launcher, &spec, RING_CAP_BYTES)
            .await
            .context("holder ensure")?;

        self.attach(session_id, &dir, resume_from_offset, sender)
            .await
    }

    /// Attach to an existing holder (no spawn) and build the session entry.
    async fn attach(
        &self,
        session_id: &str,
        dir: &std::path::Path,
        resume_from_offset: u64,
        sender: &OutboundSender,
    ) -> Result<Arc<SessionEntry>> {
        let integration_expected = dir
            .join("shim")
            .read_dir()
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
        let (session, events) = Session::attach(SessionConfig {
            session_dir: dir.to_path_buf(),
            quiet_ms: QUIET_MS,
            resume_from_offset,
            scrollback_lines: SCROLLBACK_LINES,
            repl_matcher: Box::new(BudReplRegistry),
        })
        .await
        .context("session attach")?;

        let (mut ctl, _hello) = HolderClient::connect(dir).await.context("holder stat")?;
        let stat = ctl.stat().await.context("holder stat")?;

        let shared = Arc::new(SessionShared {
            session_id: session_id.to_string(),
            grid_dirty: tokio::sync::Notify::new(),
            facts: std::sync::Mutex::new(SessionFacts {
                mode: session.mode(),
                integration: Integration::None,
                marker_seen: false,
                integration_expected,
                open_command: None,
                genuine_osc133: false,
                ring_next_offset: stat.ring_next_offset,
                cols: stat.cols,
                rows: stat.rows,
                child_pid: session.child_pid(),
                closed: !stat.child_alive,
                last_observed_screen: None,
                last_applied_input_seq: None,
                input_pending_at_prompt: false,
                deferred_resize: None,
            }),
        });

        let (pump_tx, _) = broadcast::channel(256);
        let pump = tokio::spawn({
            let manager = self.clone();
            let pump_shared = Arc::clone(&shared);
            let pump_session_id = session_id.to_string();
            let pump_sender = sender.clone();
            let pump_tx = pump_tx.clone();
            async move {
                run_pump(events, pump_sender, Arc::clone(&pump_shared), pump_tx).await;
                // Holder gone (or session torn down): drop OUR map entry so
                // later gestures re-ensure instead of writing to a dead
                // socket. ptr_eq guards against removing a newer attachment.
                manager
                    .remove_entry_if_current(&pump_session_id, &pump_shared)
                    .await;
            }
        });

        let entry = Arc::new(SessionEntry {
            shared,
            session: Mutex::new(session),
            pump_tx,
            pump,
            detect: std::sync::Mutex::new(None),
            grid_watch: std::sync::Mutex::new(None),
            grid_force_full: std::sync::atomic::AtomicBool::new(false),
        });

        let detect = tokio::spawn(detect_integration_window(
            Arc::downgrade(&entry),
            sender.clone(),
        ));
        *entry.detect.lock().unwrap() = Some(detect);

        Ok(entry)
    }

    fn registry(&self) -> Result<Registry> {
        Registry::new(self.config.term_base_dir.clone()).context("terminal registry base")
    }

    /// Live entry, or a fresh attachment to a surviving holder (daemon
    /// restart / reconnect path). Never spawns a new holder.
    /// Serializes ALL attach/replace operations for one session. Attaching is
    /// slow (connect + stat + ring replay), so a plain check-then-insert lets
    /// concurrent callers each spawn a pump; the displaced pump was never
    /// aborted and duplicated every output frame (found live, 2026-08-17 §A).
    async fn attach_lock(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut inner = self.inner.lock().await;
        Arc::clone(
            inner
                .attach_locks
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Insert an entry, aborting any displaced one (defense in depth — under
    /// the attach lock a displacement should only happen on ensure's
    /// deliberate replace, which aborts explicitly before attaching).
    async fn install_entry(&self, session_id: &str, entry: &Arc<SessionEntry>) {
        if let Some(old) = self
            .inner
            .lock()
            .await
            .sessions
            .insert(session_id.to_string(), Arc::clone(entry))
        {
            old.abort_tasks();
        }
    }

    async fn entry_or_attach(&self, session_id: &str) -> Result<Option<Arc<SessionEntry>>> {
        if let Some(entry) = self.entry(session_id).await {
            return Ok(Some(entry));
        }
        let lock = self.attach_lock(session_id).await;
        let _attach_guard = lock.lock().await;
        // Re-check under the lock: another caller may have attached while we
        // waited.
        if let Some(entry) = self.entry(session_id).await {
            return Ok(Some(entry));
        }
        let Some(sender) = self.sender().await else {
            return Ok(None);
        };
        let registry = self.registry()?;
        if !registry.session_alive(session_id).await {
            return Ok(None);
        }
        let dir = registry.session_dir(session_id)?;
        // No service-provided resume offset here: skip backfill (resume from
        // the current ring end) — the service re-ensures for byte-exact resume.
        let (mut ctl, _hello) = HolderClient::connect(&dir).await?;
        let stat = ctl.stat().await?;
        let entry = self
            .attach(session_id, &dir, stat.ring_next_offset, &sender)
            .await?;
        self.install_entry(session_id, &entry).await;
        Ok(Some(entry))
    }

    /// §6.7.6 `terminal_status` info payload for a live entry.
    async fn entry_status_info(&self, entry: &Arc<SessionEntry>) -> Value {
        let cwd = {
            let session = entry.session.lock().await;
            session.cwd()
        };
        let facts = entry.shared.facts.lock().unwrap();
        let mut info = Map::new();
        info.insert("pid".into(), Value::Number(Number::from(facts.child_pid)));
        if let Some(cwd) = cwd {
            info.insert("cwd".into(), Value::String(cwd));
        }
        info.insert("cols".into(), Value::Number(Number::from(facts.cols)));
        info.insert("rows".into(), Value::Number(Number::from(facts.rows)));
        info.insert(
            "ring_next_offset".into(),
            Value::Number(Number::from(facts.ring_next_offset)),
        );
        info.insert("mode".into(), Value::String(mode_str(facts.mode).into()));
        info.insert(
            "integration".into(),
            Value::String(integration_str(facts.integration).into()),
        );
        Value::Object(info)
    }

    // ------------------------------------------------------------------
    // terminal_send
    // ------------------------------------------------------------------

    pub async fn handle_send(&self, frame: TerminalSendFrame) -> Result<()> {
        let Some(sender) = self.sender().await else {
            warn!(request_id = %frame.request_id, "terminal_send dropped; no sender");
            return Ok(());
        };
        if !self.config.enabled {
            return self.send_result_error(&sender, &frame, "terminal_disabled");
        }

        let submit = frame.submit.unwrap_or(false);
        let key = frame
            .key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty());
        let text = frame.text.as_deref();

        if key.is_some() && (text.is_some() || submit) {
            return self.send_result_error(&sender, &frame, "ambiguous_interaction");
        }
        if submit && text.is_none() {
            return self.send_result_error(&sender, &frame, "submit_requires_text");
        }
        if text.is_none_or(str::is_empty) && !submit && key.is_none() {
            return self.send_result_error(&sender, &frame, "empty_interaction");
        }

        let entry = match self.entry_or_attach(&frame.session_id).await {
            Ok(Some(entry)) => entry,
            Ok(None) => return self.send_result_error(&sender, &frame, "session_not_found"),
            Err(err) => {
                warn!(request_id = %frame.request_id, error = %err, "terminal_send attach failed");
                return self.send_result_error(&sender, &frame, "session_not_found");
            }
        };

        // Declared-intent guard: `terminal.run` (text+submit+await:command)
        // promises "execute a shell command at a prompt". While a command is
        // already OPEN (started, unfinished — e.g. an inline TUI like codex),
        // typing into the PTY would feed the foreground program instead, and
        // the await could only resolve when that program exits. Refuse loudly;
        // the service turns this into actionable guidance (send/observe/^C).
        if submit && frame.r#await == Some(TerminalSendAwait::Command) {
            let open = entry.shared.facts.lock().unwrap().open_command.clone();
            if let Some((command_id, _since)) = open {
                debug!(
                    session_id = %frame.session_id,
                    open_command = %command_id,
                    "terminal_send refused: command_in_flight"
                );
                return self.send_result_error(&sender, &frame, "command_in_flight");
            }
        }

        // Fresh-session grace: a command-await that arrives before the shell's
        // first prompt would get sentinel-wrapped even on integrated shells.
        // When integration is expected but no marker has been seen, wait
        // briefly for the first prompt before deciding (bounded; does not
        // hold the session lock).
        if submit && frame.r#await == Some(TerminalSendAwait::Command) {
            let needs_grace = {
                let facts = entry.shared.facts.lock().unwrap();
                facts.integration_expected && !facts.marker_seen && !facts.closed
            };
            if needs_grace {
                let mut grace_rx = entry.pump_tx.subscribe();
                let _ = tokio::time::timeout(FIRST_PROMPT_GRACE, async {
                    loop {
                        match grace_rx.recv().await {
                            Ok(PumpEvent::PromptReady { .. }) | Ok(PumpEvent::Closed) | Err(_) => {
                                break
                            }
                            Ok(_) => continue,
                        }
                    }
                })
                .await;
            }
        }

        // Subscribe BEFORE dispatch so the awaited outcome cannot be missed.
        let waiter = frame.r#await.map(|_| entry.pump_tx.subscribe());

        // Live A/C marker evidence for THIS attachment (not the replay-derived
        // integration fact): decides both the sentinel wrap below and whether
        // a command-await may conclude `input_absorbed` (a start marker was
        // expected and never came).
        let genuine_osc133 = entry.shared.facts.lock().unwrap().genuine_osc133;
        let expect_start_marker =
            submit && frame.r#await == Some(TerminalSendAwait::Command) && genuine_osc133;

        // Dispatch under the per-session lock (gesture ordering); the await
        // below runs after releasing it.
        let dispatch = {
            let mut session = entry.session.lock().await;
            if let Some(text) = text {
                let mut payload = text.to_string();
                // Sentinel fallback (design D6c): only for submitted commands
                // awaiting completion, and never over genuine OSC 133. The
                // wrap decision keys off live A/C marker evidence rather than
                // the integration fact, because a reattach replay of earlier
                // sentinel `D` trailers mislabels the session `osc133`.
                if submit && frame.r#await == Some(TerminalSendAwait::Command) && !genuine_osc133 {
                    payload.push_str(SENTINEL_TRAILER);
                    session.mark_sentinel_integration();
                    let mode = session.mode();
                    let mut facts = entry.shared.facts.lock().unwrap();
                    // Only claim `sentinel` while integration is undetermined;
                    // an established (possibly replay-derived) `osc133` fact
                    // is left for real events to correct.
                    if facts.integration == Integration::None {
                        facts.integration = Integration::Sentinel;
                        facts.mode = mode;
                        // stem swallows the ModeChange from the override; emit
                        // the wire fact ourselves.
                        let _ = send_transport_frame(
                            &sender,
                            terminal_event_frame(
                                &frame.session_id,
                                "mode_changed",
                                json!({
                                    "mode": mode_str(mode),
                                    "integration": integration_str(Integration::Sentinel),
                                }),
                            ),
                        );
                    }
                }
                // Programmatic text is delivered as an explicit bracketed
                // paste when the app enabled ?2004 (chat TUIs like codex use
                // burst/paste heuristics; unbracketed burst text can eat the
                // following Enter). Submit = paste, a short beat, then a real
                // Enter keypress — the delay makes Enter read as a distinct
                // action to app-side input heuristics; ordering itself is
                // already guaranteed by the single writer. (Appending "\n"
                // to the text would be swallowed by bracketed paste.)
                if !payload.is_empty() {
                    mark_input_pending(&entry.shared.facts);
                }
                let mut write = if payload.is_empty() {
                    Ok(())
                } else {
                    session.paste_text(&payload).await
                };
                if write.is_ok() && submit {
                    tokio::time::sleep(SUBMIT_ENTER_DELAY).await;
                    write = session.send_key("enter").await;
                }
                write
            } else if let Some(key) = key {
                session.send_key(key).await
            } else {
                Ok(())
            }
        };

        if let Err(err) = dispatch {
            warn!(
                request_id = %frame.request_id,
                session_id = %frame.session_id,
                error = %err,
                "terminal_send dispatch failed"
            );
            return self.send_result_error(&sender, &frame, "send_failed");
        }

        let result = match (frame.r#await, waiter) {
            (Some(kind), Some(rx)) => {
                match tokio::time::timeout(
                    AWAIT_SAFETY_CAP,
                    await_outcome(rx, kind, expect_start_marker),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => AwaitResult::Timeout,
                }
            }
            _ => AwaitResult::Outcome(Value::Null),
        };

        // NOTE: the delta baseline is deliberately NOT refreshed here. The
        // observe view owns the baseline (§6.6a delta = changes since the
        // previous OBSERVE): the service's send-plus-proof flow observes
        // `delta` right after this send resolves, and resetting the baseline
        // post-gesture made that proof structurally empty — the agent saw
        // "no visible change" for input that visibly echoed (found live,
        // 2026-08-17 §A validation, python REPL).
        let payload = match result {
            AwaitResult::Outcome(Value::Null) => {
                terminal_send_result_frame(&frame.session_id, &frame.request_id, true, None, None)
            }
            AwaitResult::Outcome(outcome) => terminal_send_result_frame(
                &frame.session_id,
                &frame.request_id,
                true,
                Some(outcome),
                None,
            ),
            AwaitResult::Timeout => terminal_send_result_frame(
                &frame.session_id,
                &frame.request_id,
                true,
                None,
                Some("TIMEOUT"),
            ),
            AwaitResult::Closed => terminal_send_result_frame(
                &frame.session_id,
                &frame.request_id,
                true,
                None,
                Some("CANCELED"),
            ),
        };
        send_transport_frame(&sender, payload)
    }

    fn send_result_error(
        &self,
        sender: &OutboundSender,
        frame: &TerminalSendFrame,
        error: &str,
    ) -> Result<()> {
        send_transport_frame(
            sender,
            terminal_send_result_frame(
                &frame.session_id,
                &frame.request_id,
                false,
                None,
                Some(error),
            ),
        )
    }

    // ------------------------------------------------------------------
    // terminal_observe
    // ------------------------------------------------------------------

    pub async fn handle_observe(&self, frame: TerminalObserveFrame) -> Result<()> {
        let Some(sender) = self.sender().await else {
            warn!(request_id = %frame.request_id, "terminal_observe dropped; no sender");
            return Ok(());
        };
        if !self.config.enabled {
            return self.observe_error(&sender, &frame, "terminal_disabled");
        }
        let view = frame.view.as_deref().unwrap_or("screen");
        if !matches!(view, "screen" | "delta" | "history") {
            return self.observe_error(&sender, &frame, "unsupported_view");
        }

        let entry = match self.entry_or_attach(&frame.session_id).await {
            Ok(Some(entry)) => entry,
            Ok(None) => return self.observe_error(&sender, &frame, "session_not_found"),
            Err(err) => {
                warn!(request_id = %frame.request_id, error = %err, "terminal_observe attach failed");
                return self.observe_error(&sender, &frame, "session_not_found");
            }
        };

        let history_lines = frame
            .lines
            .map(|lines| lines.unsigned_abs() as usize)
            .unwrap_or(HISTORY_DEFAULT_LINES)
            .clamp(1, HISTORY_MAX_LINES);

        // Awaited observe: block on the requested fact FIRST (never holding
        // the session lock), then snapshot — so the caller sees the screen
        // as of the fact, not as of the request.
        let outcome = match frame.r#await {
            None => None,
            Some(kind) => {
                let stall_quiet =
                    Duration::from_millis(frame.quiet_ms.unwrap_or(STALL_QUIET_MS).max(QUIET_MS));
                match tokio::time::timeout(
                    AWAIT_SAFETY_CAP,
                    await_observe_outcome(&entry, kind, stall_quiet),
                )
                .await
                {
                    Ok(outcome) => Some(outcome),
                    Err(_) => return self.observe_error(&sender, &frame, "TIMEOUT"),
                }
            }
        };

        let (screen, history, screen_ansi, cursor, alt_screen, mode) = {
            let session = entry.session.lock().await;
            let history = if view == "history" {
                session.scrollback_lines(history_lines)
            } else {
                Vec::new()
            };
            // ANSI serialization only for screen views (snapshot bootstrap
            // fidelity: colors/styles/cursor survive; plain text does not).
            let screen_ansi = (view == "screen").then(|| session.screen_ansi());
            (
                session.screen_lines(),
                history,
                screen_ansi,
                session.cursor(),
                session.alt_screen_active(),
                session.mode(),
            )
        };

        let (changed, delta_lines, integration) = {
            let mut facts = entry.shared.facts.lock().unwrap();
            let (changed, delta_lines) = grid_delta(facts.last_observed_screen.as_deref(), &screen);
            facts.last_observed_screen = Some(screen.clone());
            (changed, delta_lines, facts.integration)
        };

        let output_text = match view {
            "delta" => delta_lines.join("\n"),
            "history" => history.join("\n"),
            _ => trim_trailing_empty(&screen).join("\n"),
        };
        let lines_captured = if output_text.is_empty() {
            0
        } else {
            output_text.lines().count() as u64
        };

        let observation = TerminalObservation {
            view: view.to_string(),
            output_base64: BASE64_STANDARD.encode(output_text.as_bytes()),
            lines_captured,
            changed,
            mode: mode_str(mode).to_string(),
            integration: integration_str(integration).to_string(),
            alt_screen,
            cursor_row: cursor.row,
            cursor_col: cursor.col,
            ring_next_offset: entry.shared.facts.lock().unwrap().ring_next_offset,
            output_ansi_base64: screen_ansi.map(|ansi| BASE64_STANDARD.encode(ansi.as_bytes())),
            outcome,
        };
        send_transport_frame(
            &sender,
            terminal_observe_result_frame(
                &frame.session_id,
                &frame.request_id,
                Some(observation),
                None,
            ),
        )
    }

    fn observe_error(
        &self,
        sender: &OutboundSender,
        frame: &TerminalObserveFrame,
        error: &str,
    ) -> Result<()> {
        send_transport_frame(
            sender,
            terminal_observe_result_frame(&frame.session_id, &frame.request_id, None, Some(error)),
        )
    }

    // ------------------------------------------------------------------
    // terminal_grid_watch (§6.8)
    // ------------------------------------------------------------------

    /// Start/stop grid-delta emission for a session. Enable is idempotent and
    /// always (re)starts with an immediate `full` frame — the service re-arms
    /// after reconnects/re-ensures, and a consumer that just subscribed needs
    /// complete state regardless of what was emitted before.
    pub async fn handle_grid_watch(&self, frame: TerminalGridWatchFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let entry = match self.entry_or_attach(&frame.session_id).await {
            Ok(Some(entry)) => entry,
            Ok(None) => {
                debug!(session_id = %frame.session_id, "terminal_grid_watch: no session");
                return Ok(());
            }
            Err(err) => {
                warn!(session_id = %frame.session_id, error = %err, "terminal_grid_watch attach failed");
                return Ok(());
            }
        };

        if !frame.enabled {
            if let Some(existing) = entry.grid_watch.lock().unwrap().take() {
                existing.abort();
            }
            debug!(session_id = %frame.session_id, "grid watch disabled");
            return Ok(());
        }
        // Idempotent re-arm: a live loop just gets a force-full request —
        // pushes survive (real deltas for already-connected consumers).
        {
            let mut watch = entry.grid_watch.lock().unwrap();
            if let Some(existing) = watch.as_ref() {
                if !existing.is_finished() {
                    entry
                        .grid_force_full
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    entry.shared.grid_dirty.notify_one();
                    debug!(session_id = %frame.session_id, "grid watch re-armed in place");
                    return Ok(());
                }
            }
            if let Some(existing) = watch.take() {
                existing.abort();
            }
        }
        let Some(sender) = self.sender().await else {
            return Ok(());
        };
        // Fresh watch: the consumer just seeded from a snapshot that covers
        // all history up to now — start scrollback-clean so the backlog
        // accumulated while unwatched is never shipped as an "incremental"
        // push (whole-history duplication found live on mobile).
        let cleared = entry.session.lock().await.reset_grid_scrollback_pending();
        info!(
            session_id = %frame.session_id,
            cleared_pending = cleared,
            "grid watch enabled (fresh; scrollback baseline reset)"
        );
        let task = tokio::spawn(grid_watch_loop(
            Arc::downgrade(&entry),
            frame.session_id.clone(),
            sender,
        ));
        *entry.grid_watch.lock().unwrap() = Some(task);
        Ok(())
    }

    // ------------------------------------------------------------------
    // terminal_input / terminal_resize / terminal_close
    // ------------------------------------------------------------------

    /// Raw browser keyboard bytes: written verbatim to the PTY.
    pub async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let bytes = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal input data: {err}"))?;
        let Some(entry) = self.entry_or_attach(&frame.session_id).await? else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = %frame.session_id,
                "terminal_input dropped; no session"
            );
            return Ok(());
        };
        if !bytes.is_empty() {
            mark_input_pending(&entry.shared.facts);
        }
        {
            let mut session = entry.session.lock().await;
            session
                .write_raw(&bytes)
                .await
                .map_err(|err| anyhow!("terminal_input write failed: {err}"))?;
        }
        // Record AFTER the write succeeds: grid frames emitted from here on
        // carry `applied_input_seq >= input_seq` (§6.8.3), which is what lets
        // the client retire its predictive echo for these bytes.
        if let Some(seq) = frame.input_seq {
            let mut facts = entry.shared.facts.lock().unwrap();
            let current = facts.last_applied_input_seq.unwrap_or(0);
            facts.last_applied_input_seq = Some(current.max(seq));
        }
        Ok(())
    }

    pub async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let Some(entry) = self.entry_or_attach(&frame.session_id).await? else {
            // Normal in the window between daemon (re)start and terminal_ensure:
            // the service forwards resizes based on its DB session row, and the
            // upcoming ensure carries current dimensions anyway.
            debug!(
                message_id = %frame.envelope.id,
                session_id = %frame.session_id,
                "terminal_resize dropped; no session"
            );
            return Ok(());
        };
        // Subscribe BEFORE deciding, so a `command_started`/`prompt_ready`
        // racing the decision can never be missed by the deferral task.
        let wake = entry.pump_tx.subscribe();
        let deferred = {
            let mut facts = entry.shared.facts.lock().unwrap();
            // Width shrink onto an idle shell prompt with a line pending:
            // bash's readline redisplays the multi-row line on SIGWINCH
            // using its pre-reflow row count and lands every following row
            // too high (duplicated command, overwritten output — reproduced
            // against bash 5.2/5.3 with the paste→Enter gap and with a line
            // composed at the prompt). Defer until the shell consumes the
            // line; grows and rows-only changes are safe and apply now.
            let shrink = frame.cols < facts.cols;
            let at_idle_shell_prompt =
                facts.mode == stem::events::Mode::Shell && facts.open_command.is_none();
            if shrink && at_idle_shell_prompt && facts.input_pending_at_prompt && !facts.closed {
                facts.deferred_resize = Some((frame.cols, frame.rows));
                true
            } else {
                // Newest geometry wins over anything still deferred.
                facts.deferred_resize = None;
                false
            }
        };
        if !deferred {
            return self
                .apply_resize(&entry, &frame.session_id, frame.cols, frame.rows)
                .await;
        }
        debug!(
            session_id = %frame.session_id,
            cols = frame.cols,
            rows = frame.rows,
            "terminal_resize shrink deferred: input pending at shell prompt"
        );
        let manager = self.clone();
        let session_id = frame.session_id.clone();
        tokio::spawn(async move {
            let mut wake = wake;
            let _ = tokio::time::timeout(RESIZE_DEFER_CAP, async {
                loop {
                    match wake.recv().await {
                        Ok(PumpEvent::CommandStarted { .. })
                        | Ok(PumpEvent::PromptReady { .. })
                        | Ok(PumpEvent::Closed)
                        | Err(broadcast::error::RecvError::Closed) => break,
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
            })
            .await;
            let pending = entry.shared.facts.lock().unwrap().deferred_resize.take();
            if let Some((cols, rows)) = pending {
                if let Err(err) = manager.apply_resize(&entry, &session_id, cols, rows).await {
                    warn!(session_id = %session_id, error = %err, "deferred terminal resize failed");
                }
            }
        });
        Ok(())
    }

    /// Apply a geometry change to the PTY + emulator and announce `ready`
    /// (the service re-arms grid watches on it so viewers get a full frame).
    async fn apply_resize(
        &self,
        entry: &Arc<SessionEntry>,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        {
            let mut session = entry.session.lock().await;
            session
                .resize(cols, rows)
                .await
                .map_err(|err| anyhow!("terminal resize failed: {err}"))?;
        }
        {
            let mut facts = entry.shared.facts.lock().unwrap();
            facts.cols = cols;
            facts.rows = rows;
        }
        if let Some(sender) = self.sender().await {
            let info = self.entry_status_info(entry).await;
            send_transport_frame(
                &sender,
                terminal_status_frame(session_id, "ready", Some(info)),
            )?;
        }
        Ok(())
    }

    pub async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let session_id = frame.session_id.clone();
        let entry = self.inner.lock().await.sessions.remove(&session_id);
        if let Some(entry) = entry {
            entry.abort_tasks();
            let mut session = entry.session.lock().await;
            if let Err(err) = session.kill().await {
                warn!(session_id = %session_id, error = %err, "holder kill failed");
            }
            // Best-effort registry litter cleanup once the holder is gone.
            let base = self.config.term_base_dir.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(registry) = Registry::new(base) {
                        let _ = registry.gc_stale();
                    }
                })
                .await;
            });
        }
        if let Some(sender) = self.sender().await {
            send_transport_frame(&sender, terminal_status_frame(&session_id, "closed", None))?;
        }
        info!(
            message_id = %frame.envelope.id,
            session_id = %session_id,
            reason = %frame.reason.clone().unwrap_or_default(),
            "terminal_close handled"
        );
        Ok(())
    }
}

/// Resolve a `terminal_send` await against pump events. `await: "command"`
/// matches the first `command_finished` whose start was observed after this
/// subscription — or a synthetic-start finish (sentinel path, where the start
/// may only be synthesized at finish time).
/// Resolve a `terminal_send` await off the pump broadcast.
///
/// `expect_start_marker`: the dispatched text was a submitted command on a
/// shell with genuine OSC 133 markers, so a `command_started` is expected.
/// If a quiet point (or a fresh prompt) arrives first and no start marker
/// follows within `INPUT_ABSORBED_GRACE`, the text did not run as a shell
/// command — a foreground program absorbed it, or the shell ran nothing —
/// and the await resolves `input_absorbed` instead of waiting for a
/// `command_finished` that cannot come (the codex-incident shape, kept as a
/// backstop behind the busy guard). Sentinel sessions never expect a start
/// marker (their start is synthesized at `D`), so they are excluded.
async fn await_outcome(
    mut rx: broadcast::Receiver<PumpEvent>,
    kind: TerminalSendAwait,
    expect_start_marker: bool,
) -> AwaitResult {
    let mut started_after_dispatch: HashSet<String> = HashSet::new();
    let mut absorbed: Option<(tokio::time::Instant, Value)> = None;
    loop {
        let received = match absorbed.as_ref() {
            Some((deadline, _)) => match tokio::time::timeout_at(*deadline, rx.recv()).await {
                Ok(received) => received,
                Err(_elapsed) => {
                    let (_, data) = absorbed.take().expect("absorbed candidate");
                    return AwaitResult::Outcome(json!({
                        "event": "input_absorbed",
                        "data": data,
                    }));
                }
            },
            None => rx.recv().await,
        };
        match received {
            Ok(PumpEvent::CommandStarted { command_id }) => {
                started_after_dispatch.insert(command_id);
                absorbed = None;
            }
            Ok(PumpEvent::CommandFinished {
                command_id,
                synthetic_start,
                data,
            }) => {
                if kind == TerminalSendAwait::Command
                    && (synthetic_start || started_after_dispatch.contains(&command_id))
                {
                    return AwaitResult::Outcome(json!({
                        "event": "command_finished",
                        "data": data,
                    }));
                }
                // Settled-awaits ALSO accept a command completion: it is the
                // richest possible transition. This makes the send/run tools
                // substitutable at a shell prompt — a model that types a
                // command via terminal.send still gets the real exit code
                // (matters most for smaller models fumbling tool choice).
                if kind == TerminalSendAwait::Settled {
                    return AwaitResult::Outcome(json!({
                        "event": "command_finished",
                        "data": data,
                    }));
                }
            }
            Ok(PumpEvent::Settled { data }) => {
                if kind == TerminalSendAwait::Settled {
                    return AwaitResult::Outcome(json!({ "event": "settled", "data": data }));
                }
                if expect_start_marker && started_after_dispatch.is_empty() && absorbed.is_none() {
                    let mut candidate = data.as_object().cloned().unwrap_or_default();
                    candidate.insert("signal".into(), Value::String("settled".into()));
                    absorbed = Some((
                        tokio::time::Instant::now() + INPUT_ABSORBED_GRACE,
                        Value::Object(candidate),
                    ));
                }
            }
            Ok(PumpEvent::InteractiveStarted { data }) => {
                if kind == TerminalSendAwait::Command {
                    return AwaitResult::Outcome(json!({
                        "event": "interactive_started",
                        "data": data,
                    }));
                }
            }
            Ok(PumpEvent::PromptReady { data }) => {
                // Returning to a shell prompt is maximal settlement: resolve
                // settled-awaits so a send that exits an interactive program
                // (e.g. `/quit` in an inline TUI) completes on the prompt's
                // arrival instead of riding the timeout budget (an idle
                // prompt never emits `settled` by design).
                if kind == TerminalSendAwait::Settled {
                    return AwaitResult::Outcome(json!({
                        "event": "prompt_ready",
                        "data": data,
                    }));
                }
                // A fresh prompt with no start marker since dispatch: the
                // shell ran nothing (empty/whitespace line, or a shim that
                // lost its markers). Same grace as the settled case.
                if expect_start_marker && started_after_dispatch.is_empty() && absorbed.is_none() {
                    let mut candidate = data.as_object().cloned().unwrap_or_default();
                    candidate.insert("signal".into(), Value::String("prompt_ready".into()));
                    absorbed = Some((
                        tokio::time::Instant::now() + INPUT_ABSORBED_GRACE,
                        Value::Object(candidate),
                    ));
                }
            }
            Ok(PumpEvent::Closed) => return AwaitResult::Closed,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return AwaitResult::Closed,
        }
    }
}
/// Resolve an awaited `terminal_observe` (§6.1) — the knobless wait.
///
/// One semantic, no caller-chosen mode (`await:"settled"` and `"command"` are
/// accepted as synonyms; old services get the unified behavior): a race over
/// every fact that should return control to the caller.
///
/// - `command_finished` / `prompt_ready` / close: exact boundaries from pump
///   events; they always win when they arrive first.
/// - `stalled`: content the caller has not observed (delta vs the observe
///   baseline) stays quiet for the stall window (`stall_quiet`,
///   service-owned). Detected by a 100ms poll over quiet+unseen persistence
///   — an at-prompt shell's quiet point emits no event, so events alone
///   cannot drive this. Animation resets the timer (quiet flickers); silent
///   programs never trip it (nothing unseen).
/// - `settled`: a quiet, fully-seen terminal with nothing open (idle).
/// - Start snapshot (after subscribing, so nothing is missed): already quiet
///   with unseen content resolves `stalled` immediately; already quiet,
///   seen, nothing open resolves `settled` immediately; already quiet,
///   seen, command open HOLDS — the caller just saw this exact screen, so
///   only new content or a boundary should wake it. This makes re-waiting
///   after a stall free: at most one wake per quiet stretch.
///
/// Never holds the session lock across a wait.
async fn await_observe_outcome(
    entry: &SessionEntry,
    _kind: TerminalSendAwait,
    stall_quiet: Duration,
) -> Value {
    let mut rx = entry.pump_tx.subscribe();
    let closed = || json!({ "event": "closed", "data": {} });

    let (quiet_now, mode, screen) = {
        let session = entry.session.lock().await;
        (session.is_quiet(), session.mode(), session.screen_lines())
    };
    let (open, unseen) = {
        let facts = entry.shared.facts.lock().unwrap();
        let (changed, _) = grid_delta(facts.last_observed_screen.as_deref(), &screen);
        (facts.open_command.is_some(), changed)
    };

    if quiet_now {
        if unseen {
            return json!({
                "event": "stalled",
                "data": { "mode": mode_str(mode), "quiet_ms": 0, "immediate": true },
            });
        }
        if !open {
            return json!({
                "event": "settled",
                "data": { "mode": mode_str(mode), "quiet_ms": 0, "immediate": true },
            });
        }
        // Quiet, seen, command open: hold for new facts.
    }

    let quiet_poll = Duration::from_millis(100);
    let mut quiet_unseen_since: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Ok(PumpEvent::CommandFinished { data, .. }) => {
                    return json!({ "event": "command_finished", "data": data })
                }
                Ok(PumpEvent::PromptReady { data }) => {
                    return json!({ "event": "prompt_ready", "data": data })
                }
                Ok(PumpEvent::Closed) | Err(broadcast::error::RecvError::Closed) => {
                    return closed()
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
            },
            _ = tokio::time::sleep(quiet_poll) => {
                let (quiet, mode, screen) = {
                    let session = entry.session.lock().await;
                    (session.is_quiet(), session.mode(), session.screen_lines())
                };
                if !quiet {
                    quiet_unseen_since = None;
                    continue;
                }
                let (open, unseen) = {
                    let facts = entry.shared.facts.lock().unwrap();
                    let (changed, _) = grid_delta(facts.last_observed_screen.as_deref(), &screen);
                    (facts.open_command.is_some(), changed)
                };
                if unseen {
                    let since = *quiet_unseen_since.get_or_insert_with(tokio::time::Instant::now);
                    // `is_quiet` already implies QUIET_MS of quiet before the
                    // first positive poll; require the remainder of the window.
                    if since.elapsed() + Duration::from_millis(QUIET_MS) >= stall_quiet {
                        return json!({
                            "event": "stalled",
                            "data": {
                                "mode": mode_str(mode),
                                "quiet_ms": stall_quiet.as_millis() as u64,
                            },
                        });
                    }
                } else {
                    quiet_unseen_since = None;
                    if !open {
                        return json!({
                            "event": "settled",
                            "data": { "mode": mode_str(mode), "quiet_ms": 0, "immediate": false },
                        });
                    }
                }
            }
        }
    }
}

/// Grid-sync emission loop (one per watched session): an immediate `full`
/// frame, then a coalescing tick draining accumulated damage. Holding only a
/// `Weak` keeps the entry's lifecycle authoritative — the loop ends when the
/// entry is replaced/removed, the session closes, or the transport drops.
async fn grid_watch_loop(entry: Weak<SessionEntry>, session_id: String, sender: OutboundSender) {
    let mut force_full = true;
    // Last SHIPPED predict_ok: a gate flip with no natural frame forces one
    // (a password prompt must close the gate promptly even though
    // `stty -echo` itself paints nothing).
    let mut last_predict_ok: Option<bool> = None;
    // Termios cache (predict-gate input), refreshed at most every
    // GRID_TERMIOS_REFRESH so a 60 fps scroll doesn't add an IPC roundtrip
    // per frame.
    let mut termios: Option<stem::client::TermiosFacts> = None;
    let mut termios_at: Option<tokio::time::Instant> = None;
    let mut last_emit = tokio::time::Instant::now() - GRID_MIN_INTERVAL;
    loop {
        let Some(entry) = entry.upgrade() else { return };
        if entry.shared.facts.lock().unwrap().closed {
            return;
        }
        // Lock scope: termios refresh + frame take + alt fact under one hold;
        // serialization and send happen unlocked. The termios query is a
        // local UDS roundtrip (None for surviving pre-v2 holders → gate
        // stays closed, predictions off).
        let rearm_full = entry
            .grid_force_full
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        let (frame, alt_screen) = {
            let mut session = entry.session.lock().await;
            if termios_at.is_none_or(|at| at.elapsed() >= GRID_TERMIOS_REFRESH) {
                termios = session.query_termios().await.ok().flatten();
                termios_at = Some(tokio::time::Instant::now());
            }
            (
                session.take_grid_frame(force_full || rearm_full),
                session.alt_screen_active(),
            )
        };
        let initial_full = force_full;
        force_full = false;
        let (mode, open_command, applied_input_seq) = {
            let facts = entry.shared.facts.lock().unwrap();
            (
                facts.mode,
                facts.open_command.is_some(),
                facts.last_applied_input_seq,
            )
        };
        // §6.8.3 gate: predictions only at an interactive prompt on the
        // primary screen. Note the termios test is an EXCLUSION, not a
        // positive `ECHO && ICANON` check: line-editor shells (readline/zle)
        // sit at the prompt in raw mode with kernel echo OFF and echo
        // app-side — the thing predictions model. What must never predict is
        // the silent-canonical pattern (`ICANON && !ECHO` — classic password
        // prompts) and any state with a foreground command open (sudo/read -s
        // /inline raw TUIs like codex all live under open_command).
        let at_interactive_prompt = match mode {
            stem::events::Mode::Shell => !open_command,
            stem::events::Mode::Repl => true,
            _ => false,
        };
        // `!t.icanon || t.echo` == NOT silent-canonical (`ICANON && !ECHO`).
        let predict_ok =
            at_interactive_prompt && !alt_screen && termios.is_some_and(|t| !t.icanon || t.echo);
        let mut gate_flip_forced = false;
        let frame = if frame.is_none() && last_predict_ok.is_some_and(|last| last != predict_ok) {
            gate_flip_forced = true;
            entry.session.lock().await.take_grid_frame(true)
        } else {
            frame
        };
        if let Some(frame) = frame {
            // Frame provenance (mobile grid triage asks "why was this full
            // forced"): watch start, service re-arm, predict-gate flip, or
            // ordinary damage.
            let reason = if initial_full {
                "watch_start"
            } else if rearm_full {
                "rearm"
            } else if gate_flip_forced {
                "gate_flip"
            } else {
                "damage"
            };
            if frame.scrollback_push.len() >= GRID_PUSH_WARN_LINES {
                let grid = entry.session.lock().await.grid_debug();
                warn!(
                    session_id = %session_id,
                    generation = frame.generation,
                    full = frame.full,
                    reason,
                    push = frame.scrollback_push.len(),
                    dropped = frame.scrollback_dropped,
                    grid = ?grid,
                    "grid frame ships a large scrollback_push"
                );
            } else {
                debug!(
                    session_id = %session_id,
                    generation = frame.generation,
                    full = frame.full,
                    reason,
                    push = frame.scrollback_push.len(),
                    "grid frame emitted"
                );
            }
            let mut fields = grid_frame_fields(&frame);
            fields.insert("predict_ok".into(), Value::Bool(predict_ok));
            if let Some(seq) = applied_input_seq {
                fields.insert("applied_input_seq".into(), Value::Number(Number::from(seq)));
            }
            let wire = terminal_grid_frame(&session_id, fields);
            if send_transport_frame(&sender, wire).is_err() {
                debug!(session_id = %session_id, "grid watch stopping: transport gone");
                return;
            }
            last_predict_ok = Some(predict_ok);
            last_emit = tokio::time::Instant::now();
        }
        // Pace the next iteration: wake on pump activity (a permit stored
        // while we were emitting counts — no lost updates), or the idle poll
        // for damage-less gate flips; then a coalescing beat so a burst of
        // chunks becomes one frame, floored by the minimum inter-frame gap.
        tokio::select! {
            _ = entry.shared.grid_dirty.notified() => {
                tokio::time::sleep(GRID_COALESCE).await;
            }
            _ = tokio::time::sleep(GRID_IDLE_POLL) => {}
        }
        drop(entry);
        let since_emit = last_emit.elapsed();
        if since_emit < GRID_MIN_INTERVAL {
            tokio::time::sleep(GRID_MIN_INTERVAL - since_emit).await;
        }
    }
}

/// Integration detection window: no OSC 133 marker within the window after
/// attach -> `mark_no_integration()` and emit the resulting `mode_changed`
/// (stem's marker methods swallow their own ModeChange).
async fn detect_integration_window(entry: Weak<SessionEntry>, sender: OutboundSender) {
    tokio::time::sleep(INTEGRATION_DETECT_WINDOW).await;
    let Some(entry) = entry.upgrade() else {
        return;
    };
    {
        let facts = entry.shared.facts.lock().unwrap();
        if facts.marker_seen || facts.closed {
            return;
        }
    }
    let mode = {
        let session = entry.session.lock().await;
        session.mark_no_integration();
        session.mode()
    };
    let session_id = entry.shared.session_id.clone();
    let emit = {
        let mut facts = entry.shared.facts.lock().unwrap();
        let changed = facts.integration != Integration::None || facts.mode != mode;
        facts.integration = Integration::None;
        facts.mode = mode;
        changed
    };
    if emit {
        let _ = send_transport_frame(
            &sender,
            terminal_event_frame(
                &session_id,
                "mode_changed",
                json!({
                    "mode": mode_str(mode),
                    "integration": integration_str(Integration::None),
                }),
            ),
        );
    }
}

/// Grid-diff delta (documented v1 semantics): compare the current screen grid
/// to the last observed snapshot line-by-line and return the changed rows.
/// A missing baseline returns the whole (trailing-blank-trimmed) screen.
fn grid_delta(previous: Option<&[String]>, current: &[String]) -> (bool, Vec<String>) {
    match previous {
        None => (true, trim_trailing_empty(current)),
        Some(previous) => {
            let mut changed_lines = Vec::new();
            let rows = previous.len().max(current.len());
            for index in 0..rows {
                let old = previous.get(index).map(String::as_str).unwrap_or("");
                let new = current.get(index).map(String::as_str).unwrap_or("");
                if old != new && !(old.trim().is_empty() && new.trim().is_empty()) {
                    changed_lines.push(new.to_string());
                }
            }
            (!changed_lines.is_empty(), changed_lines)
        }
    }
}

fn trim_trailing_empty(lines: &[String]) -> Vec<String> {
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map(|index| index + 1)
        .unwrap_or(0);
    lines[..end].to_vec()
}

/// Record that bytes are about to land on an idle shell prompt (a readline
/// line is pending until `command_started`/`prompt_ready`). Only meaningful
/// in shell mode with no open command: TUIs/REPLs must keep instant resizes.
fn mark_input_pending(facts: &std::sync::Mutex<SessionFacts>) {
    let mut facts = facts.lock().unwrap();
    if facts.mode == stem::events::Mode::Shell && facts.open_command.is_none() {
        facts.input_pending_at_prompt = true;
    }
}

fn build_session_env(overrides: Option<HashMap<String, String>>) -> Vec<(String, String)> {
    let mut env = HashMap::from([
        (
            "COLORTERM".to_string(),
            DEFAULT_TERMINAL_COLORTERM.to_string(),
        ),
        (
            "COLORFGBG".to_string(),
            DEFAULT_TERMINAL_COLORFGBG.to_string(),
        ),
    ]);
    if let Some(overrides) = overrides {
        env.extend(overrides);
    }
    let mut entries = env.into_iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_delta_reports_changed_rows_only() {
        let previous = vec!["prompt$ ".to_string(), "".to_string(), "".to_string()];
        let current = vec![
            "prompt$ echo hi".to_string(),
            "hi".to_string(),
            "".to_string(),
        ];
        let (changed, lines) = grid_delta(Some(&previous), &current);
        assert!(changed);
        assert_eq!(lines, vec!["prompt$ echo hi".to_string(), "hi".to_string()]);

        let (changed, lines) = grid_delta(Some(&current), &current);
        assert!(!changed);
        assert!(lines.is_empty());
    }

    #[test]
    fn grid_delta_without_baseline_returns_trimmed_screen() {
        let current = vec!["a".to_string(), "".to_string(), "".to_string()];
        let (changed, lines) = grid_delta(None, &current);
        assert!(changed);
        assert_eq!(lines, vec!["a".to_string()]);
    }

    #[test]
    fn session_env_defaults_and_overrides() {
        let env = build_session_env(None)
            .into_iter()
            .collect::<HashMap<_, _>>();
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("COLORFGBG").map(String::as_str), Some("15;0"));

        let env = build_session_env(Some(HashMap::from([(
            "COLORTERM".to_string(),
            "24bit".to_string(),
        )])))
        .into_iter()
        .collect::<HashMap<_, _>>();
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("24bit"));
    }

    #[test]
    fn sentinel_trailer_is_a_shell_literal() {
        assert!(SENTINEL_TRAILER.starts_with("; printf"));
        assert!(SENTINEL_TRAILER.contains("133;D;%s"));
        assert!(SENTINEL_TRAILER.contains("\"$?\""));
        // Literal backslash-escapes for the shell, not raw control bytes.
        assert!(!SENTINEL_TRAILER.contains('\u{1b}'));
    }
}
