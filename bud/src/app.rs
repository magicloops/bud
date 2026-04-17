use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Map, Number, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task;
use tokio::time;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message, MaybeTlsStream, WebSocketStream,
};
use tracing::{info, warn};
use url::Url;

use crate::claim::{
    poll_device_auth_flow, print_device_claim_instructions, start_device_auth_flow,
};
use crate::config::BudArgs;
use crate::identity::{
    clear_identity, installation_id_path, load_identity, load_or_create_installation_id,
    persist_identity, DeviceIdentity,
};
use crate::protocol::{
    validate_inbound_envelope_proto, Envelope, ErrorFrame, HelloAckFrame, HelloChallengeFrame,
    RunFrame, TerminalCloseFrame, TerminalEnsureFrame, TerminalInputFrame, TerminalObserveFrame,
    TerminalResizeFrame, TerminalSendFrame, DEFAULT_HEARTBEAT_SEC, PROTO_VERSION,
    TERMINAL_PROTO_VERSION,
};
use crate::run::RunExecutor;
use crate::terminal::{probe_tmux, TerminalConfig, TerminalManager};
use crate::util::{
    compute_hmac, default_shell, expand_path, new_message_id, now_millis, send_ws_frame,
    send_ws_message,
};

pub struct BudApp {
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

enum HandshakeError {
    AuthFailed { code: String, message: String },
    Other(anyhow::Error),
}

impl BudApp {
    pub async fn new(args: BudArgs) -> Self {
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

    pub async fn run(mut self) -> Result<()> {
        self.installation_id = load_or_create_installation_id(&self.installation_id_path).await?;
        self.identity = load_identity(&self.identity_path).await?;
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
                    validate_inbound_envelope_proto(&envelope).map_err(HandshakeError::Other)?;
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
                                persist_identity(&self.identity_path, &new_identity)
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
        let sender = std::sync::Arc::new(tx);

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
        validate_inbound_envelope_proto(&envelope)?;
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

    async fn clear_identity(&mut self) -> Result<()> {
        self.identity = None;
        clear_identity(&self.identity_path).await?;
        info!(path = %self.identity_path.display(), "Removed invalid bud identity");
        Ok(())
    }

    async fn bootstrap_device_auth(&mut self) -> Result<()> {
        let start = start_device_auth_flow(
            &self.http_client,
            &self.args.server,
            &self.installation_id,
            &self.args.name,
            self.device_capabilities(),
        )
        .await?;
        print_device_claim_instructions(&start);

        loop {
            let poll = poll_device_auth_flow(&self.http_client, &self.args.server, &start).await?;
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
                    persist_identity(&self.identity_path, &identity).await?;
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
}
