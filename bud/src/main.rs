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

    #[arg(
        long,
        env = "BUD_TERMINAL_BASE_DIR",
        default_value = "~/.bud"
    )]
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
    identity: Option<DeviceIdentity>,
    run_executor: RunExecutor,
    terminal_manager: TerminalManager,
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
}

#[derive(Clone)]
struct TerminalManager {
    inner: Arc<Mutex<TerminalState>>,
    config: TerminalConfig,
}

struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,
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
    activity_interval_ms: Option<u64>,      // Default: 5000ms between checks
    activity_stable_count: Option<u32>,     // Default: 2 consecutive stable checks
    activity_initial_delay_ms: Option<u64>, // Default: 2000ms before first check
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalCaptureFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    request_id: String,
    #[serde(default)]
    options: CaptureOptions,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct CaptureOptions {
    start_line: Option<i32>,    // -N for scrollback, 0 for top, None for all
    end_line: Option<i32>,      // None for bottom
    escape_sequences: bool,     // -e flag (include ANSI colors)
    join_lines: bool,           // -J flag (join wrapped lines)
}

/// Request-response pattern for terminal.run tool
/// Service sends input, Bud waits for readiness and returns output directly
#[derive(Debug, Deserialize, Clone)]
struct TerminalRunFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    request_id: String,
    #[serde(rename = "input")]
    data: String, // base64
    mode: Option<String>, // "shell" | "repl"
    timeout_ms: Option<u64>,
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

impl TerminalManager {
    fn new(config: TerminalConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalState {
                sender: None,
                sessions: HashMap::new(),
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
            self.send_status(&sender, session_id, "none", Some(json!({ "error": "terminal_create_failed" })))
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

        if frame.await_ready.as_ref().map(|a| a.enabled).unwrap_or(false) {
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
                    let detector = ActivityDetector::new(session_id_owned, handle.clone(), sender, &await_ready);
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

        if frame.await_ready.as_ref().map(|a| a.enabled).unwrap_or(false) {
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
                    let detector = ActivityDetector::new(session_id_owned, handle.clone(), sender, &await_ready);
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
        drop(inner);

        if let Some(sender) = sender {
            self.send_status(&sender, session_id, "closed", None).await?;
        }

        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            reason = %frame.reason.clone().unwrap_or_default(),
            "terminal_close handled"
        );
        Ok(())
    }

    async fn handle_capture(&self, frame: TerminalCaptureFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let (handle, sender) = {
            let inner = self.inner.lock().await;
            (inner.sessions.get(session_id).cloned(), inner.sender.clone())
        };

        let Some(sender) = sender else {
            warn!(
                request_id = %frame.request_id,
                session_id = session_id,
                "terminal_capture dropped; no sender"
            );
            return Ok(());
        };

        // If no session handle, send error response
        let Some(handle) = handle else {
            let response = json!({
                "proto": TERMINAL_PROTO_VERSION,
                "type": "terminal_capture_response",
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "session_id": session_id,
                "request_id": frame.request_id,
                "output": "",
                "output_bytes": 0,
                "lines_captured": 0,
                "error": "no_session"
            });
            send_ws_frame(&sender, response)?;
            return Ok(());
        };

        // Build capture-pane command
        let mut args = vec!["capture-pane", "-p", "-t", &handle.session_name];

        // Temporary storage for string representations
        let start_str;
        let end_str;

        if frame.options.join_lines {
            args.push("-J");
        }
        if frame.options.escape_sequences {
            args.push("-e");
        }
        if let Some(start) = frame.options.start_line {
            start_str = start.to_string();
            args.extend(["-S", &start_str]);
        }
        if let Some(end) = frame.options.end_line {
            end_str = end.to_string();
            args.extend(["-E", &end_str]);
        }

        info!(
            request_id = %frame.request_id,
            session_id = session_id,
            session = %handle.session_name,
            start_line = ?frame.options.start_line,
            end_line = ?frame.options.end_line,
            "executing capture-pane"
        );

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane")?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).to_string();
            let response = json!({
                "proto": TERMINAL_PROTO_VERSION,
                "type": "terminal_capture_response",
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "session_id": session_id,
                "request_id": frame.request_id,
                "output": "",
                "output_bytes": 0,
                "lines_captured": 0,
                "error": error
            });
            send_ws_frame(&sender, response)?;
            return Ok(());
        }

        let output_str = String::from_utf8_lossy(&output.stdout);
        let line_count = output_str.lines().count();

        info!(
            request_id = %frame.request_id,
            session_id = session_id,
            output_bytes = output.stdout.len(),
            lines_captured = line_count,
            "capture-pane completed"
        );

        // Send response with raw output (no deduplication - let service layer handle if needed)
        let response = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_capture_response",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": frame.request_id,
            "output": BASE64_STANDARD.encode(output_str.as_bytes()),
            "output_bytes": output_str.len(),
            "lines_captured": line_count,
            "error": Value::Null
        });

        send_ws_frame(&sender, response)?;
        Ok(())
    }

    /// Handle terminal_run request (request-response pattern for terminal.run tool)
    /// Sends input to terminal, waits for readiness, and returns output directly
    async fn handle_run(&self, frame: TerminalRunFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_run_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let mode = frame.mode.as_deref().unwrap_or("shell");
        let timeout_ms = frame.timeout_ms.unwrap_or(30_000);

        // Decode input
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal run input: {}", err))?;

        // Get session handle
        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            return self.send_run_error(&frame, "session_not_found").await;
        };

        // Get sender
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = request_id,
                session_id = session_id,
                "terminal_run dropped; no sender"
            );
            return Ok(());
        };

        // Record starting offset (for shell mode output retrieval)
        let start_offset = handle.offset.load(Ordering::SeqCst);

        info!(
            request_id = request_id,
            session_id = session_id,
            mode = mode,
            input_bytes = data.len(),
            start_offset = start_offset,
            "terminal_run received"
        );

        // Send input to tmux (same logic as handle_input)
        let input = String::from_utf8_lossy(&data).to_string();
        let trimmed_end = input.trim_end_matches(|c| c == '\n' || c == '\r');
        let newline_count = input.len() - trimmed_end.len();

        if !trimmed_end.is_empty() {
            let status = Command::new("tmux")
                .args(["send-keys", "-t", &handle.session_name, "-l", trimmed_end])
                .status()
                .await
                .with_context(|| "failed to dispatch tmux send-keys")?;
            if !status.success() {
                return self.send_run_error(&frame, "send_keys_failed").await;
            }
        }

        for _ in 0..newline_count {
            let status = Command::new("tmux")
                .args(["send-keys", "-t", &handle.session_name, "Enter"])
                .status()
                .await?;
            if !status.success() {
                warn!(request_id = request_id, "tmux send-keys Enter failed");
            }
        }

        // Wait for readiness and collect output
        let (assessment, output, output_bytes, truncated) = if mode == "repl" {
            // Activity-based: compare capture-pane hashes
            self.wait_activity_and_capture(&handle, timeout_ms).await?
        } else {
            // Quiescence-based: watch log file
            self.wait_quiescence_and_read(&handle, start_offset, timeout_ms).await?
        };

        // Send response
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_run_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": request_id,
            "output": BASE64_STANDARD.encode(&output),
            "output_bytes": output_bytes,
            "truncated": truncated,
            "readiness": assessment,
            "error": Value::Null,
        });
        send_ws_frame(&sender, payload)?;

        info!(
            request_id = request_id,
            session_id = session_id,
            output_bytes = output_bytes,
            truncated = truncated,
            "terminal_run_result sent"
        );

        Ok(())
    }

    /// Send error response for terminal_run
    async fn send_run_error(&self, frame: &TerminalRunFrame, error: &str) -> Result<()> {
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let Some(sender) = sender else {
            warn!(
                request_id = %frame.request_id,
                error = error,
                "terminal_run error but no sender"
            );
            return Ok(());
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_run_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": frame.session_id,
            "request_id": frame.request_id,
            "output": "",
            "output_bytes": 0,
            "truncated": false,
            "readiness": {
                "ready": false,
                "confidence": 0.0,
                "trigger": "error",
                "hints": {}
            },
            "error": error,
        });
        send_ws_frame(&sender, payload)?;
        Ok(())
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

        let (output, truncated) =
            self.read_log_range(&log_path, start_offset, end_size, MAX_OUTPUT)
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
        timeout_ms: u64,
    ) -> Result<(serde_json::Value, Vec<u8>, usize, bool)> {
        let interval_ms = 5000;
        let stable_count_target = 2;
        let initial_delay_ms = 2000;

        // Initial delay
        time::sleep(Duration::from_millis(initial_delay_ms)).await;

        let start = Instant::now();
        let mut last_hash: Option<u64> = None;
        let mut stable_count = 0;
        let mut check_count = 0;

        loop {
            // Check timeout
            if start.elapsed() >= Duration::from_millis(timeout_ms) {
                break;
            }

            // Capture pane and hash
            let capture = self.run_capture_pane(&handle.session_name).await?;
            let hash = self.hash_content(&capture);
            check_count += 1;

            if Some(hash) == last_hash {
                stable_count += 1;
                if stable_count >= stable_count_target {
                    // Screen is stable
                    break;
                }
            } else {
                stable_count = 0;
            }
            last_hash = Some(hash);

            time::sleep(Duration::from_millis(interval_ms)).await;
        }

        // Final capture for output
        let capture = self.run_capture_pane(&handle.session_name).await?;
        let output = capture.into_bytes();
        let output_bytes = output.len();

        let confidence = if stable_count >= stable_count_target {
            0.85
        } else {
            0.5
        };
        let trigger = if stable_count >= stable_count_target {
            "activity_stable"
        } else {
            "timeout"
        };

        let assessment = json!({
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

        Ok((assessment, output, output_bytes, false)) // capture-pane doesn't truncate
    }

    /// Run tmux capture-pane and return the output
    async fn run_capture_pane(&self, session_name: &str) -> Result<String> {
        let output = Command::new("tmux")
            .args(["capture-pane", "-p", "-t", session_name])
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
                    map.insert("info".into(), json!({
                        "tmux_session": handle.session_name,
                        "cols": handle.cols,
                        "rows": handle.rows,
                    }));
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
            inner.sessions.insert(session_id.to_string(), handle.clone());
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
            .args(["pipe-pane", "-t", &tmux_name])  // Stop existing pipe
            .status()
            .await;
        let pipe_cmd = format!("cat >> {}", log_path.display());
        let pipe_status = Command::new("tmux")
            .args(["pipe-pane", "-t", &tmux_name, &pipe_cmd])  // Start new pipe (no -o)
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
        let _ = self.send_status(&sender, session_id, "ready", Some(info)).await;
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
        let assessment = Self::assess(&output, &last_line, quiet_for_ms, start.elapsed().as_millis() as u64);
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

    fn assess(output: &str, last_line: &str, quiet_for_ms: u64, elapsed_ms: u64) -> serde_json::Value {
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
        if trimmed.ends_with('$') || trimmed.ends_with('#') || trimmed.ends_with('>') || trimmed.ends_with('%') {
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
        let trigger = if elapsed_ms >= 30_000 { "timeout" } else { "quiescence" };
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
        if line.ends_with('$') || line.ends_with('#') || line.ends_with('%') || line.contains(":~$") {
            return (Some("shell"), Some(0.95), Self::hints_prompt());
        }
        if line.starts_with(">>>") || line.starts_with("...") || line.starts_with("In [") {
            return (Some("python"), Some(0.95), Self::hints_prompt());
        }
        if line == ">" {
            return (Some("node"), Some(0.85), Self::hints_prompt());
        }
        if line.contains("[y/n]") || line.contains("[Y/n]") || lower.contains("yes/no") || lower.contains("continue?") || lower.contains("(yes/no)") {
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
        if lower.ends_with("mysql>") || lower.ends_with("postgres=#") || lower.ends_with("postgres=>") || lower.ends_with("sqlite>") {
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
    base_dir.join("sessions").join(session_id).join("terminal.log")
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
        };
        Self {
            args,
            identity_path,
            identity: None,
            run_executor: RunExecutor::new(default_cwd),
            terminal_manager: TerminalManager::new(terminal_config),
            debug_enabled,
        }
    }

    async fn run(mut self) -> Result<()> {
        self.identity = self.load_identity().await?;
        if let Some(identity) = &self.identity {
            info!(bud_id = %identity.bud_id, "Loaded existing identity");
        } else {
            info!("No identity found; expecting enrollment token");
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
        let url = Url::parse(&self.args.server)?;
        info!(server = %url, "Connecting to backend");
        let (stream, _) = connect_async(url.clone())
            .await
            .with_context(|| format!("failed to connect to {}", url))?;

        let (stream, meta) = self.perform_handshake(stream).await?;
        info!(
            bud_id = %meta.bud_id,
            session_id = %meta.session_id,
            heartbeat_sec = meta.heartbeat_sec,
            "Handshake established"
        );
        self.run_session(stream, meta).await
    }

    async fn perform_handshake(
        &mut self,
        mut stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, SessionMeta)> {
        let hello_frame = self.build_hello_frame()?;
        stream
            .send(Message::Text(serde_json::to_string(&hello_frame)?))
            .await?;

        loop {
            let Some(msg) = stream.next().await else {
                bail!("connection closed before handshake completed");
            };
            match msg {
                Ok(Message::Text(text)) => {
                    let envelope: Envelope = serde_json::from_str(&text)?;
                    match envelope.kind.as_str() {
                        "hello_ack" => {
                            let ack: HelloAckFrame = serde_json::from_str(&text)?;
                            if let Some(secret) = ack.device_secret.clone() {
                                let new_identity = DeviceIdentity {
                                    bud_id: ack.bud_id.clone(),
                                    device_secret: secret,
                                    server_url: self.args.server.clone(),
                                    name: self.args.name.clone(),
                                    default_cwd: self.args.cwd.clone(),
                                };
                                self.persist_identity(&new_identity).await?;
                                self.identity = Some(new_identity);
                                self.args.token = None;
                            } else if self.identity.is_none() {
                                bail!("hello_ack missing device_secret during enrollment");
                            }
                            let meta = SessionMeta {
                                bud_id: ack.bud_id,
                                session_id: ack.session_id,
                                heartbeat_sec: ack.heartbeat_sec.unwrap_or(DEFAULT_HEARTBEAT_SEC),
                            };
                            return Ok((stream, meta));
                        }
                        "hello_challenge" => {
                            let challenge: HelloChallengeFrame = serde_json::from_str(&text)?;
                            let identity = self
                                .identity
                                .as_ref()
                                .ok_or_else(|| anyhow!("no identity available for challenge"))?;
                            let proof = compute_hmac(&identity.device_secret, &challenge.nonce)?;
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
                                .send(Message::Text(serde_json::to_string(&proof_frame)?))
                                .await?;
                        }
                        "error" => {
                            let err_frame: ErrorFrame = serde_json::from_str(&text)?;
                            bail!(
                                "backend error during handshake (code={}): {}",
                                err_frame.code,
                                err_frame.message
                            );
                        }
                        other => warn!(frame_type = other, "Unexpected frame during handshake"),
                    }
                }
                Ok(Message::Ping(payload)) => {
                    stream.send(Message::Pong(payload)).await?;
                }
                Ok(Message::Close(frame)) => {
                    bail!("connection closed during handshake: {:?}", frame);
                }
                Ok(Message::Binary(_)) => {}
                Err(err) => return Err(err.into()),
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
            "terminal_capture" => {
                let frame: TerminalCaptureFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_capture(frame).await?;
            }
            "terminal_run" => {
                let frame: TerminalRunFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_run(frame).await?;
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
                let identity: DeviceIdentity = serde_json::from_slice(&bytes)?;
                Ok(Some(identity))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    async fn persist_identity(&self, identity: &DeviceIdentity) -> Result<()> {
        if let Some(parent) = self.identity_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&self.identity_path)
            .await?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            tokio::task::spawn_blocking({
                let path = self.identity_path.clone();
                move || std::fs::set_permissions(path, perms)
            })
            .await??;
        }

        let serialized = serde_json::to_vec_pretty(identity)?;
        file.write_all(&serialized).await?;
        file.sync_all().await?;
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
            "capabilities".into(),
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
            }),
        );

        if let Some(identity) = &self.identity {
            frame.insert("bud_id".into(), Value::String(identity.bud_id.clone()));
        } else if let Some(token) = &self.args.token {
            frame.insert("token".into(), Value::String(token.clone()));
        } else {
            bail!("No identity file found and no enrollment token provided");
        }

        Ok(Value::Object(frame))
    }
}

fn compute_hmac(secret: &str, nonce: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| anyhow!("invalid device secret length"))?;
    mac.update(nonce.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(URL_SAFE_NO_PAD.encode(bytes))
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
