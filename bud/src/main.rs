use std::collections::{HashMap, VecDeque};
use std::io;
use std::io::SeekFrom;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use clap::Parser;
use futures::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use nix::unistd::{self, Pid};
use qrcodegen::{QrCode, QrCodeEcc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use sha2::Sha256;
use tokio::fs;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::task::{self, LocalSet};
use tokio::time;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message, MaybeTlsStream, WebSocketStream,
};
use tracing::{info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use ulid::Ulid;
use url::Url;

type HmacSha256 = Hmac<Sha256>;
type OutboundSender = Arc<mpsc::UnboundedSender<Message>>;

const PROTO_VERSION: &str = "0.1";
const TERMINAL_PROTO_VERSION: &str = "0.2";
const DEFAULT_HEARTBEAT_SEC: u64 = 30;
const MAX_QUEUE_DEPTH: usize = 10;

/// Bud (device agent) CLI arguments.
#[derive(Debug, Parser, Clone)]
#[command(name = "bud", about = "Bud device agent PoC", version)]
struct BudArgs {
    #[arg(
        long,
        env = "BUD_SERVER_URL",
        default_value = "wss://localhost:8443/ws"
    )]
    server: String,

    #[arg(long, env = "BUD_ENROLLMENT_TOKEN")]
    token: Option<String>,

    #[arg(long, env = "BUD_DEVICE_NAME", default_value = "bud-dev")]
    name: String,

    #[arg(long, env = "BUD_DEFAULT_CWD", default_value = "~")]
    cwd: String,

    #[arg(
        long,
        env = "BUD_IDENTITY_FILE",
        default_value = "~/.bud/identity.json"
    )]
    identity_file: String,

    #[arg(long, env = "BUD_RECONNECT_BASE_SEC", default_value_t = 5)]
    reconnect_base_sec: u64,

    #[arg(long, env = "BUD_TERMINAL_ENABLED", default_value_t = false)]
    terminal_enabled: bool,

    #[arg(long, env = "BUD_TERMINAL_BASE_DIR", default_value = "~/.bud")]
    terminal_base_dir: String,

    #[arg(long, env = "BUD_TERMINAL_COLS", default_value_t = 200)]
    terminal_cols: u16,

    #[arg(long, env = "BUD_TERMINAL_ROWS", default_value_t = 50)]
    terminal_rows: u16,

    #[arg(long, env = "BUD_DEBUG", default_value_t = false)]
    debug: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct DeviceIdentity {
    bud_id: String,
    device_secret: String,
    server_url: String,
    name: String,
    default_cwd: String,
}

struct BudApp {
    args: BudArgs,
    identity_path: PathBuf,
    installation_id_path: PathBuf,
    installation_id: String,
    identity: Option<DeviceIdentity>,
    run_executor: RunExecutor,
    terminal_manager: TerminalManager,
    http_client: Client,
    debug_enabled: bool,
}

struct SessionMeta {
    bud_id: String,
    session_id: String,
    heartbeat_sec: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    proto: String,
    id: String,
    ts: u64,
    #[serde(default)]
    ext: Value,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HelloAckFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    bud_id: String,
    heartbeat_sec: Option<u64>,
    device_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HelloChallengeFrame {
    #[serde(flatten)]
    envelope: Envelope,
    nonce: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ErrorFrame {
    #[serde(flatten)]
    envelope: Envelope,
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthStartResponse {
    flow_id: String,
    claim_url: String,
    qr_payload: String,
    poll_secret: String,
    expires_at: String,
    poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthPollResponse {
    status: String,
    bud_id: Option<String>,
    device_secret: Option<String>,
    expires_at: Option<String>,
    error_code: Option<String>,
    poll_interval_ms: Option<u64>,
}

#[derive(Debug)]
enum HandshakeError {
    AuthFailed { code: String, message: String },
    Other(anyhow::Error),
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct RunFrame {
    #[serde(flatten)]
    envelope: Envelope,
    run_id: String,
    cmd: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    use_pty: Option<bool>,
}

#[derive(Clone)]
struct RunCommand {
    run_id: String,
    cmd: String,
    cwd: PathBuf,
    env: HashMap<String, String>,
    #[allow(dead_code)]
    timeout_ms: u64,
}

#[derive(Clone)]
struct RunExecutor {
    inner: Arc<Mutex<ExecutorState>>,
}

struct ExecutorState {
    queue: VecDeque<RunCommand>,
    current_run: Option<String>,
    sender: Option<OutboundSender>,
    #[allow(dead_code)]
    active: HashMap<String, RunHandle>,
    current_dir: PathBuf,
}

struct RunHandle {
    #[allow(dead_code)]
    cancel_tx: mpsc::UnboundedSender<CancelCommand>,
}

enum CancelCommand {
    #[allow(dead_code)]
    Terminate,
}

#[derive(Clone)]
struct TerminalConfig {
    enabled: bool,
    base_log_dir: PathBuf,
    cols: u16,
    rows: u16,
    shell: String,
    tmux_available: bool,
    tmux_version: Option<String>,
    debug_enabled: bool,
}

#[derive(Clone)]
struct TerminalManager {
    inner: Arc<Mutex<TerminalState>>,
    config: TerminalConfig,
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
    #[allow(dead_code)]
    log_path: PathBuf,
    watcher: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    seq: Arc<AtomicU64>,
    #[allow(dead_code)]
    offset: Arc<AtomicU64>,
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

#[derive(Debug, Deserialize, Clone, Default)]
struct TerminalEnsureConfig {
    shell: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalEnsureFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    config: Option<TerminalEnsureConfig>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalInputFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    data: String,
    await_ready: Option<AwaitReady>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalResizeFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalInterruptFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    await_ready: Option<AwaitReady>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalCloseFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    reason: Option<String>,
}

// Activity-based readiness detection defaults (for TUI/REPL apps)
const ACTIVITY_DEFAULT_INITIAL_DELAY_MS: u64 = 2000;
const ACTIVITY_DEFAULT_INTERVAL_MS: u64 = 5000;
const ACTIVITY_DEFAULT_STABLE_COUNT: u32 = 2;
const ACTIVITY_DEFAULT_MAX_WAIT_MS: u64 = 60_000;
const SCREEN_WAIT_POLL_INTERVAL_MS: u64 = 100;
const SCREEN_WAIT_SETTLED_QUIET_MS: u64 = 300;
const DEFAULT_DELTA_CAPTURE_START_LINE: i32 = -50;
const LOW_SIGNAL_SEPARATOR_MIN_RUN: usize = 4;
const MAX_VISIBLE_DELTA_LINES: usize = 20;
const MAX_CHANGED_WINDOW_LINES: usize = 20;
const MAX_VISIBLE_DELTA_BYTES: usize = 4096;

#[derive(Debug, Deserialize, Clone, Default)]
struct AwaitReady {
    enabled: bool,
    quiescence_ms: Option<u64>,
    max_wait_ms: Option<u64>,
    // Activity-based detection for TUI/REPL apps (e.g., Claude Code)
    // Instead of watching for byte output quiescence, we compare capture-pane
    // hashes at intervals to detect when the screen stops changing.
    #[serde(default)]
    activity_based: bool,
    activity_interval_ms: Option<u64>, // Default: 5000ms between checks
    activity_stable_count: Option<u32>, // Default: 2 consecutive stable checks
    activity_initial_delay_ms: Option<u64>, // Default: 2000ms before first check
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalSendFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    request_id: String,
    text: Option<String>,
    submit: Option<bool>,
    keys: Option<Vec<String>>,
    observe: Option<TerminalSendObserveFrame>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalSendObserveFrame {
    after_ms: Option<u64>,
    wait_for: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalObserveFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    request_id: String,
    view: Option<String>,
    lines: Option<i32>,
    wait_for: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum TerminalCaptureScope {
    Normal,
    Alternate,
    PaneMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum TerminalCursorShape {
    Block,
    Underline,
    Bar,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalScreenStateMessage {
    capture_scope: TerminalCaptureScope,
    pane: TerminalPaneSize,
    cursor: TerminalCursorState,
    screen: TerminalScreenGrid,
    pane_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalPaneSize {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalCursorState {
    row: u16,
    col: u16,
    visible: bool,
    shape: Option<TerminalCursorShape>,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalScreenGrid {
    lines: Vec<String>,
    trailing_spaces_preserved: bool,
    wraps: Option<bool>,
}

#[derive(Debug, Clone)]
struct TmuxPaneMetadata {
    cols: u16,
    rows: u16,
    cursor_x: u16,
    cursor_y: u16,
    cursor_visible: bool,
    cursor_shape: Option<TerminalCursorShape>,
    capture_scope: TerminalCaptureScope,
    pane_mode: Option<String>,
    wraps: Option<bool>,
}

#[derive(Debug)]
struct VisibleScreenCaptureState {
    capture: String,
    summary: CaptureLogSummary,
    captured_after_ms: u64,
    screen_state: TerminalScreenStateMessage,
}

impl RunExecutor {
    fn new(initial_cwd: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ExecutorState {
                queue: VecDeque::new(),
                current_run: None,
                sender: None,
                active: HashMap::new(),
                current_dir: initial_cwd,
            })),
        }
    }

    async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        inner.sender = None;
    }

    async fn prepare_command(
        &self,
        run_id: String,
        cmd: String,
        requested_cwd: Option<String>,
        env: HashMap<String, String>,
        timeout_ms: u64,
    ) -> Result<RunCommand> {
        let mut inner = self.inner.lock().await;
        let resolved_cwd = if let Some(override_cwd) = requested_cwd {
            match expand_path(&override_cwd) {
                Some(path) => {
                    inner.current_dir = path.clone();
                    path
                }
                None => inner.current_dir.clone(),
            }
        } else {
            inner.current_dir.clone()
        };
        drop(inner);
        Ok(RunCommand {
            run_id,
            cmd,
            cwd: resolved_cwd,
            env,
            timeout_ms,
        })
    }

    async fn enqueue(&self, command: RunCommand) -> Result<()> {
        info!(
            run_id = %command.run_id,
            cmd = %command.cmd,
            cwd = %command.cwd.display(),
            "Queued run command"
        );
        let mut inner = self.inner.lock().await;
        if inner.queue.len() >= MAX_QUEUE_DEPTH {
            bail!("run queue is full");
        }
        inner.queue.push_back(command);
        if inner.current_run.is_none() {
            if let Some(next) = inner.queue.pop_front() {
                inner.current_run = Some(next.run_id.clone());
                let sender = inner.sender.clone();
                drop(inner);
                self.spawn_run(next, sender).await;
            }
        }
        Ok(())
    }

    async fn spawn_run(&self, cmd: RunCommand, sender: Option<OutboundSender>) {
        let executor = self.clone();
        task::spawn_local(async move {
            if let Err(err) = executor.execute_run(cmd.clone(), sender.clone()).await {
                warn!(error = %err, "run execution failed");
                if let Some(sender) = sender.clone() {
                    let _ = send_ws_frame(
                        &sender,
                        json!({
                            "proto": PROTO_VERSION,
                            "type": "run_finished",
                            "id": new_message_id(),
                            "ts": now_millis(),
                            "ext": {},
                            "run_id": cmd.run_id,
                            "exit_code": null,
                            "signal": null,
                            "canceled": false,
                            "cwd": cmd.cwd.to_string_lossy(),
                            "error": err.to_string()
                        }),
                    );
                }
            }
            executor.finish_and_start_next(cmd.run_id).await;
        });
    }

    async fn finish_and_start_next(&self, run_id: String) {
        let mut inner = self.inner.lock().await;
        if inner.current_run.as_deref() == Some(&run_id) {
            inner.current_run = None;
        }
        if inner.current_run.is_none() {
            if let Some(next) = inner.queue.pop_front() {
                inner.current_run = Some(next.run_id.clone());
                let sender = inner.sender.clone();
                drop(inner);
                self.spawn_run(next, sender).await;
            }
        }
    }

    async fn execute_run(&self, run: RunCommand, sender: Option<OutboundSender>) -> Result<()> {
        let sender = sender.ok_or_else(|| anyhow!("no websocket writer available"))?;
        info!(
            run_id = %run.run_id,
            cmd = %run.cmd,
            cwd = %run.cwd.display(),
            "Starting shell command"
        );
        if !run.cwd.exists() {
            warn!(
                run_id = %run.run_id,
                cwd = %run.cwd.display(),
                "Run cwd does not exist; command may fail"
            );
        }
        let shell = default_shell();
        let mut command = Command::new(shell);
        command.arg("-lc").arg(&run.cmd);
        command.envs(run.env.clone());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::null());
        command.current_dir(&run.cwd);
        unsafe {
            command.pre_exec(|| {
                unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))
                    .map_err(|err| io::Error::new(io::ErrorKind::Other, err))
            });
        }

        let cwd_clone = run.cwd.clone();
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn shell in {}", cwd_clone.display()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("missing stderr pipe"))?;

        let seq = Arc::new(AtomicU64::new(0));
        let sender_stdout = sender.clone();
        let sender_stderr = sender.clone();
        let run_id_stdout = run.run_id.clone();
        let run_id_stderr = run.run_id.clone();
        let seq_stdout = seq.clone();

        let stdout_task = task::spawn_local(async move {
            if let Err(err) =
                stream_pipe(stdout, run_id_stdout, "stdout", sender_stdout, seq_stdout).await
            {
                warn!(error = %err, "stdout stream error");
            }
        });

        let stderr_task = task::spawn_local(async move {
            if let Err(err) = stream_pipe(stderr, run_id_stderr, "stderr", sender_stderr, seq).await
            {
                warn!(error = %err, "stderr stream error");
            }
        });

        let wait_status = child.wait().await;
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let (exit_code, signal) = match wait_status {
            Ok(status) => (status.code(), status.signal().map(|s| format!("SIG{}", s))),
            Err(err) => {
                warn!(run_id = %run.run_id, error = %err, "failed to wait for child");
                (Some(1), None)
            }
        };

        info!(
            run_id = %run.run_id,
            exit_code = exit_code,
            signal = signal.as_deref().unwrap_or(""),
            "Shell command finished"
        );

        send_ws_frame(
            &sender,
            json!({
                "proto": PROTO_VERSION,
                "type": "run_finished",
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "run_id": run.run_id,
                "exit_code": exit_code,
                "signal": signal,
                "canceled": false,
                "cwd": run.cwd.to_string_lossy(),
            }),
        )?;

        info!(run_id = %run.run_id, "Sent run_finished frame to backend");

        Ok(())
    }
}

/// Simple hash for change detection (used by ActivityDetector)
fn simple_hash(data: &[u8]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
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
    changed_since_baseline: bool,
    check_count: u32,
    stable_checks: u32,
}

#[derive(Debug, Clone)]
struct AdditiveDeltaPayload {
    changed: bool,
    text: String,
    truncated: bool,
    strategy: &'static str,
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
    let truncated: String = normalized.chars().take(max_chars.saturating_sub(3)).collect();
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
        "settled" => Ok(ScreenWaitMode::Settled),
        _ => bail!("unsupported wait_for mode: {wait_for}"),
    }
}

#[derive(Debug, Clone)]
struct ResolvedTerminalSendObserve {
    after_ms: u64,
    wait_for: String,
    timeout_ms: u64,
}

fn resolve_terminal_send_observe(frame: &TerminalSendFrame) -> Option<ResolvedTerminalSendObserve> {
    frame.observe.as_ref().map(|observe| ResolvedTerminalSendObserve {
        after_ms: observe.after_ms.unwrap_or(1000),
        wait_for: observe
            .wait_for
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        timeout_ms: observe.timeout_ms.unwrap_or(5_000),
    })
}

fn dispatch_only_readiness() -> Value {
    json!({
        "ready": false,
        "confidence": 0.0,
        "trigger": "dispatch_only",
        "hints": {
            "looks_like_prompt": false,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": false
        }
    })
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
                hints.insert(
                    "may_still_be_processing".into(),
                    Value::Bool(processing),
                );
            }
        }
    }

    assessment
}

fn parse_tmux_bool(value: &str) -> bool {
    matches!(value.trim(), "1" | "on" | "true" | "yes")
}

fn parse_tmux_u16(value: &str, field: &str) -> Result<u16> {
    value
        .trim()
        .parse::<u16>()
        .with_context(|| format!("failed to parse tmux {field}: {value}"))
}

fn parse_cursor_shape(value: &str) -> Option<TerminalCursorShape> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    Some(match normalized.as_str() {
        "block" => TerminalCursorShape::Block,
        "underline" | "underscore" => TerminalCursorShape::Underline,
        "bar" | "beam" | "vertical" => TerminalCursorShape::Bar,
        _ => TerminalCursorShape::Unknown,
    })
}

fn normalize_visible_screen_lines(capture: &str, expected_rows: u16) -> Vec<String> {
    let mut lines = capture
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect::<Vec<String>>();

    if lines.len() == expected_rows as usize + 1 && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }

    if lines.len() > expected_rows as usize {
        lines.truncate(expected_rows as usize);
    }

    while lines.len() < expected_rows as usize {
        lines.push(String::new());
    }

    lines
}

impl TerminalManager {
    fn new(config: TerminalConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalState {
                sender: None,
                sessions: HashMap::new(),
                delivered_captures: HashMap::new(),
            })),
            config,
        }
    }

    async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        // Abort all session watchers
        for (_, handle) in inner.sessions.drain() {
            handle.watcher.abort();
        }
        inner.delivered_captures.clear();
        inner.sender = None;
    }

    async fn handle_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
        if !self.config.enabled {
            info!("terminal support disabled; ignoring terminal_ensure");
            return Ok(());
        }

        let session_id = &frame.session_id;
        let inner = self.inner.lock().await;

        // Check if session already exists
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

        let ensured = self.ensure_tmux_session(session_id, frame.config).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner.sessions.insert(session_id.clone(), handle.clone());
            drop(inner);
            self.send_status(&sender, session_id, "ready", None).await?;
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

    async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal input data: {}", err))?;

        // Get or create handle for this session
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

        // Split input into text and trailing newlines.
        // Send text literally with -l (safe, no escaping needed), then send Enter keys separately.
        // This ensures Enter is interpreted as the Enter key, not a literal newline character.
        // Important for TUI applications like Claude Code that handle Enter specially.
        let trimmed_end = input.trim_end_matches(|c| c == '\n' || c == '\r');
        let newline_count = input.len() - trimmed_end.len();

        // Send the text content (if any) literally
        if !trimmed_end.is_empty() {
            let status = Command::new("tmux")
                .args(["send-keys", "-t", &handle.session_name, "-l", trimmed_end])
                .status()
                .await
                .with_context(|| "failed to dispatch tmux send-keys (text)")?;
            if !status.success() {
                warn!(message_id = %frame.envelope.id, "tmux send-keys (text) failed");
            }
        }

        // Send Enter key(s) for each newline
        for _ in 0..newline_count {
            let status = Command::new("tmux")
                .args(["send-keys", "-t", &handle.session_name, "Enter"])
                .status()
                .await
                .with_context(|| "failed to dispatch tmux send-keys (Enter)")?;
            if !status.success() {
                warn!(message_id = %frame.envelope.id, "tmux send-keys (Enter) failed");
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
                    // Use activity-based detection for TUI/REPL apps
                    // Compares capture-pane hashes at intervals to detect screen stability
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
                        &await_ready,
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "activity detection failed");
                        }
                    });
                } else {
                    // Use quiescence-based detection for shell commands
                    // Watches pipe-pane log for new bytes
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

    async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
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

        let status = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                &handle.session_name,
                "-x",
                &frame.cols.to_string(),
                "-y",
                &frame.rows.to_string(),
            ])
            .status()
            .await
            .with_context(|| "failed to resize tmux window")?;
        if !status.success() {
            warn!(message_id = %frame.envelope.id, "tmux resize-window failed");
        }

        Ok(())
    }

    async fn handle_interrupt(&self, frame: TerminalInterruptFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = session_id,
                "terminal_interrupt dropped; no session"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(Ordering::SeqCst);
        let status = Command::new("tmux")
            .args(["send-keys", "-t", &handle.session_name, "C-c"])
            .status()
            .await
            .with_context(|| "failed to send tmux interrupt")?;
        if !status.success() {
            warn!(message_id = %frame.envelope.id, "tmux interrupt failed");
        }

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
                    // Use activity-based detection for TUI/REPL apps
                    info!(
                        message_id = %frame.envelope.id,
                        session_id = session_id,
                        session = %handle.session_name,
                        "using activity-based readiness detection after interrupt"
                    );
                    let detector = ActivityDetector::new(
                        session_id_owned,
                        handle.clone(),
                        sender,
                        &await_ready,
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "activity detection failed");
                        }
                    });
                } else {
                    // Use quiescence-based detection for shell commands
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

    async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };

        let mut inner = self.inner.lock().await;
        if let Some(handle) = inner.sessions.remove(session_id) {
            handle.watcher.abort();
            let _ = Command::new("tmux")
                .args(["kill-session", "-t", &handle.session_name])
                .status()
                .await;
            info!(
                session_id = session_id,
                session_name = %handle.session_name,
                "terminal session closed"
            );
        }
        inner.delivered_captures.remove(session_id);
        drop(inner);

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

    async fn handle_observe(&self, frame: TerminalObserveFrame) -> Result<()> {
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
            return self.send_observe_error(&frame, "unsupported_wait_for").await;
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
                .run_capture_pane_with_lines(&handle.session_name, start_line)
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
                    .run_capture_pane_with_lines(&handle.session_name, start_line)
                    .await?;
                let capture_ms = capture_start.elapsed().as_millis() as u64;
                let capture_summary =
                    summarize_capture_for_log(&output, self.config.debug_enabled);
                (readiness, output, capture_ms, capture_summary, false)
            } else {
                let wait_result = self
                    .wait_for_screen_state(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        wait_baseline
                            .as_deref()
                            .or(delivered_baseline.as_deref()),
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
        let mut screen_state: Option<TerminalScreenStateMessage> = None;
        let (output, output_bytes, lines_captured, changed, truncated, output_summary) = match view {
            "delta" => {
                let comparison_baseline = delivered_baseline
                    .as_deref()
                    .or(wait_baseline.as_deref());
                let delta = build_additive_delta_payload(comparison_baseline, &current_capture);
                let fallback_delta = if delivered_baseline.is_none()
                    && delta.text.is_empty()
                    && !delta.changed
                {
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
                    capture_summary.clone(),
                )
            }
            "screen" => {
                let visible_screen = self
                    .capture_visible_screen_state(&handle.session_name, capture_ms)
                    .await?;
                let output_bytes = visible_screen.capture.as_bytes().len();
                let lines_captured = visible_screen.screen_state.screen.lines.len();
                screen_state = Some(visible_screen.screen_state);
                (
                    visible_screen.capture,
                    output_bytes,
                    lines_captured,
                    None,
                    None,
                    visible_screen.summary,
                )
            }
            "history" => {
                let output_bytes = current_capture.as_bytes().len();
                let lines_captured = current_capture.lines().count();
                (
                    current_capture.clone(),
                    output_bytes,
                    lines_captured,
                    None,
                    None,
                    capture_summary.clone(),
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
            "screen_state": screen_state,
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
            capture_hash = format!("{:016x}", output_summary.hash),
            capture_line_count = output_summary.line_count,
            last_non_empty_line = %output_summary.last_non_empty_line,
            preview_head = ?output_summary.preview_head.as_deref(),
            preview_tail = ?output_summary.preview_tail.as_deref(),
            "terminal_observe_result sent"
        );

        Ok(())
    }

    async fn handle_send(&self, frame: TerminalSendFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_send_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let observe = resolve_terminal_send_observe(&frame);
        let wait_for = observe
            .as_ref()
            .map(|value| value.wait_for.as_str())
            .unwrap_or("none");
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
        let submitted = match self
            .dispatch_interaction_to_tmux(&handle, text, submit, &keys)
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

        let delta_start_line = Some(DEFAULT_DELTA_CAPTURE_START_LINE);
        let (delta, readiness, current_capture, current_summary, captured_after_ms) =
            if let Some(observe) = observe.as_ref() {
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

                match observe.wait_for.as_str() {
                    "none" => {
                        if observe.after_ms > 0 {
                            time::sleep(Duration::from_millis(observe.after_ms)).await;
                        }

                        match self
                            .capture_screen_state(
                                &handle.session_name,
                                delta_start_line,
                                observe.after_ms,
                            )
                            .await
                        {
                            Ok(current) => {
                                let delta = build_additive_delta_payload(
                                    baseline_capture.as_ref().map(|state| state.capture.as_str()),
                                    &current.capture,
                                );
                                let readiness = assess_capture_readiness(&current.capture);
                                let captured_after_ms = current.captured_after_ms;
                                (
                                    Some(delta),
                                    readiness,
                                    Some(current.capture),
                                    Some(current.summary),
                                    Some(captured_after_ms),
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
                                        observe.wait_for.as_str(),
                                        observe.timeout_ms,
                                        start_offset,
                                    )
                                    .await?,
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
                                observe.wait_for.as_str(),
                                observe.timeout_ms,
                                start_offset,
                            )
                            .await?;
                        let captured_after_ms = shell_wait_start.elapsed().as_millis() as u64;
                        match self
                            .capture_screen_state(
                                &handle.session_name,
                                delta_start_line,
                                captured_after_ms,
                            )
                            .await
                        {
                            Ok(current) => {
                                let delta = build_additive_delta_payload(
                                    baseline_capture.as_ref().map(|state| state.capture.as_str()),
                                    &current.capture,
                                );
                                let captured_after_ms = current.captured_after_ms;
                                (
                                    Some(delta),
                                    readiness,
                                    Some(current.capture),
                                    Some(current.summary),
                                    Some(captured_after_ms),
                                )
                            }
                            Err(err) => {
                                warn!(
                                    request_id = request_id,
                                    session_id = session_id,
                                    error = %err,
                                    "terminal_send final capture after shell_ready failed"
                                );
                                (None, readiness, None, None, None)
                            }
                        }
                    }
                    "changed" | "settled" => {
                        let wait_result = self
                            .wait_for_screen_state(
                                &handle,
                                request_id,
                                observe.wait_for.as_str(),
                                observe.timeout_ms,
                                baseline_capture.as_ref().map(|state| state.capture.as_str()),
                                delta_start_line,
                            )
                            .await?;
                        let delta = build_additive_delta_payload(
                            baseline_capture.as_ref().map(|state| state.capture.as_str()),
                            &wait_result.capture,
                        );

                        (
                            Some(delta),
                            wait_result.assessment,
                            Some(wait_result.capture),
                            Some(wait_result.summary),
                            Some(wait_result.captured_after_ms),
                        )
                    }
                    _ => return self.send_send_error(&frame, "unsupported_wait_for").await,
                }
            } else {
                (None, dispatch_only_readiness(), None, None, None)
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
            observe_enabled = observe.is_some(),
            observe_delay_ms = observe
                .as_ref()
                .map(|value| value.after_ms)
                .unwrap_or(0),
            submitted = submitted,
            key_count = keys.len(),
            has_text = text.is_some(),
            delta_changed = ?delta.as_ref().map(|value| value.changed),
            delta_truncated = ?delta.as_ref().map(|value| value.truncated),
            delta_text_bytes = ?delta.as_ref().map(|value| value.text.as_bytes().len()),
            captured_after_ms = ?captured_after_ms,
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

    async fn dispatch_interaction_to_tmux(
        &self,
        handle: &Arc<TerminalHandle>,
        text: Option<&str>,
        submit: bool,
        keys: &[String],
    ) -> Result<bool> {
        let mut submitted = false;

        if let Some(text) = text {
            submitted |= self
                .send_text_payload_to_tmux(&handle.session_name, text, submit)
                .await?;
        } else if submit {
            self.send_tmux_key(&handle.session_name, "Enter").await?;
            submitted = true;
        }

        for key in keys {
            submitted |= self
                .send_interaction_key(&handle.session_name, key)
                .await?;
        }

        Ok(submitted)
    }

    async fn send_text_payload_to_tmux(
        &self,
        session_name: &str,
        text: &str,
        submit: bool,
    ) -> Result<bool> {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let segments: Vec<&str> = normalized.split('\n').collect();
        let mut submitted = false;

        for (index, segment) in segments.iter().enumerate() {
            if !segment.is_empty() {
                self.send_literal_text(session_name, segment).await?;
                submitted = true;
            }

            let should_press_enter =
                index + 1 < segments.len() || (submit && index + 1 == segments.len());
            if should_press_enter {
                self.send_tmux_key(session_name, "Enter").await?;
                submitted = true;
            }
        }

        if normalized.is_empty() && submit {
            self.send_tmux_key(session_name, "Enter").await?;
            submitted = true;
        }

        Ok(submitted)
    }

    async fn send_literal_text(&self, session_name: &str, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        let status = Command::new("tmux")
            .args(["send-keys", "-t", session_name, "-l", text])
            .status()
            .await
            .with_context(|| "failed to dispatch tmux send-keys (literal text)")?;

        if !status.success() {
            bail!("tmux send-keys literal text failed");
        }

        Ok(())
    }

    async fn send_tmux_key(&self, session_name: &str, key: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", session_name, key])
            .status()
            .await
            .with_context(|| format!("failed to dispatch tmux send-keys ({key})"))?;

        if !status.success() {
            bail!("tmux send-keys {key} failed");
        }

        Ok(())
    }

    async fn send_interaction_key(&self, session_name: &str, key: &str) -> Result<bool> {
        let normalized = key.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Ok(false);
        }

        match normalized.as_str() {
            "enter" | "return" => {
                self.send_tmux_key(session_name, "Enter").await?;
                Ok(true)
            }
            "space" | "spacebar" => {
                self.send_literal_text(session_name, " ").await?;
                Ok(true)
            }
            "tab" => {
                self.send_tmux_key(session_name, "Tab").await?;
                Ok(true)
            }
            "escape" | "esc" => {
                self.send_tmux_key(session_name, "Escape").await?;
                Ok(true)
            }
            "up" | "arrowup" => {
                self.send_tmux_key(session_name, "Up").await?;
                Ok(true)
            }
            "down" | "arrowdown" => {
                self.send_tmux_key(session_name, "Down").await?;
                Ok(true)
            }
            "left" | "arrowleft" => {
                self.send_tmux_key(session_name, "Left").await?;
                Ok(true)
            }
            "right" | "arrowright" => {
                self.send_tmux_key(session_name, "Right").await?;
                Ok(true)
            }
            "backspace" => {
                self.send_tmux_key(session_name, "BSpace").await?;
                Ok(true)
            }
            "delete" => {
                self.send_tmux_key(session_name, "DC").await?;
                Ok(true)
            }
            "home" => {
                self.send_tmux_key(session_name, "Home").await?;
                Ok(true)
            }
            "end" => {
                self.send_tmux_key(session_name, "End").await?;
                Ok(true)
            }
            "pageup" => {
                self.send_tmux_key(session_name, "PageUp").await?;
                Ok(true)
            }
            "pagedown" => {
                self.send_tmux_key(session_name, "PageDown").await?;
                Ok(true)
            }
            _ if key.chars().count() == 1 => {
                self.send_literal_text(session_name, key).await?;
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
                self
                    .wait_for_screen_state(
                        handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        None,
                        None,
                    )
                    .await?
                    .assessment
            }
            "settled" => {
                let (assessment, _, _, _) = self
                    .wait_activity_and_capture(handle, request_id, timeout_ms)
                    .await?;
                assessment
            }
            "none" => {
                let capture = self.run_capture_pane(&handle.session_name).await?;
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

    /// Wait for quiescence (shell mode) and read output from log file
    async fn wait_quiescence_and_read(
        &self,
        handle: &Arc<TerminalHandle>,
        start_offset: u64,
        timeout_ms: u64,
    ) -> Result<(serde_json::Value, Vec<u8>, usize, bool)> {
        const MAX_OUTPUT: usize = 64 * 1024; // 64KB max output
        let quiescence_ms = 1500;
        let start = Instant::now();
        let mut last_change = Instant::now();
        let mut last_size = handle.offset.load(Ordering::SeqCst);
        let log_path = handle.log_path.clone();

        // Wait for quiescence or timeout
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

        // Read output from start_offset to current end
        let end_size = fs::metadata(&log_path)
            .await
            .map(|m| m.len())
            .unwrap_or(last_size);

        let (output, truncated) = self
            .read_log_range(&log_path, start_offset, end_size, MAX_OUTPUT)
            .await;

        let output_bytes = output.len();
        let text = String::from_utf8_lossy(&output).to_string();
        let last_line = text.lines().last().unwrap_or("").to_string();
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let assessment = ReadinessDetector::assess(&text, &last_line, quiet_for_ms, elapsed_ms);

        Ok((assessment, output, output_bytes, truncated))
    }

    /// Read log file from start to end, limiting to max_bytes
    async fn read_log_range(
        &self,
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

        // If truncating, read the last N bytes; otherwise read from start
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

    /// Wait for activity stability (REPL mode) and capture screen
    async fn wait_activity_and_capture(
        &self,
        handle: &Arc<TerminalHandle>,
        request_id: &str,
        timeout_ms: u64,
    ) -> Result<(serde_json::Value, Vec<u8>, usize, bool)> {
        let wait_result = self
            .wait_for_screen_state(
                handle,
                request_id,
                "settled",
                timeout_ms,
                None,
                None,
            )
            .await?;
        let output = wait_result.capture.into_bytes();
        let output_bytes = output.len();
        Ok((wait_result.assessment, output, output_bytes, false))
    }

    /// Run tmux capture-pane and return the output.
    async fn run_capture_pane(&self, session_name: &str) -> Result<String> {
        self.run_capture_pane_with_lines(session_name, None).await
    }

    async fn run_capture_pane_with_lines(
        &self,
        session_name: &str,
        start_line: Option<i32>,
    ) -> Result<String> {
        let mut args = vec!["capture-pane", "-p", "-J", "-t", session_name];
        let start_line_owned;
        if let Some(start) = start_line {
            start_line_owned = start.to_string();
            args.extend(["-S", &start_line_owned]);
        }

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane")?;

        if !output.status.success() {
            bail!(
                "tmux capture-pane failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn fetch_tmux_pane_metadata(&self, session_name: &str) -> Result<TmuxPaneMetadata> {
        let format = "#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{cursor_shape}\t#{alternate_on}\t#{pane_in_mode}\t#{pane_mode}\t#{wrap_flag}";
        let output = Command::new("tmux")
            .args(["display-message", "-p", "-t", session_name, format])
            .output()
            .await
            .with_context(|| "failed to fetch tmux pane metadata")?;

        if !output.status.success() {
            bail!(
                "tmux display-message failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let text = String::from_utf8_lossy(&output.stdout).trim_end().to_string();
        let mut parts = text.split('\t');

        let cols = parse_tmux_u16(parts.next().unwrap_or_default(), "pane_width")?;
        let rows = parse_tmux_u16(parts.next().unwrap_or_default(), "pane_height")?;
        let cursor_x = parse_tmux_u16(parts.next().unwrap_or_default(), "cursor_x")?;
        let cursor_y = parse_tmux_u16(parts.next().unwrap_or_default(), "cursor_y")?;
        let cursor_visible = parse_tmux_bool(parts.next().unwrap_or_default());
        let cursor_shape = parse_cursor_shape(parts.next().unwrap_or_default());
        let alternate_on = parse_tmux_bool(parts.next().unwrap_or_default());
        let pane_in_mode = parse_tmux_bool(parts.next().unwrap_or_default());
        let pane_mode = parts
            .next()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let wraps = parts.next().map(parse_tmux_bool);

        let capture_scope = if pane_in_mode {
            TerminalCaptureScope::PaneMode
        } else if alternate_on {
            TerminalCaptureScope::Alternate
        } else {
            TerminalCaptureScope::Normal
        };

        Ok(TmuxPaneMetadata {
            cols,
            rows,
            cursor_x: cursor_x.min(cols.saturating_sub(1)),
            cursor_y: cursor_y.min(rows.saturating_sub(1)),
            cursor_visible,
            cursor_shape,
            capture_scope,
            pane_mode,
            wraps,
        })
    }

    async fn run_capture_visible_screen(
        &self,
        session_name: &str,
        metadata: &TmuxPaneMetadata,
    ) -> Result<String> {
        let mut args = vec!["capture-pane", "-p", "-N", "-t", session_name];
        match metadata.capture_scope {
            TerminalCaptureScope::Alternate => args.insert(2, "-a"),
            TerminalCaptureScope::PaneMode => args.insert(2, "-M"),
            TerminalCaptureScope::Normal => {}
        }

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane for visible screen")?;

        if !output.status.success() {
            bail!(
                "tmux visible-screen capture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn capture_visible_screen_state(
        &self,
        session_name: &str,
        captured_after_ms: u64,
    ) -> Result<VisibleScreenCaptureState> {
        let metadata = self.fetch_tmux_pane_metadata(session_name).await?;
        let raw_capture = self.run_capture_visible_screen(session_name, &metadata).await?;
        let lines = normalize_visible_screen_lines(&raw_capture, metadata.rows);
        let capture = lines.join("\n");
        let summary = summarize_capture_for_log(&capture, self.config.debug_enabled);

        Ok(VisibleScreenCaptureState {
            capture,
            summary,
            captured_after_ms,
            screen_state: TerminalScreenStateMessage {
                capture_scope: metadata.capture_scope,
                pane: TerminalPaneSize {
                    cols: metadata.cols,
                    rows: metadata.rows,
                },
                cursor: TerminalCursorState {
                    row: metadata.cursor_y,
                    col: metadata.cursor_x,
                    visible: metadata.cursor_visible,
                    shape: metadata.cursor_shape,
                },
                screen: TerminalScreenGrid {
                    lines,
                    trailing_spaces_preserved: true,
                    wraps: metadata.wraps,
                },
                pane_mode: metadata.pane_mode,
            },
        })
    }

    async fn capture_screen_state(
        &self,
        session_name: &str,
        start_line: Option<i32>,
        captured_after_ms: u64,
    ) -> Result<ScreenCaptureState> {
        let capture = self
            .run_capture_pane_with_lines(session_name, start_line)
            .await?;
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
                changed_since_baseline: false,
                check_count: 0,
                stable_checks: 0,
            });
        }

        let baseline = match baseline_capture {
            Some(existing) => ScreenCaptureState {
                capture: existing.to_string(),
                summary: summarize_capture_for_log(existing, self.config.debug_enabled),
                captured_after_ms: 0,
            },
            None => self
                .capture_screen_state(&handle.session_name, start_line, 0)
                .await?,
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
                    changed_since_baseline,
                    check_count,
                    stable_checks,
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
                        changed_since_baseline,
                        check_count,
                        stable_checks,
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
                        changed_since_baseline,
                        check_count,
                        stable_checks,
                    });
                }
                _ => {
                    last_summary = current.summary.clone();
                    final_state = current;
                }
            }
        }
    }

    /// Hash content for activity-based detection
    fn hash_content(&self, content: &str) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        hasher.finish()
    }

    async fn send_status(
        &self,
        sender: &OutboundSender,
        session_id: &str,
        state: &str,
        info: Option<Value>,
    ) -> Result<()> {
        let mut payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_status",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "state": state,
        });
        if let Some(info_obj) = info {
            if let Some(map) = payload.as_object_mut() {
                map.insert("info".into(), info_obj);
            }
        }

        // Add session info if we have a handle
        {
            let inner = self.inner.lock().await;
            if let Some(handle) = inner.sessions.get(session_id) {
                if let Some(map) = payload.as_object_mut() {
                    map.insert(
                        "info".into(),
                        json!({
                            "tmux_session": handle.session_name,
                            "cols": handle.cols,
                            "rows": handle.rows,
                        }),
                    );
                }
            }
        }

        send_ws_frame(sender, payload)
    }

    /// Get or create handle for a specific session
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
        // Create session if not exists
        let ensured = self.ensure_tmux_session(session_id, cfg).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner
                .sessions
                .insert(session_id.to_string(), handle.clone());
            return Ok(Some(handle));
        }
        Ok(None)
    }

    async fn ensure_tmux_session(
        &self,
        session_id: &str,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        if !self.config.tmux_available {
            return Ok(None);
        }
        let cfg = cfg.unwrap_or_default();
        let tmux_name = tmux_session_name(session_id);
        let log_path = session_log_path(&self.config.base_log_dir, session_id);
        let _ = cfg.env; // env passthrough not yet implemented
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
        let session_exists = Command::new("tmux")
            .args(["has-session", "-t", &tmux_name])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if !session_exists {
            info!(
                session_id = session_id,
                tmux_name = %tmux_name,
                "creating new tmux session"
            );
            let status = Command::new("tmux")
                .args([
                    "new-session",
                    "-d",
                    "-s",
                    &tmux_name,
                    "-x",
                    &cols.to_string(),
                    "-y",
                    &rows.to_string(),
                    "-c",
                    &cwd,
                    &shell,
                ])
                .status()
                .await
                .with_context(|| "failed to create tmux session")?;
            if !status.success() {
                warn!(session_id = session_id, tmux_name = %tmux_name, "tmux new-session failed");
                return Ok(None);
            }

            // Set history-limit to allow capture-pane to retrieve scrollback
            // Agent can request up to 1000 lines; 5000 gives headroom
            let _ = Command::new("tmux")
                .args(["set-option", "-t", &tmux_name, "history-limit", "5000"])
                .status()
                .await;
        } else {
            info!(
                session_id = session_id,
                tmux_name = %tmux_name,
                "reattaching to existing tmux session"
            );
        }

        // Ensure pipe-pane to log - first stop any existing pipe, then start fresh
        // The -o flag would skip if already piping, but after disconnect the old pipe
        // process may have died while tmux still thinks it's piping
        let _ = Command::new("tmux")
            .args(["pipe-pane", "-t", &tmux_name]) // Stop existing pipe
            .status()
            .await;
        let pipe_cmd = format!("cat >> {}", log_path.display());
        let pipe_status = Command::new("tmux")
            .args(["pipe-pane", "-t", &tmux_name, &pipe_cmd]) // Start new pipe (no -o)
            .status()
            .await;
        match &pipe_status {
            Ok(status) if status.success() => {
                info!(session_id = session_id, tmux_name = %tmux_name, "tmux pipe-pane established");
            }
            Ok(status) => {
                warn!(session_id = session_id, tmux_name = %tmux_name, exit_code = ?status.code(), "tmux pipe-pane failed");
            }
            Err(err) => {
                warn!(session_id = session_id, tmux_name = %tmux_name, error = %err, "tmux pipe-pane command failed");
            }
        }

        let metadata = fs::metadata(&log_path).await.ok();
        let start_offset = metadata.map(|m| m.len()).unwrap_or(0);
        let pid = tmux_pane_pid(&tmux_name).await.ok();
        let cwd_reported = tmux_pane_cwd(&tmux_name).await.ok();
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
        let sender_clone = sender.clone();
        let watcher = self.spawn_output_watcher(
            session_id.to_string(),
            tmux_name.clone(),
            log_path.clone(),
            sender_clone,
            seq.clone(),
            offset.clone(),
        );
        let handle = Arc::new(TerminalHandle {
            session_id: session_id.to_string(),
            session_name: tmux_name,
            log_path,
            watcher,
            seq,
            offset,
            cols,
            rows,
        });
        // Immediately send status with info
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

    fn spawn_output_watcher(
        &self,
        session_id: String,
        session_name: String,
        log_path: PathBuf,
        sender: OutboundSender,
        seq: Arc<AtomicU64>,
        offset: Arc<AtomicU64>,
    ) -> tokio::task::JoinHandle<()> {
        info!(session_id = %session_id, session = %session_name, log_path = %log_path.display(), "spawning terminal output watcher");
        tokio::spawn(async move {
            info!(session_id = %session_id, session = %session_name, "output watcher task started");
            loop {
                let size = match fs::metadata(&log_path).await {
                    Ok(meta) => meta.len(),
                    Err(err) => {
                        warn!(session_id = %session_id, session = %session_name, error = %err, "failed to stat log file");
                        time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let current_offset = offset.load(Ordering::SeqCst);
                if size > current_offset {
                    info!(session_id = %session_id, session = %session_name, size = size, current_offset = current_offset, "new output detected");
                    match fs::File::open(&log_path).await {
                        Ok(mut file) => {
                            if file.seek(SeekFrom::Start(current_offset)).await.is_ok() {
                                let mut buf = vec![0u8; (size - current_offset) as usize];
                                if file.read_exact(&mut buf).await.is_ok() {
                                    let seq_no = seq.fetch_add(1, Ordering::SeqCst);
                                    let payload = json!({
                                        "proto": TERMINAL_PROTO_VERSION,
                                        "type": "terminal_output",
                                        "id": new_message_id(),
                                        "ts": now_millis(),
                                        "ext": {},
                                        "session_id": session_id,
                                        "seq": seq_no,
                                        "data": BASE64_STANDARD.encode(&buf),
                                        "byte_offset": current_offset,
                                    });
                                    info!(session_id = %session_id, session = %session_name, seq = seq_no, bytes = buf.len(), "sending terminal_output");
                                    if let Err(err) = send_ws_frame(&sender, payload) {
                                        warn!(session_id = %session_id, session = %session_name, error = %err, "failed to send terminal_output");
                                        break; // Exit loop if send fails - channel is dead
                                    }
                                    offset.store(size, Ordering::SeqCst);
                                } else {
                                    warn!(session_id = %session_id, session = %session_name, "failed to read log file");
                                }
                            } else {
                                warn!(session_id = %session_id, session = %session_name, "failed to seek log file");
                            }
                        }
                        Err(err) => {
                            warn!(session_id = %session_id, session = %session_name, error = %err, "failed to open log file");
                        }
                    }
                }
                time::sleep(Duration::from_millis(50)).await;
            }
            info!(session_id = %session_id, session = %session_name, "output watcher task exiting");
        })
    }

    async fn tmux_available(&self) -> Result<bool> {
        Ok(self.config.tmux_available)
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
        let (output_bytes, output, last_line) = self.read_tail(end_size).await;
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let assessment = Self::assess(
            &output,
            &last_line,
            quiet_for_ms,
            start.elapsed().as_millis() as u64,
        );
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": self.session_id,
            "assessment": assessment,
            "output_since_input": BASE64_STANDARD.encode(output.as_bytes()),
            "output_bytes": output_bytes,
            "last_line": last_line,
        });
        send_ws_frame(&self.sender, payload)?;
        Ok(())
    }

    async fn read_tail(&self, end_size: u64) -> (usize, String, String) {
        const MAX_READ: usize = 16 * 1024;
        let start = self.start_offset;
        if end_size <= start {
            return (0, String::new(), String::new());
        }
        let to_read = std::cmp::min((end_size - start) as usize, MAX_READ);
        let mut buf = vec![0u8; to_read];
        if let Ok(mut file) = fs::File::open(&self.handle.log_path).await {
            let _ = file.seek(SeekFrom::Start(end_size - to_read as u64)).await;
            let _ = file.read_exact(&mut buf).await;
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let last_line_owned = text
            .lines()
            .last()
            .unwrap_or_else(|| text.trim_end_matches(&['\r', '\n'][..]))
            .to_string();
        (buf.len(), text, last_line_owned)
    }

    fn assess(
        output: &str,
        last_line: &str,
        quiet_for_ms: u64,
        elapsed_ms: u64,
    ) -> serde_json::Value {
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

    fn detect_prompt(last_line: &str) -> (Option<&'static str>, Option<f64>, serde_json::Value) {
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

    fn hints_prompt() -> serde_json::Value {
        json!({
            "looks_like_prompt": true,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": false
        })
    }

    fn hints_none() -> serde_json::Value {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity-based readiness detection (for TUI/REPL apps like Claude Code)
// ─────────────────────────────────────────────────────────────────────────────
//
// Instead of watching for byte output quiescence (which fails for TUI apps that
// have natural pauses during processing), we compare capture-pane screen hashes
// at intervals. When the screen is unchanged for N consecutive checks, we
// declare the terminal "ready".
//
// This approach works because TUI apps like Claude Code update the screen
// frequently during processing (tool calls, thinking indicators, output
// streaming), and become visually stable when idle.

struct ActivityDetector {
    session_id: String,
    handle: Arc<TerminalHandle>,
    sender: OutboundSender,
    initial_delay_ms: u64,
    interval_ms: u64,
    stable_count_required: u32,
    max_wait_ms: u64,
}

impl ActivityDetector {
    fn new(
        session_id: String,
        handle: Arc<TerminalHandle>,
        sender: OutboundSender,
        await_ready: &AwaitReady,
    ) -> Self {
        Self {
            session_id,
            handle,
            sender,
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

        // Initial delay - let the program start processing
        time::sleep(Duration::from_millis(self.initial_delay_ms)).await;

        loop {
            // Check timeout first
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

            // Capture pane and hash
            let output = match self.capture_pane().await {
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
                        // Ready!
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
                    // Content changed - activity detected
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
                    // First capture
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        "activity check: first capture"
                    );
                }
            }

            last_hash = Some(current_hash);

            // Wait for next check
            time::sleep(Duration::from_millis(self.interval_ms)).await;
        }
    }

    async fn capture_pane(&self) -> Result<String> {
        let output = Command::new("tmux")
            .args(["capture-pane", "-p", "-t", &self.handle.session_name])
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane for activity detection")?;

        if !output.status.success() {
            bail!(
                "tmux capture-pane failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    async fn send_ready(
        &self,
        confidence: f64,
        trigger: &str,
        stable_count: u32,
        check_count: u32,
    ) -> Result<()> {
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": self.session_id,
            "assessment": {
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
            }
        });
        send_ws_frame(&self.sender, payload)?;
        Ok(())
    }
}

/// Derive tmux session name from session_id
/// e.g., "sess_01HXYZ..." -> "s_01HXYZ"
fn tmux_session_name(session_id: &str) -> String {
    let suffix = session_id.strip_prefix("sess_").unwrap_or(session_id);
    let name = format!("s_{}", suffix);
    // tmux limits session names to 256 chars, but keep short for readability
    if name.len() > 32 {
        name[..32].to_string()
    } else {
        name
    }
}

/// Get log path for a session
/// base_dir/sessions/{session_id}/terminal.log
fn session_log_path(base_dir: &Path, session_id: &str) -> PathBuf {
    base_dir
        .join("sessions")
        .join(session_id)
        .join("terminal.log")
}

async fn tmux_pane_pid(session_name: &str) -> Result<i32> {
    let output = Command::new("tmux")
        .args(["display-message", "-t", session_name, "-p", "#{pane_pid}"])
        .output()
        .await
        .with_context(|| "failed to get tmux pane pid")?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    text.parse::<i32>()
        .map_err(|err| anyhow!("failed to parse pane pid: {}", err))
}

async fn tmux_pane_cwd(session_name: &str) -> Result<String> {
    let output = Command::new("tmux")
        .args([
            "display-message",
            "-t",
            session_name,
            "-p",
            "#{pane_current_path}",
        ])
        .output()
        .await
        .with_context(|| "failed to get tmux pane cwd")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn stream_pipe<R: AsyncRead + Unpin>(
    mut reader: R,
    run_id: String,
    stream: &str,
    sender: OutboundSender,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let seq_no = seq.fetch_add(1, Ordering::SeqCst);
        send_ws_frame(
            &sender,
            json!({
                "proto": PROTO_VERSION,
                "type": stream,
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "run_id": run_id,
                "seq": seq_no,
                "data": BASE64_STANDARD.encode(chunk)
            }),
        )?;
    }
    Ok(())
}

fn send_ws_frame(sender: &OutboundSender, payload: Value) -> Result<()> {
    let text = serde_json::to_string(&payload)?;
    send_ws_message(sender, Message::Text(text))
}

fn send_ws_message(sender: &OutboundSender, message: Message) -> Result<()> {
    sender
        .send(message)
        .map_err(|_| anyhow!("websocket disconnected"))
}

impl BudApp {
    async fn new(args: BudArgs) -> Self {
        let identity_path = PathBuf::from(shellexpand::tilde(&args.identity_file).into_owned());
        let installation_id_path = installation_id_path(&identity_path);
        let default_cwd = expand_path(&args.cwd)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let default_shell = default_shell().to_string();
        let (tmux_available, tmux_version) = probe_tmux();
        let debug_enabled = args.debug;
        let terminal_config = TerminalConfig {
            enabled: args.terminal_enabled,
            base_log_dir: expand_path(&args.terminal_base_dir)
                .unwrap_or_else(|| PathBuf::from(&args.terminal_base_dir)),
            cols: args.terminal_cols,
            rows: args.terminal_rows,
            shell: default_shell.clone(),
            tmux_available,
            tmux_version,
            debug_enabled,
        };
        Self {
            args,
            identity_path,
            installation_id_path,
            installation_id: String::new(),
            identity: None,
            run_executor: RunExecutor::new(default_cwd),
            terminal_manager: TerminalManager::new(terminal_config),
            http_client: Client::new(),
            debug_enabled,
        }
    }

    async fn run(mut self) -> Result<()> {
        self.installation_id = self.load_or_create_installation_id().await?;
        self.identity = self.load_identity().await?;
        if let Some(identity) = &self.identity {
            info!(bud_id = %identity.bud_id, "Loaded existing identity");
        } else {
            info!(
                installation_id = %self.installation_id,
                "No device credential found; device claim will be required"
            );
        }

        loop {
            match self.connect_once().await {
                Ok(_) => info!("Session ended; reconnecting"),
                Err(err) => warn!(error = ?err, "Session failed; retrying"),
            }
            time::sleep(Duration::from_secs(self.args.reconnect_base_sec)).await;
        }
    }

    async fn connect_once(&mut self) -> Result<()> {
        loop {
            if self.identity.is_none() && self.args.token.is_none() {
                self.bootstrap_device_auth().await?;
            }

            let url = Url::parse(&self.args.server)?;
            info!(server = %url, "Connecting to backend");
            let (stream, _) = connect_async(url.clone())
                .await
                .with_context(|| format!("failed to connect to {}", url))?;

            match self.perform_handshake(stream).await {
                Ok((stream, meta)) => {
                    info!(
                        bud_id = %meta.bud_id,
                        session_id = %meta.session_id,
                        heartbeat_sec = meta.heartbeat_sec,
                        "Handshake established"
                    );
                    return self.run_session(stream, meta).await;
                }
                Err(HandshakeError::AuthFailed { code, message }) => {
                    if self.args.token.is_some() {
                        bail!(
                            "backend error during handshake (code={}): {}",
                            code,
                            message
                        );
                    }

                    warn!(
                        code = %code,
                        message = %message,
                        "Stored device credential rejected; starting device claim flow"
                    );
                    self.clear_identity().await?;
                    self.bootstrap_device_auth().await?;
                }
                Err(HandshakeError::Other(err)) => return Err(err),
            }
        }
    }

    async fn perform_handshake(
        &mut self,
        mut stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) -> std::result::Result<
        (WebSocketStream<MaybeTlsStream<TcpStream>>, SessionMeta),
        HandshakeError,
    > {
        let hello_frame = self.build_hello_frame().map_err(HandshakeError::Other)?;
        stream
            .send(Message::Text(
                serde_json::to_string(&hello_frame)
                    .map_err(|err| HandshakeError::Other(err.into()))?,
            ))
            .await
            .map_err(|err| HandshakeError::Other(err.into()))?;

        loop {
            let Some(msg) = stream.next().await else {
                return Err(HandshakeError::Other(anyhow!(
                    "connection closed before handshake completed"
                )));
            };
            match msg {
                Ok(Message::Text(text)) => {
                    let envelope: Envelope = serde_json::from_str(&text)
                        .map_err(|err| HandshakeError::Other(err.into()))?;
                    match envelope.kind.as_str() {
                        "hello_ack" => {
                            let ack: HelloAckFrame = serde_json::from_str(&text)
                                .map_err(|err| HandshakeError::Other(err.into()))?;
                            if let Some(secret) = ack.device_secret.clone() {
                                let new_identity = DeviceIdentity {
                                    bud_id: ack.bud_id.clone(),
                                    device_secret: secret,
                                    server_url: self.args.server.clone(),
                                    name: self.args.name.clone(),
                                    default_cwd: self.args.cwd.clone(),
                                };
                                self.persist_identity(&new_identity)
                                    .await
                                    .map_err(HandshakeError::Other)?;
                                self.identity = Some(new_identity);
                                self.args.token = None;
                            } else if self.identity.is_none() {
                                return Err(HandshakeError::Other(anyhow!(
                                    "hello_ack missing device_secret during enrollment"
                                )));
                            }
                            let meta = SessionMeta {
                                bud_id: ack.bud_id,
                                session_id: ack.session_id,
                                heartbeat_sec: ack.heartbeat_sec.unwrap_or(DEFAULT_HEARTBEAT_SEC),
                            };
                            return Ok((stream, meta));
                        }
                        "hello_challenge" => {
                            let challenge: HelloChallengeFrame = serde_json::from_str(&text)
                                .map_err(|err| HandshakeError::Other(err.into()))?;
                            let identity = self.identity.as_ref().ok_or_else(|| {
                                HandshakeError::Other(anyhow!(
                                    "no identity available for challenge"
                                ))
                            })?;
                            let proof = compute_hmac(&identity.device_secret, &challenge.nonce)
                                .map_err(HandshakeError::Other)?;
                            let proof_frame = json!({
                                "proto": PROTO_VERSION,
                                "type": "hello_proof",
                                "id": new_message_id(),
                                "ts": now_millis(),
                                "ext": {},
                                "bud_id": identity.bud_id,
                                "hmac": proof
                            });
                            stream
                                .send(Message::Text(
                                    serde_json::to_string(&proof_frame)
                                        .map_err(|err| HandshakeError::Other(err.into()))?,
                                ))
                                .await
                                .map_err(|err| HandshakeError::Other(err.into()))?;
                        }
                        "error" => {
                            let err_frame: ErrorFrame = serde_json::from_str(&text)
                                .map_err(|err| HandshakeError::Other(err.into()))?;
                            if err_frame.code == "AUTH_FAILED" {
                                return Err(HandshakeError::AuthFailed {
                                    code: err_frame.code,
                                    message: err_frame.message,
                                });
                            }
                            return Err(HandshakeError::Other(anyhow!(
                                "backend error during handshake (code={}): {}",
                                err_frame.code,
                                err_frame.message
                            )));
                        }
                        other => warn!(frame_type = other, "Unexpected frame during handshake"),
                    }
                }
                Ok(Message::Ping(payload)) => {
                    stream
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|err| HandshakeError::Other(err.into()))?;
                }
                Ok(Message::Close(frame)) => {
                    return Err(HandshakeError::Other(anyhow!(
                        "connection closed during handshake: {:?}",
                        frame
                    )));
                }
                Ok(Message::Binary(_)) => {}
                Err(err) => return Err(HandshakeError::Other(err.into())),
                _ => {}
            }
        }
    }

    async fn run_session(
        &self,
        stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
        meta: SessionMeta,
    ) -> Result<()> {
        let mut interval = time::interval(Duration::from_secs(meta.heartbeat_sec.max(5)));
        let (write, mut read) = stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let sender = Arc::new(tx);

        let writer_handle = task::spawn_local(async move {
            let mut sink = write;
            while let Some(message) = rx.recv().await {
                if let Err(err) = sink.send(message).await {
                    warn!(error = %err, "Failed to send WS frame");
                    break;
                }
            }
        });

        self.run_executor.set_sender(sender.clone()).await;
        self.terminal_manager.set_sender(sender.clone()).await;
        // Note: terminal sessions are now created on-demand via terminal_ensure
        // No longer auto-creating a single session on connect
        if self.terminal_manager.config.enabled && !self.terminal_manager.config.tmux_available {
            info!("terminal enabled but tmux unavailable; terminal sessions will fail");
        }

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let heartbeat = json!({
                        "proto": PROTO_VERSION,
                        "type": "heartbeat",
                        "id": new_message_id(),
                        "ts": now_millis(),
                        "ext": {},
                        "session_id": meta.session_id
                    });
                    if let Err(err) = send_ws_frame(&sender, heartbeat) {
                        self.run_executor.clear_sender().await;
                        self.terminal_manager.clear_sender().await;
                        drop(sender);
                        let _ = writer_handle.await;
                        return Err(err);
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            self.handle_server_frame(&text).await?;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if let Err(err) = send_ws_message(&sender, Message::Pong(payload)) {
                                self.run_executor.clear_sender().await;
                                self.terminal_manager.clear_sender().await;
                                drop(sender);
                                let _ = writer_handle.await;
                                return Err(err);
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            info!(?frame, "Server closed connection");
                            self.run_executor.clear_sender().await;
                            self.terminal_manager.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Ok(());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            if self.debug_enabled {
                                info!(error = %err, "WS read error; reconnecting soon");
                            }
                            self.run_executor.clear_sender().await;
                            self.terminal_manager.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Err(err.into());
                        }
                        None => {
                            if self.debug_enabled {
                                info!("WS stream ended; reconnecting");
                            }
                            self.run_executor.clear_sender().await;
                            self.terminal_manager.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    async fn handle_server_frame(&self, text: &str) -> Result<()> {
        let envelope: Envelope = serde_json::from_str(text)?;
        match envelope.kind.as_str() {
            "run" => {
                let frame: RunFrame = serde_json::from_str(text)?;
                self.handle_run_frame(frame).await?;
            }
            "terminal_ensure" => {
                let frame: TerminalEnsureFrame = serde_json::from_str(text)?;
                info!(
                    message_id = %frame.envelope.id,
                    session_id = %frame.session_id,
                    "terminal_ensure received"
                );
                self.terminal_manager.handle_ensure(frame).await?;
            }
            "terminal_input" => {
                let frame: TerminalInputFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_input(frame).await?;
            }
            "terminal_resize" => {
                let frame: TerminalResizeFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_resize(frame).await?;
            }
            "terminal_interrupt" => {
                let frame: TerminalInterruptFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_interrupt(frame).await?;
            }
            "terminal_close" => {
                let frame: TerminalCloseFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_close(frame).await?;
            }
            "terminal_send" => {
                let frame: TerminalSendFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_send(frame).await?;
            }
            "terminal_observe" => {
                let frame: TerminalObserveFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_observe(frame).await?;
            }
            "error" => {
                let err: ErrorFrame = serde_json::from_str(text)?;
                warn!(code = %err.code, message = %err.message, "Backend error");
            }
            "log_ack" | "hello_ack" | "hello_challenge" => {}
            other => warn!(frame_type = other, "Unhandled frame type"),
        }
        Ok(())
    }

    async fn handle_run_frame(&self, frame: RunFrame) -> Result<()> {
        let mut env = frame.env.unwrap_or_default();
        env.entry("CI".into()).or_insert_with(|| "1".into());
        env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
        env.entry("GIT_ASKPASS".into())
            .or_insert_with(|| "/bin/true".into());

        let command = self
            .run_executor
            .prepare_command(
                frame.run_id.clone(),
                frame.cmd.clone(),
                frame.cwd.clone(),
                env,
                frame.timeout_ms.unwrap_or(30 * 60 * 1000),
            )
            .await?;

        info!(
            run_id = %command.run_id,
            cmd = %command.cmd,
            cwd = %command.cwd.display(),
            "Received run frame from backend"
        );

        self.run_executor.enqueue(command).await?;
        Ok(())
    }

    async fn load_identity(&self) -> Result<Option<DeviceIdentity>> {
        match fs::read(&self.identity_path).await {
            Ok(bytes) => {
                let identity = match serde_json::from_slice::<DeviceIdentity>(&bytes) {
                    Ok(identity) => identity,
                    Err(err) => {
                        warn!(
                            path = %self.identity_path.display(),
                            error = %err,
                            "Stored bud identity is invalid; reauth will be required"
                        );
                        return Ok(None);
                    }
                };

                if identity.bud_id.trim().is_empty() || identity.device_secret.trim().is_empty() {
                    warn!(
                        path = %self.identity_path.display(),
                        "Stored bud identity is incomplete; reauth will be required"
                    );
                    return Ok(None);
                }

                Ok(Some(identity))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    async fn persist_identity(&self, identity: &DeviceIdentity) -> Result<()> {
        let serialized = serde_json::to_vec_pretty(identity)?;
        write_private_file(&self.identity_path, &serialized).await?;
        info!(
            bud_id = %identity.bud_id,
            path = %self.identity_path.display(),
            "Saved bud identity"
        );
        Ok(())
    }

    fn build_hello_frame(&self) -> Result<Value> {
        let mut frame = Map::new();
        frame.insert("proto".into(), Value::String(PROTO_VERSION.into()));
        frame.insert("type".into(), Value::String("hello".into()));
        frame.insert("id".into(), Value::String(new_message_id()));
        frame.insert("ts".into(), Value::Number(Number::from(now_millis())));
        frame.insert("ext".into(), json!({}));
        frame.insert("name".into(), Value::String(self.args.name.clone()));
        frame.insert("os".into(), Value::String(std::env::consts::OS.into()));
        frame.insert("arch".into(), Value::String(std::env::consts::ARCH.into()));
        frame.insert(
            "version".into(),
            Value::String(env!("CARGO_PKG_VERSION").into()),
        );
        frame.insert(
            "installation_id".into(),
            Value::String(self.installation_id.clone()),
        );
        frame.insert("capabilities".into(), self.device_capabilities());

        if let Some(identity) = &self.identity {
            frame.insert("bud_id".into(), Value::String(identity.bud_id.clone()));
        } else if let Some(token) = &self.args.token {
            frame.insert("token".into(), Value::String(token.clone()));
        } else {
            bail!("No device credential found and no enrollment token provided");
        }

        Ok(Value::Object(frame))
    }

    fn device_capabilities(&self) -> Value {
        json!({
            "max_concurrency": 1,
            "supports_pty": true,
            "shell_default": "/bin/bash",
            "sessions": true,
            "sessions_backends": if self.args.terminal_enabled && self.terminal_manager.config.tmux_available {
                json!(["pty","tmux"])
            } else { json!(["pty"]) },
            "terminal": self.args.terminal_enabled && self.terminal_manager.config.tmux_available,
            "terminal_proto": TERMINAL_PROTO_VERSION,
            "terminal_backends": if self.args.terminal_enabled && self.terminal_manager.config.tmux_available { json!(["tmux"]) } else { json!([]) },
            "tmux_version": self.terminal_manager.config.tmux_version,
        })
    }

    async fn load_or_create_installation_id(&self) -> Result<String> {
        match fs::read_to_string(&self.installation_id_path).await {
            Ok(value) => {
                let installation_id = value.trim().to_string();
                if installation_id.is_empty() {
                    bail!("installation id file is empty");
                }
                Ok(installation_id)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let installation_id = format!("inst_{}", Ulid::new());
                write_private_file(&self.installation_id_path, installation_id.as_bytes()).await?;
                info!(
                    installation_id = %installation_id,
                    path = %self.installation_id_path.display(),
                    "Generated installation identity"
                );
                Ok(installation_id)
            }
            Err(err) => Err(err.into()),
        }
    }

    async fn clear_identity(&mut self) -> Result<()> {
        self.identity = None;
        match fs::remove_file(&self.identity_path).await {
            Ok(()) => {
                info!(path = %self.identity_path.display(), "Removed invalid bud identity");
                Ok(())
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    async fn bootstrap_device_auth(&mut self) -> Result<()> {
        let start = self.start_device_auth_flow().await?;
        print_device_claim_instructions(&start);

        loop {
            let poll = self.poll_device_auth_flow(&start).await?;
            match poll.status.as_str() {
                "pending" => {
                    let wait_ms = poll
                        .poll_interval_ms
                        .or(start.poll_interval_ms)
                        .unwrap_or(2_000)
                        .max(500);
                    time::sleep(Duration::from_millis(wait_ms)).await;
                }
                "approved" => {
                    let bud_id = poll
                        .bud_id
                        .clone()
                        .ok_or_else(|| anyhow!("device auth response missing bud_id"))?;
                    let device_secret = poll
                        .device_secret
                        .clone()
                        .ok_or_else(|| anyhow!("device auth response missing device_secret"))?;
                    let identity = DeviceIdentity {
                        bud_id: bud_id.clone(),
                        device_secret,
                        server_url: self.args.server.clone(),
                        name: self.args.name.clone(),
                        default_cwd: self.args.cwd.clone(),
                    };
                    self.persist_identity(&identity).await?;
                    self.identity = Some(identity);
                    self.args.token = None;
                    println!();
                    println!("Device claim approved for Bud `{}`. Connecting...", bud_id);
                    println!();
                    return Ok(());
                }
                "rejected" => {
                    bail!(
                        "device claim rejected{}",
                        poll.error_code
                            .as_ref()
                            .map(|code| format!(" ({})", code))
                            .unwrap_or_default()
                    );
                }
                "expired" => {
                    bail!(
                        "device claim expired before approval{}",
                        poll.expires_at
                            .as_ref()
                            .map(|value| format!(" at {}", value))
                            .unwrap_or_default()
                    );
                }
                "completed" => {
                    bail!("device claim already completed on another connection");
                }
                other => bail!("unknown device auth status: {}", other),
            }
        }
    }

    async fn start_device_auth_flow(&self) -> Result<DeviceAuthStartResponse> {
        let api_base = api_base_url_from_ws_url(&self.args.server)?;
        let response = self
            .http_client
            .post(api_base.join("api/device-auth/start")?)
            .json(&json!({
                "installation_id": self.installation_id.clone(),
                "name": self.args.name.clone(),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "version": env!("CARGO_PKG_VERSION"),
                "capabilities": self.device_capabilities(),
            }))
            .send()
            .await
            .with_context(|| "failed to start device auth flow")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("device auth start failed (status={}): {}", status, body);
        }

        response
            .json::<DeviceAuthStartResponse>()
            .await
            .with_context(|| "failed to parse device auth start response")
    }

    async fn poll_device_auth_flow(
        &self,
        start: &DeviceAuthStartResponse,
    ) -> Result<DeviceAuthPollResponse> {
        let api_base = api_base_url_from_ws_url(&self.args.server)?;
        let response = self
            .http_client
            .post(api_base.join("api/device-auth/poll")?)
            .json(&json!({
                "flow_id": start.flow_id.clone(),
                "poll_secret": start.poll_secret.clone(),
            }))
            .send()
            .await
            .with_context(|| "failed to poll device auth flow")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("device auth poll failed (status={}): {}", status, body);
        }

        response
            .json::<DeviceAuthPollResponse>()
            .await
            .with_context(|| "failed to parse device auth poll response")
    }
}

fn compute_hmac(secret: &str, nonce: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| anyhow!("invalid device secret length"))?;
    mac.update(nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn print_device_claim_instructions(start: &DeviceAuthStartResponse) {
    println!();
    println!("Bud needs browser approval before it can connect.");
    println!("Open this link on a signed-in browser:");
    println!("{}", start.claim_url);
    println!();
    println!(
        "Claim expires at {}. Waiting for browser approval...",
        start.expires_at
    );
    println!();
    if let Err(err) = print_terminal_qr(&start.qr_payload) {
        warn!(error = %err, "Failed to render terminal QR code");
        println!("QR rendering failed. Open the claim URL above instead.");
    }
    println!();
}

fn print_terminal_qr(payload: &str) -> Result<()> {
    let qr = QrCode::encode_text(payload, QrCodeEcc::Medium)
        .map_err(|_| anyhow!("failed to encode QR payload"))?;
    let size = qr.size();
    let border = 2;
    let mut y = -border;
    while y < size + border {
        let mut line = String::new();
        for x in -border..(size + border) {
            let top = qr_module(&qr, x, y);
            let bottom = qr_module(&qr, x, y + 1);
            let ch = match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            };
            line.push(ch);
            line.push(ch);
        }
        println!("{}", line);
        y += 2;
    }
    Ok(())
}

fn qr_module(qr: &QrCode, x: i32, y: i32) -> bool {
    x >= 0 && y >= 0 && x < qr.size() && y < qr.size() && qr.get_module(x, y)
}

fn new_message_id() -> String {
    Ulid::new().to_string()
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_shell() -> &'static str {
    // Respect user's configured shell from $SHELL
    if let Ok(shell) = std::env::var("SHELL") {
        if Path::new(&shell).exists() {
            // Leak the string to get a static reference (acceptable for startup config)
            return Box::leak(shell.into_boxed_str());
        }
    }
    // Fallback to bash or sh
    if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    }
}

fn expand_path(path: &str) -> Option<PathBuf> {
    Some(PathBuf::from(shellexpand::tilde(path).into_owned()))
}

fn installation_id_path(identity_path: &Path) -> PathBuf {
    match identity_path.parent() {
        Some(parent) => parent.join("installation-id"),
        None => PathBuf::from("installation-id"),
    }
}

fn api_base_url_from_ws_url(ws_url: &str) -> Result<Url> {
    let mut url = Url::parse(ws_url)?;
    match url.scheme() {
        "wss" => url
            .set_scheme("https")
            .map_err(|_| anyhow!("failed to convert wss URL to https"))?,
        "ws" => url
            .set_scheme("http")
            .map_err(|_| anyhow!("failed to convert ws URL to http"))?,
        "https" | "http" => {}
        other => bail!("unsupported server URL scheme: {}", other),
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || std::fs::set_permissions(path, perms)).await??;
    }

    file.write_all(bytes).await?;
    file.sync_all().await?;
    Ok(())
}

fn probe_tmux() -> (bool, Option<String>) {
    use std::process::Command as StdCommand;
    let output = StdCommand::new("tmux").arg("-V").output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let version = text
                .split_whitespace()
                .nth(1)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            (true, version)
        }
        _ => (false, None),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    setup_tracing();
    let args = BudArgs::parse();
    let app = BudApp::new(args).await;
    LocalSet::new().run_until(app.run()).await
}

fn setup_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).with_target(false).init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_screen_wait_mode_supports_phase_seven_modes() {
        assert_eq!(parse_screen_wait_mode("none").unwrap(), ScreenWaitMode::None);
        assert_eq!(parse_screen_wait_mode("changed").unwrap(), ScreenWaitMode::Changed);
        assert_eq!(parse_screen_wait_mode("settled").unwrap(), ScreenWaitMode::Settled);
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
    fn resolve_terminal_send_observe_defaults_when_observe_object_is_present() {
        let frame = TerminalSendFrame {
            envelope: Envelope {
                kind: "terminal_send".to_string(),
                proto: TERMINAL_PROTO_VERSION.to_string(),
                id: "msg_1".to_string(),
                ts: 0,
                ext: Value::Null,
            },
            session_id: "sess_1".to_string(),
            request_id: "send_1".to_string(),
            text: Some("pwd".to_string()),
            submit: Some(true),
            keys: Some(vec![]),
            observe: Some(TerminalSendObserveFrame {
                after_ms: None,
                wait_for: None,
                timeout_ms: None,
            }),
        };

        let observe = resolve_terminal_send_observe(&frame).expect("observe config");
        assert_eq!(observe.after_ms, 1000);
        assert_eq!(observe.wait_for, "none");
        assert_eq!(observe.timeout_ms, 5_000);
    }

    #[test]
    fn resolve_terminal_send_observe_is_none_for_dispatch_only_requests() {
        let frame = TerminalSendFrame {
            envelope: Envelope {
                kind: "terminal_send".to_string(),
                proto: TERMINAL_PROTO_VERSION.to_string(),
                id: "msg_1".to_string(),
                ts: 0,
                ext: Value::Null,
            },
            session_id: "sess_1".to_string(),
            request_id: "send_1".to_string(),
            text: Some("a".to_string()),
            submit: Some(false),
            keys: Some(vec![]),
            observe: None,
        };

        assert!(resolve_terminal_send_observe(&frame).is_none());
    }
}
