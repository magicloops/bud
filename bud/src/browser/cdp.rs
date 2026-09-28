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

/// The caller's deadline can drop a CDP future before its own timeout logs.
/// Keep this separate from channel poisoning: observing cancellation never makes
/// the interrupted command safe to replay.
struct CallDiagnostic<'a> {
    method: &'a str,
    started: Instant,
    stage: &'static str,
    frames_received: u64,
    finished: bool,
}

impl Drop for CallDiagnostic<'_> {
    fn drop(&mut self) {
        if !self.finished {
            tracing::warn!(
                component = "browser_cdp",
                event = "call_cancelled",
                method = self.method,
                stage = self.stage,
                elapsed_ms = self.started.elapsed().as_millis() as u64,
                frames_received = self.frames_received,
                "Browser CDP call cancelled before acknowledgement"
            );
        }
    }
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

    /// Dedicated inventory-event connections use this without a command in flight.
    /// Page payloads are discarded; callers receive only a dirty signal.
    pub async fn next_checkpoint_change(&mut self) -> Result<()> {
        while let Some(frame) = self.socket.next().await {
            match frame? {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text)?;
                    if matches!(
                        value["method"].as_str(),
                        Some(
                            "Target.targetInfoChanged"
                                | "Target.targetDestroyed"
                                | "Target.targetCreated"
                        )
                    ) {
                        return Ok(());
                    }
                }
                Message::Ping(bytes) => self.socket.send(Message::Pong(bytes)).await?,
                Message::Close(_) => break,
                _ => {}
            }
        }
        bail!("browser_checkpoint_channel_closed")
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
        let mut diagnostic = CallDiagnostic {
            method,
            started,
            stage: "send",
            frames_received: 0,
            finished: false,
        };
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            self.socket.send(Message::Text(request.to_string())).await?;
            sent_ms = Some(started.elapsed().as_millis());
            diagnostic.stage = "receive";
            while let Some(frame) = self.socket.next().await {
                diagnostic.frames_received += 1;
                match frame? {
                    Message::Text(text) => {
                        diagnostic.stage = "decode";
                        let value: Value = serde_json::from_str(&text)?;
                        diagnostic.stage = "receive";
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
        diagnostic.finished = true;
        let stage = diagnostic.stage;
        let frames_received = diagnostic.frames_received;
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
                stage,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Log(Arc<Mutex<Vec<u8>>>);
    impl Write for Log {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn caller_cancellation_logs_method_without_payload_and_keeps_channel_poisoned() {
        let log = Log(Arc::new(Mutex::new(Vec::new())));
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let (received_tx, received_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let message = socket.next().await.unwrap().unwrap();
            assert!(message.is_text());
            received_tx.send(()).unwrap();
            // Keep the channel open but never acknowledge the command.
            std::future::pending::<()>().await;
        });
        let mut cdp = Cdp::connect(&endpoint).await.unwrap();
        {
            let call = cdp.call(
                None,
                "Input.dispatchMouseEvent",
                json!({"private":"do-not-log"}),
            );
            tokio::pin!(call);
            tokio::select! {
                _ = received_rx => {},
                result = &mut call => panic!("unexpected completion: {result:?}"),
                _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("command never arrived"),
            }
        }
        assert!(cdp.interrupted());
        assert_eq!(
            cdp.call(None, "Target.getTargets", json!({}))
                .await
                .unwrap_err()
                .to_string(),
            "browser_channel_interrupted"
        );
        let text = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
        assert!(text.contains("call_cancelled"), "{text}");
        assert!(text.contains("Input.dispatchMouseEvent"), "{text}");
        assert!(text.contains("receive"), "{text}");
        assert!(!text.contains("do-not-log"));
        server.abort();
    }
}
