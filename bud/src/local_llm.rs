use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method, Url};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio::task;
use tokio::time;
use tracing::{info, warn};

use crate::config::BudArgs;
use crate::protocol::{
    LocalLlmOpenFrame, StreamCreditFrame, StreamDataFrame, StreamResetFrame, PROTO_VERSION,
};
use crate::transport::{send_transport_frame, TransportSender};
use crate::util::{new_message_id, now_millis};

pub const LOCAL_LLM_HTTP_STREAM_TYPE: &str = "local_llm_http";

const DS4_SERVER_ID: &str = "ds4";
const DS4_PROVIDER_MODEL: &str = "deepseek-v4-flash";
const DEFAULT_INITIAL_CREDIT_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES: usize = 16 * 1024;
const MAX_CHUNK_BYTES_LIMIT: usize = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONCURRENT_STREAMS: usize = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const STREAM_TOTAL_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const REQUEST_HEADER_ALLOWLIST: &[&str] = &["accept", "content-type"];
const RESPONSE_HEADER_ALLOWLIST: &[&str] = &["content-length", "content-type"];

#[derive(Clone)]
pub struct LocalLlmManager {
    inner: Arc<LocalLlmManagerInner>,
}

struct LocalLlmManagerInner {
    config: Option<LocalLlmConfig>,
    client: Client,
    streams: Mutex<HashMap<String, mpsc::UnboundedSender<LocalLlmStreamEvent>>>,
    capability: StdMutex<Option<Value>>,
}

#[derive(Clone)]
struct LocalLlmConfig {
    origin: Url,
    context_tokens: u64,
    max_output_tokens: u64,
}

#[derive(Debug, Default, Clone, Copy, Eq, PartialEq)]
pub struct LocalLlmDisconnectSummary {
    pub streams: usize,
}

enum LocalLlmStreamEvent {
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

impl LocalLlmManager {
    pub fn new(args: &BudArgs, client: Client) -> Self {
        let config = match args.local_llm_ds4_url.as_deref() {
            Some(raw_url) => match LocalLlmConfig::from_args(raw_url, args) {
                Ok(config) => Some(config),
                Err(err) => {
                    warn!(
                        error = %err,
                        "Ignoring invalid local ds4 configuration"
                    );
                    None
                }
            },
            None => None,
        };

        Self {
            inner: Arc::new(LocalLlmManagerInner {
                config,
                client,
                streams: Mutex::new(HashMap::new()),
                capability: StdMutex::new(None),
            }),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.inner.config.is_some()
    }

    pub fn capability(&self) -> Option<Value> {
        self.inner
            .capability
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    pub async fn refresh_capability(&self) {
        let Some(config) = self.inner.config.clone() else {
            if let Ok(mut capability) = self.inner.capability.lock() {
                *capability = None;
            }
            return;
        };

        let models_url = match config.origin.join("/v1/models") {
            Ok(url) => url,
            Err(err) => {
                warn!(error = %err, "Failed to build local ds4 model probe URL");
                return;
            }
        };

        let result = time::timeout(PROBE_TIMEOUT, self.inner.client.get(models_url).send()).await;
        let response = match result {
            Ok(Ok(response)) if response.status().is_success() => response,
            Ok(Ok(response)) => {
                warn!(
                    status = response.status().as_u16(),
                    "Local ds4 model probe returned non-success status"
                );
                self.clear_capability();
                return;
            }
            Ok(Err(err)) => {
                warn!(error = %err, "Local ds4 model probe failed");
                self.clear_capability();
                return;
            }
            Err(_) => {
                warn!("Local ds4 model probe timed out");
                self.clear_capability();
                return;
            }
        };

        let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
        let model_available = body
            .get("data")
            .and_then(Value::as_array)
            .map(|models| {
                models.iter().any(|model| {
                    model
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id == DS4_PROVIDER_MODEL)
                })
            })
            .unwrap_or(true);

        if !model_available {
            warn!(
                model = DS4_PROVIDER_MODEL,
                "Local ds4 probe succeeded but expected model was not advertised"
            );
            self.clear_capability();
            return;
        }

        let capability = json!({
            "local_api": true,
            "servers": [
                {
                    "id": DS4_SERVER_ID,
                    "provider": "ds4",
                    "compatibility": ["openai_responses"],
                    "request_mode": "ds4_openai_responses",
                    "generation_path": "/v1/responses",
                    "models": [
                        {
                            "id": DS4_PROVIDER_MODEL,
                            "display_name": "ds4 DeepSeek V4",
                            "context_window_tokens": config.context_tokens,
                            "max_output_tokens": config.max_output_tokens
                        }
                    ],
                    "concurrency": 1,
                    "healthy": true
                }
            ]
        });
        if let Ok(mut stored) = self.inner.capability.lock() {
            *stored = Some(capability);
        }
        info!("Local ds4 capability probe succeeded");
    }

    pub async fn handle_open(&self, frame: LocalLlmOpenFrame, sender: TransportSender) {
        let manager = self.clone();
        let stream_id = frame.stream_id.clone();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        if !self.register_stream(stream_id.clone(), event_tx).await {
            if let Err(err) = send_open_rejected(
                &sender,
                &frame,
                "BUD_BUSY",
                "local ds4 already has an active stream",
                true,
            ) {
                warn!(error = %err, "failed to reject local LLM stream for concurrency");
            }
            return;
        }
        task::spawn_local(async move {
            match time::timeout(
                STREAM_TOTAL_TTL,
                manager.run_local_llm(frame, sender.clone(), event_rx),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    warn!(error = %err, "local LLM stream task failed");
                }
                Err(_) => {
                    if let Err(err) = send_stream_reset(
                        &sender,
                        &stream_id,
                        "timeout",
                        "LOCAL_LLM_STREAM_TTL_EXCEEDED",
                        "local LLM stream exceeded the daemon TTL",
                        false,
                    ) {
                        warn!(error = %err, "failed to reset expired local LLM stream");
                    }
                }
            }
            manager.unregister_stream(&stream_id).await;
        });
    }

    pub async fn apply_credit(&self, frame: StreamCreditFrame) {
        let streams = self.inner.streams.lock().await;
        if let Some(sender) = streams.get(&frame.stream_id) {
            let _ = sender.send(LocalLlmStreamEvent::Credit {
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
                    "failed to decode local LLM request body chunk"
                );
                return false;
            }
        };
        let streams = self.inner.streams.lock().await;
        if let Some(sender) = streams.get(&frame.stream_id) {
            let _ = sender.send(LocalLlmStreamEvent::RequestBody {
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
            let mut streams = self.inner.streams.lock().await;
            streams.remove(&frame.stream_id)
        };
        if let Some(sender) = sender {
            let _ = sender.send(LocalLlmStreamEvent::Reset {
                reason: frame.reason,
            });
        }
    }

    pub async fn abort_all_for_transport_disconnect(
        &self,
        reason: &str,
    ) -> LocalLlmDisconnectSummary {
        let stream_senders = {
            let mut streams = self.inner.streams.lock().await;
            streams
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for sender in &stream_senders {
            let _ = sender.send(LocalLlmStreamEvent::Reset {
                reason: reason.to_string(),
            });
        }
        LocalLlmDisconnectSummary {
            streams: stream_senders.len(),
        }
    }

    async fn run_local_llm(
        &self,
        frame: LocalLlmOpenFrame,
        sender: TransportSender,
        mut event_rx: mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
    ) -> Result<()> {
        let Some(config) = self.inner.config.clone() else {
            send_open_rejected(
                &sender,
                &frame,
                "LOCAL_LLM_NOT_CONFIGURED",
                "local ds4 is not configured",
                false,
            )?;
            return Ok(());
        };

        if let Err(err) = validate_open_frame(&frame) {
            send_open_rejected(&sender, &frame, "POLICY_DENIED", &err.to_string(), false)?;
            return Ok(());
        }
        let request_body = match read_request_body(&frame, &mut event_rx).await {
            Ok(body) => body,
            Err(err) => {
                send_open_rejected(
                    &sender,
                    &frame,
                    "REQUEST_BODY_INVALID",
                    &err.to_string(),
                    false,
                )?;
                return Ok(());
            }
        };

        let url = config.origin.join(&frame.path)?;
        let mut request = self.inner.client.request(Method::POST, url);
        for (name, value) in sanitize_request_headers(frame.headers.as_ref()) {
            request = request.header(name, value);
        }
        request = request.body(request_body);

        let mut send_future = Box::pin(request.send());
        let mut response = loop {
            tokio::select! {
                result = &mut send_future => {
                    match result {
                        Ok(response) => break response,
                        Err(err) => {
                            send_open_rejected(
                                &sender,
                                &frame,
                                "LOCAL_LLM_CONNECT_FAILED",
                                &err.to_string(),
                                true,
                            )?;
                            return Ok(());
                        }
                    }
                }
                event = event_rx.recv() => {
                    match event {
                        Some(LocalLlmStreamEvent::Reset { reason }) => {
                            warn!(
                                stream_id = %frame.stream_id,
                                reason = %reason,
                                "local LLM stream reset before local response"
                            );
                            return Ok(());
                        }
                        Some(LocalLlmStreamEvent::Credit { .. }) => {}
                        Some(LocalLlmStreamEvent::RequestBody { .. }) => {
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
                _ = time::sleep(STREAM_IDLE_TIMEOUT) => {
                    send_open_rejected(
                        &sender,
                        &frame,
                        "LOCAL_LLM_OPEN_IDLE_TIMEOUT",
                        "local LLM did not return response headers before the daemon idle timeout",
                        true,
                    )?;
                    return Ok(());
                }
            }
        };

        send_open_accepted(&sender, &frame, response.status().as_u16(), &response)?;
        let max_chunk_bytes = frame
            .max_chunk_bytes
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_CHUNK_BYTES)
            .clamp(1, MAX_CHUNK_BYTES_LIMIT);
        let mut available_credit = frame
            .initial_credit_bytes
            .unwrap_or(DEFAULT_INITIAL_CREDIT_BYTES);
        let mut offset = 0_u64;
        let mut response_bytes = 0_u64;

        loop {
            drain_events(&mut available_credit, &mut event_rx)?;
            let maybe_chunk = loop {
                tokio::select! {
                    event = event_rx.recv() => {
                        match event {
                            Some(LocalLlmStreamEvent::Credit { credit_bytes }) => {
                                available_credit = available_credit.saturating_add(credit_bytes);
                            }
                            Some(LocalLlmStreamEvent::Reset { reason }) => {
                                warn!(
                                    stream_id = %frame.stream_id,
                                    reason = %reason,
                                    "local LLM stream reset while reading response"
                                );
                                return Ok(());
                            }
                            Some(LocalLlmStreamEvent::RequestBody { .. }) => {
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
                                    "LOCAL_LLM_READ_FAILED",
                                    &err.to_string(),
                                    true,
                                )?;
                                return Ok(());
                            }
                        }
                    }
                    _ = time::sleep(STREAM_IDLE_TIMEOUT) => {
                        send_stream_reset(
                            &sender,
                            &frame.stream_id,
                            "timeout",
                            "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT",
                            "local LLM response was idle past the daemon timeout",
                            true,
                        )?;
                        return Ok(());
                    }
                }
            };
            let Some(chunk) = maybe_chunk else {
                break;
            };
            response_bytes = response_bytes.saturating_add(chunk.len() as u64);
            if response_bytes > MAX_RESPONSE_BODY_BYTES {
                send_stream_reset(
                    &sender,
                    &frame.stream_id,
                    "local_error",
                    "LOCAL_LLM_RESPONSE_TOO_LARGE",
                    "local LLM response exceeded the daemon limit",
                    false,
                )?;
                return Ok(());
            }

            for segment in chunk.chunks(max_chunk_bytes) {
                drain_events(&mut available_credit, &mut event_rx)?;
                if let Err(err) =
                    wait_for_credit(&mut available_credit, segment.len() as u64, &mut event_rx)
                        .await
                {
                    warn!(
                        stream_id = %frame.stream_id,
                        error = %err,
                        "stopping local LLM stream while waiting for credit"
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
        sender: mpsc::UnboundedSender<LocalLlmStreamEvent>,
    ) -> bool {
        let mut streams = self.inner.streams.lock().await;
        if streams.len() >= MAX_CONCURRENT_STREAMS || streams.contains_key(&stream_id) {
            return false;
        }
        streams.insert(stream_id, sender);
        true
    }

    async fn unregister_stream(&self, stream_id: &str) {
        self.inner.streams.lock().await.remove(stream_id);
    }

    fn clear_capability(&self) {
        if let Ok(mut capability) = self.inner.capability.lock() {
            *capability = None;
        }
    }
}

impl LocalLlmConfig {
    fn from_args(raw_url: &str, args: &BudArgs) -> Result<Self> {
        if args.local_llm_ds4_context_tokens == 0 || args.local_llm_ds4_max_output_tokens == 0 {
            bail!("local ds4 context and max output token values must be positive");
        }
        Ok(Self {
            origin: normalize_loopback_http_origin(raw_url)?,
            context_tokens: args.local_llm_ds4_context_tokens,
            max_output_tokens: args.local_llm_ds4_max_output_tokens,
        })
    }
}

fn validate_open_frame(frame: &LocalLlmOpenFrame) -> Result<()> {
    if frame.stream_type != LOCAL_LLM_HTTP_STREAM_TYPE {
        bail!("unsupported local LLM stream_type: {}", frame.stream_type);
    }
    if frame.local_llm_server_id != DS4_SERVER_ID {
        bail!(
            "unsupported local LLM server id: {}",
            frame.local_llm_server_id
        );
    }
    if frame.method.to_uppercase() != "POST" {
        bail!("unsupported local LLM method: {}", frame.method);
    }
    if frame.path != "/v1/responses" {
        bail!("unsupported local LLM path: {}", frame.path);
    }
    Ok(())
}

async fn read_request_body(
    frame: &LocalLlmOpenFrame,
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
) -> Result<Vec<u8>> {
    read_request_body_with_idle_timeout(frame, event_rx, STREAM_IDLE_TIMEOUT).await
}

async fn read_request_body_with_idle_timeout(
    frame: &LocalLlmOpenFrame,
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
    idle_timeout: Duration,
) -> Result<Vec<u8>> {
    let expected = frame.request_body_bytes.unwrap_or(0);
    if expected > MAX_REQUEST_BODY_BYTES {
        bail!("request body exceeds daemon local LLM limit");
    }
    let mut body = Vec::with_capacity(expected.min(usize::MAX as u64) as usize);
    while body.len() < expected as usize || expected == 0 {
        let event = recv_stream_event_with_idle_timeout(event_rx, idle_timeout, "request body")
            .await?
            .ok_or_else(|| anyhow!("request body stream ended before completion"))?;
        match event {
            LocalLlmStreamEvent::Credit { .. } => continue,
            LocalLlmStreamEvent::Reset { reason } => {
                bail!("stream reset before request body: {}", reason)
            }
            LocalLlmStreamEvent::RequestBody {
                offset,
                data,
                end_stream,
            } => {
                if offset != body.len() as u64 {
                    bail!(
                        "request body offset mismatch: expected {}, got {}",
                        body.len(),
                        offset
                    );
                }
                if body.len() + data.len() > expected as usize {
                    bail!("request body exceeded advertised byte length");
                }
                body.extend_from_slice(&data);
                if end_stream {
                    if body.len() != expected as usize {
                        bail!(
                            "request body closed at {} bytes; expected {}",
                            body.len(),
                            expected
                        );
                    }
                    break;
                }
            }
        }
    }
    Ok(body)
}

async fn wait_for_credit(
    available_credit: &mut u64,
    needed: u64,
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
) -> Result<()> {
    wait_for_credit_with_idle_timeout(available_credit, needed, event_rx, STREAM_IDLE_TIMEOUT).await
}

async fn wait_for_credit_with_idle_timeout(
    available_credit: &mut u64,
    needed: u64,
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
    idle_timeout: Duration,
) -> Result<()> {
    while *available_credit < needed {
        let event = recv_stream_event_with_idle_timeout(event_rx, idle_timeout, "response credit")
            .await?
            .ok_or_else(|| anyhow!("stream closed while waiting for credit"))?;
        match event {
            LocalLlmStreamEvent::Credit { credit_bytes } => {
                *available_credit = available_credit.saturating_add(credit_bytes);
            }
            LocalLlmStreamEvent::Reset { reason } => {
                bail!("stream reset while waiting for credit: {}", reason)
            }
            LocalLlmStreamEvent::RequestBody { .. } => {
                bail!("request body data arrived after local response started")
            }
        }
    }
    Ok(())
}

async fn recv_stream_event_with_idle_timeout(
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
    idle_timeout: Duration,
    phase: &str,
) -> Result<Option<LocalLlmStreamEvent>> {
    match time::timeout(idle_timeout, event_rx.recv()).await {
        Ok(event) => Ok(event),
        Err(_) => bail!("local LLM stream idle timeout while waiting for {phase}"),
    }
}

fn drain_events(
    available_credit: &mut u64,
    event_rx: &mut mpsc::UnboundedReceiver<LocalLlmStreamEvent>,
) -> Result<()> {
    loop {
        match event_rx.try_recv() {
            Ok(LocalLlmStreamEvent::Credit { credit_bytes }) => {
                *available_credit = available_credit.saturating_add(credit_bytes);
            }
            Ok(LocalLlmStreamEvent::Reset { reason }) => {
                bail!("stream reset: {}", reason);
            }
            Ok(LocalLlmStreamEvent::RequestBody { .. }) => {
                bail!("request body data arrived after local response started");
            }
            Err(mpsc::error::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::error::TryRecvError::Disconnected) => {
                bail!("local LLM stream event channel closed")
            }
        }
    }
}

fn normalize_loopback_http_origin(raw_url: &str) -> Result<Url> {
    let trimmed = raw_url.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    let mut parsed = Url::parse(&with_scheme)?;
    if parsed.scheme() != "http" {
        bail!("local ds4 URL must use http://");
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        bail!("local ds4 URL must be an origin without a path");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("local ds4 URL must not include query or fragment");
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("local ds4 URL must include a host"))?;
    if !is_loopback_host(host) {
        bail!("local ds4 URL host must be localhost or a loopback IP");
    }
    parsed.set_path("/");
    Ok(parsed)
}

fn is_loopback_host(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => addr.is_loopback() && addr != Ipv4Addr::new(127, 0, 0, 0),
        Ok(IpAddr::V6(addr)) => addr.is_loopback(),
        Err(_) => false,
    }
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

fn response_headers(response: &reqwest::Response) -> HashMap<String, String> {
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

fn send_open_accepted(
    sender: &TransportSender,
    frame: &LocalLlmOpenFrame,
    status_code: u16,
    response: &reqwest::Response,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "local_llm_open_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "operation_id": frame.operation_id,
            "stream_id": frame.stream_id,
            "accepted": true,
            "status_code": status_code,
            "headers": response_headers(response),
            "compatibility": "openai_responses",
            "request_mode": "ds4_openai_responses"
        }),
    )
}

fn send_open_rejected(
    sender: &TransportSender,
    frame: &LocalLlmOpenFrame,
    code: &str,
    message: &str,
    retryable: bool,
) -> Result<()> {
    send_transport_frame(
        sender,
        json!({
            "proto": PROTO_VERSION,
            "type": "local_llm_open_result",
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
    frame: &LocalLlmOpenFrame,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BudArgs;
    use crate::protocol::Envelope;

    fn args() -> BudArgs {
        BudArgs {
            server: "ws://127.0.0.1:3000/ws".into(),
            grpc_control_url: None,
            grpc_data_url: None,
            token: None,
            claim_id: None,
            name: "bud-test".into(),
            cwd: None,
            base_dir: None,
            local: false,
            identity_file: None,
            reconnect_base_sec: 1,
            terminal_enabled: false,
            terminal_base_dir: None,
            terminal_cols: 80,
            terminal_rows: 24,
            local_llm_ds4_url: None,
            local_llm_ds4_context_tokens: 100_000,
            local_llm_ds4_max_output_tokens: 384_000,
            debug: false,
            command: None,
        }
    }

    fn open_frame() -> LocalLlmOpenFrame {
        LocalLlmOpenFrame {
            envelope: Envelope {
                kind: "local_llm_open".to_string(),
                proto: PROTO_VERSION.to_string(),
                id: "msg_test".to_string(),
                ts: 0,
                ext: Value::Null,
            },
            operation_id: "llm_op_test".to_string(),
            stream_id: "llm_st_test".to_string(),
            stream_type: LOCAL_LLM_HTTP_STREAM_TYPE.to_string(),
            local_llm_server_id: DS4_SERVER_ID.to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            headers: None,
            request_body_bytes: Some(0),
            initial_credit_bytes: Some(1024),
            max_chunk_bytes: Some(1024),
        }
    }

    #[test]
    fn loopback_origin_normalization_accepts_only_http_loopback_origins() {
        assert_eq!(
            normalize_loopback_http_origin("127.0.0.1:8000")
                .expect("127.0.0.1 should be accepted")
                .as_str(),
            "http://127.0.0.1:8000/"
        );
        assert_eq!(
            normalize_loopback_http_origin("http://localhost:8000/")
                .expect("localhost should be accepted")
                .as_str(),
            "http://localhost:8000/"
        );
        assert_eq!(
            normalize_loopback_http_origin("http://[::1]:8000")
                .expect("IPv6 loopback should be accepted")
                .as_str(),
            "http://[::1]:8000/"
        );
    }

    #[test]
    fn loopback_origin_normalization_rejects_unsafe_targets() {
        for raw_url in [
            "https://127.0.0.1:8000",
            "http://127.0.0.0:8000",
            "http://192.168.1.10:8000",
            "http://localhost:8000/v1",
            "http://localhost:8000?x=1",
        ] {
            assert!(
                normalize_loopback_http_origin(raw_url).is_err(),
                "{raw_url} should be rejected"
            );
        }
    }

    #[test]
    fn open_frame_policy_limits_ds4_to_responses_post() {
        assert!(validate_open_frame(&open_frame()).is_ok());

        let mut wrong_stream = open_frame();
        wrong_stream.stream_type = "localhost_http_proxy".to_string();
        assert!(validate_open_frame(&wrong_stream).is_err());

        let mut wrong_server = open_frame();
        wrong_server.local_llm_server_id = "other".to_string();
        assert!(validate_open_frame(&wrong_server).is_err());

        let mut wrong_method = open_frame();
        wrong_method.method = "GET".to_string();
        assert!(validate_open_frame(&wrong_method).is_err());

        let mut wrong_path = open_frame();
        wrong_path.path = "/v1/chat/completions".to_string();
        assert!(validate_open_frame(&wrong_path).is_err());
    }

    #[test]
    fn request_header_sanitization_keeps_only_ds4_http_headers() {
        let headers = HashMap::from([
            ("content-type".to_string(), "application/json".to_string()),
            ("accept".to_string(), "text/event-stream".to_string()),
            ("authorization".to_string(), "Bearer secret".to_string()),
            ("cookie".to_string(), "sid=secret".to_string()),
        ]);

        let sanitized = sanitize_request_headers(Some(&headers));
        let names = sanitized
            .into_iter()
            .map(|(name, _)| name.to_string())
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 2);
        assert!(names.contains(&"accept".to_string()));
        assert!(names.contains(&"content-type".to_string()));
    }

    #[tokio::test]
    async fn request_body_reader_enforces_advertised_size_limit() {
        let mut frame = open_frame();
        frame.request_body_bytes = Some(MAX_REQUEST_BODY_BYTES + 1);
        let (_tx, mut rx) = mpsc::unbounded_channel();

        let err = read_request_body_with_idle_timeout(&frame, &mut rx, Duration::from_millis(1))
            .await
            .expect_err("oversized local LLM request should be rejected");

        assert!(
            err.to_string().contains("request body exceeds"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn request_body_reader_times_out_while_waiting_for_body() {
        let mut frame = open_frame();
        frame.request_body_bytes = Some(1);
        let (_tx, mut rx) = mpsc::unbounded_channel();

        let err = read_request_body_with_idle_timeout(&frame, &mut rx, Duration::from_millis(1))
            .await
            .expect_err("missing local LLM request body should time out");

        assert!(
            err.to_string().contains("idle timeout"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn credit_wait_times_out_while_waiting_for_response_credit() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let mut available_credit = 0;

        let err = wait_for_credit_with_idle_timeout(
            &mut available_credit,
            1,
            &mut rx,
            Duration::from_millis(1),
        )
        .await
        .expect_err("missing local LLM response credit should time out");

        assert!(
            err.to_string().contains("idle timeout"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn manager_enforces_single_active_local_llm_stream() {
        let manager = LocalLlmManager::new(&args(), Client::new());
        let (first_tx, _first_rx) = mpsc::unbounded_channel();
        let (second_tx, _second_rx) = mpsc::unbounded_channel();
        let (third_tx, _third_rx) = mpsc::unbounded_channel();

        assert!(
            manager
                .register_stream("stream-1".to_string(), first_tx)
                .await
        );
        assert!(
            !manager
                .register_stream("stream-2".to_string(), second_tx)
                .await
        );

        manager.unregister_stream("stream-1").await;

        assert!(
            manager
                .register_stream("stream-2".to_string(), third_tx)
                .await
        );
    }
}
