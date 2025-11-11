use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Number, Value};
use sha2::Sha256;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time;
use tokio_tungstenite::{
    connect_async,
    tungstenite::protocol::Message,
    MaybeTlsStream, WebSocketStream,
};
use tracing::{info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use ulid::Ulid;
use url::Url;

type HmacSha256 = Hmac<Sha256>;

const PROTO_VERSION: &str = "0.1";
const DEFAULT_HEARTBEAT_SEC: u64 = 30;

/// Bud (device agent) CLI arguments.
#[derive(Debug, Parser, Clone)]
#[command(name = "bud", about = "Bud device agent PoC", version)]
struct BudArgs {
    /// Backend WSS endpoint (e.g., wss://bud.dev/ws).
    #[arg(
        long,
        env = "BUD_SERVER_URL",
        default_value = "wss://localhost:8443/ws"
    )]
    server: String,

    /// Enrollment token for first-time registration.
    #[arg(long, env = "BUD_ENROLLMENT_TOKEN")]
    token: Option<String>,

    /// Friendly device name presented in the UI.
    #[arg(long, env = "BUD_DEVICE_NAME", default_value = "bud-dev")]
    name: String,

    /// Default working directory for shell commands.
    #[arg(long, env = "BUD_DEFAULT_CWD", default_value = "~")]
    cwd: String,

    /// Path to the device identity file (bud_id + device_secret).
    #[arg(
        long,
        env = "BUD_IDENTITY_FILE",
        default_value = "~/.bud/identity.json"
    )]
    identity_file: String,

    /// Minimum seconds between reconnect attempts.
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
}

struct SessionMeta {
    bud_id: String,
    session_id: String,
    heartbeat_sec: u64,
}

#[derive(Debug, Deserialize)]
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

impl BudApp {
    fn new(args: BudArgs) -> Self {
        let identity_path = PathBuf::from(shellexpand::tilde(&args.identity_file).into_owned());
        Self {
            args,
            identity_path,
            identity: None,
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
        let hello_text = serde_json::to_string(&hello_frame)?;
        stream.send(Message::Text(hello_text)).await?;

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
                                // Enrollment complete; no need to reuse token again.
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
                        other => {
                            warn!(
                                frame_type = other,
                                "Ignoring unexpected frame during handshake"
                            );
                        }
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
        let (mut write, mut read) = stream.split();
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
                    if let Err(err) = write.send(Message::Text(serde_json::to_string(&heartbeat)?)).await {
                        return Err(err.into());
                    }
                }
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            self.handle_server_frame(&text)?;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            write.send(Message::Pong(payload)).await?;
                        }
                        Some(Ok(Message::Close(frame))) => {
                            info!(?frame, "Server closed connection");
                            return Ok(());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => return Err(err.into()),
                        None => return Ok(()),
                    }
                }
            }
        }
    }

    fn handle_server_frame(&self, text: &str) -> Result<()> {
        let envelope: Envelope = serde_json::from_str(text)?;
        match envelope.kind.as_str() {
            "run" => {
                info!("Received run request (not yet implemented)");
            }
            "error" => {
                let err: ErrorFrame = serde_json::from_str(text)?;
                warn!(code = %err.code, message = %err.message, "Backend error");
            }
            "log_ack" | "hello_ack" | "hello_challenge" => {
                // Already handled elsewhere; ignore duplicates.
            }
            other => {
                warn!(frame_type = other, "Unhandled frame type");
            }
        }
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
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
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

#[tokio::main]
async fn main() -> Result<()> {
    setup_tracing();
    let args = BudArgs::parse();
    BudApp::new(args).run().await
}

fn setup_tracing() {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(env_filter).with_target(false).init();
}
