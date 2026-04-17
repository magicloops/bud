pub mod tmux;

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Number, Value};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::Mutex;
use tokio::time;
use tracing::{info, warn};

use crate::protocol::{
    AwaitReady, TerminalCloseFrame, TerminalEnsureConfig, TerminalEnsureFrame, TerminalInputFrame,
    TerminalObserveFrame, TerminalResizeFrame, TerminalSendFrame, TERMINAL_PROTO_VERSION,
};
use crate::util::{new_message_id, now_millis, send_ws_frame, OutboundSender};

use self::tmux::{probe_tmux as tmux_probe, TmuxBackend};

// TerminalManager owns the service-facing terminal contract and keeps readiness
// assessment above the backend boundary. The tmux adapter remains an internal
// implementation detail even while a few tmux-shaped fields still leak through
// the wire contract for compatibility.
const DEFAULT_TERMINAL_COLORTERM: &str = "truecolor";
const DEFAULT_TERMINAL_COLORFGBG: &str = "15;0";

const ACTIVITY_DEFAULT_INITIAL_DELAY_MS: u64 = 2000;
const ACTIVITY_DEFAULT_INTERVAL_MS: u64 = 5000;
const ACTIVITY_DEFAULT_STABLE_COUNT: u32 = 2;
const ACTIVITY_DEFAULT_MAX_WAIT_MS: u64 = 60_000;
const OUTPUT_QUIESCENCE_POLL_INTERVAL_MS: u64 = 50;
const OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES: u32 = 3;
const OUTPUT_QUIESCENCE_QUIET_MS: u64 = 150;
const SCREEN_WAIT_POLL_INTERVAL_MS: u64 = 100;
const SCREEN_WAIT_SETTLED_QUIET_MS: u64 = 300;
const DEFAULT_DELTA_CAPTURE_START_LINE: i32 = -50;
const LOW_SIGNAL_SEPARATOR_MIN_RUN: usize = 4;
const MAX_VISIBLE_DELTA_LINES: usize = 20;
const MAX_CHANGED_WINDOW_LINES: usize = 20;
const MAX_VISIBLE_DELTA_BYTES: usize = 4096;
const TMUX_TEXT_TO_ENTER_DELAY_MS: u64 = 10;

#[derive(Clone)]
pub struct TerminalConfig {
    pub enabled: bool,
    pub base_log_dir: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    pub tmux_available: bool,
    pub tmux_version: Option<String>,
    pub debug_enabled: bool,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Mutex<TerminalState>>,
    pub config: TerminalConfig,
    backend: TmuxBackend,
}

struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,
    delivered_captures: HashMap<String, DeliveredCaptureState>,
}

#[derive(Clone, Debug)]
struct DeliveredCaptureState {
    capture: String,
    start_line: Option<i32>,
}

struct TerminalHandle {
    session_id: String,
    session_name: String,
    log_path: PathBuf,
    pid: Option<i32>,
    cwd: Option<String>,
    watcher: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    seq: Arc<AtomicU64>,
    #[allow(dead_code)]
    offset: Arc<AtomicU64>,
    last_output_at: Arc<AtomicU64>,
    last_output_seq: Arc<AtomicU64>,
    cols: u16,
    rows: u16,
}

struct ReadinessDetector {
    session_id: String,
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    start_offset: u64,
    await_ready: Option<AwaitReady>,
}

#[derive(Clone, Debug)]
struct CaptureLogSummary {
    hash: u64,
    line_count: usize,
    last_non_empty_line: String,
    preview_head: Option<String>,
    preview_tail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScreenWaitMode {
    None,
    Changed,
    Settled,
}

#[derive(Debug)]
struct ScreenCaptureState {
    capture: String,
    summary: CaptureLogSummary,
    captured_after_ms: u64,
}

#[derive(Debug)]
struct ScreenWaitResult {
    capture: String,
    summary: CaptureLogSummary,
    assessment: Value,
    captured_after_ms: u64,
}

#[derive(Debug)]
struct OutputQuiescenceWaitResult {
    trigger: &'static str,
    quiet_for_ms: u64,
    elapsed_ms: u64,
    check_count: u32,
    stable_checks: u32,
    output_seen: bool,
    latest_offset: u64,
    last_output_seq: u64,
}

#[derive(Debug, Clone)]
struct AdditiveDeltaPayload {
    changed: bool,
    text: String,
    truncated: bool,
    strategy: &'static str,
}

#[derive(Debug, Clone)]
struct TerminalStatusSnapshot {
    session_name: String,
    cols: u16,
    rows: u16,
    output_log_bytes: u64,
    pid: Option<i32>,
    cwd: Option<String>,
}

struct ActivityDetector {
    session_id: String,
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    backend: TmuxBackend,
    initial_delay_ms: u64,
    interval_ms: u64,
    stable_count_required: u32,
    max_wait_ms: u64,
}

impl TerminalManager {
    pub fn new(config: TerminalConfig) -> Self {
        let backend = TmuxBackend::new(config.clone());
        Self {
            inner: Arc::new(Mutex::new(TerminalState {
                sender: None,
                sessions: HashMap::new(),
                delivered_captures: HashMap::new(),
            })),
            config,
            backend,
        }
    }

    pub async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    pub async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        for (_, handle) in inner.sessions.drain() {
            handle.watcher.abort();
        }
        inner.delivered_captures.clear();
        inner.sender = None;
    }

    pub async fn handle_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
        if !self.config.enabled {
            info!("terminal support disabled; ignoring terminal_ensure");
            return Ok(());
        }

        let session_id = &frame.session_id;
        let inner = self.inner.lock().await;

        if inner.sessions.contains_key(session_id) {
            if let Some(sender) = inner.sender.clone() {
                drop(inner);
                self.send_status(&sender, session_id, "ready", None).await?;
            }
            return Ok(());
        }

        let sender = inner
            .sender
            .clone()
            .ok_or_else(|| anyhow!("no websocket writer available"))?;
        drop(inner);

        if !self.config.tmux_available {
            warn!("tmux not available; cannot create terminal");
            self.send_status(
                &sender,
                session_id,
                "none",
                Some(json!({ "error": "tmux_unavailable" })),
            )
            .await?;
            return Ok(());
        }

        let ensured = self
            .ensure_terminal_session(session_id, frame.config)
            .await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner.sessions.insert(session_id.clone(), handle);
        } else {
            self.send_status(
                &sender,
                session_id,
                "none",
                Some(json!({ "error": "terminal_create_failed" })),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal input data: {}", err))?;

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = session_id,
                "terminal_input dropped; no session"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(Ordering::SeqCst);
        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            bytes = data.len(),
            session = %handle.session_name,
            start_offset = start_offset,
            "terminal_input received"
        );
        let input = String::from_utf8_lossy(&data).to_string();
        let (trimmed_end, newline_count) = split_low_level_input(&input);

        if !trimmed_end.is_empty() {
            if let Err(err) = self
                .backend
                .send_literal_text(&handle.session_name, &trimmed_end)
                .await
            {
                warn!(message_id = %frame.envelope.id, error = %err, "tmux send-keys (text) failed");
            }
        }

        if !trimmed_end.is_empty() && newline_count > 0 {
            time::sleep(Duration::from_millis(TMUX_TEXT_TO_ENTER_DELAY_MS)).await;
        }
        for _ in 0..newline_count {
            if let Err(err) = self.backend.send_key(&handle.session_name, "Enter").await {
                warn!(message_id = %frame.envelope.id, error = %err, "tmux send-keys (Enter) failed");
            }
        }

        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            bytes = input.len(),
            text_bytes = trimmed_end.len(),
            enter_count = newline_count,
            session = %handle.session_name,
            "tmux send-keys succeeded"
        );

        if frame
            .await_ready
            .as_ref()
            .map(|a| a.enabled)
            .unwrap_or(false)
        {
            if let Some(sender) = self.inner.lock().await.sender.clone() {
                let await_ready = frame.await_ready.clone().unwrap_or_default();
                let session_id_owned = session_id.clone();

                if await_ready.activity_based {
                    info!(
                        message_id = %frame.envelope.id,
                        session_id = session_id,
                        session = %handle.session_name,
                        "using activity-based readiness detection"
                    );
                    let detector = ActivityDetector::new(
                        session_id_owned,
                        handle.clone(),
                        sender,
                        self.backend.clone(),
                        &await_ready,
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "activity detection failed");
                        }
                    });
                } else {
                    let detector = ReadinessDetector::new(
                        session_id_owned,
                        handle.clone(),
                        sender,
                        start_offset,
                        frame.await_ready.clone(),
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "readiness detection failed");
                        }
                    });
                }
            }
        }
        Ok(())
    }

    pub async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = session_id,
                "terminal_resize dropped; no session"
            );
            return Ok(());
        };

        if let Err(err) = self
            .backend
            .resize_window(&handle.session_name, frame.cols, frame.rows)
            .await
        {
            warn!(message_id = %frame.envelope.id, error = %err, "tmux resize-window failed");
        }

        Ok(())
    }

    pub async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };

        let handle = {
            let mut inner = self.inner.lock().await;
            let handle = inner.sessions.remove(session_id);
            inner.delivered_captures.remove(session_id);
            handle
        };

        if let Some(handle) = handle {
            handle.watcher.abort();
            let _ = self.backend.kill_session(&handle.session_name).await;
            info!(
                session_id = session_id,
                session_name = %handle.session_name,
                "terminal session closed"
            );
        }

        if let Some(sender) = sender {
            self.send_status(&sender, session_id, "closed", None)
                .await?;
        }

        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            reason = %frame.reason.clone().unwrap_or_default(),
            "terminal_close handled"
        );
        Ok(())
    }

    pub async fn handle_observe(&self, frame: TerminalObserveFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_observe_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let view = frame.view.as_deref().unwrap_or("delta");
        let wait_for = frame.wait_for.as_deref().unwrap_or("none");
        let timeout_ms = frame.timeout_ms.unwrap_or(30_000);
        let lines = frame.lines.unwrap_or(-50);
        let view = match parse_observe_view(view) {
            Ok(parsed) => parsed,
            Err(_) => {
                return self.send_observe_error(&frame, "unsupported_view").await;
            }
        };
        let start_line = start_line_for_observe_view(view, lines);

        if view == "delta" && wait_for == "shell_ready" {
            return self
                .send_observe_error(&frame, "unsupported_wait_for")
                .await;
        }

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            return self.send_observe_error(&frame, "session_not_found").await;
        };

        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = request_id,
                session_id = session_id,
                "terminal_observe dropped; no sender"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(Ordering::SeqCst);
        info!(
            request_id = request_id,
            session_id = session_id,
            session = %handle.session_name,
            view = view,
            wait_for = wait_for,
            lines = lines,
            start_line = ?start_line,
            timeout_ms = timeout_ms,
            start_offset = start_offset,
            "terminal_observe received"
        );

        let delivered_baseline = if view == "delta" {
            self.get_delivered_capture(session_id, start_line).await
        } else {
            None
        };
        let wait_baseline = if view == "delta"
            && delivered_baseline.is_none()
            && wait_for != "none"
            && wait_for != "shell_ready"
        {
            match self
                .capture_with_lines(&handle.session_name, start_line)
                .await
            {
                Ok(capture) => Some(capture),
                Err(err) => {
                    warn!(
                        request_id = request_id,
                        session_id = session_id,
                        error = %err,
                        "terminal_observe baseline capture failed"
                    );
                    None
                }
            }
        } else {
            None
        };

        let readiness_wait_start = Instant::now();
        let (readiness, current_capture, capture_ms, capture_summary, reused_wait_capture) =
            if wait_for == "shell_ready" {
                let readiness = self
                    .resolve_readiness_after_interaction(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        start_offset,
                    )
                    .await?;

                let capture_start = Instant::now();
                let output = self
                    .capture_with_lines(&handle.session_name, start_line)
                    .await?;
                let capture_ms = capture_start.elapsed().as_millis() as u64;
                let capture_summary = summarize_capture_for_log(&output, self.config.debug_enabled);
                (readiness, output, capture_ms, capture_summary, false)
            } else if matches!(wait_for, "settled" | "screen_stable") {
                let observe_started_at = now_millis();
                let quiescence = self
                    .wait_for_output_quiescence(
                        &handle,
                        request_id,
                        timeout_ms,
                        observe_started_at,
                        start_offset,
                    )
                    .await?;
                let current = self
                    .capture_screen_state(&handle.session_name, start_line, quiescence.elapsed_ms)
                    .await?;
                let readiness = self.build_quiescence_assessment(&current.capture, &quiescence);
                (
                    readiness,
                    current.capture,
                    current.captured_after_ms,
                    current.summary,
                    false,
                )
            } else {
                let wait_result = self
                    .wait_for_screen_state(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        wait_baseline.as_deref().or(delivered_baseline.as_deref()),
                        start_line,
                    )
                    .await?;
                (
                    wait_result.assessment,
                    wait_result.capture,
                    wait_result.captured_after_ms,
                    wait_result.summary,
                    true,
                )
            };
        let readiness_wait_ms = readiness_wait_start.elapsed().as_millis() as u64;
        let (output, output_bytes, lines_captured, changed, truncated, delta_strategy) = match view
        {
            "delta" => {
                let comparison_baseline =
                    delivered_baseline.as_deref().or(wait_baseline.as_deref());
                let delta = build_additive_delta_payload(comparison_baseline, &current_capture);
                let fallback_delta =
                    if delivered_baseline.is_none() && delta.text.is_empty() && !delta.changed {
                        Some(build_additive_delta_payload(None, &current_capture))
                    } else {
                        None
                    };
                let output = fallback_delta
                    .as_ref()
                    .map(|value| value.text.clone())
                    .unwrap_or_else(|| delta.text.clone());
                let output_bytes = output.as_bytes().len();
                let lines_captured = output.lines().count();
                (
                    output,
                    output_bytes,
                    lines_captured,
                    Some(delta.changed),
                    Some(
                        fallback_delta
                            .as_ref()
                            .map(|value| value.truncated)
                            .unwrap_or(delta.truncated),
                    ),
                    Some(
                        fallback_delta
                            .as_ref()
                            .map(|value| value.strategy)
                            .unwrap_or(delta.strategy),
                    ),
                )
            }
            "screen" | "history" => {
                let output_bytes = current_capture.as_bytes().len();
                let lines_captured = current_capture.lines().count();
                (
                    current_capture.clone(),
                    output_bytes,
                    lines_captured,
                    None,
                    None,
                    None,
                )
            }
            _ => unreachable!("unsupported observe view"),
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_observe_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": request_id,
            "view": view,
            "output": BASE64_STANDARD.encode(output.as_bytes()),
            "output_bytes": output_bytes,
            "lines_captured": lines_captured,
            "changed": changed,
            "truncated": truncated,
            "readiness": readiness,
            "error": Value::Null,
        });
        send_ws_frame(&sender, payload)?;

        if view == "delta" {
            self.store_delivered_capture(session_id, &current_capture, start_line)
                .await;
        }

        info!(
            request_id = request_id,
            session_id = session_id,
            view = view,
            wait_for = wait_for,
            lines = lines,
            start_line = ?start_line,
            readiness_wait_ms = readiness_wait_ms,
            capture_ms = capture_ms,
            reused_wait_capture = reused_wait_capture,
            output_bytes = output_bytes,
            lines_captured = lines_captured,
            delta_changed = changed,
            delta_truncated = truncated,
            delta_strategy = delta_strategy,
            capture_hash = format!("{:016x}", capture_summary.hash),
            capture_line_count = capture_summary.line_count,
            last_non_empty_line = %capture_summary.last_non_empty_line,
            preview_head = ?capture_summary.preview_head.as_deref(),
            preview_tail = ?capture_summary.preview_tail.as_deref(),
            "terminal_observe_result sent"
        );

        Ok(())
    }

    pub async fn handle_send(&self, frame: TerminalSendFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_send_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let wait_for = frame.wait_for.as_deref().unwrap_or("settled");
        let timeout_ms = frame.timeout_ms.unwrap_or(30_000);
        let observe_after_ms = frame.observe_after_ms.unwrap_or(1000);
        let submit = frame.submit.unwrap_or(false);
        let text = frame.text.as_deref();
        let keys = frame.keys.clone().unwrap_or_default();

        if text.is_none() && !submit && keys.is_empty() {
            return self.send_send_error(&frame, "empty_interaction").await;
        }

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            return self.send_send_error(&frame, "session_not_found").await;
        };

        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = request_id,
                session_id = session_id,
                "terminal_send dropped; no sender"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(Ordering::SeqCst);
        let delta_start_line = Some(DEFAULT_DELTA_CAPTURE_START_LINE);
        let baseline_capture = match self
            .capture_screen_state(&handle.session_name, delta_start_line, 0)
            .await
        {
            Ok(capture) => Some(capture),
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_send baseline capture failed"
                );
                None
            }
        };

        let submitted = match self
            .dispatch_interaction_to_backend(&handle, text, submit, &keys)
            .await
        {
            Ok(submitted) => submitted,
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_send dispatch failed"
                );
                return self.send_send_error(&frame, "send_keys_failed").await;
            }
        };
        let dispatch_completed_at = now_millis();

        let (
            delta,
            readiness,
            current_capture,
            current_summary,
            captured_after_ms,
            quiescence_wait,
        ) = match wait_for {
            "none" => {
                if observe_after_ms > 0 {
                    time::sleep(Duration::from_millis(observe_after_ms)).await;
                }

                match self
                    .capture_screen_state(&handle.session_name, delta_start_line, observe_after_ms)
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        let readiness = assess_capture_readiness(&current.capture);
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            None,
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send post-send capture failed"
                        );
                        (
                            None,
                            self.resolve_readiness_after_interaction(
                                &handle,
                                request_id,
                                wait_for,
                                timeout_ms,
                                start_offset,
                            )
                            .await?,
                            None,
                            None,
                            None,
                            None,
                        )
                    }
                }
            }
            "shell_ready" => {
                let shell_wait_start = Instant::now();
                let readiness = self
                    .resolve_readiness_after_interaction(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        start_offset,
                    )
                    .await?;
                let captured_after_ms = shell_wait_start.elapsed().as_millis() as u64;
                match self
                    .capture_screen_state(&handle.session_name, delta_start_line, captured_after_ms)
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            None,
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send final capture after shell_ready failed"
                        );
                        (None, readiness, None, None, None, None)
                    }
                }
            }
            "changed" => {
                let wait_result = self
                    .wait_for_screen_state(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        baseline_capture
                            .as_ref()
                            .map(|state| state.capture.as_str()),
                        delta_start_line,
                    )
                    .await?;
                let delta = build_additive_delta_payload(
                    baseline_capture
                        .as_ref()
                        .map(|state| state.capture.as_str()),
                    &wait_result.capture,
                );

                (
                    Some(delta),
                    wait_result.assessment,
                    Some(wait_result.capture),
                    Some(wait_result.summary),
                    Some(wait_result.captured_after_ms),
                    None,
                )
            }
            "settled" | "screen_stable" => {
                let quiescence = self
                    .wait_for_output_quiescence(
                        &handle,
                        request_id,
                        timeout_ms,
                        dispatch_completed_at,
                        start_offset,
                    )
                    .await?;

                match self
                    .capture_screen_state(
                        &handle.session_name,
                        delta_start_line,
                        quiescence.elapsed_ms,
                    )
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        let readiness =
                            self.build_quiescence_assessment(&current.capture, &quiescence);
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            Some(quiescence),
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send final capture after output quiescence failed"
                        );
                        let readiness = self.build_quiescence_assessment("", &quiescence);
                        (None, readiness, None, None, None, Some(quiescence))
                    }
                }
            }
            _ => return self.send_send_error(&frame, "unsupported_wait_for").await,
        };

        if let Some(current_capture) = current_capture.as_deref() {
            self.store_delivered_capture(session_id, current_capture, delta_start_line)
                .await;
        }

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_send_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": request_id,
            "submitted": submitted,
            "delta": delta
                .as_ref()
                .map(build_delta_payload_json)
                .unwrap_or(Value::Null),
            "readiness": readiness,
            "error": Value::Null,
        });
        send_ws_frame(&sender, payload)?;

        info!(
            request_id = request_id,
            session_id = session_id,
            wait_for = wait_for,
            observe_after_ms = observe_after_ms,
            submitted = submitted,
            key_count = keys.len(),
            has_text = text.is_some(),
            delta_changed = ?delta.as_ref().map(|value| value.changed),
            delta_truncated = ?delta.as_ref().map(|value| value.truncated),
            delta_strategy = ?delta.as_ref().map(|value| value.strategy),
            delta_text_bytes = ?delta.as_ref().map(|value| value.text.as_bytes().len()),
            captured_after_ms = ?captured_after_ms,
            quiescence_trigger = ?quiescence_wait.as_ref().map(|value| value.trigger),
            quiescence_output_seen = ?quiescence_wait.as_ref().map(|value| value.output_seen),
            quiescence_checks = ?quiescence_wait.as_ref().map(|value| value.check_count),
            quiescence_stable_checks = ?quiescence_wait.as_ref().map(|value| value.stable_checks),
            quiescence_quiet_for_ms = ?quiescence_wait.as_ref().map(|value| value.quiet_for_ms),
            quiescence_latest_offset = ?quiescence_wait.as_ref().map(|value| value.latest_offset),
            quiescence_last_output_seq = ?quiescence_wait.as_ref().map(|value| value.last_output_seq),
            capture_hash = ?current_summary
                .as_ref()
                .map(|summary| format!("{:016x}", summary.hash)),
            capture_line_count = ?current_summary.as_ref().map(|summary| summary.line_count),
            last_non_empty_line = current_summary
                .as_ref()
                .map(|summary| summary.last_non_empty_line.as_str())
                .unwrap_or(""),
            preview_head = ?current_summary
                .as_ref()
                .and_then(|summary| summary.preview_head.as_deref()),
            preview_tail = ?current_summary
                .as_ref()
                .and_then(|summary| summary.preview_tail.as_deref()),
            "terminal_send_result sent"
        );

        Ok(())
    }

    async fn send_send_error(&self, frame: &TerminalSendFrame, error: &str) -> Result<()> {
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = %frame.request_id,
                error = error,
                "terminal_send error but no sender"
            );
            return Ok(());
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_send_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": frame.session_id,
            "request_id": frame.request_id,
            "submitted": false,
            "delta": Value::Null,
            "readiness": Self::error_readiness(),
            "error": error,
        });
        send_ws_frame(&sender, payload)?;
        Ok(())
    }

    async fn send_observe_error(&self, frame: &TerminalObserveFrame, error: &str) -> Result<()> {
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = %frame.request_id,
                error = error,
                "terminal_observe error but no sender"
            );
            return Ok(());
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_observe_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": frame.session_id,
            "request_id": frame.request_id,
            "view": frame.view.as_deref().unwrap_or("delta"),
            "output": "",
            "output_bytes": 0,
            "lines_captured": 0,
            "changed": Value::Null,
            "truncated": Value::Null,
            "readiness": Self::error_readiness(),
            "error": error,
        });
        send_ws_frame(&sender, payload)?;
        Ok(())
    }

    fn error_readiness() -> Value {
        json!({
            "ready": false,
            "confidence": 0.0,
            "trigger": "error",
            "hints": {
                "looks_like_prompt": false,
                "looks_like_confirmation": false,
                "looks_like_password": false,
                "looks_like_pager": false,
                "looks_like_error": true,
                "may_still_be_processing": false
            }
        })
    }

    async fn get_delivered_capture(
        &self,
        session_id: &str,
        start_line: Option<i32>,
    ) -> Option<String> {
        let inner = self.inner.lock().await;
        inner
            .delivered_captures
            .get(session_id)
            .filter(|state| state.start_line == start_line)
            .map(|state| state.capture.clone())
    }

    async fn store_delivered_capture(
        &self,
        session_id: &str,
        capture: &str,
        start_line: Option<i32>,
    ) {
        let mut inner = self.inner.lock().await;
        inner.delivered_captures.insert(
            session_id.to_string(),
            DeliveredCaptureState {
                capture: capture.to_string(),
                start_line,
            },
        );
    }

    async fn dispatch_interaction_to_backend(
        &self,
        handle: &Arc<TerminalHandle>,
        text: Option<&str>,
        submit: bool,
        keys: &[String],
    ) -> Result<bool> {
        let mut submitted = false;

        if let Some(text) = text {
            submitted |= self
                .send_text_payload_to_backend(&handle.session_name, text, submit)
                .await?;
        } else if submit {
            self.backend.send_key(&handle.session_name, "Enter").await?;
            submitted = true;
        }

        for key in keys {
            submitted |= self.send_interaction_key(&handle.session_name, key).await?;
        }

        Ok(submitted)
    }

    async fn send_text_payload_to_backend(
        &self,
        session_name: &str,
        text: &str,
        submit: bool,
    ) -> Result<bool> {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let segments: Vec<&str> = normalized.split('\n').collect();
        let mut submitted = false;
        let mut sent_literal_text = false;

        for (index, segment) in segments.iter().enumerate() {
            if !segment.is_empty() {
                self.backend
                    .send_literal_text(session_name, segment)
                    .await?;
                submitted = true;
                sent_literal_text = true;
            }

            let should_press_enter =
                index + 1 < segments.len() || (submit && index + 1 == segments.len());
            if should_press_enter {
                if sent_literal_text {
                    time::sleep(Duration::from_millis(TMUX_TEXT_TO_ENTER_DELAY_MS)).await;
                    sent_literal_text = false;
                }
                self.backend.send_key(session_name, "Enter").await?;
                submitted = true;
            }
        }

        if normalized.is_empty() && submit {
            self.backend.send_key(session_name, "Enter").await?;
            submitted = true;
        }

        Ok(submitted)
    }

    async fn send_interaction_key(&self, session_name: &str, key: &str) -> Result<bool> {
        if let Some(tmux_key) = normalize_tmux_key_notation(key) {
            self.backend.send_key(session_name, &tmux_key).await?;
            return Ok(true);
        }

        let normalized = key.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Ok(false);
        }

        match normalized.as_str() {
            "enter" | "return" => {
                self.backend.send_key(session_name, "Enter").await?;
                Ok(true)
            }
            "space" | "spacebar" => {
                self.backend.send_literal_text(session_name, " ").await?;
                Ok(true)
            }
            "tab" => {
                self.backend.send_key(session_name, "Tab").await?;
                Ok(true)
            }
            "escape" | "esc" => {
                self.backend.send_key(session_name, "Escape").await?;
                Ok(true)
            }
            "up" | "arrowup" => {
                self.backend.send_key(session_name, "Up").await?;
                Ok(true)
            }
            "down" | "arrowdown" => {
                self.backend.send_key(session_name, "Down").await?;
                Ok(true)
            }
            "left" | "arrowleft" => {
                self.backend.send_key(session_name, "Left").await?;
                Ok(true)
            }
            "right" | "arrowright" => {
                self.backend.send_key(session_name, "Right").await?;
                Ok(true)
            }
            "backspace" => {
                self.backend.send_key(session_name, "BSpace").await?;
                Ok(true)
            }
            "delete" => {
                self.backend.send_key(session_name, "DC").await?;
                Ok(true)
            }
            "home" => {
                self.backend.send_key(session_name, "Home").await?;
                Ok(true)
            }
            "end" => {
                self.backend.send_key(session_name, "End").await?;
                Ok(true)
            }
            "pageup" => {
                self.backend.send_key(session_name, "PageUp").await?;
                Ok(true)
            }
            "pagedown" => {
                self.backend.send_key(session_name, "PageDown").await?;
                Ok(true)
            }
            _ if key.chars().count() == 1 => {
                self.backend.send_literal_text(session_name, key).await?;
                Ok(true)
            }
            _ => bail!("unsupported interaction key: {key}"),
        }
    }

    async fn resolve_readiness_after_interaction(
        &self,
        handle: &Arc<TerminalHandle>,
        request_id: &str,
        wait_for: &str,
        timeout_ms: u64,
        start_offset: u64,
    ) -> Result<Value> {
        info!(
            request_id = request_id,
            session_id = %handle.session_id,
            session = %handle.session_name,
            wait_for = wait_for,
            timeout_ms = timeout_ms,
            start_offset = start_offset,
            "resolving readiness after interaction"
        );

        let wait_start = Instant::now();
        let assessment = match wait_for {
            "shell_ready" => {
                let (assessment, _, _, _) = self
                    .wait_quiescence_and_read(handle, start_offset, timeout_ms)
                    .await?;
                assessment
            }
            "changed" => {
                self.wait_for_screen_state(handle, request_id, wait_for, timeout_ms, None, None)
                    .await?
                    .assessment
            }
            "settled" | "screen_stable" => {
                let (assessment, _, _, _) = self
                    .wait_activity_and_capture(handle, request_id, timeout_ms)
                    .await?;
                assessment
            }
            "none" => {
                let capture = self.capture(&handle.session_name).await?;
                assess_capture_readiness(&capture)
            }
            _ => bail!("unsupported wait_for mode: {wait_for}"),
        };

        info!(
            request_id = request_id,
            session_id = %handle.session_id,
            session = %handle.session_name,
            wait_for = wait_for,
            elapsed_ms = wait_start.elapsed().as_millis() as u64,
            readiness_trigger = assessment
                .get("trigger")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            readiness_confidence = assessment
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0),
            "readiness resolution complete"
        );

        Ok(assessment)
    }

    async fn wait_quiescence_and_read(
        &self,
        handle: &Arc<TerminalHandle>,
        start_offset: u64,
        timeout_ms: u64,
    ) -> Result<(Value, Vec<u8>, usize, bool)> {
        const MAX_OUTPUT: usize = 64 * 1024;
        let quiescence_ms = 1500;
        let start = Instant::now();
        let mut last_change = Instant::now();
        let mut last_size = handle.offset.load(Ordering::SeqCst);
        let log_path = handle.log_path.clone();

        loop {
            let size = match fs::metadata(&log_path).await {
                Ok(meta) => meta.len(),
                Err(_) => {
                    time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if size != last_size {
                last_change = Instant::now();
                last_size = size;
            }
            if last_change.elapsed() >= Duration::from_millis(quiescence_ms)
                || start.elapsed() >= Duration::from_millis(timeout_ms)
            {
                break;
            }
            time::sleep(Duration::from_millis(50)).await;
        }

        let end_size = fs::metadata(&log_path)
            .await
            .map(|m| m.len())
            .unwrap_or(last_size);

        let (output, truncated) =
            read_log_range(&log_path, start_offset, end_size, MAX_OUTPUT).await;
        let output_bytes = output.len();
        let text = String::from_utf8_lossy(&output).to_string();
        let last_line = text.lines().last().unwrap_or("").to_string();
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let assessment = ReadinessDetector::assess(&text, &last_line, quiet_for_ms, elapsed_ms);

        Ok((assessment, output, output_bytes, truncated))
    }

    async fn wait_activity_and_capture(
        &self,
        handle: &Arc<TerminalHandle>,
        request_id: &str,
        timeout_ms: u64,
    ) -> Result<(Value, Vec<u8>, usize, bool)> {
        let wait_result = self
            .wait_for_screen_state(handle, request_id, "settled", timeout_ms, None, None)
            .await?;
        let output = wait_result.capture.into_bytes();
        let output_bytes = output.len();
        Ok((wait_result.assessment, output, output_bytes, false))
    }

    async fn wait_for_output_quiescence(
        &self,
        handle: &Arc<TerminalHandle>,
        request_id: &str,
        timeout_ms: u64,
        started_at_ms: u64,
        start_offset: u64,
    ) -> Result<OutputQuiescenceWaitResult> {
        let started_at = Instant::now();
        let mut previous_offset = handle.offset.load(Ordering::SeqCst);
        let mut check_count: u32 = 0;
        let mut stable_checks: u32 = 0;

        if self.config.debug_enabled {
            info!(
                request_id = request_id,
                session_id = %handle.session_id,
                session = %handle.session_name,
                timeout_ms = timeout_ms,
                poll_interval_ms = OUTPUT_QUIESCENCE_POLL_INTERVAL_MS,
                required_stable_samples = OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES,
                quiet_ms = OUTPUT_QUIESCENCE_QUIET_MS,
                start_offset = start_offset,
                "output quiescence wait started"
            );
        }

        loop {
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            let current_offset = handle.offset.load(Ordering::SeqCst);
            let output_seen = current_offset > start_offset;
            let last_output_at = handle.last_output_at.load(Ordering::SeqCst);
            let quiet_reference_ms = if output_seen || last_output_at > started_at_ms {
                last_output_at.max(started_at_ms)
            } else {
                started_at_ms
            };
            let quiet_for_ms = now_millis().saturating_sub(quiet_reference_ms);
            let last_output_seq = handle.last_output_seq.load(Ordering::SeqCst);

            if elapsed_ms >= timeout_ms {
                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        output_seen = output_seen,
                        latest_offset = current_offset,
                        last_output_seq = last_output_seq,
                        "output quiescence wait timed out"
                    );
                }

                return Ok(OutputQuiescenceWaitResult {
                    trigger: "timeout",
                    quiet_for_ms,
                    elapsed_ms,
                    check_count,
                    stable_checks,
                    output_seen,
                    latest_offset: current_offset,
                    last_output_seq,
                });
            }

            let sleep_ms =
                OUTPUT_QUIESCENCE_POLL_INTERVAL_MS.min(timeout_ms.saturating_sub(elapsed_ms));
            if sleep_ms > 0 {
                time::sleep(Duration::from_millis(sleep_ms)).await;
            }

            let current_offset = handle.offset.load(Ordering::SeqCst);
            check_count += 1;
            if current_offset == previous_offset {
                stable_checks += 1;
            } else {
                stable_checks = 0;
                previous_offset = current_offset;
            }

            let output_seen = current_offset > start_offset;
            let last_output_at = handle.last_output_at.load(Ordering::SeqCst);
            let quiet_reference_ms = if output_seen || last_output_at > started_at_ms {
                last_output_at.max(started_at_ms)
            } else {
                started_at_ms
            };
            let quiet_for_ms = now_millis().saturating_sub(quiet_reference_ms);
            let last_output_seq = handle.last_output_seq.load(Ordering::SeqCst);
            let elapsed_ms = started_at.elapsed().as_millis() as u64;

            if self.config.debug_enabled {
                info!(
                    request_id = request_id,
                    session_id = %handle.session_id,
                    session = %handle.session_name,
                    check_count = check_count,
                    stable_checks = stable_checks,
                    quiet_for_ms = quiet_for_ms,
                    output_seen = output_seen,
                    latest_offset = current_offset,
                    last_output_seq = last_output_seq,
                    "output quiescence wait check"
                );
            }

            if stable_checks >= OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES
                && quiet_for_ms >= OUTPUT_QUIESCENCE_QUIET_MS
            {
                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        output_seen = output_seen,
                        latest_offset = current_offset,
                        last_output_seq = last_output_seq,
                        "output quiescence wait settled"
                    );
                }

                return Ok(OutputQuiescenceWaitResult {
                    trigger: "settled",
                    quiet_for_ms,
                    elapsed_ms,
                    check_count,
                    stable_checks,
                    output_seen,
                    latest_offset: current_offset,
                    last_output_seq,
                });
            }
        }
    }

    fn build_quiescence_assessment(
        &self,
        capture: &str,
        quiescence: &OutputQuiescenceWaitResult,
    ) -> Value {
        match quiescence.trigger {
            "settled" => build_screen_wait_assessment(
                capture,
                "settled",
                quiescence.quiet_for_ms,
                quiescence.check_count,
                quiescence.stable_checks,
                Some(false),
                None,
                Some(0.85),
                Some(true),
            ),
            "timeout" => build_screen_wait_assessment(
                capture,
                "timeout",
                quiescence.quiet_for_ms,
                quiescence.check_count,
                quiescence.stable_checks,
                Some(true),
                Some(0.4),
                None,
                Some(false),
            ),
            _ => assess_capture_readiness(capture),
        }
    }

    async fn capture(&self, session_name: &str) -> Result<String> {
        self.capture_with_lines(session_name, None).await
    }

    async fn capture_with_lines(
        &self,
        session_name: &str,
        start_line: Option<i32>,
    ) -> Result<String> {
        self.backend
            .capture_pane_with_lines(session_name, start_line)
            .await
    }

    async fn capture_screen_state(
        &self,
        session_name: &str,
        start_line: Option<i32>,
        captured_after_ms: u64,
    ) -> Result<ScreenCaptureState> {
        let capture = self.capture_with_lines(session_name, start_line).await?;
        let summary = summarize_capture_for_log(&capture, self.config.debug_enabled);
        Ok(ScreenCaptureState {
            capture,
            summary,
            captured_after_ms,
        })
    }

    async fn wait_for_screen_state(
        &self,
        handle: &Arc<TerminalHandle>,
        request_id: &str,
        wait_for: &str,
        timeout_ms: u64,
        baseline_capture: Option<&str>,
        start_line: Option<i32>,
    ) -> Result<ScreenWaitResult> {
        let mode = parse_screen_wait_mode(wait_for)?;
        if mode == ScreenWaitMode::None {
            let current = self
                .capture_screen_state(&handle.session_name, start_line, 0)
                .await?;
            return Ok(ScreenWaitResult {
                assessment: assess_capture_readiness(&current.capture),
                capture: current.capture,
                summary: current.summary,
                captured_after_ms: current.captured_after_ms,
            });
        }

        let baseline = match baseline_capture {
            Some(existing) => ScreenCaptureState {
                capture: existing.to_string(),
                summary: summarize_capture_for_log(existing, self.config.debug_enabled),
                captured_after_ms: 0,
            },
            None => {
                self.capture_screen_state(&handle.session_name, start_line, 0)
                    .await?
            }
        };

        let started_at = Instant::now();
        let baseline_hash = baseline.summary.hash;
        let mut last_summary = baseline.summary.clone();
        let mut final_state = baseline;
        let mut last_change_at = started_at;
        let mut changed_since_baseline = false;
        let mut check_count = 0;
        let mut stable_checks = 0;

        if self.config.debug_enabled {
            info!(
                request_id = request_id,
                session_id = %handle.session_id,
                session = %handle.session_name,
                wait_for = wait_for,
                timeout_ms = timeout_ms,
                interval_ms = SCREEN_WAIT_POLL_INTERVAL_MS,
                quiet_ms = SCREEN_WAIT_SETTLED_QUIET_MS,
                baseline_hash = format!("{:016x}", final_state.summary.hash),
                baseline_line_count = final_state.summary.line_count,
                baseline_last_non_empty_line = %final_state.summary.last_non_empty_line,
                preview_head = ?final_state.summary.preview_head.as_deref(),
                preview_tail = ?final_state.summary.preview_tail.as_deref(),
                "screen wait started"
            );
        }

        loop {
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            if elapsed_ms >= timeout_ms {
                let quiet_for_ms = last_change_at.elapsed().as_millis() as u64;
                let (may_still_be_processing, confidence_override, ready_override) = match mode {
                    ScreenWaitMode::Changed => (Some(false), Some(0.35), Some(false)),
                    ScreenWaitMode::Settled => (Some(true), Some(0.4), Some(false)),
                    ScreenWaitMode::None => (None, None, None),
                };
                let assessment = build_screen_wait_assessment(
                    &final_state.capture,
                    "timeout",
                    quiet_for_ms,
                    check_count,
                    stable_checks,
                    may_still_be_processing,
                    confidence_override,
                    None,
                    ready_override,
                );

                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        wait_for = wait_for,
                        timeout_ms = timeout_ms,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        changed_since_baseline = changed_since_baseline,
                        final_hash = format!("{:016x}", final_state.summary.hash),
                        final_last_non_empty_line = %final_state.summary.last_non_empty_line,
                        "screen wait timed out"
                    );
                }

                return Ok(ScreenWaitResult {
                    assessment,
                    capture: final_state.capture,
                    summary: final_state.summary,
                    captured_after_ms: final_state.captured_after_ms,
                });
            }

            let sleep_ms = SCREEN_WAIT_POLL_INTERVAL_MS.min(timeout_ms.saturating_sub(elapsed_ms));
            if sleep_ms > 0 {
                time::sleep(Duration::from_millis(sleep_ms)).await;
            }

            let current = self
                .capture_screen_state(
                    &handle.session_name,
                    start_line,
                    started_at.elapsed().as_millis() as u64,
                )
                .await?;
            check_count += 1;

            let changed_from_previous = current.summary.hash != last_summary.hash;
            let changed_from_baseline = current.summary.hash != baseline_hash;

            if changed_from_baseline {
                changed_since_baseline = true;
            }

            if changed_from_previous {
                last_change_at = Instant::now();
                stable_checks = 0;
            } else {
                stable_checks += 1;
            }

            let quiet_for_ms = last_change_at.elapsed().as_millis() as u64;

            if self.config.debug_enabled {
                info!(
                    request_id = request_id,
                    session_id = %handle.session_id,
                    session = %handle.session_name,
                    wait_for = wait_for,
                    check_count = check_count,
                    stable_checks = stable_checks,
                    changed_from_previous = changed_from_previous,
                    changed_from_baseline = changed_from_baseline,
                    changed_since_baseline = changed_since_baseline,
                    captured_after_ms = current.captured_after_ms,
                    quiet_for_ms = quiet_for_ms,
                    screen_hash = format!("{:016x}", current.summary.hash),
                    line_count = current.summary.line_count,
                    last_non_empty_line = %current.summary.last_non_empty_line,
                    preview_head = ?current.summary.preview_head.as_deref(),
                    preview_tail = ?current.summary.preview_tail.as_deref(),
                    "screen wait capture check"
                );
            }

            match mode {
                ScreenWaitMode::Changed if changed_from_baseline => {
                    let assessment = build_screen_wait_assessment(
                        &current.capture,
                        "changed",
                        quiet_for_ms,
                        check_count,
                        stable_checks,
                        Some(true),
                        None,
                        Some(0.6),
                        Some(true),
                    );

                    return Ok(ScreenWaitResult {
                        assessment,
                        capture: current.capture,
                        summary: current.summary,
                        captured_after_ms: current.captured_after_ms,
                    });
                }
                ScreenWaitMode::Settled if quiet_for_ms >= SCREEN_WAIT_SETTLED_QUIET_MS => {
                    let assessment = build_screen_wait_assessment(
                        &current.capture,
                        "settled",
                        quiet_for_ms,
                        check_count,
                        stable_checks,
                        Some(false),
                        None,
                        Some(0.85),
                        Some(true),
                    );

                    return Ok(ScreenWaitResult {
                        assessment,
                        capture: current.capture,
                        summary: current.summary,
                        captured_after_ms: current.captured_after_ms,
                    });
                }
                _ => {
                    last_summary = current.summary.clone();
                    final_state = current;
                }
            }
        }
    }

    async fn send_status(
        &self,
        sender: &OutboundSender,
        session_id: &str,
        state: &str,
        info: Option<Value>,
    ) -> Result<()> {
        let handle_snapshot = {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .get(session_id)
                .map(|handle| TerminalStatusSnapshot {
                    session_name: handle.session_name.clone(),
                    cols: handle.cols,
                    rows: handle.rows,
                    output_log_bytes: handle.offset.load(Ordering::SeqCst),
                    pid: handle.pid,
                    cwd: handle.cwd.clone(),
                })
        };

        let payload = build_terminal_status_payload(session_id, state, info, handle_snapshot);
        send_ws_frame(sender, payload)
    }

    async fn ensure_handle_for_session(
        &self,
        session_id: &str,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        {
            let inner = self.inner.lock().await;
            if let Some(handle) = inner.sessions.get(session_id) {
                return Ok(Some(handle.clone()));
            }
        }

        let ensured = self.ensure_terminal_session(session_id, cfg).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner
                .sessions
                .insert(session_id.to_string(), handle.clone());
            return Ok(Some(handle));
        }
        Ok(None)
    }

    async fn ensure_terminal_session(
        &self,
        session_id: &str,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        if !self.config.tmux_available {
            return Ok(None);
        }
        let cfg = cfg.unwrap_or_default();
        let session_name = self.backend.session_name(session_id);
        let log_path = self.backend.log_path(session_id);
        let session_env = build_terminal_session_env(cfg.env);
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).await.ok();
        }
        let mut cols = cfg.cols.unwrap_or(self.config.cols);
        let mut rows = cfg.rows.unwrap_or(self.config.rows);
        if cols == 0 {
            cols = 200;
        }
        if rows == 0 {
            rows = 50;
        }
        let shell = cfg.shell.unwrap_or_else(|| self.config.shell.clone());
        let cwd = cfg.cwd.unwrap_or_else(|| "~".to_string());

        let session_exists = self.backend.session_exists(&session_name).await;
        if !session_exists {
            info!(
                session_id = session_id,
                session_name = %session_name,
                "creating new tmux session"
            );
            if self
                .backend
                .create_session(&session_name, cols, rows, &cwd, &shell, &session_env)
                .await
                .is_err()
            {
                warn!(session_id = session_id, session_name = %session_name, "tmux new-session failed");
                return Ok(None);
            }

            let _ = self.backend.set_history_limit(&session_name, 5000).await;
        } else {
            info!(
                session_id = session_id,
                session_name = %session_name,
                "reattaching to existing tmux session"
            );
        }

        match self.backend.reset_pipe(&session_name, &log_path).await {
            Ok(true) => {
                info!(session_id = session_id, session_name = %session_name, "tmux pipe-pane established");
            }
            Ok(false) => {
                warn!(session_id = session_id, session_name = %session_name, "tmux pipe-pane failed");
            }
            Err(err) => {
                warn!(session_id = session_id, session_name = %session_name, error = %err, "tmux pipe-pane command failed");
            }
        }

        let metadata = fs::metadata(&log_path).await.ok();
        let start_offset = metadata.map(|m| m.len()).unwrap_or(0);
        let pid = self.backend.pane_pid(&session_name).await.ok();
        let cwd_reported = self.backend.pane_cwd(&session_name).await.ok();
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let sender = match sender {
            Some(s) => s,
            None => return Ok(None),
        };
        let seq = Arc::new(AtomicU64::new(0));
        let offset = Arc::new(AtomicU64::new(start_offset));
        let last_output_at = Arc::new(AtomicU64::new(now_millis()));
        let last_output_seq = Arc::new(AtomicU64::new(0));
        let watcher = self.backend.spawn_output_watcher(
            session_id.to_string(),
            session_name.clone(),
            log_path.clone(),
            sender.clone(),
            seq.clone(),
            offset.clone(),
            last_output_at.clone(),
            last_output_seq.clone(),
        );
        let handle = Arc::new(TerminalHandle {
            session_id: session_id.to_string(),
            session_name,
            log_path,
            pid,
            cwd: cwd_reported.clone(),
            watcher,
            seq,
            offset,
            last_output_at,
            last_output_seq,
            cols,
            rows,
        });
        let info = json!({
            "tmux_session": handle.session_name,
            "pid": pid,
            "cwd": cwd_reported,
            "cols": handle.cols,
            "rows": handle.rows,
            "output_log_bytes": start_offset,
        });
        let _ = self
            .send_status(&sender, session_id, "ready", Some(info))
            .await;
        Ok(Some(handle))
    }
}

impl ReadinessDetector {
    fn new(
        session_id: String,
        handle: Arc<TerminalHandle>,
        sender: OutboundSender,
        start_offset: u64,
        await_ready: Option<AwaitReady>,
    ) -> Self {
        Self {
            session_id,
            handle,
            sender,
            start_offset,
            await_ready,
        }
    }

    async fn run(self) -> Result<()> {
        let quiescence_ms = self
            .await_ready
            .as_ref()
            .and_then(|a| a.quiescence_ms)
            .unwrap_or(1500);
        let max_wait_ms = self
            .await_ready
            .as_ref()
            .and_then(|a| a.max_wait_ms)
            .unwrap_or(30_000);
        let start = Instant::now();
        let mut last_change = Instant::now();
        let mut last_size = self.handle.offset.load(Ordering::SeqCst);
        let log_path = self.handle.log_path.clone();
        loop {
            let size = match fs::metadata(&log_path).await {
                Ok(meta) => meta.len(),
                Err(_) => {
                    time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if size != last_size {
                last_change = Instant::now();
                last_size = size;
            }
            if last_change.elapsed() >= Duration::from_millis(quiescence_ms)
                || start.elapsed() >= Duration::from_millis(max_wait_ms)
            {
                break;
            }
            time::sleep(Duration::from_millis(50)).await;
        }

        let end_size = match fs::metadata(&log_path).await {
            Ok(meta) => meta.len(),
            Err(_) => last_size,
        };
        let (output, last_line) = self.read_tail(end_size).await;
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let assessment = Self::assess(
            &output,
            &last_line,
            quiet_for_ms,
            start.elapsed().as_millis() as u64,
        );
        self.send_ready(&assessment)?;
        Ok(())
    }

    async fn read_tail(&self, end_size: u64) -> (String, String) {
        read_log_tail(&self.handle.log_path, self.start_offset, end_size).await
    }

    fn assess(output: &str, last_line: &str, quiet_for_ms: u64, elapsed_ms: u64) -> Value {
        let (prompt_type, prompt_conf, prompt_hints) = Self::detect_prompt(last_line);
        if let Some((ptype, conf)) = prompt_type.zip(prompt_conf) {
            return json!({
                "ready": true,
                "confidence": conf,
                "trigger": "prompt_detected",
                "prompt_type": ptype,
                "hints": prompt_hints,
                "quiet_for_ms": quiet_for_ms,
            });
        }
        let mut confidence: f32 = 0.5;
        let trimmed = last_line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.ends_with('$')
            || trimmed.ends_with('#')
            || trimmed.ends_with('>')
            || trimmed.ends_with('%')
        {
            confidence += 0.25;
        }
        if trimmed.len() < 60 {
            confidence += 0.1;
        }
        if !trimmed.contains(' ') {
            confidence += 0.1;
        }
        if !trimmed.is_empty() && !trimmed.ends_with('\n') {
            confidence += 0.05;
        }
        if trimmed.len() > 150 {
            confidence -= 0.2;
        }
        if output.contains("%") && output.to_lowercase().contains("eta") {
            confidence -= 0.15;
        }
        if Self::looks_like_progress(output) {
            confidence -= 0.1;
        }
        if quiet_for_ms < 500 {
            confidence -= 0.1;
        }
        let ready = confidence >= 0.55;
        let trigger = if elapsed_ms >= 30_000 {
            "timeout"
        } else {
            "quiescence"
        };
        json!({
            "ready": ready,
            "confidence": confidence.clamp(0.0, 1.0),
            "trigger": trigger,
            "hints": {
                "looks_like_prompt": false,
                "looks_like_confirmation": false,
                "looks_like_password": false,
                "looks_like_pager": false,
                "looks_like_error": output.to_lowercase().contains("error"),
                "may_still_be_processing": !ready
            },
            "quiet_for_ms": quiet_for_ms,
        })
    }

    fn detect_prompt(last_line: &str) -> (Option<&'static str>, Option<f64>, Value) {
        let line = last_line.trim();
        if line.is_empty() {
            return (None, None, Self::hints_none());
        }
        let lower = line.to_lowercase();
        if line.ends_with('$') || line.ends_with('#') || line.ends_with('%') || line.contains(":~$")
        {
            return (Some("shell"), Some(0.95), Self::hints_prompt());
        }
        if line.starts_with(">>>") || line.starts_with("...") || line.starts_with("In [") {
            return (Some("python"), Some(0.95), Self::hints_prompt());
        }
        if line == ">" {
            return (Some("node"), Some(0.85), Self::hints_prompt());
        }
        if line.contains("[y/n]")
            || line.contains("[Y/n]")
            || lower.contains("yes/no")
            || lower.contains("continue?")
            || lower.contains("(yes/no)")
        {
            return (
                Some("confirmation"),
                Some(0.95),
                json!({
                    "looks_like_prompt": true,
                    "looks_like_confirmation": true,
                    "looks_like_password": false,
                    "looks_like_pager": false,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if lower.ends_with("password:") || lower.contains("passphrase") {
            return (
                Some("password"),
                Some(0.95),
                json!({
                    "looks_like_prompt": false,
                    "looks_like_confirmation": false,
                    "looks_like_password": true,
                    "looks_like_pager": false,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if line == ":" || line == "(END)" || line.starts_with("--More--") {
            return (
                Some("pager"),
                Some(0.9),
                json!({
                    "looks_like_prompt": false,
                    "looks_like_confirmation": false,
                    "looks_like_password": false,
                    "looks_like_pager": true,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if lower.ends_with("mysql>")
            || lower.ends_with("postgres=#")
            || lower.ends_with("postgres=>")
            || lower.ends_with("sqlite>")
        {
            return (Some("database"), Some(0.95), Self::hints_prompt());
        }
        (None, None, Self::hints_none())
    }

    fn hints_prompt() -> Value {
        json!({
            "looks_like_prompt": true,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": false
        })
    }

    fn hints_none() -> Value {
        json!({
            "looks_like_prompt": false,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": true
        })
    }

    fn looks_like_progress(output: &str) -> bool {
        let lower = output.to_lowercase();
        lower.contains("eta")
            || lower.contains('%')
            || lower.contains("download")
            || lower.contains("fetching")
            || lower.contains("progress")
            || lower.contains("completed")
    }

    fn send_ready(&self, assessment: &Value) -> Result<()> {
        let frame = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": &self.session_id,
            "assessment": assessment,
        });
        send_ws_frame(&self.sender, frame)?;
        Ok(())
    }
}

impl ActivityDetector {
    fn new(
        session_id: String,
        handle: Arc<TerminalHandle>,
        sender: OutboundSender,
        backend: TmuxBackend,
        await_ready: &AwaitReady,
    ) -> Self {
        Self {
            session_id,
            handle,
            sender,
            backend,
            initial_delay_ms: await_ready
                .activity_initial_delay_ms
                .unwrap_or(ACTIVITY_DEFAULT_INITIAL_DELAY_MS),
            interval_ms: await_ready
                .activity_interval_ms
                .unwrap_or(ACTIVITY_DEFAULT_INTERVAL_MS),
            stable_count_required: await_ready
                .activity_stable_count
                .unwrap_or(ACTIVITY_DEFAULT_STABLE_COUNT),
            max_wait_ms: await_ready
                .max_wait_ms
                .unwrap_or(ACTIVITY_DEFAULT_MAX_WAIT_MS),
        }
    }

    async fn run(self) -> Result<()> {
        let start = Instant::now();
        let mut last_hash: Option<u64> = None;
        let mut stable_count: u32 = 0;
        let mut check_count: u32 = 0;

        info!(
            session_id = %self.session_id,
            session = %self.handle.session_name,
            initial_delay_ms = self.initial_delay_ms,
            interval_ms = self.interval_ms,
            stable_count_required = self.stable_count_required,
            max_wait_ms = self.max_wait_ms,
            "activity detection started"
        );

        time::sleep(Duration::from_millis(self.initial_delay_ms)).await;

        loop {
            if start.elapsed() >= Duration::from_millis(self.max_wait_ms) {
                info!(
                    session_id = %self.session_id,
                    session = %self.handle.session_name,
                    check_count,
                    stable_count,
                    elapsed_ms = start.elapsed().as_millis(),
                    "activity detection timeout"
                );
                self.send_ready(0.5, "timeout", stable_count, check_count)
                    .await?;
                return Ok(());
            }

            let output = match self
                .backend
                .capture_pane_with_lines(&self.handle.session_name, None)
                .await
            {
                Ok(out) => out,
                Err(err) => {
                    warn!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        error = %err,
                        "capture-pane failed, retrying"
                    );
                    time::sleep(Duration::from_millis(self.interval_ms)).await;
                    continue;
                }
            };
            let current_hash = simple_hash(output.as_bytes());
            check_count += 1;

            match last_hash {
                Some(prev) if prev == current_hash => {
                    stable_count += 1;
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        stable_count,
                        required = self.stable_count_required,
                        "activity check: stable"
                    );

                    if stable_count >= self.stable_count_required {
                        info!(
                            session_id = %self.session_id,
                            session = %self.handle.session_name,
                            check_count,
                            stable_count,
                            elapsed_ms = start.elapsed().as_millis(),
                            "activity detection: ready (screen stable)"
                        );
                        self.send_ready(0.9, "activity_stable", stable_count, check_count)
                            .await?;
                        return Ok(());
                    }
                }
                Some(_) => {
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        prev_stable_count = stable_count,
                        "activity check: content changed"
                    );
                    stable_count = 0;
                }
                None => {
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        "activity check: first capture"
                    );
                }
            }

            last_hash = Some(current_hash);

            time::sleep(Duration::from_millis(self.interval_ms)).await;
        }
    }

    async fn send_ready(
        &self,
        confidence: f64,
        trigger: &str,
        stable_count: u32,
        check_count: u32,
    ) -> Result<()> {
        let readiness = json!({
            "ready": confidence >= 0.5,
            "confidence": confidence,
            "trigger": trigger,
            "hints": {
                "looks_like_prompt": false,
                "looks_like_confirmation": false,
                "looks_like_password": false,
                "looks_like_pager": false,
                "looks_like_error": false,
                "may_still_be_processing": confidence < 0.7
            },
            "activity_checks": check_count,
            "stable_checks": stable_count
        });
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": &self.session_id,
            "assessment": &readiness,
        });
        send_ws_frame(&self.sender, payload)?;

        Ok(())
    }
}

pub fn probe_tmux() -> (bool, Option<String>) {
    tmux_probe()
}

fn build_terminal_status_payload(
    session_id: &str,
    state: &str,
    info: Option<Value>,
    handle_snapshot: Option<TerminalStatusSnapshot>,
) -> Value {
    let mut payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_status",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": session_id,
        "state": state,
    });

    let mut info_map = match info {
        Some(Value::Object(obj)) => obj,
        _ => Map::new(),
    };

    if let Some(snapshot) = handle_snapshot {
        info_map.insert("tmux_session".into(), Value::String(snapshot.session_name));
        info_map.insert("cols".into(), Value::Number(Number::from(snapshot.cols)));
        info_map.insert("rows".into(), Value::Number(Number::from(snapshot.rows)));
        info_map.insert(
            "output_log_bytes".into(),
            Value::Number(Number::from(snapshot.output_log_bytes)),
        );
        if let Some(pid) = snapshot.pid {
            info_map.insert("pid".into(), Value::Number(Number::from(pid)));
        }
        if let Some(cwd) = snapshot.cwd {
            info_map.insert("cwd".into(), Value::String(cwd));
        }
    }

    if !info_map.is_empty() {
        if let Some(map) = payload.as_object_mut() {
            map.insert("info".into(), Value::Object(info_map));
        }
    }

    payload
}

fn simple_hash(data: &[u8]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

fn summarize_capture_for_log(content: &str, include_preview: bool) -> CaptureLogSummary {
    let lines: Vec<&str> = content.lines().collect();
    let line_count = lines.len();
    let last_non_empty_line = lines
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .copied()
        .unwrap_or_else(|| content.trim_end_matches(&['\r', '\n'][..]));

    CaptureLogSummary {
        hash: simple_hash(content.as_bytes()),
        line_count,
        last_non_empty_line: truncate_log_value(last_non_empty_line, 160),
        preview_head: include_preview.then(|| preview_lines(&lines, false)),
        preview_tail: include_preview.then(|| preview_lines(&lines, true)),
    }
}

fn preview_lines(lines: &[&str], from_end: bool) -> String {
    let preview_count = 2;
    let selected: Vec<&str> = if from_end {
        lines
            .iter()
            .rev()
            .take(preview_count)
            .copied()
            .collect::<Vec<&str>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        lines.iter().take(preview_count).copied().collect()
    };
    truncate_log_value(&selected.join(" | "), 240)
}

fn truncate_log_value(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<&str>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let truncated: String = normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect();
    format!("{truncated}...")
}

fn assess_capture_readiness(capture: &str) -> Value {
    let last_line = capture
        .lines()
        .last()
        .unwrap_or_else(|| capture.trim_end_matches(&['\r', '\n'][..]));
    ReadinessDetector::assess(capture, last_line, 0, 0)
}

fn tail_excerpt_from_lines(lines: &[&str], max_lines: usize) -> String {
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn is_low_signal_separator_line(line: &str) -> bool {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    if first.is_alphanumeric() || first.is_whitespace() {
        return false;
    }

    let mut count = 1;
    for ch in chars {
        if ch != first {
            return false;
        }
        count += 1;
    }

    count >= LOW_SIGNAL_SEPARATOR_MIN_RUN
}

fn strip_low_signal_delta_lines(text: &str) -> String {
    let filtered: Vec<&str> = text
        .lines()
        .filter(|line| !is_low_signal_separator_line(line))
        .collect();

    let Some(start) = filtered.iter().position(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let end = filtered
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .unwrap_or(start);

    filtered[start..=end].join("\n")
}

fn truncate_text_to_bytes(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }

    if max_bytes <= 3 {
        return ("...".chars().take(max_bytes).collect(), true);
    }

    let keep_bytes = max_bytes.saturating_sub(3);
    let mut start = text.len().saturating_sub(keep_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }

    (format!("...{}", &text[start..]), true)
}

fn common_prefix_line_count<'a>(baseline: &[&'a str], current: &[&'a str]) -> usize {
    let limit = baseline.len().min(current.len());
    let mut count = 0;
    while count < limit && baseline[count] == current[count] {
        count += 1;
    }
    count
}

fn common_suffix_line_count<'a>(baseline: &[&'a str], current: &[&'a str], prefix: usize) -> usize {
    let baseline_remaining = baseline.len().saturating_sub(prefix);
    let current_remaining = current.len().saturating_sub(prefix);
    let limit = baseline_remaining.min(current_remaining);
    let mut count = 0;
    while count < limit
        && baseline[baseline.len() - 1 - count] == current[current.len() - 1 - count]
    {
        count += 1;
    }
    count
}

fn build_additive_delta_payload(
    baseline_capture: Option<&str>,
    current_capture: &str,
) -> AdditiveDeltaPayload {
    let current_lines: Vec<&str> = current_capture.lines().collect();
    let tail_fallback = |strategy: &'static str, changed: bool| {
        let excerpt = tail_excerpt_from_lines(&current_lines, MAX_VISIBLE_DELTA_LINES);
        let normalized_excerpt = strip_low_signal_delta_lines(&excerpt);
        let (text, truncated) =
            truncate_text_to_bytes(&normalized_excerpt, MAX_VISIBLE_DELTA_BYTES);
        AdditiveDeltaPayload {
            changed,
            text,
            truncated,
            strategy,
        }
    };

    let Some(baseline_capture) = baseline_capture else {
        if current_capture.is_empty() {
            return AdditiveDeltaPayload {
                changed: false,
                text: String::new(),
                truncated: false,
                strategy: "no_baseline_empty",
            };
        }
        return tail_fallback("initial_tail", true);
    };

    if baseline_capture == current_capture {
        return AdditiveDeltaPayload {
            changed: false,
            text: String::new(),
            truncated: false,
            strategy: "unchanged",
        };
    }

    let baseline_lines: Vec<&str> = baseline_capture.lines().collect();
    let prefix = common_prefix_line_count(&baseline_lines, &current_lines);
    let suffix = common_suffix_line_count(&baseline_lines, &current_lines, prefix);

    let current_middle_end = current_lines.len().saturating_sub(suffix);
    let current_middle = if prefix <= current_middle_end {
        &current_lines[prefix..current_middle_end]
    } else {
        &[][..]
    };

    let append_like = prefix == baseline_lines.len() && current_lines.len() >= baseline_lines.len();
    let mut strategy = "tail_fallback";
    let candidate = if append_like {
        strategy = "novel_suffix";
        current_lines[prefix..].join("\n")
    } else if !current_middle.is_empty()
        && (prefix > 0 || suffix > 0)
        && current_middle.len() <= MAX_CHANGED_WINDOW_LINES
    {
        strategy = "changed_window";
        current_middle.join("\n")
    } else if prefix < current_lines.len() {
        let suffix_candidate = current_lines[prefix..].join("\n");
        if !suffix_candidate.trim().is_empty()
            && suffix_candidate.lines().count() <= MAX_CHANGED_WINDOW_LINES * 2
        {
            strategy = "suffix_fallback";
            suffix_candidate
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let candidate = strip_low_signal_delta_lines(&candidate);
    if candidate.trim().is_empty() && !current_capture.is_empty() {
        return tail_fallback("tail_fallback", true);
    }

    let (text, truncated) = truncate_text_to_bytes(&candidate, MAX_VISIBLE_DELTA_BYTES);
    AdditiveDeltaPayload {
        changed: true,
        text,
        truncated,
        strategy,
    }
}

fn build_delta_payload_json(delta: &AdditiveDeltaPayload) -> Value {
    json!({
        "changed": delta.changed,
        "text": delta.text,
        "truncated": delta.truncated,
    })
}

fn start_line_for_observe_view(view: &str, lines: i32) -> Option<i32> {
    match view {
        "screen" => None,
        "delta" | "history" => Some(lines),
        _ => Some(lines),
    }
}

fn parse_observe_view(view: &str) -> Result<&str> {
    match view {
        "delta" | "screen" | "history" => Ok(view),
        _ => bail!("unsupported_view"),
    }
}

fn parse_screen_wait_mode(wait_for: &str) -> Result<ScreenWaitMode> {
    match wait_for {
        "none" => Ok(ScreenWaitMode::None),
        "changed" => Ok(ScreenWaitMode::Changed),
        "settled" | "screen_stable" => Ok(ScreenWaitMode::Settled),
        _ => bail!("unsupported wait_for mode: {wait_for}"),
    }
}

fn normalize_tmux_key_notation(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("ctrl+")
        .or_else(|| lower.strip_prefix("ctrl-"))
        .or_else(|| lower.strip_prefix("control+"))
        .or_else(|| lower.strip_prefix("control-"))
    {
        if !rest.is_empty() {
            return Some(format!("C-{}", rest));
        }
    }

    if let Some(rest) = trimmed
        .strip_prefix("C-")
        .or_else(|| trimmed.strip_prefix("c-"))
    {
        if !rest.is_empty() {
            return Some(format!("C-{}", rest.to_ascii_lowercase()));
        }
    }

    None
}

fn set_json_number(map: &mut Map<String, Value>, key: &str, value: u64) {
    map.insert(key.to_string(), Value::Number(Number::from(value)));
}

fn build_screen_wait_assessment(
    capture: &str,
    trigger: &str,
    quiet_for_ms: u64,
    check_count: u32,
    stable_checks: u32,
    may_still_be_processing: Option<bool>,
    confidence_override: Option<f64>,
    confidence_floor: Option<f64>,
    ready_override: Option<bool>,
) -> Value {
    let mut assessment = assess_capture_readiness(capture);

    if let Some(map) = assessment.as_object_mut() {
        map.insert("trigger".into(), Value::String(trigger.to_string()));
        set_json_number(map, "quiet_for_ms", quiet_for_ms);
        if check_count > 0 {
            set_json_number(map, "activity_checks", check_count as u64);
        }
        if stable_checks > 0 {
            set_json_number(map, "stable_checks", stable_checks as u64);
        }

        if let Some(next) = confidence_override {
            if let Some(number) = Number::from_f64(next) {
                map.insert("confidence".into(), Value::Number(number));
            }
        } else if let Some(floor) = confidence_floor {
            let current = map
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let next = current.max(floor);
            if let Some(number) = Number::from_f64(next) {
                map.insert("confidence".into(), Value::Number(number));
            }
        }

        if let Some(ready) = ready_override {
            map.insert("ready".into(), Value::Bool(ready));
        }

        if let Some(processing) = may_still_be_processing {
            if let Some(hints) = map.get_mut("hints").and_then(|value| value.as_object_mut()) {
                hints.insert("may_still_be_processing".into(), Value::Bool(processing));
            }
        }
    }

    assessment
}

fn last_line_from_text(text: &str) -> String {
    text.lines()
        .last()
        .unwrap_or_else(|| text.trim_end_matches(&['\r', '\n'][..]))
        .to_string()
}

async fn read_log_tail(log_path: &Path, start_offset: u64, end_size: u64) -> (String, String) {
    const MAX_READ: usize = 16 * 1024;
    if end_size <= start_offset {
        return (String::new(), String::new());
    }
    let available = (end_size - start_offset) as usize;
    let to_read = std::cmp::min(available, MAX_READ);
    let mut buf = vec![0u8; to_read];
    if let Ok(mut file) = fs::File::open(log_path).await {
        let _ = file.seek(SeekFrom::Start(end_size - to_read as u64)).await;
        let _ = file.read_exact(&mut buf).await;
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let last_line_owned = last_line_from_text(&text);
    (text, last_line_owned)
}

async fn read_log_range(
    log_path: &Path,
    start: u64,
    end: u64,
    max_bytes: usize,
) -> (Vec<u8>, bool) {
    if end <= start {
        return (Vec::new(), false);
    }

    let total_bytes = (end - start) as usize;
    let truncated = total_bytes > max_bytes;
    let to_read = total_bytes.min(max_bytes);

    let seek_pos = if truncated {
        end - to_read as u64
    } else {
        start
    };

    let mut buf = vec![0u8; to_read];
    if let Ok(mut file) = fs::File::open(log_path).await {
        let _ = file.seek(SeekFrom::Start(seek_pos)).await;
        let _ = file.read_exact(&mut buf).await;
    }

    (buf, truncated)
}

fn build_terminal_session_env(
    env_overrides: Option<HashMap<String, String>>,
) -> Vec<(String, String)> {
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

    if let Some(overrides) = env_overrides {
        env.extend(overrides);
    }

    let mut entries = env.into_iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

fn split_low_level_input(input: &str) -> (String, usize) {
    let mut end = input.len();
    let mut newline_count = 0;

    while end > 0 {
        if input[..end].ends_with("\r\n") {
            end -= 2;
            newline_count += 1;
        } else if input[..end].ends_with('\n') || input[..end].ends_with('\r') {
            end -= 1;
            newline_count += 1;
        } else {
            break;
        }
    }

    (input[..end].to_string(), newline_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_screen_wait_mode_supports_phase_seven_modes() {
        assert_eq!(
            parse_screen_wait_mode("none").unwrap(),
            ScreenWaitMode::None
        );
        assert_eq!(
            parse_screen_wait_mode("changed").unwrap(),
            ScreenWaitMode::Changed
        );
        assert_eq!(
            parse_screen_wait_mode("settled").unwrap(),
            ScreenWaitMode::Settled
        );
    }

    #[test]
    fn parse_screen_wait_mode_still_accepts_legacy_alias() {
        assert_eq!(
            parse_screen_wait_mode("screen_stable").unwrap(),
            ScreenWaitMode::Settled
        );
    }

    #[test]
    fn normalize_tmux_key_notation_prefers_tmux_style_ctrl_chords() {
        assert_eq!(normalize_tmux_key_notation("C-c").as_deref(), Some("C-c"));
        assert_eq!(normalize_tmux_key_notation("c-D").as_deref(), Some("C-d"));
    }

    #[test]
    fn normalize_tmux_key_notation_accepts_ctrl_aliases() {
        assert_eq!(
            normalize_tmux_key_notation("ctrl+c").as_deref(),
            Some("C-c")
        );
        assert_eq!(
            normalize_tmux_key_notation("control-d").as_deref(),
            Some("C-d")
        );
    }

    #[test]
    fn build_screen_wait_assessment_applies_phase_seven_overrides() {
        let assessment = build_screen_wait_assessment(
            "Claude is thinking...\n",
            "settled",
            350,
            3,
            2,
            Some(false),
            Some(0.85),
            None,
            Some(true),
        );

        assert_eq!(
            assessment.get("trigger").and_then(|value| value.as_str()),
            Some("settled")
        );
        assert_eq!(
            assessment.get("ready").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(
            assessment
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0)
                >= 0.85
        );
        assert_eq!(
            assessment
                .get("hints")
                .and_then(|value| value.get("may_still_be_processing"))
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            assessment
                .get("activity_checks")
                .and_then(|value| value.as_u64()),
            Some(3)
        );
        assert_eq!(
            assessment
                .get("stable_checks")
                .and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn additive_delta_prefers_novel_suffix_for_append_like_changes() {
        let delta = build_additive_delta_payload(Some("line 1\nline 2"), "line 1\nline 2\nline 3");

        assert!(delta.changed);
        assert_eq!(delta.text, "line 3");
        assert!(!delta.truncated);
        assert_eq!(delta.strategy, "novel_suffix");
    }

    #[test]
    fn additive_delta_uses_changed_window_for_localized_rewrite() {
        let delta = build_additive_delta_payload(
            Some("alpha\nbeta\ngamma\ndelta"),
            "alpha\nbeta updated\ngamma updated\ndelta",
        );

        assert!(delta.changed);
        assert_eq!(delta.text, "beta updated\ngamma updated");
        assert!(!delta.truncated);
        assert_eq!(delta.strategy, "changed_window");
    }

    #[test]
    fn additive_delta_falls_back_to_tail_for_large_repaint() {
        let baseline = (0..50)
            .map(|index| format!("before {index}"))
            .collect::<Vec<String>>()
            .join("\n");
        let current = (0..50)
            .map(|index| format!("after {index}"))
            .collect::<Vec<String>>()
            .join("\n");

        let delta = build_additive_delta_payload(Some(&baseline), &current);

        assert!(delta.changed);
        assert_eq!(delta.strategy, "tail_fallback");
        assert!(delta.text.contains("after 49"));
    }

    #[test]
    fn additive_delta_strips_low_signal_separator_lines() {
        let delta = build_additive_delta_payload(
            Some("ready"),
            "ready\n────────────────────────\nDo you want to proceed?",
        );

        assert!(delta.changed);
        assert_eq!(delta.text, "Do you want to proceed?");
        assert_eq!(delta.strategy, "novel_suffix");
    }

    #[test]
    fn additive_delta_preserves_single_separator_glyph_lines() {
        let delta = build_additive_delta_payload(Some("ready"), "ready\n─\nnext");

        assert!(delta.changed);
        assert_eq!(delta.text, "─\nnext");
        assert_eq!(delta.strategy, "novel_suffix");
    }

    #[test]
    fn build_terminal_session_env_includes_dark_terminal_defaults() {
        let env = build_terminal_session_env(None)
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(
            env.get("COLORTERM").map(String::as_str),
            Some(DEFAULT_TERMINAL_COLORTERM)
        );
        assert_eq!(
            env.get("COLORFGBG").map(String::as_str),
            Some(DEFAULT_TERMINAL_COLORFGBG)
        );
    }

    #[test]
    fn build_terminal_session_env_allows_explicit_overrides() {
        let env = build_terminal_session_env(Some(HashMap::from([
            ("COLORTERM".to_string(), "24bit".to_string()),
            ("COLORFGBG".to_string(), "0;15".to_string()),
            ("TERM_PROGRAM".to_string(), "bud-test".to_string()),
        ])))
        .into_iter()
        .collect::<HashMap<_, _>>();

        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("24bit"));
        assert_eq!(env.get("COLORFGBG").map(String::as_str), Some("0;15"));
        assert_eq!(
            env.get("TERM_PROGRAM").map(String::as_str),
            Some("bud-test")
        );
    }

    #[test]
    fn split_low_level_input_treats_crlf_as_single_enter() {
        let (text, enters) = split_low_level_input("hello\r\n");
        assert_eq!(text, "hello");
        assert_eq!(enters, 1);
    }

    #[test]
    fn split_low_level_input_counts_multiple_trailing_linebreak_sequences() {
        let (text, enters) = split_low_level_input("hello\r\n\n\r");
        assert_eq!(text, "hello");
        assert_eq!(enters, 3);
    }

    #[test]
    fn terminal_status_payload_merges_existing_info_with_handle_snapshot() {
        let payload = build_terminal_status_payload(
            "sess_123",
            "ready",
            Some(json!({
                "cwd": "/tmp/work",
                "pid": 42,
                "output_log_bytes": 17,
                "existing": true,
            })),
            Some(TerminalStatusSnapshot {
                session_name: "s_123".to_string(),
                cols: 200,
                rows: 50,
                output_log_bytes: 17,
                pid: Some(42),
                cwd: Some("/tmp/work".to_string()),
            }),
        );

        let info = payload
            .get("info")
            .and_then(|value| value.as_object())
            .expect("terminal_status info");

        assert_eq!(
            info.get("tmux_session").and_then(|value| value.as_str()),
            Some("s_123")
        );
        assert_eq!(info.get("cols").and_then(|value| value.as_u64()), Some(200));
        assert_eq!(info.get("rows").and_then(|value| value.as_u64()), Some(50));
        assert_eq!(info.get("pid").and_then(|value| value.as_i64()), Some(42));
        assert_eq!(
            info.get("cwd").and_then(|value| value.as_str()),
            Some("/tmp/work")
        );
        assert_eq!(
            info.get("output_log_bytes")
                .and_then(|value| value.as_u64()),
            Some(17)
        );
        assert_eq!(
            info.get("existing").and_then(|value| value.as_bool()),
            Some(true)
        );
    }
}
