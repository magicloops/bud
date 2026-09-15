//! Deliberately serial CDP transport for managed browser operations. Never export this API
//! through the service. A timed-out command may have executed: poison the channel
//! rather than retrying mutations or consuming their late results as new work.
use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

pub(crate) struct Cdp {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    poisoned: bool,
}

impl Cdp {
    pub fn interrupted(&self) -> bool {
        self.poisoned
    }

    pub async fn connect(endpoint: &str) -> Result<Self> {
        let config = WebSocketConfig {
            max_message_size: Some(24 * 1024 * 1024),
            max_frame_size: Some(24 * 1024 * 1024),
            ..Default::default()
        };
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(endpoint, Some(config), false),
        )
        .await
        .context("browser_connect_timeout")?
        .map_err(|_| anyhow::anyhow!("browser_connect_failed"))?;
        Ok(Self {
            socket,
            next_id: 0,
            poisoned: false,
        })
    }

    pub async fn call(
        &mut self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if self.poisoned {
            bail!("browser_channel_interrupted");
        }
        self.next_id += 1;
        let id = self.next_id;
        let mut request = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            request["sessionId"] = json!(session);
        }
        // Cancellation also leaves this channel poisoned, even if the future is
        // dropped before the timeout. Only a definitive response clears it.
        self.poisoned = true;
        let started = Instant::now();
        let mut sent_ms = None;
        let mut frames_received = 0;
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            self.socket.send(Message::Text(request.to_string())).await?;
            sent_ms = Some(started.elapsed().as_millis());
            while let Some(frame) = self.socket.next().await {
                frames_received += 1;
                match frame? {
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text)?;
                        if value["id"].as_u64() == Some(id) {
                            return Ok(value);
                        }
                        // No event queue in this slice. Targets/documents are
                        // re-resolved before operations; frames are demand-only.
                    }
                    Message::Ping(bytes) => self.socket.send(Message::Pong(bytes)).await?,
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            bail!("browser_channel_closed")
        })
        .await;
        let failure = match &result {
            Err(_) => Some("timeout"),
            Ok(Err(_)) => Some("transport_or_decode"),
            Ok(Ok(value)) if value.get("error").is_some() => Some("command_rejected"),
            _ => None,
        };
        if let Some(reason) = failure {
            // Method names are internal constants. Never log params, responses,
            // or raw errors: even a read failure can contain private page data.
            tracing::warn!(
                component = "browser_cdp",
                event = "call_failed",
                method,
                reason,
                elapsed_ms = started.elapsed().as_millis() as u64,
                frames_received,
                "Browser CDP call failed"
            );
        }
        let response: Value = result.with_context(|| format!(
            "browser_command_unknown method={method} id={id} sent_ms={sent_ms:?} frames_received={frames_received} elapsed_ms={}", started.elapsed().as_millis()
        ))??;
        self.poisoned = false;
        if response.get("error").is_some() {
            // CDP error strings can contain URLs or submitted values.
            bail!("browser_command_rejected");
        }
        Ok(response["result"].clone())
    }
}
