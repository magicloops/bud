use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::io::{Read, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use clap::Parser;
use futures::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use nix::pty::openpty;
use nix::unistd::{self, dup, Pid};
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
const DEFAULT_PTY_ROWS: u16 = 24;
const DEFAULT_PTY_COLS: u16 = 80;
const SESSION_OUTPUT_INFLIGHT: usize = 128;

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

    #[arg(long, env = "BUD_TERMINAL_SESSION", default_value = "bud_terminal")]
    terminal_session: String,

    #[arg(
        long,
        env = "BUD_TERMINAL_LOG",
        default_value = "/tmp/bud_terminal.log"
    )]
    terminal_log: String,

    #[arg(long, env = "BUD_TERMINAL_COLS", default_value_t = 200)]
    terminal_cols: u16,

    #[arg(long, env = "BUD_TERMINAL_ROWS", default_value_t = 50)]
    terminal_rows: u16,
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
    session_manager: SessionManager,
    terminal_manager: TerminalManager,
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

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct SessionOpenFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    backend: Option<String>,
    cmd: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    pty: SessionPtyOptions,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct SessionPtyOptions {
    rows: Option<u16>,
    cols: Option<u16>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct SessionInputFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    data: String,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct SessionResizeFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    rows: u16,
    cols: u16,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
struct SessionCloseFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    reason: Option<String>,
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
struct SessionManager {
    inner: Arc<Mutex<SessionState>>,
}

struct SessionState {
    sessions: HashMap<String, SessionHandle>,
    sender: Option<OutboundSender>,
    default_shell: String,
}

struct SessionHandle {
    command_tx: mpsc::UnboundedSender<SessionCommand>,
}

enum SessionCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    Close,
    #[allow(dead_code)]
    Log(String),
}

#[derive(Clone)]
struct TerminalConfig {
    enabled: bool,
    session_name: String,
    log_path: PathBuf,
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
    handle: Option<Arc<TerminalHandle>>,
}

struct TerminalHandle {
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
    config: Option<TerminalEnsureConfig>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalInputFrame {
    #[serde(flatten)]
    envelope: Envelope,
    data: String,
    await_ready: Option<AwaitReady>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalResizeFrame {
    #[serde(flatten)]
    envelope: Envelope,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalInterruptFrame {
    #[serde(flatten)]
    envelope: Envelope,
    await_ready: Option<AwaitReady>,
}

#[derive(Debug, Deserialize, Clone)]
struct TerminalCloseFrame {
    #[serde(flatten)]
    envelope: Envelope,
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct AwaitReady {
    enabled: bool,
    quiescence_ms: Option<u64>,
    max_wait_ms: Option<u64>,
}

struct SessionConfig {
    session_id: String,
    #[allow(dead_code)]
    backend: String,
    cmd: Option<String>,
    cwd: Option<PathBuf>,
    env: HashMap<String, String>,
    rows: u16,
    cols: u16,
    default_shell: String,
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

impl SessionManager {
    fn new(default_shell: String) -> Self {
        Self {
            inner: Arc::new(Mutex::new(SessionState {
                sessions: HashMap::new(),
                sender: None,
                default_shell,
            })),
        }
    }

    async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        let sessions = std::mem::take(&mut inner.sessions);
        inner.sender = None;
        drop(inner);
        for (_, handle) in sessions {
            let _ = handle.command_tx.send(SessionCommand::Close);
        }
    }

    async fn handle_open(&self, frame: SessionOpenFrame) -> Result<()> {
        let backend = frame.backend.clone().unwrap_or_else(|| "pty".to_string());
        if backend.as_str() != "pty" {
            self.send_session_error(
                &frame.session_id,
                "backend_unsupported",
                "Unsupported session backend",
            )
            .await?;
            return Ok(());
        }
        let mut inner = self.inner.lock().await;
        if inner.sessions.contains_key(&frame.session_id) {
            return Ok(());
        }
        let sender = inner
            .sender
            .clone()
            .ok_or_else(|| anyhow!("no websocket writer available"))?;
        let mut env = frame.env.unwrap_or_default();
        env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
        env.entry("TERM".into())
            .or_insert_with(|| "xterm-256color".into());
        let cwd = frame
            .cwd
            .and_then(|value| expand_path(&value))
            .or_else(|| std::env::current_dir().ok());
        let config = SessionConfig {
            session_id: frame.session_id.clone(),
            backend,
            cmd: frame.cmd.clone(),
            cwd,
            env,
            rows: frame.pty.rows.unwrap_or(DEFAULT_PTY_ROWS),
            cols: frame.pty.cols.unwrap_or(DEFAULT_PTY_COLS),
            default_shell: inner.default_shell.clone(),
        };
        let session_id = config.session_id.clone();
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        inner.sessions.insert(
            session_id.clone(),
            SessionHandle {
                command_tx: command_tx.clone(),
            },
        );
        drop(inner);
        let manager = self.clone();
        tokio::task::spawn_local(async move {
            if let Err(err) = run_pty_session(config, sender, command_rx).await {
                warn!(session_id = %session_id, error = %err, "session task failed");
                let _ = manager
                    .send_session_error(&session_id, "EXEC_FAILED", err.to_string())
                    .await;
            }
            manager.remove_session(&session_id).await;
        });
        Ok(())
    }

    async fn handle_input(&self, frame: SessionInputFrame) -> Result<()> {
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid session input data: {}", err))?;
        info!(session_id = %frame.session_id, bytes = data.len(), "received session_input frame");
        let inner = self.inner.lock().await;
        if let Some(handle) = inner.sessions.get(&frame.session_id) {
            let _ = handle.command_tx.send(SessionCommand::Input(data));
        } else {
            warn!(session_id = %frame.session_id, "session_input dropped; session missing");
        }
        Ok(())
    }

    async fn handle_resize(&self, frame: SessionResizeFrame) -> Result<()> {
        let inner = self.inner.lock().await;
        if let Some(handle) = inner.sessions.get(&frame.session_id) {
            let _ = handle
                .command_tx
                .send(SessionCommand::Resize(frame.rows, frame.cols));
        }
        Ok(())
    }

    async fn handle_close(&self, frame: SessionCloseFrame) -> Result<()> {
        let inner = self.inner.lock().await;
        if let Some(handle) = inner.sessions.get(&frame.session_id) {
            let _ = handle.command_tx.send(SessionCommand::Close);
        }
        Ok(())
    }

    async fn remove_session(&self, session_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.sessions.remove(session_id);
    }

    async fn send_session_error<S: Into<String>>(
        &self,
        session_id: &str,
        code: &str,
        message: S,
    ) -> Result<()> {
        let inner = self.inner.lock().await;
        if let Some(sender) = &inner.sender {
            send_ws_frame(
                sender,
                json!({
                    "proto": PROTO_VERSION,
                    "type": "session_error",
                    "id": new_message_id(),
                    "ts": now_millis(),
                    "ext": {},
                    "session_id": session_id,
                    "code": code,
                    "message": message.into()
                }),
            )?;
        }
        Ok(())
    }
}

impl TerminalManager {
    fn new(config: TerminalConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalState {
                sender: None,
                handle: None,
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
        if let Some(handle) = inner.handle.take() {
            handle.watcher.abort();
        }
        inner.sender = None;
    }

    async fn handle_ensure(&self, cfg: Option<TerminalEnsureConfig>) -> Result<()> {
        if !self.config.enabled {
            info!("terminal support disabled; ignoring terminal_ensure");
            return Ok(());
        }
        let inner = self.inner.lock().await;
        if inner.handle.is_some() {
            if let Some(sender) = inner.sender.clone() {
                self.send_status(&sender, "ready", None).await?;
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
                "none",
                Some(json!({ "error": "tmux_unavailable" })),
            )
            .await?;
            return Ok(());
        }

        let ensured = self.ensure_tmux_session(cfg).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner.handle = Some(handle.clone());
            drop(inner);
            self.send_status(&sender, "ready", None).await?;
        } else {
            self.send_status(&sender, "none", Some(json!({ "error": "terminal_create_failed" })))
                .await?;
        }
        Ok(())
    }

    async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal input data: {}", err))?;
        let handle = self.ensure_handle_if_missing(None).await?;
        let Some(handle) = handle else {
            warn!(message_id = %frame.envelope.id, "terminal_input dropped; no session");
            return Ok(());
        };
        let start_offset = handle.offset.load(Ordering::SeqCst);
        let input = String::from_utf8_lossy(&data).to_string();
        let status = Command::new("tmux")
            .args(["send-keys", "-t", &handle.session_name, "-l", &input])
            .status()
            .await
            .with_context(|| "failed to dispatch tmux send-keys")?;
        if !status.success() {
            warn!(message_id = %frame.envelope.id, "tmux send-keys failed");
        }
        if frame.await_ready.as_ref().map(|a| a.enabled).unwrap_or(false) {
            if let Some(sender) = self.inner.lock().await.sender.clone() {
                let detector = ReadinessDetector::new(
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
        Ok(())
    }

    async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let handle = self.ensure_handle_if_missing(None).await?;
        let Some(handle) = handle else {
            warn!(message_id = %frame.envelope.id, "terminal_resize dropped; no session");
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
        let handle = self.ensure_handle_if_missing(None).await?;
        let Some(handle) = handle else {
            warn!(message_id = %frame.envelope.id, "terminal_interrupt dropped; no session");
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
                let detector = ReadinessDetector::new(
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
        Ok(())
    }

    async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }
        let sender = {
            let inner = self.inner.lock().await;
            inner.sender.clone()
        };
        let mut inner = self.inner.lock().await;
        if let Some(handle) = inner.handle.take() {
            handle.watcher.abort();
            let _ = Command::new("tmux")
                .args(["kill-session", "-t", &handle.session_name])
                .status()
                .await;
        }
        drop(inner);
        if let Some(sender) = sender {
            self.send_status(&sender, "closed", None).await?;
        }
        info!(
            message_id = %frame.envelope.id,
            reason = %frame.reason.clone().unwrap_or_default(),
            "terminal_close handled"
        );
        Ok(())
    }

    async fn send_status(
        &self,
        sender: &OutboundSender,
        state: &str,
        info: Option<Value>,
    ) -> Result<()> {
        let mut payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_status",
            "message_id": new_message_id(),
            "sent_at": iso_now(),
            "extensions": {},
            "state": state,
        });
        if let Some(info_obj) = info {
            if let Some(map) = payload.as_object_mut() {
                map.insert("info".into(), info_obj);
            }
        }
        send_ws_frame(sender, payload)
    }

    async fn ensure_handle_if_missing(
        &self,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        {
            let inner = self.inner.lock().await;
            if let Some(handle) = &inner.handle {
                return Ok(Some(handle.clone()));
            }
        }
        let ensured = self.ensure_tmux_session(cfg).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner.handle = Some(handle.clone());
            return Ok(Some(handle));
        }
        Ok(None)
    }

    async fn ensure_tmux_session(
        &self,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        if !self.config.tmux_available {
            return Ok(None);
        }
        let cfg = cfg.unwrap_or_default();
        let session_name = self.config.session_name.clone();
        let log_path = self.config.log_path.clone();
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
            .args(["has-session", "-t", &session_name])
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if !session_exists {
            let status = Command::new("tmux")
                .args([
                    "new-session",
                    "-d",
                    "-s",
                    &session_name,
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
                warn!(session = %session_name, "tmux new-session failed");
                return Ok(None);
            }
        }

        // Ensure pipe-pane to log
        let pipe_cmd = format!("cat >> {}", log_path.display());
        let _ = Command::new("tmux")
            .args(["pipe-pane", "-t", &session_name, "-o", &pipe_cmd])
            .status()
            .await;

        let metadata = fs::metadata(&log_path).await.ok();
        let start_offset = metadata.map(|m| m.len()).unwrap_or(0);
        let pid = tmux_pane_pid(&session_name).await.ok();
        let cwd_reported = tmux_pane_cwd(&session_name).await.ok();
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
            session_name.clone(),
            log_path.clone(),
            sender_clone,
            seq.clone(),
            offset.clone(),
        );
        let handle = Arc::new(TerminalHandle {
            session_name,
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
        let _ = self.send_status(&sender, "ready", Some(info)).await;
        Ok(Some(handle))
    }

    fn spawn_output_watcher(
        &self,
        session_name: String,
        log_path: PathBuf,
        sender: OutboundSender,
        seq: Arc<AtomicU64>,
        offset: Arc<AtomicU64>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let size = match fs::metadata(&log_path).await {
                    Ok(meta) => meta.len(),
                    Err(_) => {
                        time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let current_offset = offset.load(Ordering::SeqCst);
                if size > current_offset {
                    match fs::File::open(&log_path).await {
                        Ok(mut file) => {
                            if file.seek(SeekFrom::Start(current_offset)).await.is_ok() {
                                let mut buf = vec![0u8; (size - current_offset) as usize];
                                if file.read_exact(&mut buf).await.is_ok() {
                                    let seq_no = seq.fetch_add(1, Ordering::SeqCst);
                                    let payload = json!({
                                        "proto": TERMINAL_PROTO_VERSION,
                                        "type": "terminal_output",
                                        "message_id": new_message_id(),
                                        "sent_at": iso_now(),
                                        "extensions": {},
                                        "seq": seq_no,
                                        "data": BASE64_STANDARD.encode(&buf),
                                        "byte_offset": current_offset,
                                    });
                                    if let Err(err) = send_ws_frame(&sender, payload) {
                                        warn!(session = %session_name, error = %err, "failed to send terminal_output");
                                    }
                                    offset.store(size, Ordering::SeqCst);
                                }
                            }
                        }
                        Err(_) => {}
                    }
                }
                time::sleep(Duration::from_millis(50)).await;
            }
        })
    }

    async fn tmux_available(&self) -> Result<bool> {
        Ok(self.config.tmux_available)
    }
}

impl ReadinessDetector {
    fn new(
        handle: Arc<TerminalHandle>,
        sender: OutboundSender,
        start_offset: u64,
        await_ready: Option<AwaitReady>,
    ) -> Self {
        Self {
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
            "message_id": new_message_id(),
            "sent_at": iso_now(),
            "extensions": {},
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

async fn run_pty_session(
    config: SessionConfig,
    sender: OutboundSender,
    mut command_rx: mpsc::UnboundedReceiver<SessionCommand>,
) -> Result<()> {
    let winsize = libc::winsize {
        ws_row: config.rows,
        ws_col: config.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = openpty(Some(&winsize), None)?;
    let slave_fd = pty.slave.into_raw_fd();
    let stdin_fd = dup(slave_fd)?;
    let stdout_fd = dup(slave_fd)?;
    let stderr_fd = dup(slave_fd)?;
    unsafe {
        libc::close(slave_fd);
    }

    let mut command = Command::new(config.default_shell.clone());
    if let Some(cmd) = config.cmd.clone() {
        command.arg("-lc").arg(cmd);
    } else {
        command.arg("-l");
    }
    if let Some(cwd) = config.cwd.clone() {
        command.current_dir(cwd);
    }
    command.envs(config.env.clone());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY.into(), 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.stdin(unsafe { Stdio::from_raw_fd(stdin_fd) });
    command.stdout(unsafe { Stdio::from_raw_fd(stdout_fd) });
    command.stderr(unsafe { Stdio::from_raw_fd(stderr_fd) });
        let child = command.spawn()?;
    let reader_file = {
        let master_fd = pty.master.into_raw_fd();
        unsafe { File::from_raw_fd(master_fd) }
    };
    let writer_file = reader_file.try_clone()?;
    let writer = Arc::new(StdMutex::new(writer_file));
    let session_id = config.session_id.clone();
    let seq = Arc::new(AtomicU64::new(0));
    let (output_tx, mut output_rx) = mpsc::channel::<Vec<u8>>(SESSION_OUTPUT_INFLIGHT);
    let reader_sender = output_tx.clone();
    let reader_handle = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut reader = reader_file;
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let chunk = buffer[..read].to_vec();
            if reader_sender.blocking_send(chunk).is_err() {
                break;
            }
        }
        Ok(())
    });
    let sender_output = sender.clone();
    let session_id_clone = session_id.clone();
    let forward_handle = tokio::task::spawn_local(async move {
        while let Some(chunk) = output_rx.recv().await {
            let seq_no = seq.fetch_add(1, Ordering::SeqCst);
            if let Err(err) = send_ws_frame(
                &sender_output,
                json!({
                    "proto": PROTO_VERSION,
                    "type": "session_output",
                    "id": new_message_id(),
                    "ts": now_millis(),
                    "ext": {},
                    "session_id": session_id_clone,
                    "seq": seq_no,
                    "data": BASE64_STANDARD.encode(&chunk)
                }),
            ) {
                warn!(session_id = %session_id_clone, error = %err, "failed to forward session output");
                break;
            }
        }
    });

    send_ws_frame(
        &sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "session_opened",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "backend": "pty",
        }),
    )?;

    use futures::FutureExt;
    let child_handle = Arc::new(tokio::sync::Mutex::new(child));
    let wait_handle = child_handle.clone();
    let mut child_wait = async move {
        let mut guard = wait_handle.lock().await;
        guard.wait().await
    }
    .boxed_local();
    let mut exit_status: Option<std::process::ExitStatus> = None;
    loop {
        tokio::select! {
            Some(cmd) = command_rx.recv() => {
                match cmd {
                    SessionCommand::Input(data) => {
                        info!(session_id = %config.session_id, bytes = data.len(), "writing session input to PTY");
                        let writer = writer.clone();
                        let data_for_write = data.clone();
                        tokio::task::spawn_blocking(move || -> Result<()> {
                            let mut guard = writer.lock().unwrap();
                            guard.write_all(&data_for_write)?;
                            guard.flush()?;
                            Ok(())
                        }).await??;
                        if let Ok(text) = String::from_utf8(data) {
                            info!(session_id = %config.session_id, input_preview = %text, "session input text (debug)");
                        } else {
                            info!(session_id = %config.session_id, "session input not UTF-8");
                        }
                    }
                    SessionCommand::Resize(rows, cols) => {
                        let writer = writer.clone();
                        tokio::task::spawn_blocking(move || -> Result<()> {
                            let fd = writer.lock().unwrap().as_raw_fd();
                            let winsize = libc::winsize {
                                ws_row: rows,
                                ws_col: cols,
                                ws_xpixel: 0,
                                ws_ypixel: 0,
                            };
                            let res = unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &winsize) };
                            if res != 0 {
                                return Err(io::Error::last_os_error().into());
                            }
                            Ok(())
                        }).await??;
                    }
                    SessionCommand::Close => {
                        let child_handle = child_handle.clone();
                        tokio::task::spawn_local(async move {
                            if let Ok(mut guard) = child_handle.try_lock() {
                                let _ = guard.start_kill();
                            }
                        });
                    }
                    SessionCommand::Log(msg) => {
                        info!(session_id = %config.session_id, message = %msg, "session debug log");
                    }
                }
            }
            status = &mut child_wait => {
                exit_status = Some(status?);
                break;
            }
        }
    }

    drop(output_tx);
    match reader_handle.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => warn!(session_id = %config.session_id, error = %err, "PTY reader error"),
        Err(err) => warn!(session_id = %config.session_id, error = %err, "PTY reader join error"),
    }
    if let Err(err) = forward_handle.await {
        warn!(session_id = %config.session_id, error = %err, "PTY output forwarder error");
    }

    if let Some(status) = exit_status {
        send_ws_frame(
            &sender,
            json!({
                "proto": PROTO_VERSION,
                "type": "session_closed",
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "session_id": config.session_id,
                "exit_code": status.code(),
                "signal": status.signal(),
                "canceled": false
            }),
        )?;
    }
    Ok(())
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
        let terminal_config = TerminalConfig {
            enabled: args.terminal_enabled,
            session_name: args.terminal_session.clone(),
            log_path: expand_path(&args.terminal_log)
                .unwrap_or_else(|| PathBuf::from(&args.terminal_log)),
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
            session_manager: SessionManager::new(default_shell),
            terminal_manager: TerminalManager::new(terminal_config),
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
        self.session_manager.set_sender(sender.clone()).await;
        self.terminal_manager.set_sender(sender.clone()).await;
        if self.terminal_manager.config.enabled && self.terminal_manager.config.tmux_available {
            if let Err(err) = self.terminal_manager.handle_ensure(None).await {
                warn!(error = %err, "failed to initialize terminal on connect");
            }
        } else if self.terminal_manager.config.enabled {
            info!("terminal enabled but tmux unavailable; skipping terminal init");
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
                        self.session_manager.clear_sender().await;
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
                                self.session_manager.clear_sender().await;
                                self.terminal_manager.clear_sender().await;
                                drop(sender);
                                let _ = writer_handle.await;
                                return Err(err);
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            info!(?frame, "Server closed connection");
                            self.run_executor.clear_sender().await;
                            self.session_manager.clear_sender().await;
                            self.terminal_manager.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Ok(());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            self.run_executor.clear_sender().await;
                            self.session_manager.clear_sender().await;
                            self.terminal_manager.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Err(err.into());
                        }
                        None => {
                            self.run_executor.clear_sender().await;
                            self.session_manager.clear_sender().await;
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
            "session_open" => {
                let frame: SessionOpenFrame = serde_json::from_str(text)?;
                self.session_manager.handle_open(frame).await?;
            }
            "session_input" => {
                let frame: SessionInputFrame = serde_json::from_str(text)?;
                self.session_manager.handle_input(frame).await?;
            }
            "session_resize" => {
                let frame: SessionResizeFrame = serde_json::from_str(text)?;
                self.session_manager.handle_resize(frame).await?;
            }
            "session_close" => {
                let frame: SessionCloseFrame = serde_json::from_str(text)?;
                self.session_manager.handle_close(frame).await?;
            }
            "terminal_ensure" => {
                let frame: TerminalEnsureFrame = serde_json::from_str(text)?;
                self.terminal_manager.handle_ensure(frame.config).await?;
                info!(message_id = %frame.envelope.id, "terminal_ensure handled");
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
