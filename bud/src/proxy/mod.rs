use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use reqwest::header::{HeaderName, HeaderValue, SET_COOKIE};
use reqwest::{Client, Method, Url};
use serde_json::{json, Value};
use tokio::net::lookup_host;
use tokio::sync::{mpsc, Mutex};
use tokio::task;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request as WebSocketRequest;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

use crate::protocol::{
    ProxyOpenFrame, ProxyWebSocketCloseFrame, ProxyWebSocketErrorFrame, ProxyWebSocketMessageFrame,
    ProxyWebSocketOpenFrame, StreamCreditFrame, StreamDataFrame, StreamResetFrame, PROTO_VERSION,
};
use crate::transport::{send_transport_frame, TransportSender};
use crate::util::{new_message_id, now_millis};

const LOCALHOST_PROXY_STREAM_TYPE: &str = "localhost_http_proxy";
const LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE: &str = "localhost_websocket_proxy";
const DEFAULT_INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const MAX_CHUNK_BYTES_LIMIT: usize = 1024 * 1024;
const DEFAULT_MAX_WS_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_WS_MESSAGE_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: u64 = 10 * 1024 * 1024;
const REQUEST_HEADER_ALLOWLIST: &[&str] = &[
    "accept",
    "accept-language",
    "cookie",
    "content-type",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
];
const RESPONSE_HEADER_ALLOWLIST: &[&str] = &[
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "expires",
    "last-modified",
];

#[derive(Clone, Default)]
pub struct ProxyManager {
    streams: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ProxyStreamEvent>>>>,
    ws_sessions: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ProxyWebSocketEvent>>>>,
}

enum ProxyStreamEvent {
    Credit {
        credit_bytes: u64,
    },
    RequestBody {
        offset: u64,
        data: Vec<u8>,
        end_stream: bool,
    },
    Reset {
        reason: String,
    },
}

enum ProxyWebSocketEvent {
    Message { message_type: String, data: String },
    Close { reason: Option<String> },
    Error { message: String },
}

impl ProxyManager {
    pub async fn handle_open(
        &self,
        frame: ProxyOpenFrame,
        sender: TransportSender,
        client: Client,
    ) {
        let manager = self.clone();
        let stream_id = frame.stream_id.clone();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        self.register_stream(stream_id.clone(), event_tx).await;
        task::spawn_local(async move {
            if let Err(err) = manager.run_proxy(frame, sender, client, event_rx).await {
                warn!(error = %err, "localhost proxy stream task failed");
            }
            manager.unregister_stream(&stream_id).await;
        });
    }

    pub fn handle_ws_open(&self, frame: ProxyWebSocketOpenFrame, sender: TransportSender) {
        let manager = self.clone();
        task::spawn_local(async move {
            if let Err(err) = manager.run_ws_proxy(frame, sender).await {
                warn!(error = %err, "localhost WebSocket proxy task failed");
            }
        });
    }

    pub async fn apply_credit(&self, frame: StreamCreditFrame) {
        let streams = self.streams.lock().await;
        if let Some(sender) = streams.get(&frame.stream_id) {
            let _ = sender.send(ProxyStreamEvent::Credit {
                credit_bytes: frame.credit_bytes,
            });
        }
    }

    pub async fn apply_data(&self, frame: StreamDataFrame) -> bool {
        let data = match BASE64_STANDARD.decode(frame.data.as_bytes()) {
            Ok(data) => data,
            Err(err) => {
                warn!(
                    stream_id = %frame.stream_id,
                    error = %err,
                    "failed to decode proxy request body chunk"
                );
                return false;
            }
        };
        let streams = self.streams.lock().await;
        if let Some(sender) = streams.get(&frame.stream_id) {
            let _ = sender.send(ProxyStreamEvent::RequestBody {
                offset: frame.offset,
                data,
                end_stream: frame.end_stream,
            });
            return true;
        }
        false
    }

    pub async fn apply_reset(&self, frame: StreamResetFrame) {
        let sender = {
            let mut streams = self.streams.lock().await;
            streams.remove(&frame.stream_id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(ProxyStreamEvent::Reset {
                reason: frame.reason,
            });
        }
    }

    pub async fn apply_ws_message(&self, frame: ProxyWebSocketMessageFrame) {
        let sessions = self.ws_sessions.lock().await;
        if let Some(sender) = sessions.get(&frame.ws_session_id) {
            let _ = sender.send(ProxyWebSocketEvent::Message {
                message_type: frame.message_type,
                data: frame.data,
            });
        }
    }

    pub async fn apply_ws_close(&self, frame: ProxyWebSocketCloseFrame) {
        let sender = {
            let mut sessions = self.ws_sessions.lock().await;
            sessions.remove(&frame.ws_session_id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(ProxyWebSocketEvent::Close {
                reason: frame.reason,
            });
        }
    }

    pub async fn apply_ws_error(&self, frame: ProxyWebSocketErrorFrame) {
        let sender = {
            let mut sessions = self.ws_sessions.lock().await;
            sessions.remove(&frame.ws_session_id)
        };
        if let Some(sender) = sender {
            let message = frame
                .error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("proxied WebSocket reset")
                .to_string();
            let _ = sender.send(ProxyWebSocketEvent::Error { message });
        }
    }

    async fn run_proxy(
        &self,
        frame: ProxyOpenFrame,
        sender: TransportSender,
        client: Client,
        mut event_rx: mpsc::UnboundedReceiver<ProxyStreamEvent>,
    ) -> Result<()> {
        if let Err(err) = validate_proxy_open_frame(&frame) {
            send_proxy_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let result = self
            .run_validated_proxy(frame.clone(), sender.clone(), client, &mut event_rx)
            .await;

        if let Err(err) = result {
            warn!(
                stream_id = %frame.stream_id,
                operation_id = %frame.operation_id,
                error = %err,
                "localhost proxy stream ended with error"
            );
        }
        Ok(())
    }

    async fn run_ws_proxy(
        &self,
        frame: ProxyWebSocketOpenFrame,
        sender: TransportSender,
    ) -> Result<()> {
        if let Err(err) = validate_proxy_ws_open_frame(&frame) {
            send_proxy_ws_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        self.register_ws_session(frame.ws_session_id.clone(), event_tx)
            .await;

        let result = self
            .run_validated_ws_proxy(frame.clone(), sender.clone(), &mut event_rx)
            .await;
        self.unregister_ws_session(&frame.ws_session_id).await;

        if let Err(err) = result {
            warn!(
                ws_session_id = %frame.ws_session_id,
                operation_id = %frame.operation_id,
                error = %err,
                "localhost WebSocket proxy ended with error"
            );
        }
        Ok(())
    }

    async fn run_validated_proxy(
        &self,
        frame: ProxyOpenFrame,
        sender: TransportSender,
        client: Client,
        credit_rx: &mut mpsc::UnboundedReceiver<ProxyStreamEvent>,
    ) -> Result<()> {
        let url = proxy_url(&frame)?;
        if let Err(err) = validate_loopback_resolution(&frame.target_host, frame.target_port).await
        {
            send_proxy_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }
        let method = method_for_proxy_open(&frame)?;
        let mut request = client.request(method.clone(), url);
        for (name, value) in sanitize_request_headers(frame.headers.as_ref()) {
            request = request.header(name, value);
        }
        let request_body = match read_request_body(&frame, credit_rx).await {
            Ok(body) => body,
            Err(err) => {
                send_proxy_open_rejected(
                    &sender,
                    &frame,
                    "REQUEST_BODY_INVALID",
                    &err.to_string(),
                    false,
                )?;
                return Ok(());
            }
        };
        if let Some(body) = request_body {
            request = request.body(body);
        }

        let mut send_future = Box::pin(request.send());
        let mut response = loop {
            tokio::select! {
                result = &mut send_future => {
                    match result {
                        Ok(response) => break response,
                        Err(err) => {
                            send_proxy_open_rejected(
                                &sender,
                                &frame,
                                "LOCAL_CONNECT_FAILED",
                                &err.to_string(),
                                true,
                            )?;
                            return Ok(());
                        }
                    }
                }
                event = credit_rx.recv() => {
                    match event {
                        Some(ProxyStreamEvent::Reset { reason }) => {
                            warn!(
                                stream_id = %frame.stream_id,
                                reason = %reason,
                                "proxy stream reset before local response"
                            );
                            return Ok(());
                        }
                        Some(ProxyStreamEvent::Credit { .. }) => {}
                        Some(ProxyStreamEvent::RequestBody { .. }) => {
                            send_stream_reset(
                                &sender,
                                &frame.stream_id,
                                "protocol_error",
                                "UNEXPECTED_REQUEST_BODY_DATA",
                                "request body data arrived after the body was complete",
                                false,
                            )?;
                            return Ok(());
                        }
                        None => return Ok(()),
                    }
                }
            }
        };

        send_proxy_open_accepted(&sender, &frame, response.status().as_u16(), &response)?;
        if method == Method::HEAD {
            send_stream_close(&sender, &frame.stream_id, 0)?;
            return Ok(());
        }

        let max_chunk_bytes = frame
            .max_chunk_bytes
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_CHUNK_BYTES)
            .clamp(1, MAX_CHUNK_BYTES_LIMIT);
        let mut available_credit = frame
            .initial_credit_bytes
            .unwrap_or(DEFAULT_INITIAL_CREDIT_BYTES);
        let mut offset = 0_u64;

        loop {
            drain_proxy_events(&mut available_credit, credit_rx)?;
            let maybe_chunk = loop {
                tokio::select! {
                    event = credit_rx.recv() => {
                        match event {
                            Some(ProxyStreamEvent::Credit { credit_bytes }) => {
                                available_credit = available_credit.saturating_add(credit_bytes);
                            }
                            Some(ProxyStreamEvent::Reset { reason }) => {
                                warn!(
                                    stream_id = %frame.stream_id,
                                    reason = %reason,
                                    "proxy stream reset while reading local response"
                                );
                                return Ok(());
                            }
                            Some(ProxyStreamEvent::RequestBody { .. }) => {
                                send_stream_reset(
                                    &sender,
                                    &frame.stream_id,
                                    "protocol_error",
                                    "UNEXPECTED_REQUEST_BODY_DATA",
                                    "request body data arrived after the body was complete",
                                    false,
                                )?;
                                return Ok(());
                            }
                            None => return Ok(()),
                        }
                    }
                    result = response.chunk() => {
                        match result {
                            Ok(Some(chunk)) => break Some(chunk),
                            Ok(None) => break None,
                            Err(err) => {
                                send_stream_reset(
                                    &sender,
                                    &frame.stream_id,
                                    "remote_error",
                                    "LOCAL_READ_FAILED",
                                    &err.to_string(),
                                    true,
                                )?;
                                return Ok(());
                            }
                        }
                    }
                }
            };
            let Some(chunk) = maybe_chunk else {
                break;
            };
            for segment in chunk.chunks(max_chunk_bytes) {
                drain_proxy_events(&mut available_credit, credit_rx)?;
                if let Err(err) =
                    wait_for_credit(&mut available_credit, segment.len() as u64, credit_rx).await
                {
                    warn!(
                        stream_id = %frame.stream_id,
                        error = %err,
                        "stopping localhost proxy stream while waiting for credit"
                    );
                    return Ok(());
                }
                send_stream_data(&sender, &frame, offset, segment, false)?;
                available_credit = available_credit.saturating_sub(segment.len() as u64);
                offset += segment.len() as u64;
            }
        }

        send_stream_close(&sender, &frame.stream_id, offset)
    }

    async fn run_validated_ws_proxy(
        &self,
        frame: ProxyWebSocketOpenFrame,
        sender: TransportSender,
        event_rx: &mut mpsc::UnboundedReceiver<ProxyWebSocketEvent>,
    ) -> Result<()> {
        let request = proxy_ws_request(&frame)?;
        if let Err(err) = validate_loopback_resolution(&frame.target_host, frame.target_port).await
        {
            send_proxy_ws_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let (ws_stream, response) = match connect_async(request).await {
            Ok(result) => result,
            Err(err) => {
                send_proxy_ws_open_rejected(
                    &sender,
                    &frame,
                    "LOCAL_CONNECT_FAILED",
                    &err.to_string(),
                    true,
                )?;
                return Ok(());
            }
        };
        let selected_protocol = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        send_proxy_ws_open_accepted(&sender, &frame, selected_protocol.as_deref())?;

        let max_message_bytes = frame
            .max_message_bytes
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_WS_MESSAGE_BYTES)
            .clamp(1, MAX_WS_MESSAGE_BYTES_LIMIT);
        let (mut ws_write, mut ws_read) = ws_stream.split();

        loop {
            tokio::select! {
                Some(event) = event_rx.recv() => {
                    match event {
                        ProxyWebSocketEvent::Message { message_type, data } => {
                            let message = proxy_ws_event_message(&message_type, &data, max_message_bytes)?;
                            ws_write.send(message).await?;
                        }
                        ProxyWebSocketEvent::Close { reason } => {
                            let _ = reason;
                            ws_write.send(Message::Close(None)).await?;
                            return Ok(());
                        }
                        ProxyWebSocketEvent::Error { message } => {
                            warn!(
                                ws_session_id = %frame.ws_session_id,
                                message = %message,
                                "service reset proxied WebSocket"
                            );
                            ws_write.send(Message::Close(None)).await?;
                            return Ok(());
                        }
                    }
                }
                maybe_message = ws_read.next() => {
                    let Some(message) = maybe_message else {
                        send_proxy_ws_close(&sender, &frame.ws_session_id, None, Some("local WebSocket closed"))?;
                        return Ok(());
                    };
                    match message {
                        Ok(Message::Text(text)) => {
                            if text.as_bytes().len() > max_message_bytes {
                                send_proxy_ws_error(&sender, &frame.ws_session_id, "LOCAL_WS_MESSAGE_TOO_LARGE", "local WebSocket text message exceeded max_message_bytes", false)?;
                                return Ok(());
                            }
                            send_proxy_ws_message_text(&sender, &frame.ws_session_id, &text)?;
                        }
                        Ok(Message::Binary(bytes)) => {
                            if bytes.len() > max_message_bytes {
                                send_proxy_ws_error(&sender, &frame.ws_session_id, "LOCAL_WS_MESSAGE_TOO_LARGE", "local WebSocket binary message exceeded max_message_bytes", false)?;
                                return Ok(());
                            }
                            send_proxy_ws_message_binary(&sender, &frame.ws_session_id, &bytes)?;
                        }
                        Ok(Message::Close(close)) => {
                            let (code, reason) = close
                                .map(|frame| (Some(u16::from(frame.code)), Some(frame.reason.to_string())))
                                .unwrap_or((None, None));
                            send_proxy_ws_close(&sender, &frame.ws_session_id, code, reason.as_deref())?;
                            return Ok(());
                        }
                        Ok(Message::Ping(payload)) => {
                            ws_write.send(Message::Pong(payload)).await?;
                        }
                        Ok(Message::Pong(_)) => {}
                        Ok(Message::Frame(_)) => {}
                        Err(err) => {
                            send_proxy_ws_error(&sender, &frame.ws_session_id, "LOCAL_WS_READ_FAILED", &err.to_string(), true)?;
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    async fn register_stream(
        &self,
        stream_id: String,
        sender: mpsc::UnboundedSender<ProxyStreamEvent>,
    ) {
        self.streams.lock().await.insert(stream_id, sender);
    }

    async fn unregister_stream(&self, stream_id: &str) {
        self.streams.lock().await.remove(stream_id);
    }

    async fn register_ws_session(
        &self,
        ws_session_id: String,
        sender: mpsc::UnboundedSender<ProxyWebSocketEvent>,
    ) {
        self.ws_sessions.lock().await.insert(ws_session_id, sender);
    }

    async fn unregister_ws_session(&self, ws_session_id: &str) {
        self.ws_sessions.lock().await.remove(ws_session_id);
    }
}

pub fn validate_proxy_open_frame(frame: &ProxyOpenFrame) -> Result<()> {
    if frame.stream_type != LOCALHOST_PROXY_STREAM_TYPE {
        bail!("unsupported proxy stream type: {}", frame.stream_type);
    }
    if !matches!(
        frame.target_host.as_str(),
        "127.0.0.1" | "::1" | "localhost"
    ) {
        bail!("proxy target host must be 127.0.0.1, ::1, or localhost");
    }
    method_for_proxy_open(frame)?;
    if !frame.path.starts_with('/') {
        bail!("proxy target path must be absolute");
    }
    Ok(())
}

pub fn validate_proxy_ws_open_frame(frame: &ProxyWebSocketOpenFrame) -> Result<()> {
    if frame.stream_type != LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE {
        bail!(
            "unsupported proxy WebSocket stream type: {}",
            frame.stream_type
        );
    }
    if !matches!(
        frame.target_host.as_str(),
        "127.0.0.1" | "::1" | "localhost"
    ) {
        bail!("proxy WebSocket target host must be 127.0.0.1, ::1, or localhost");
    }
    if !frame.path.starts_with('/') {
        bail!("proxy WebSocket target path must be absolute");
    }
    if frame.path.contains('\0') {
        bail!("proxy WebSocket target path cannot contain NUL bytes");
    }
    Ok(())
}

fn method_for_proxy_open(frame: &ProxyOpenFrame) -> Result<Method> {
    match frame.method.as_str() {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        "OPTIONS" => Ok(Method::OPTIONS),
        other => bail!("unsupported proxy method: {}", other),
    }
}

fn proxy_url(frame: &ProxyOpenFrame) -> Result<Url> {
    let host = match frame.target_host.as_str() {
        "::1" => "[::1]",
        other => other,
    };
    Url::parse(&format!(
        "http://{}:{}{}",
        host, frame.target_port, frame.path
    ))
    .map_err(|err| err.into())
}

fn proxy_ws_url(frame: &ProxyWebSocketOpenFrame) -> Result<Url> {
    let host = match frame.target_host.as_str() {
        "::1" => "[::1]",
        other => other,
    };
    Url::parse(&format!(
        "ws://{}:{}{}",
        host, frame.target_port, frame.path
    ))
    .map_err(|err| err.into())
}

fn proxy_ws_request(frame: &ProxyWebSocketOpenFrame) -> Result<WebSocketRequest> {
    let mut request = proxy_ws_url(frame)?.into_client_request()?;
    let protocols = safe_ws_subprotocols(frame.protocols.as_deref());
    if !protocols.is_empty() {
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", protocols.join(", ").parse()?);
    }
    Ok(request)
}

fn safe_ws_subprotocols(protocols: Option<&[String]>) -> Vec<String> {
    let mut safe = Vec::new();
    for protocol in protocols.unwrap_or(&[]).iter() {
        let value = protocol.trim();
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(is_ws_subprotocol_token_byte)
            || safe.iter().any(|existing| existing == value)
        {
            continue;
        }
        safe.push(value.to_string());
        if safe.len() >= 8 {
            break;
        }
    }
    safe
}

fn is_ws_subprotocol_token_byte(byte: u8) -> bool {
    matches!(
        byte,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+'
            | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
            | b'0'..=b'9'
            | b'A'..=b'Z'
            | b'a'..=b'z'
    )
}

async fn validate_loopback_resolution(host: &str, port: u16) -> Result<()> {
    match host {
        "127.0.0.1" | "::1" => Ok(()),
        "localhost" => {
            let mut addrs = lookup_host((host, port)).await?;
            let mut saw_addr = false;
            for addr in addrs.by_ref() {
                saw_addr = true;
                if !addr.ip().is_loopback() {
                    bail!("localhost resolved to non-loopback address {}", addr.ip());
                }
            }
            if !saw_addr {
                bail!("localhost did not resolve to any address");
            }
            Ok(())
        }
        other => bail!("unsupported proxy target host: {}", other),
    }
}

async fn read_request_body(
    frame: &ProxyOpenFrame,
    event_rx: &mut mpsc::UnboundedReceiver<ProxyStreamEvent>,
) -> Result<Option<Vec<u8>>> {
    let expected = frame.request_body_bytes.unwrap_or(0);
    if expected == 0 {
        return Ok(None);
    }
    if expected > MAX_REQUEST_BODY_BYTES {
        bail!(
            "proxy request body exceeds {} bytes",
            MAX_REQUEST_BODY_BYTES
        );
    }

    let mut body = Vec::with_capacity(expected as usize);
    let mut saw_end_stream = false;
    while (body.len() as u64) < expected {
        match event_rx.recv().await {
            Some(ProxyStreamEvent::RequestBody {
                offset,
                data,
                end_stream,
            }) => {
                if offset != body.len() as u64 {
                    bail!(
                        "proxy request body offset mismatch: expected {}, got {}",
                        body.len(),
                        offset
                    );
                }
                let next_len = body.len() + data.len();
                if next_len as u64 > expected || next_len as u64 > MAX_REQUEST_BODY_BYTES {
                    bail!("proxy request body exceeded declared size");
                }
                body.extend_from_slice(&data);
                saw_end_stream = end_stream;
                if end_stream && body.len() as u64 != expected {
                    bail!("proxy request body ended before declared size");
                }
            }
            Some(ProxyStreamEvent::Reset { reason }) => {
                bail!("proxy stream reset while reading request body: {}", reason);
            }
            Some(ProxyStreamEvent::Credit { .. }) => {}
            None => bail!("proxy request body channel closed"),
        }
    }
    if !saw_end_stream {
        bail!("proxy request body completed without end_stream");
    }
    Ok(Some(body))
}

fn drain_proxy_events(
    available_credit: &mut u64,
    event_rx: &mut mpsc::UnboundedReceiver<ProxyStreamEvent>,
) -> Result<()> {
    loop {
        match event_rx.try_recv() {
            Ok(ProxyStreamEvent::Credit { credit_bytes }) => {
                *available_credit = available_credit.saturating_add(credit_bytes);
            }
            Ok(ProxyStreamEvent::Reset { reason }) => bail!("proxy stream reset: {}", reason),
            Ok(ProxyStreamEvent::RequestBody { .. }) => {
                bail!("unexpected proxy request body data after request started")
            }
            Err(mpsc::error::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::error::TryRecvError::Disconnected) => {
                bail!("proxy stream event channel closed")
            }
        }
    }
}

async fn wait_for_credit(
    available_credit: &mut u64,
    required: u64,
    credit_rx: &mut mpsc::UnboundedReceiver<ProxyStreamEvent>,
) -> Result<()> {
    while *available_credit < required {
        match credit_rx.recv().await {
            Some(ProxyStreamEvent::Credit { credit_bytes }) => {
                *available_credit = available_credit.saturating_add(credit_bytes);
            }
            Some(ProxyStreamEvent::Reset { reason }) => bail!("proxy stream reset: {}", reason),
            Some(ProxyStreamEvent::RequestBody { .. }) => {
                bail!("unexpected proxy request body data after request started")
            }
            None => bail!("proxy stream credit channel closed"),
        }
    }
    Ok(())
}

fn send_proxy_open_accepted(
    sender: &TransportSender,
    frame: &ProxyOpenFrame,
    status_code: u16,
    response: &reqwest::Response,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "stream_id": frame.stream_id,
            "accepted": true,
            "status_code": status_code,
            "headers": sanitize_response_headers(response),
            "set_cookies": sanitize_response_cookies(response),
        }),
    )
}

fn send_proxy_open_rejected(
    sender: &TransportSender,
    frame: &ProxyOpenFrame,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "stream_id": frame.stream_id,
            "accepted": false,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable
            }
        }),
    )
}

fn send_proxy_ws_open_accepted(
    sender: &TransportSender,
    frame: &ProxyWebSocketOpenFrame,
    selected_protocol: Option<&str>,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "ws_session_id": frame.ws_session_id,
            "accepted": true,
            "selected_protocol": selected_protocol,
        }),
    )
}

fn send_proxy_ws_open_rejected(
    sender: &TransportSender,
    frame: &ProxyWebSocketOpenFrame,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "ws_session_id": frame.ws_session_id,
            "accepted": false,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable
            }
        }),
    )
}

fn send_proxy_ws_message_text(
    sender: &TransportSender,
    ws_session_id: &str,
    data: &str,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_message",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "ws_session_id": ws_session_id,
            "message_type": "text",
            "data": data,
        }),
    )
}

fn send_proxy_ws_message_binary(
    sender: &TransportSender,
    ws_session_id: &str,
    data: &[u8],
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_message",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "ws_session_id": ws_session_id,
            "message_type": "binary",
            "data": BASE64_STANDARD.encode(data),
        }),
    )
}

fn send_proxy_ws_close(
    sender: &TransportSender,
    ws_session_id: &str,
    code: Option<u16>,
    reason: Option<&str>,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_close",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "ws_session_id": ws_session_id,
            "code": code,
            "reason": reason,
        }),
    )
}

fn send_proxy_ws_error(
    sender: &TransportSender,
    ws_session_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "proxy_ws_error",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "ws_session_id": ws_session_id,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable
            }
        }),
    )
}

fn proxy_ws_event_message(
    message_type: &str,
    data: &str,
    max_message_bytes: usize,
) -> Result<Message> {
    match message_type {
        "text" => {
            if data.as_bytes().len() > max_message_bytes {
                bail!("proxied WebSocket text message exceeds max_message_bytes");
            }
            Ok(Message::Text(data.to_string()))
        }
        "binary" => {
            let decoded = BASE64_STANDARD.decode(data.as_bytes())?;
            if decoded.len() > max_message_bytes {
                bail!("proxied WebSocket binary message exceeds max_message_bytes");
            }
            Ok(Message::Binary(decoded))
        }
        other => bail!("unsupported proxied WebSocket message_type: {}", other),
    }
}

fn send_stream_data(
    sender: &TransportSender,
    frame: &ProxyOpenFrame,
    offset: u64,
    data: &[u8],
    end_stream: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "stream_data",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "stream_id": frame.stream_id,
            "stream_type": frame.stream_type,
            "offset": offset,
            "data": BASE64_STANDARD.encode(data),
            "end_stream": end_stream,
        }),
    )
}

fn send_stream_close(sender: &TransportSender, stream_id: &str, final_offset: u64) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "stream_close",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "stream_id": stream_id,
            "final_offset": final_offset,
        }),
    )
}

fn send_stream_reset(
    sender: &TransportSender,
    stream_id: &str,
    reason: &str,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "stream_reset",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "stream_id": stream_id,
            "reason": reason,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable
            }
        }),
    )
}

fn sanitize_request_headers(
    headers: Option<&HashMap<String, String>>,
) -> Vec<(HeaderName, HeaderValue)> {
    let Some(headers) = headers else {
        return Vec::new();
    };
    headers
        .iter()
        .filter_map(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            if !REQUEST_HEADER_ALLOWLIST.contains(&lower.as_str()) {
                return None;
            }
            let name = HeaderName::from_bytes(lower.as_bytes()).ok()?;
            let value = HeaderValue::from_str(value).ok()?;
            Some((name, value))
        })
        .collect()
}

fn sanitize_response_headers(response: &reqwest::Response) -> HashMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            let lower = name.as_str().to_ascii_lowercase();
            if !RESPONSE_HEADER_ALLOWLIST.contains(&lower.as_str()) {
                return None;
            }
            Some((lower, value.to_str().ok()?.to_string()))
        })
        .collect()
}

fn sanitize_response_cookies(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect()
}

#[allow(dead_code)]
fn error_value(code: &str, message: &str, retryable: bool) -> Value {
    json!({
        "code": code,
        "message": message,
        "retryable": retryable
    })
}

#[cfg(test)]
mod tests {
    use crate::protocol::Envelope;

    use super::*;

    fn frame() -> ProxyOpenFrame {
        ProxyOpenFrame {
            envelope: Envelope {
                kind: "proxy_open".into(),
                proto: PROTO_VERSION.into(),
                id: "msg_test".into(),
                ts: 0,
                ext: Value::Null,
            },
            operation_id: "op_test".into(),
            stream_id: "st_test".into(),
            proxy_session_id: "ps_test".into(),
            stream_type: LOCALHOST_PROXY_STREAM_TYPE.into(),
            target_host: "127.0.0.1".into(),
            target_port: 3000,
            method: "GET".into(),
            path: "/index.html".into(),
            headers: None,
            request_body_bytes: None,
            initial_credit_bytes: Some(1024),
            max_chunk_bytes: Some(16 * 1024),
        }
    }

    fn ws_frame() -> ProxyWebSocketOpenFrame {
        ProxyWebSocketOpenFrame {
            envelope: Envelope {
                kind: "proxy_ws_open".into(),
                proto: PROTO_VERSION.into(),
                id: "msg_ws_test".into(),
                ts: 0,
                ext: Value::Null,
            },
            operation_id: "op_test".into(),
            ws_session_id: "st_ws_test".into(),
            proxied_site_id: Some("site_test".into()),
            stream_type: LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE.into(),
            target_host: "localhost".into(),
            target_port: 5173,
            path: "/@vite/client".into(),
            protocols: None,
            max_message_bytes: Some(1024 * 1024),
        }
    }

    #[test]
    fn validates_loopback_methods() {
        assert!(validate_proxy_open_frame(&frame()).is_ok());

        let mut localhost = frame();
        localhost.target_host = "localhost".into();
        assert!(validate_proxy_open_frame(&localhost).is_ok());

        let mut ipv6_loopback = frame();
        ipv6_loopback.target_host = "::1".into();
        assert!(validate_proxy_open_frame(&ipv6_loopback).is_ok());

        let mut non_loopback = frame();
        non_loopback.target_host = "10.0.0.1".into();
        assert!(validate_proxy_open_frame(&non_loopback).is_err());

        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            let mut supported_method = frame();
            supported_method.method = method.into();
            assert!(validate_proxy_open_frame(&supported_method).is_ok());
        }

        let mut unsupported_method = frame();
        unsupported_method.method = "TRACE".into();
        assert!(validate_proxy_open_frame(&unsupported_method).is_err());

        let mut relative_path = frame();
        relative_path.path = "relative".into();
        assert!(validate_proxy_open_frame(&relative_path).is_err());
    }

    #[test]
    fn validates_websocket_loopback_absolute_path() {
        assert!(validate_proxy_ws_open_frame(&ws_frame()).is_ok());

        let mut ipv4 = ws_frame();
        ipv4.target_host = "127.0.0.1".into();
        assert!(validate_proxy_ws_open_frame(&ipv4).is_ok());

        let mut ipv6 = ws_frame();
        ipv6.target_host = "::1".into();
        assert!(validate_proxy_ws_open_frame(&ipv6).is_ok());

        let mut non_loopback = ws_frame();
        non_loopback.target_host = "example.com".into();
        assert!(validate_proxy_ws_open_frame(&non_loopback).is_err());

        let mut bad_stream_type = ws_frame();
        bad_stream_type.stream_type = LOCALHOST_PROXY_STREAM_TYPE.into();
        assert!(validate_proxy_ws_open_frame(&bad_stream_type).is_err());

        let mut relative_path = ws_frame();
        relative_path.path = "relative".into();
        assert!(validate_proxy_ws_open_frame(&relative_path).is_err());
    }

    #[test]
    fn websocket_request_forwards_safe_subprotocols() {
        let mut frame = ws_frame();
        frame.protocols = Some(vec![
            "vite-hmr".into(),
            "bad protocol".into(),
            "vite-hmr".into(),
            "graphql-transport-ws".into(),
        ]);

        let request = proxy_ws_request(&frame).expect("request");
        let protocol = request
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|value| value.to_str().ok());

        assert_eq!(protocol, Some("vite-hmr, graphql-transport-ws"));
    }

    #[test]
    fn forwards_only_safe_http_request_headers_including_cookies() {
        let headers = HashMap::from([
            ("Cookie".to_string(), "app_session=abc".to_string()),
            ("Authorization".to_string(), "Bearer secret".to_string()),
            ("Connection".to_string(), "keep-alive".to_string()),
            ("Accept".to_string(), "text/html".to_string()),
        ]);

        let sanitized = sanitize_request_headers(Some(&headers));
        let as_strings = sanitized
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect::<HashMap<_, _>>();

        assert_eq!(
            as_strings.get("cookie"),
            Some(&"app_session=abc".to_string())
        );
        assert_eq!(as_strings.get("accept"), Some(&"text/html".to_string()));
        assert!(!as_strings.contains_key("authorization"));
        assert!(!as_strings.contains_key("connection"));
    }
}
