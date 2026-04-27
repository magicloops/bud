use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method, Url};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio::task;
use tracing::warn;

use crate::protocol::{ProxyOpenFrame, StreamCreditFrame, StreamResetFrame, PROTO_VERSION};
use crate::transport::{send_transport_frame, TransportSender};
use crate::util::{new_message_id, now_millis};

const LOCALHOST_PROXY_STREAM_TYPE: &str = "localhost_http_proxy";
const DEFAULT_INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const MAX_CHUNK_BYTES_LIMIT: usize = 1024 * 1024;
const REQUEST_HEADER_ALLOWLIST: &[&str] = &[
    "accept",
    "accept-language",
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
}

enum ProxyStreamEvent {
    Credit { credit_bytes: u64 },
    Reset { reason: String },
}

impl ProxyManager {
    pub fn handle_open(&self, frame: ProxyOpenFrame, sender: TransportSender, client: Client) {
        let manager = self.clone();
        task::spawn_local(async move {
            if let Err(err) = manager.run_proxy(frame, sender, client).await {
                warn!(error = %err, "localhost proxy stream task failed");
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

    async fn run_proxy(
        &self,
        frame: ProxyOpenFrame,
        sender: TransportSender,
        client: Client,
    ) -> Result<()> {
        if let Err(err) = validate_proxy_open_frame(&frame) {
            send_proxy_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }

        let (credit_tx, mut credit_rx) = mpsc::unbounded_channel();
        self.register_stream(frame.stream_id.clone(), credit_tx)
            .await;

        let result = self
            .run_validated_proxy(frame.clone(), sender.clone(), client, &mut credit_rx)
            .await;
        self.unregister_stream(&frame.stream_id).await;

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

    async fn run_validated_proxy(
        &self,
        frame: ProxyOpenFrame,
        sender: TransportSender,
        client: Client,
        credit_rx: &mut mpsc::UnboundedReceiver<ProxyStreamEvent>,
    ) -> Result<()> {
        let url = proxy_url(&frame)?;
        let method = method_for_proxy_open(&frame)?;
        let mut request = client.request(method.clone(), url);
        for (name, value) in sanitize_request_headers(frame.headers.as_ref()) {
            request = request.header(name, value);
        }

        let mut response = match request.send().await {
            Ok(response) => response,
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
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
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
            };
            for segment in chunk.chunks(max_chunk_bytes) {
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
}

pub fn validate_proxy_open_frame(frame: &ProxyOpenFrame) -> Result<()> {
    if frame.stream_type != LOCALHOST_PROXY_STREAM_TYPE {
        bail!("unsupported proxy stream type: {}", frame.stream_type);
    }
    if frame.target_host != "127.0.0.1" {
        bail!("proxy target host must be 127.0.0.1");
    }
    method_for_proxy_open(frame)?;
    if !frame.path.starts_with('/') {
        bail!("proxy target path must be absolute");
    }
    Ok(())
}

fn method_for_proxy_open(frame: &ProxyOpenFrame) -> Result<Method> {
    match frame.method.as_str() {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        other => bail!("unsupported proxy method: {}", other),
    }
}

fn proxy_url(frame: &ProxyOpenFrame) -> Result<Url> {
    Url::parse(&format!(
        "http://127.0.0.1:{}{}",
        frame.target_port, frame.path
    ))
    .map_err(|err| err.into())
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
            initial_credit_bytes: Some(1024),
            max_chunk_bytes: Some(16 * 1024),
        }
    }

    #[test]
    fn validates_loopback_get_or_head_only() {
        assert!(validate_proxy_open_frame(&frame()).is_ok());

        let mut non_loopback = frame();
        non_loopback.target_host = "localhost".into();
        assert!(validate_proxy_open_frame(&non_loopback).is_err());

        let mut unsupported_method = frame();
        unsupported_method.method = "POST".into();
        assert!(validate_proxy_open_frame(&unsupported_method).is_err());

        let mut relative_path = frame();
        relative_path.path = "relative".into();
        assert!(validate_proxy_open_frame(&relative_path).is_err());
    }
}
