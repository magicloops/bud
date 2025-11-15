use std::collections::{HashMap, VecDeque};
use std::io;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
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
}

struct SessionMeta {
    bud_id: String,
    session_id: String,
    heartbeat_sec: u64,
}

#[derive(Debug, Deserialize, Clone)]
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
struct HelloAckFrame {
    #[serde(flatten)]
    envelope: Envelope,
    session_id: String,
    bud_id: String,
    heartbeat_sec: Option<u64>,
    device_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HelloChallengeFrame {
    #[serde(flatten)]
    envelope: Envelope,
    nonce: String,
}

#[derive(Debug, Deserialize)]
struct ErrorFrame {
    #[serde(flatten)]
    envelope: Envelope,
    code: String,
    message: String,
}

#[derive(Debug, Deserialize, Clone)]
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
    cwd: String,
    env: HashMap<String, String>,
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
    active: HashMap<String, RunHandle>,
}

struct RunHandle {
    cancel_tx: mpsc::UnboundedSender<CancelCommand>,
}

enum CancelCommand {
    Terminate,
}

impl RunExecutor {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ExecutorState {
                queue: VecDeque::new(),
                current_run: None,
                sender: None,
                active: HashMap::new(),
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

    async fn enqueue(&self, command: RunCommand) -> Result<()> {
        info!(
            run_id = %command.run_id,
            cmd = %command.cmd,
            cwd = %command.cwd,
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
            executor
                .execute_run(cmd.clone(), sender.clone())
                .await
                .unwrap_or_else(|err| warn!(error = %err, "run execution failed"));
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
            cwd = %run.cwd,
            "Starting shell command"
        );
        let shell = default_shell();
        let mut command = Command::new(shell);
        command.arg("-lc").arg(&run.cmd);
        command.envs(run.env.clone());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::null());
        if let Some(dir) = expand_path(&run.cwd) {
            command.current_dir(dir);
        }
        unsafe {
            command.pre_exec(|| {
                unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))
                    .map_err(|err| io::Error::new(io::ErrorKind::Other, err))
            });
        }

        let mut child = command.spawn().context("failed to spawn shell")?;
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
            }),
        )?;

        info!(run_id = %run.run_id, "Sent run_finished frame to backend");

        Ok(())
    }
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
    fn new(args: BudArgs) -> Self {
        let identity_path = PathBuf::from(shellexpand::tilde(&args.identity_file).into_owned());
        Self {
            args,
            identity_path,
            identity: None,
            run_executor: RunExecutor::new(),
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
                                drop(sender);
                                let _ = writer_handle.await;
                                return Err(err);
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            info!(?frame, "Server closed connection");
                            self.run_executor.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Ok(());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            self.run_executor.clear_sender().await;
                            drop(sender);
                            let _ = writer_handle.await;
                            return Err(err.into());
                        }
                        None => {
                            self.run_executor.clear_sender().await;
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
        let cwd = frame.cwd.clone().unwrap_or_else(|| self.args.cwd.clone());
        let mut env = frame.env.unwrap_or_default();
        env.entry("CI".into()).or_insert_with(|| "1".into());
        env.entry("LANG".into()).or_insert_with(|| "C.UTF-8".into());
        env.entry("GIT_ASKPASS".into())
            .or_insert_with(|| "/bin/true".into());

        let command = RunCommand {
            run_id: frame.run_id.clone(),
            cmd: frame.cmd.clone(),
            cwd,
            env,
            timeout_ms: frame.timeout_ms.unwrap_or(30 * 60 * 1000),
        };

        info!(
            run_id = %command.run_id,
            cmd = %command.cmd,
            cwd = %command.cwd,
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
                "supports_pty": false,
                "shell_default": "/bin/bash"
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

#[tokio::main]
async fn main() -> Result<()> {
    setup_tracing();
    let args = BudArgs::parse();
    let app = BudApp::new(args);
    LocalSet::new().run_until(app.run()).await
}

fn setup_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).with_target(false).init();
}
