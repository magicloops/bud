//! Dedicated local event reader. No browser-facing CDP surface or input replay.
use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    MaybeTlsStream, WebSocketStream,
};

/// Screencast describes the visual viewport. Layout bounds round fractional
/// scroll offsets inward and can lose a CSS pixel on HiDPI displays.
pub(super) fn viewport(metrics: &Value) -> Result<Value> {
    let v = &metrics["cssVisualViewport"];
    if v["scale"].as_f64() != Some(1.0)
        || v["zoom"].as_f64().is_some_and(|zoom| zoom != 1.0)
        || v["offsetX"].as_f64() != Some(0.0)
        || v["offsetY"].as_f64() != Some(0.0)
    {
        bail!("browser_stream_unsupported_viewport");
    }
    for field in ["clientWidth", "clientHeight", "pageX", "pageY"] {
        if v[field].as_f64().is_none_or(|n| !n.is_finite()) {
            bail!("browser_viewport_unavailable");
        }
    }
    if v["clientWidth"].as_f64().unwrap() <= 0.0 || v["clientHeight"].as_f64().unwrap() <= 0.0 {
        bail!("browser_viewport_unavailable");
    }
    Ok(
        json!({"clientWidth":v["clientWidth"],"clientHeight":v["clientHeight"],
        "pageX":v["pageX"],"pageY":v["pageY"]}),
    )
}

pub(super) struct SourceConfig {
    pub endpoint: String,
    pub target: String,
    pub document: String,
    pub width: f64,
    pub height: f64,
    pub live: Arc<AtomicBool>,
    pub cleanup: Arc<AtomicU8>,
}
#[derive(Clone)]
pub(super) struct SourceFrame {
    pub image: Arc<Vec<u8>>,
    pub metrics: Value,
    pub received: Instant,
}
pub(super) struct Source {
    pub latest: watch::Receiver<Option<SourceFrame>>,
    live: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<Result<()>>,
}
impl Source {
    pub async fn start(config: SourceConfig) -> Result<Self> {
        config.cleanup.store(0, Ordering::SeqCst);
        let live = config.live.clone();
        let (latest, receiver) = watch::channel(None);
        let (ready, started) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _fence = CompletionFence {
                live: config.live.clone(),
                cleanup: config.cleanup.clone(),
            };
            let result = run(&config, latest, ready).await;
            config.live.store(false, Ordering::SeqCst);
            result
        });
        let mut source = Self {
            latest: receiver,
            live,
            task,
        };
        if started.await.unwrap_or(false) {
            Ok(source)
        } else {
            source.stop().await?;
            bail!("browser_stream_start_failed")
        }
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.live.store(false, Ordering::SeqCst);
        (&mut self.task)
            .await
            .context("browser_stream_task_failed")?
    }
}
impl Drop for Source {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

struct CompletionFence {
    live: Arc<AtomicBool>,
    cleanup: Arc<AtomicU8>,
}
impl Drop for CompletionFence {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
        let _ = self
            .cleanup
            .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst);
    }
}

struct Reader<'a> {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    config: &'a SourceConfig,
    session: Option<String>,
    next: u64,
    acks: HashSet<u64>,
    latest: watch::Sender<Option<SourceFrame>>,
}
impl Reader<'_> {
    async fn send(&mut self, method: &str, params: Value) -> Result<u64> {
        self.next += 1;
        let mut value = json!({"id":self.next,"method":method,"params":params});
        if let Some(session) = &self.session {
            value["sessionId"] = json!(session);
        }
        tokio::time::timeout(
            Duration::from_secs(1),
            self.socket.send(Message::Text(value.to_string())),
        )
        .await??;
        Ok(self.next)
    }
    async fn receive(&mut self) -> Result<Value> {
        loop {
            let message =
                match tokio::time::timeout(Duration::from_millis(25), self.socket.next()).await {
                    Ok(value) => value.context("browser_stream_closed")??,
                    Err(_) => return Ok(json!({})),
                };
            let value: Value = match message {
                Message::Text(text) => serde_json::from_str(&text)?,
                Message::Ping(_) => {
                    tokio::time::timeout(Duration::from_secs(1), self.socket.flush()).await??;
                    continue;
                }
                Message::Pong(_) => continue,
                _ => bail!("browser_stream_closed"),
            };
            if let Some(id) = value["id"].as_u64() {
                self.acks.remove(&id);
                if value.get("error").is_some() {
                    bail!("browser_stream_command_rejected");
                }
                return Ok(value);
            }
            if value["sessionId"].as_str() != self.session.as_deref() {
                return Ok(value);
            }
            let params = &value["params"];
            match value["method"].as_str() {
                Some("Page.frameNavigated")
                    if params["frame"]["parentId"].is_null()
                        && params["frame"]["loaderId"].as_str() != Some(&self.config.document) =>
                {
                    tracing::info!(
                        component = "browser_media",
                        event = "source_retired",
                        reason = "document_changed",
                        "Private capture source retired"
                    );
                    self.config.live.store(false, Ordering::SeqCst);
                }
                Some(
                    "Page.navigatedWithinDocument"
                    | "Inspector.detached"
                    | "Inspector.targetCrashed",
                ) => {
                    tracing::info!(
                        component = "browser_media",
                        event = "source_retired",
                        reason = "page_event",
                        method = value["method"].as_str().unwrap_or_default(),
                        "Private capture source retired"
                    );
                    self.config.live.store(false, Ordering::SeqCst);
                }
                Some("Page.screencastFrame") => {
                    if self.acks.len() >= 32 {
                        bail!("browser_stream_ack_capacity");
                    }
                    let ack = params["sessionId"]
                        .as_u64()
                        .context("browser_stream_invalid_frame")?;
                    let id = self
                        .send("Page.screencastFrameAck", json!({"sessionId":ack}))
                        .await?;
                    self.acks.insert(id);
                    let metadata = &params["metadata"];
                    if metadata["deviceWidth"].as_f64() != Some(self.config.width)
                        || metadata["deviceHeight"].as_f64() != Some(self.config.height)
                        || metadata["pageScaleFactor"].as_f64() != Some(1.0)
                    {
                        tracing::info!(
                            component = "browser_media",
                            event = "source_retired",
                            reason = "geometry_changed",
                            expected_width = self.config.width,
                            expected_height = self.config.height,
                            device_width = metadata["deviceWidth"].as_f64(),
                            device_height = metadata["deviceHeight"].as_f64(),
                            page_scale = metadata["pageScaleFactor"].as_f64(),
                            "Private capture source retired"
                        );
                        self.config.live.store(false, Ordering::SeqCst);
                    }
                    if self.config.live.load(Ordering::SeqCst) {
                        use base64::Engine;
                        let image = params["data"]
                            .as_str()
                            .context("browser_stream_invalid_frame")?;
                        if image.len() > 1_400_000 {
                            bail!("browser_stream_frame_bounds");
                        }
                        let image = base64::engine::general_purpose::STANDARD.decode(image)?;
                        if image.len() > 1024 * 1024 {
                            bail!("browser_stream_frame_bounds");
                        }
                        let x = metadata["scrollOffsetX"]
                            .as_f64()
                            .context("browser_stream_invalid_frame")?;
                        let y = metadata["scrollOffsetY"]
                            .as_f64()
                            .context("browser_stream_invalid_frame")?;
                        self.latest.send_replace(Some(SourceFrame { image: Arc::new(image), received: Instant::now(),
                            metrics: json!({"clientWidth":self.config.width,"clientHeight":self.config.height,"pageX":x,"pageY":y}) }));
                    }
                }
                _ => {}
            }
            if !self.config.live.load(Ordering::SeqCst) {
                self.latest.send_replace(None);
            }
            return Ok(value);
        }
    }
    async fn refresh_idle(&mut self) -> Result<()> {
        use base64::Engine;
        let started = Instant::now();
        let before = self.call("Page.getLayoutMetrics", json!({})).await?;
        let metrics = viewport(&before)?;
        if metrics["clientWidth"].as_f64() != Some(self.config.width)
            || metrics["clientHeight"].as_f64() != Some(self.config.height)
        {
            self.config.live.store(false, Ordering::SeqCst);
            return Ok(());
        }
        let shot = self.call("Page.captureScreenshot", json!({"format":"jpeg","quality":70,
            "captureBeyondViewport":false,"clip":{"x":metrics["pageX"],"y":metrics["pageY"],
            "width":self.config.width,"height":self.config.height,"scale":(1280.0/self.config.width.max(self.config.height)).min(1.0)}})).await?;
        let captured = Instant::now();
        let after = self.call("Page.getLayoutMetrics", json!({})).await?;
        let tree = self.call("Page.getFrameTree", json!({})).await?;
        if !self.config.live.load(Ordering::SeqCst)
            || tree["frameTree"]["frame"]["loaderId"] != self.config.document
            || metrics != viewport(&after)?
            || self
                .latest
                .borrow()
                .as_ref()
                .is_some_and(|frame| frame.received > started)
        {
            return Ok(());
        }
        let image = shot["data"]
            .as_str()
            .context("browser_stream_invalid_frame")?;
        if image.len() > 1_400_000 {
            bail!("browser_stream_frame_bounds");
        }
        let image = base64::engine::general_purpose::STANDARD.decode(image)?;
        if image.len() > 1024 * 1024 {
            bail!("browser_stream_frame_bounds");
        }
        self.latest.send_replace(Some(SourceFrame {
            image: Arc::new(image),
            metrics: metrics.clone(),
            received: captured,
        }));
        Ok(())
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.send(method, params).await?;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let value = self.receive().await?;
                if value["id"].as_u64() == Some(id) {
                    return Ok(value["result"].clone());
                }
            }
        })
        .await?
    }
}
async fn run(
    config: &SourceConfig,
    latest: watch::Sender<Option<SourceFrame>>,
    ready: oneshot::Sender<bool>,
) -> Result<()> {
    let ws = WebSocketConfig {
        max_message_size: Some(2 * 1024 * 1024),
        max_frame_size: Some(2 * 1024 * 1024),
        max_write_buffer_size: 128 * 1024,
        write_buffer_size: 0,
        ..Default::default()
    };
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(5),
        connect_async_with_config(&config.endpoint, Some(ws), false),
    )
    .await??;
    let mut reader = Reader {
        socket,
        config,
        session: None,
        next: 0,
        acks: HashSet::new(),
        latest,
    };
    let setup = async {
        let attached = reader.call("Target.attachToTarget", json!({"targetId":config.target,"flatten":true})).await?;
        reader.session = Some(attached["sessionId"].as_str().context("browser_stream_attach_failed")?.into());
        reader.call("Page.enable", json!({})).await?;
        let tree = reader.call("Page.getFrameTree", json!({})).await?;
        if tree["frameTree"]["frame"]["loaderId"].as_str() != Some(&config.document)
            || !config.live.load(Ordering::SeqCst) { bail!("browser_stream_generation_changed"); }
        reader.call("Emulation.setFocusEmulationEnabled", json!({"enabled":true})).await?;
        if !config.live.load(Ordering::SeqCst) { bail!("browser_stream_generation_changed"); }
        reader.call("Page.startScreencast", json!({"format":"jpeg","quality":70,"maxWidth":1280,"maxHeight":1280,"everyNthFrame":1})).await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    let _ = ready.send(setup.is_ok());
    let result = if setup.is_ok() {
        async {
            let mut last_refresh = Instant::now();
            while config.live.load(Ordering::SeqCst) {
                reader.receive().await?;
                let idle = reader
                    .latest
                    .borrow()
                    .as_ref()
                    .is_none_or(|frame| frame.received.elapsed() > Duration::from_secs(1));
                if idle && last_refresh.elapsed() > Duration::from_secs(1) {
                    reader.refresh_idle().await?;
                    last_refresh = Instant::now();
                }
            }
            Ok(())
        }
        .await
    } else {
        setup
    };
    config.live.store(false, Ordering::SeqCst);
    reader.latest.send_replace(None);
    // Dedicated source only: interruption here cannot poison the command client.
    if reader.session.is_some() {
        let stopped = reader.call("Page.stopScreencast", json!({})).await;
        let disabled = reader
            .call(
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled":false}),
            )
            .await;
        config.cleanup.store(
            if stopped.is_ok() && disabled.is_ok() {
                1
            } else {
                2
            },
            Ordering::SeqCst,
        );
    } else {
        config.cleanup.store(1, Ordering::SeqCst);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visual_metrics_preserve_fractional_scroll_and_reject_unsupported_transforms() {
        let mut metrics = json!({
            "cssLayoutViewport":{"clientWidth":440,"clientHeight":815,"pageX":0,"pageY":102},
            "cssVisualViewport":{"clientWidth":440,"clientHeight":816,"pageX":0,"pageY":101.5,
                "offsetX":0,"offsetY":0,"scale":1,"zoom":1}
        });
        let normalized = viewport(&metrics).unwrap();
        assert_eq!(normalized["clientHeight"], 816);
        assert_eq!(normalized["pageY"], 101.5);
        for (field, value) in [
            ("scale", 1.1),
            ("zoom", 1.1),
            ("offsetX", 1.),
            ("offsetY", 1.),
            ("clientHeight", 0.),
        ] {
            let original = metrics["cssVisualViewport"][field].clone();
            metrics["cssVisualViewport"][field] = json!(value);
            assert!(viewport(&metrics).is_err(), "{field}");
            metrics["cssVisualViewport"][field] = original;
        }
        metrics["cssVisualViewport"]["clientHeight"] = json!(817);
        assert_ne!(
            viewport(&metrics).unwrap()["clientHeight"],
            normalized["clientHeight"],
            "real one-pixel resize is not normalized away"
        );
    }
}
