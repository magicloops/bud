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
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{
    connect_async, tungstenite::protocol::Message, MaybeTlsStream, WebSocketStream,
};
use tracing::{info, warn};
use url::Url;

use crate::claim::{
    poll_device_auth_flow, print_device_claim_instructions, start_device_auth_flow,
};
use crate::config::BudArgs;
use crate::files::FileManager;
use crate::grpc_control::{
    bud::v1::BudEnvelope, connect_control_stream, envelope_to_json_text, json_frame_to_envelope,
    GrpcControlStream,
};
use crate::grpc_data::{connect_data_stream, json_frame_to_data_envelope};
use crate::identity::{
    clear_identity, installation_id_path, load_identity, load_or_create_installation_id,
    persist_identity, DeviceIdentity,
};
use crate::journal::{load_journal, DaemonJournal};
use crate::proto_wire::{decode_bud_frame, encode_bud_frame};
use crate::protocol::{
    validate_inbound_envelope_proto, Envelope, ErrorFrame, FileOpenFrame, HelloAckFrame,
    HelloChallengeFrame, ProxyOpenFrame, RunFrame, StreamCloseFrame, StreamCreditFrame,
    StreamDataFrame, StreamResetFrame, TerminalCloseFrame, TerminalEnsureFrame, TerminalInputFrame,
    TerminalObserveFrame, TerminalResizeFrame, TerminalSendFrame, DEFAULT_HEARTBEAT_SEC,
    PROTO_VERSION, TERMINAL_PROTO_VERSION,
};
use crate::proxy::ProxyManager;
use crate::run::RunExecutor;
use crate::terminal::{probe_tmux, TerminalConfig, TerminalManager};
use crate::transport::{send_transport_frame, send_transport_message, TransportSender};
use crate::util::{compute_hmac, default_shell, expand_path, new_message_id, now_millis};

pub struct BudApp {
    args: BudArgs,
    identity_path: PathBuf,
    journal_path: PathBuf,
    installation_id_path: PathBuf,
    installation_id: String,
    identity: Option<DeviceIdentity>,
    run_executor: RunExecutor,
    terminal_manager: TerminalManager,
    http_client: Client,
    proxy_http_client: Client,
    proxy_manager: ProxyManager,
    file_manager: FileManager,
    debug_enabled: bool,
}

struct SessionMeta {
    bud_id: String,
    session_id: String,
    heartbeat_sec: u64,
    envelope_binary: bool,
}

#[derive(Clone, Copy)]
enum HelloTransportMode {
    WebSocket,
    GrpcControl,
}

struct GrpcDataAttachment {
    sender: mpsc::Sender<Value>,
    writer_handle: task::JoinHandle<()>,
    reader_handle: task::JoinHandle<()>,
}

impl GrpcDataAttachment {
    async fn shutdown(self) {
        drop(self.sender);
        self.writer_handle.abort();
        let _ = self.writer_handle.await;
        self.reader_handle.abort();
        let _ = self.reader_handle.await;
    }
}

enum HandshakeError {
    AuthFailed { code: String, message: String },
    Other(anyhow::Error),
}

impl BudApp {
    pub async fn new(args: BudArgs) -> Self {
        let identity_path = PathBuf::from(shellexpand::tilde(&args.identity_file).into_owned());
        let journal_path = identity_path.with_file_name("journal.json");
        let installation_id_path = installation_id_path(&identity_path);
        let default_cwd = expand_path(&args.cwd)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let default_shell = default_shell().to_string();
        let tmux_available = probe_tmux();
        let debug_enabled = args.debug;
        let proxy_http_client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| Client::new());
        let terminal_config = TerminalConfig {
            enabled: args.terminal_enabled,
            base_log_dir: expand_path(&args.terminal_base_dir)
                .unwrap_or_else(|| PathBuf::from(&args.terminal_base_dir)),
            cols: args.terminal_cols,
            rows: args.terminal_rows,
            shell: default_shell.clone(),
            tmux_available,
            debug_enabled,
        };
        Self {
            args,
            identity_path,
            journal_path,
            installation_id_path,
            installation_id: String::new(),
            identity: None,
            run_executor: RunExecutor::new(default_cwd.clone()),
            terminal_manager: TerminalManager::new(terminal_config),
            http_client: Client::new(),
            proxy_http_client,
            proxy_manager: ProxyManager::default(),
            file_manager: FileManager::new(default_cwd),
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
        if let Some(endpoint) = self.args.grpc_control_url.clone() {
            match self.connect_once_grpc(endpoint).await {
                Ok(()) => return Ok(()),
                Err(err) if grpc_error_allows_websocket_fallback(&err) => {
                    warn!(
                        error = ?err,
                        server = %self.args.server,
                        "gRPC control unavailable; falling back to WebSocket baseline"
                    );
                }
                Err(err) => return Err(err),
            }
        }

        self.connect_once_websocket().await
    }

    async fn connect_once_websocket(&mut self) -> Result<()> {
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

    async fn connect_once_grpc(&mut self, endpoint: String) -> Result<()> {
        loop {
            if self.identity.is_none() && self.args.token.is_none() {
                self.bootstrap_device_auth().await?;
            }

            info!(endpoint = %endpoint, "Connecting to backend gRPC control gateway");
            let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Value>();
            let (envelope_tx, envelope_rx) = mpsc::channel::<BudEnvelope>(128);
            let writer_handle = task::spawn_local(async move {
                while let Some(frame) = frame_rx.recv().await {
                    let envelope = match json_frame_to_envelope(&frame) {
                        Ok(envelope) => envelope,
                        Err(err) => {
                            warn!(error = %err, "Failed to encode gRPC BudEnvelope");
                            break;
                        }
                    };
                    if envelope_tx.send(envelope).await.is_err() {
                        break;
                    }
                }
            });
            let sender = TransportSender::grpc(frame_tx.clone());
            let hello_frame = self.build_hello_frame(HelloTransportMode::GrpcControl)?;
            send_transport_frame(&sender, hello_frame)?;

            let mut stream =
                match connect_control_stream(&endpoint, ReceiverStream::new(envelope_rx)).await {
                    Ok(stream) => stream,
                    Err(err) => {
                        drop(sender);
                        let _ = writer_handle.await;
                        return Err(err);
                    }
                };

            match self.perform_grpc_handshake(&sender, &mut stream).await {
                Ok(meta) => {
                    info!(
                        bud_id = %meta.bud_id,
                        session_id = %meta.session_id,
                        heartbeat_sec = meta.heartbeat_sec,
                        "gRPC handshake established"
                    );
                    let data_attachment = match self.start_grpc_data_attachment(&meta).await {
                        Ok(attachment) => attachment,
                        Err(err) => {
                            warn!(
                                error = ?err,
                                "Failed to attach gRPC data stream; falling back to control stream for terminal output"
                            );
                            None
                        }
                    };
                    let session_sender = data_attachment
                        .as_ref()
                        .map(|attachment| {
                            TransportSender::grpc_with_data(
                                frame_tx.clone(),
                                attachment.sender.clone(),
                            )
                        })
                        .unwrap_or_else(|| sender.clone());
                    drop(sender);
                    return self
                        .run_grpc_session(
                            session_sender,
                            stream,
                            meta,
                            writer_handle,
                            data_attachment,
                        )
                        .await;
                }
                Err(HandshakeError::AuthFailed { code, message }) => {
                    drop(sender);
                    let _ = writer_handle.await;
                    if self.args.token.is_some() {
                        bail!(
                            "backend error during gRPC handshake (code={}): {}",
                            code,
                            message
                        );
                    }

                    warn!(
                        code = %code,
                        message = %message,
                        "Stored device credential rejected over gRPC; starting device claim flow"
                    );
                    self.clear_identity().await?;
                    self.bootstrap_device_auth().await?;
                }
                Err(HandshakeError::Other(err)) => {
                    drop(sender);
                    let _ = writer_handle.await;
                    return Err(err);
                }
            }
        }
    }

    async fn perform_grpc_handshake(
        &mut self,
        sender: &TransportSender,
        stream: &mut GrpcControlStream,
    ) -> std::result::Result<SessionMeta, HandshakeError> {
        loop {
            let envelope = stream
                .message()
                .await
                .map_err(|err| HandshakeError::Other(err.into()))?
                .ok_or_else(|| {
                    HandshakeError::Other(anyhow!(
                        "gRPC control stream closed before handshake completed"
                    ))
                })?;
            let text = envelope_to_json_text(&envelope).map_err(HandshakeError::Other)?;
            let envelope: Envelope =
                serde_json::from_str(&text).map_err(|err| HandshakeError::Other(err.into()))?;
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
                    return Ok(SessionMeta {
                        bud_id: ack.bud_id,
                        session_id: ack.session_id,
                        heartbeat_sec: ack.heartbeat_sec.unwrap_or(DEFAULT_HEARTBEAT_SEC),
                        envelope_binary: true,
                    });
                }
                "hello_challenge" => {
                    let challenge: HelloChallengeFrame = serde_json::from_str(&text)
                        .map_err(|err| HandshakeError::Other(err.into()))?;
                    let identity = self.identity.as_ref().ok_or_else(|| {
                        HandshakeError::Other(anyhow!("no identity available for challenge"))
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
                    send_transport_frame(sender, proof_frame).map_err(HandshakeError::Other)?;
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
                        "backend error during gRPC handshake (code={}): {}",
                        err_frame.code,
                        err_frame.message
                    )));
                }
                other => warn!(frame_type = other, "Unexpected frame during gRPC handshake"),
            }
        }
    }

    async fn start_grpc_data_attachment(
        &self,
        meta: &SessionMeta,
    ) -> Result<Option<GrpcDataAttachment>> {
        let Some(endpoint) = self.args.grpc_data_url.clone() else {
            return Ok(None);
        };

        info!(endpoint = %endpoint, "Attaching gRPC data stream");
        let (frame_tx, mut frame_rx) = mpsc::channel::<Value>(128);
        let (envelope_tx, envelope_rx) = mpsc::channel::<BudEnvelope>(128);
        let writer_handle = task::spawn_local(async move {
            while let Some(frame) = frame_rx.recv().await {
                let envelope = match json_frame_to_data_envelope(&frame) {
                    Ok(envelope) => envelope,
                    Err(err) => {
                        warn!(error = %err, "Failed to encode gRPC data BudEnvelope");
                        break;
                    }
                };
                if envelope_tx.send(envelope).await.is_err() {
                    break;
                }
            }
        });

        let attach_frame = json!({
            "proto": PROTO_VERSION,
            "type": "data_attach",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "bud_id": &meta.bud_id,
            "device_session_id": &meta.session_id,
            "streams": ["terminal_output", "localhost_http_proxy", "file_read"],
            "max_chunk_bytes": 16 * 1024,
        });
        if frame_tx.send(attach_frame).await.is_err() {
            drop(frame_tx);
            let _ = writer_handle.await;
            bail!("gRPC data writer stopped before attach");
        }

        let mut stream =
            match connect_data_stream(&endpoint, ReceiverStream::new(envelope_rx)).await {
                Ok(stream) => stream,
                Err(err) => {
                    drop(frame_tx);
                    let _ = writer_handle.await;
                    return Err(err);
                }
            };

        let reader_frame_tx = frame_tx.clone();
        let proxy_manager = self.proxy_manager.clone();
        let file_manager = self.file_manager.clone();
        let reader_handle = task::spawn_local(async move {
            loop {
                match stream.message().await {
                    Ok(Some(envelope)) => match envelope_to_json_text(&envelope) {
                        Ok(text) => {
                            let envelope: std::result::Result<Envelope, _> =
                                serde_json::from_str(&text);
                            match envelope {
                                Ok(envelope) if envelope.kind == "data_attach_ack" => {
                                    info!("gRPC data stream attached");
                                }
                                Ok(envelope) if envelope.kind == "stream_credit" => {
                                    match serde_json::from_str::<StreamCreditFrame>(&text) {
                                        Ok(frame) => {
                                            tracing::debug!(
                                                stream_id = %frame.stream_id,
                                                receive_offset = frame.receive_offset,
                                                credit_bytes = frame.credit_bytes,
                                                "gRPC data stream credit received"
                                            );
                                            proxy_manager.apply_credit(frame.clone()).await;
                                            file_manager.apply_credit(frame).await;
                                        }
                                        Err(err) => warn!(
                                            error = %err,
                                            "Failed to parse gRPC data stream_credit frame"
                                        ),
                                    }
                                }
                                Ok(envelope) if envelope.kind == "stream_data" => {
                                    match serde_json::from_str::<StreamDataFrame>(&text) {
                                        Ok(frame) => {
                                            warn!(
                                                stream_id = %frame.stream_id,
                                                stream_type = %frame.stream_type,
                                                "Rejecting unsupported inbound gRPC data stream"
                                            );
                                            let reset = json!({
                                                "proto": PROTO_VERSION,
                                                "type": "stream_reset",
                                                "id": new_message_id(),
                                                "ts": now_millis(),
                                                "ext": {},
                                                "stream_id": frame.stream_id,
                                                "reason": "protocol_error",
                                                "error": {
                                                    "code": "UNSUPPORTED_STREAM",
                                                    "message": "daemon has no adapter for this stream type",
                                                    "retryable": false
                                                }
                                            });
                                            if reader_frame_tx.send(reset).await.is_err() {
                                                break;
                                            }
                                        }
                                        Err(err) => warn!(
                                            error = %err,
                                            "Failed to parse gRPC data stream_data frame"
                                        ),
                                    }
                                }
                                Ok(envelope) if envelope.kind == "stream_reset" => {
                                    match serde_json::from_str::<StreamResetFrame>(&text) {
                                        Ok(frame) => {
                                            warn!(
                                                stream_id = %frame.stream_id,
                                                reason = %frame.reason,
                                                "gRPC data runtime stream reset"
                                            );
                                            proxy_manager.apply_reset(frame.clone()).await;
                                            file_manager.apply_reset(frame).await;
                                        }
                                        Err(err) => warn!(
                                            error = %err,
                                            "Failed to parse gRPC data stream_reset frame"
                                        ),
                                    }
                                }
                                Ok(envelope) if envelope.kind == "stream_close" => {
                                    match serde_json::from_str::<StreamCloseFrame>(&text) {
                                        Ok(frame) => tracing::debug!(
                                            stream_id = %frame.stream_id,
                                            final_offset = frame.final_offset,
                                            "gRPC data runtime stream closed"
                                        ),
                                        Err(err) => warn!(
                                            error = %err,
                                            "Failed to parse gRPC data stream_close frame"
                                        ),
                                    }
                                }
                                Ok(envelope) if envelope.kind == "error" => {
                                    warn!(frame = %text, "gRPC data stream error frame received");
                                }
                                Ok(envelope) => {
                                    warn!(frame_type = %envelope.kind, "Unhandled gRPC data stream frame");
                                }
                                Err(err) => {
                                    warn!(error = %err, "Failed to parse gRPC data stream frame");
                                }
                            }
                        }
                        Err(err) => {
                            warn!(error = %err, "Failed to decode gRPC data stream envelope");
                            break;
                        }
                    },
                    Ok(None) => break,
                    Err(err) => {
                        warn!(error = %err, "gRPC data stream read error");
                        break;
                    }
                }
            }
        });

        Ok(Some(GrpcDataAttachment {
            sender: frame_tx,
            writer_handle,
            reader_handle,
        }))
    }

    async fn run_grpc_session(
        &self,
        sender: TransportSender,
        mut stream: GrpcControlStream,
        meta: SessionMeta,
        writer_handle: task::JoinHandle<()>,
        data_attachment: Option<GrpcDataAttachment>,
    ) -> Result<()> {
        let mut interval = time::interval(Duration::from_secs(meta.heartbeat_sec.max(5)));

        self.run_executor.set_sender(sender.clone()).await;
        self.terminal_manager.set_sender(sender.clone()).await;
        if self.terminal_manager.config.enabled && !self.terminal_manager.config.tmux_available {
            info!("terminal enabled but tmux unavailable; terminal sessions will fail");
        }
        self.send_reconnect_report(&sender, &meta).await?;

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
                    if let Err(err) = send_transport_frame(&sender, heartbeat) {
                        self.shutdown_grpc_session(sender, writer_handle, data_attachment).await;
                        return Err(err);
                    }
                }
                message = stream.message() => {
                    match message {
                        Ok(Some(envelope)) => {
                            let text = envelope_to_json_text(&envelope)?;
                            self.handle_server_frame(&text, &sender).await?;
                        }
                        Ok(None) => {
                            if self.debug_enabled {
                                info!("gRPC control stream ended; reconnecting");
                            }
                            self.shutdown_grpc_session(sender, writer_handle, data_attachment).await;
                            return Ok(());
                        }
                        Err(err) => {
                            if self.debug_enabled {
                                info!(error = %err, "gRPC control read error; reconnecting soon");
                            }
                            self.shutdown_grpc_session(sender, writer_handle, data_attachment).await;
                            return Err(err.into());
                        }
                    }
                }
            }
        }
    }

    async fn shutdown_grpc_session(
        &self,
        sender: TransportSender,
        writer_handle: task::JoinHandle<()>,
        data_attachment: Option<GrpcDataAttachment>,
    ) {
        self.run_executor.clear_sender().await;
        self.terminal_manager.clear_sender().await;
        drop(sender);
        if let Some(data_attachment) = data_attachment {
            data_attachment.shutdown().await;
        }
        writer_handle.abort();
        let _ = writer_handle.await;
    }

    async fn perform_handshake(
        &mut self,
        mut stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) -> std::result::Result<
        (WebSocketStream<MaybeTlsStream<TcpStream>>, SessionMeta),
        HandshakeError,
    > {
        let hello_frame = self
            .build_hello_frame(HelloTransportMode::WebSocket)
            .map_err(HandshakeError::Other)?;
        stream
            .send(Message::Binary(
                encode_bud_frame(&hello_frame).map_err(HandshakeError::Other)?,
            ))
            .await
            .map_err(|err| HandshakeError::Other(err.into()))?;

        let mut envelope_binary = false;
        loop {
            let Some(msg) = stream.next().await else {
                return Err(HandshakeError::Other(anyhow!(
                    "connection closed before handshake completed"
                )));
            };
            let text = match msg {
                Ok(Message::Text(text)) => text,
                Ok(Message::Binary(bytes)) => {
                    envelope_binary = true;
                    decode_bud_frame(&bytes).map_err(HandshakeError::Other)?
                }
                Ok(Message::Ping(payload)) => {
                    stream
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|err| HandshakeError::Other(err.into()))?;
                    continue;
                }
                Ok(Message::Close(frame)) => {
                    return Err(HandshakeError::Other(anyhow!(
                        "connection closed during handshake: {:?}",
                        frame
                    )));
                }
                Err(err) => return Err(HandshakeError::Other(err.into())),
                _ => continue,
            };

            let envelope: Envelope =
                serde_json::from_str(&text).map_err(|err| HandshakeError::Other(err.into()))?;
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
                        envelope_binary,
                    };
                    return Ok((stream, meta));
                }
                "hello_challenge" => {
                    let challenge: HelloChallengeFrame = serde_json::from_str(&text)
                        .map_err(|err| HandshakeError::Other(err.into()))?;
                    let identity = self.identity.as_ref().ok_or_else(|| {
                        HandshakeError::Other(anyhow!("no identity available for challenge"))
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
                    let proof_message = if envelope_binary {
                        Message::Binary(
                            encode_bud_frame(&proof_frame).map_err(HandshakeError::Other)?,
                        )
                    } else {
                        Message::Text(
                            serde_json::to_string(&proof_frame)
                                .map_err(|err| HandshakeError::Other(err.into()))?,
                        )
                    };
                    stream
                        .send(proof_message)
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
            };
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
        let sender = TransportSender::websocket(tx, meta.envelope_binary);

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
        self.send_reconnect_report(&sender, &meta).await?;

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
                    if let Err(err) = send_transport_frame(&sender, heartbeat) {
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
                            self.handle_server_frame(&text, &sender).await?;
                        }
                        Some(Ok(Message::Binary(bytes))) => {
                            let text = decode_bud_frame(&bytes)?;
                            self.handle_server_frame(&text, &sender).await?;
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if let Err(err) = send_transport_message(&sender, Message::Pong(payload)) {
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

    async fn handle_server_frame(&self, text: &str, sender: &TransportSender) -> Result<()> {
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
            "proxy_open" => {
                let frame: ProxyOpenFrame = serde_json::from_str(text)?;
                self.proxy_manager.handle_open(
                    frame,
                    sender.clone(),
                    self.proxy_http_client.clone(),
                );
            }
            "file_open" => {
                let frame: FileOpenFrame = serde_json::from_str(text)?;
                let has_resolution_hint = frame
                    .resolution_hint
                    .as_ref()
                    .is_some_and(|hint| hint.kind == "host_cwd" && hint.host_cwd.is_some());
                let terminal_cwd = match (has_resolution_hint, frame.terminal_session_id.as_deref())
                {
                    (true, _) => None,
                    (false, Some(session_id)) => {
                        self.terminal_manager
                            .fresh_pane_cwd_for_session(session_id)
                            .await
                    }
                    (false, None) => None,
                };
                self.file_manager
                    .handle_open(frame, sender.clone(), terminal_cwd);
            }
            "stream_credit" => {
                let frame: StreamCreditFrame = serde_json::from_str(text)?;
                tracing::debug!(
                    stream_id = %frame.stream_id,
                    receive_offset = frame.receive_offset,
                    credit_bytes = frame.credit_bytes,
                    "WebSocket stream credit received"
                );
                self.proxy_manager.apply_credit(frame.clone()).await;
                self.file_manager.apply_credit(frame).await;
            }
            "stream_data" => {
                let frame: StreamDataFrame = serde_json::from_str(text)?;
                warn!(
                    stream_id = %frame.stream_id,
                    stream_type = %frame.stream_type,
                    "Rejecting unsupported inbound WebSocket data stream"
                );
                let reset = json!({
                    "proto": PROTO_VERSION,
                    "type": "stream_reset",
                    "id": new_message_id(),
                    "ts": now_millis(),
                    "ext": {},
                    "stream_id": frame.stream_id,
                    "reason": "protocol_error",
                    "error": {
                        "code": "UNSUPPORTED_STREAM",
                        "message": "daemon has no adapter for this stream type",
                        "retryable": false
                    }
                });
                send_transport_frame(sender, reset)?;
            }
            "stream_reset" => {
                let frame: StreamResetFrame = serde_json::from_str(text)?;
                warn!(
                    stream_id = %frame.stream_id,
                    reason = %frame.reason,
                    "WebSocket runtime stream reset"
                );
                self.proxy_manager.apply_reset(frame.clone()).await;
                self.file_manager.apply_reset(frame).await;
            }
            "stream_close" => {
                let frame: StreamCloseFrame = serde_json::from_str(text)?;
                tracing::debug!(
                    stream_id = %frame.stream_id,
                    final_offset = frame.final_offset,
                    "WebSocket runtime stream closed"
                );
            }
            "error" => {
                let err: ErrorFrame = serde_json::from_str(text)?;
                warn!(code = %err.code, message = %err.message, "Backend error");
            }
            "reconciliation_decision" => {
                let value: Value = serde_json::from_str(text)?;
                let operation_count = value
                    .get("operations")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                let stream_count = value
                    .get("streams")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                info!(
                    operation_count,
                    stream_count, "reconnect reconciliation decision received"
                );
            }
            "log_ack" | "hello_ack" | "hello_challenge" => {}
            other => warn!(frame_type = other, "Unhandled frame type"),
        }
        Ok(())
    }

    async fn send_reconnect_report(
        &self,
        sender: &TransportSender,
        meta: &SessionMeta,
    ) -> Result<()> {
        let journal = match load_journal(&self.journal_path).await {
            Ok(journal) => journal,
            Err(err) => {
                warn!(
                    path = %self.journal_path.display(),
                    error = %err,
                    "failed to load daemon journal; reporting empty reconciliation state"
                );
                DaemonJournal::default()
            }
        };
        let operations: Vec<Value> = journal
            .accepted_operations
            .iter()
            .map(|operation| {
                json!({
                    "operation_id": &operation.operation_id,
                    "state": &operation.state,
                    "operation_type": &operation.operation_type,
                    "updated_at": &operation.updated_at,
                })
            })
            .collect();
        let streams: Vec<Value> = journal
            .active_streams
            .iter()
            .map(|stream| {
                json!({
                    "stream_id": &stream.stream_id,
                    "operation_id": &stream.operation_id,
                    "stream_type": &stream.stream_type,
                    "state": &stream.state,
                    "send_offset": stream.send_offset,
                    "receive_offset": stream.receive_offset,
                    "updated_at": &stream.updated_at,
                })
            })
            .collect();

        let report = json!({
            "proto": PROTO_VERSION,
            "type": "reconnect_report",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "bud_id": &meta.bud_id,
            "device_session_id": &meta.session_id,
            "operations": operations,
            "streams": streams,
            "terminal_sessions": journal.terminal_sessions,
            "local_policy_version": journal.local_policy_version,
        });
        send_transport_frame(sender, report)
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
            self.device_capabilities(HelloTransportMode::WebSocket),
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

    fn build_hello_frame(&self, transport_mode: HelloTransportMode) -> Result<Value> {
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
        frame.insert(
            "capabilities".into(),
            self.device_capabilities(transport_mode),
        );

        if let Some(identity) = &self.identity {
            frame.insert("bud_id".into(), Value::String(identity.bud_id.clone()));
        } else if let Some(token) = &self.args.token {
            frame.insert("token".into(), Value::String(token.clone()));
        } else {
            bail!("No device credential found and no enrollment token provided");
        }

        Ok(Value::Object(frame))
    }

    fn device_capabilities(&self, transport_mode: HelloTransportMode) -> Value {
        let terminal_available =
            self.args.terminal_enabled && self.terminal_manager.config.tmux_available;
        let websocket_mode = matches!(transport_mode, HelloTransportMode::WebSocket);
        let grpc_data_mode = matches!(transport_mode, HelloTransportMode::GrpcControl)
            && self.args.grpc_data_url.is_some();
        let stream_frames_supported = websocket_mode || grpc_data_mode;

        json!({
            "max_concurrency": 1,
            "shell_default": self.terminal_manager.config.shell,
            "sessions": terminal_available,
            "terminal": terminal_available,
            "terminal_proto": TERMINAL_PROTO_VERSION,
            "bud_envelope": {
                "version": 1,
                "websocket_binary": true,
                "h2_grpc_control": matches!(transport_mode, HelloTransportMode::GrpcControl),
                "h2_data": grpc_data_mode,
                "stream_frames": stream_frames_supported
            },
            "proxy": {
                "localhost_http": stream_frames_supported,
                "methods": ["GET", "HEAD"],
                "target_hosts": ["127.0.0.1"]
            },
            "files": {
                "workspace_read": stream_frames_supported,
                "roots": ["workspace"],
                "permissions": ["stat", "read", "range"]
            },
        })
    }
}

fn grpc_error_allows_websocket_fallback(err: &anyhow::Error) -> bool {
    !err.chain().any(|cause| {
        cause
            .to_string()
            .contains("gRPC handshake (code=AUTH_FAILED)")
    })
}
