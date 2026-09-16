//! Dedicated demand-driven media socket. Never put images on daemon control.
use super::manager::Slot;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    target_id: Option<String>,
    pixel_ratio: Option<f64>,
}

pub(super) fn start(
    slot: Arc<Slot>,
    mut connection: watch::Receiver<Option<String>>,
    device: String,
    epoch: u64,
    controller: Option<String>,
    endpoint: String,
    ticket: String,
) {
    tokio::spawn(async move {
        let started = Instant::now();
        let mut phase = "connect";
        let mut frames = 0_u64;
        let current_connection = connection.clone();
        let run = async {
            let config = WebSocketConfig {
                max_message_size: Some(4096),
                max_frame_size: Some(4096),
                max_write_buffer_size: 2 * 1024 * 1024,
                ..Default::default()
            };
            let (mut socket, _) = tokio::time::timeout(
                Duration::from_secs(5),
                connect_async_with_config(endpoint, Some(config), false),
            )
            .await??;
            phase = "authenticate";
            socket
                .send(Message::Text(json!({"ticket":ticket}).to_string()))
                .await?;
            let mut next_capture = tokio::time::Instant::now();
            loop {
                phase = "receive_demand";
                let message = tokio::select! {
                    biased;
                    _ = connection.changed() => anyhow::bail!("browser_media_revoked"),
                    message = tokio::time::timeout(Duration::from_secs(10), socket.next()) => message?,
                };
                let Some(Ok(Message::Text(text))) = message else {
                    anyhow::bail!("browser_media_closed");
                };
                phase = "validate_demand";
                let request: Capture = serde_json::from_str(&text)?;
                if request
                    .target_id
                    .as_ref()
                    .is_some_and(|v| v.is_empty() || v.len() > 128)
                {
                    anyhow::bail!("browser_invalid_target");
                }
                if request
                    .pixel_ratio
                    .is_some_and(|ratio| !ratio.is_finite() || !(1.0..=2.0).contains(&ratio))
                {
                    anyhow::bail!("browser_invalid_capture_scale");
                }
                phase = "pace_capture";
                tokio::time::sleep_until(next_capture).await;
                phase = "authorize_capture";
                if current_connection.borrow().as_deref() != Some(&device)
                    || !slot
                        .authority
                        .lock()
                        .unwrap()
                        .viewer_allowed(epoch, controller.as_deref())
                {
                    anyhow::bail!("browser_media_revoked");
                }
                // Join input's FIFO lock instead of repeatedly losing a try_lock
                // race during sustained wheel input. No CDP call is cancelled here.
                phase = "wait_capture";
                let data = if let Ok(mut entry) =
                    tokio::time::timeout(Duration::from_secs(1), slot.state.lock()).await
                {
                    phase = "authorize_capture";
                    if current_connection.borrow().as_deref() != Some(&device)
                        || !slot
                            .authority
                            .lock()
                            .unwrap()
                            .viewer_allowed(epoch, controller.as_deref())
                    {
                        anyhow::bail!("browser_media_revoked");
                    }
                    next_capture = tokio::time::Instant::now() + Duration::from_millis(100);
                    let preferred = request
                        .target_id
                        .as_ref()
                        .or(entry.target.as_ref())
                        .cloned();
                    let browser = entry
                        .browser
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("browser_interrupted"))?;
                    phase = "list_targets";
                    let targets = browser.targets().await?;
                    let target = preferred
                        .filter(|id| targets.iter().any(|t| &t.target_id == id))
                        .or_else(|| targets.first().map(|t| t.target_id.clone()))
                        .ok_or_else(|| anyhow::anyhow!("browser_no_target"))?;
                    phase = "capture";
                    let mut data = match browser.capture_scaled(&target, request.pixel_ratio).await
                    {
                        Ok(data) => data,
                        Err(error) if error.to_string() == "browser_frame_discarded" => {
                            json!({"busy":true})
                        }
                        Err(error) => return Err(error),
                    };
                    // Display origin only: URLs can carry sign-in tokens.
                    data["targets"]=json!(targets.iter().map(|t|json!({"target_id":t.target_id,
                        "origin":url::Url::parse(&t.url).map(|u|u.origin().ascii_serialization()).unwrap_or_default()})).collect::<Vec<_>>());
                    entry.target = Some(target);
                    data
                } else {
                    json!({"busy":true})
                };
                phase = "authorize_delivery";
                if current_connection.borrow().as_deref() != Some(&device)
                    || !slot
                        .authority
                        .lock()
                        .unwrap()
                        .viewer_allowed(epoch, controller.as_deref())
                {
                    anyhow::bail!("browser_media_revoked");
                }
                phase = "send_frame";
                tokio::time::timeout(
                    Duration::from_secs(3),
                    socket.send(Message::Text(data.to_string())),
                )
                .await??;
                if data.get("image").is_some() {
                    frames += 1;
                }
                // Capture and delivery count toward the next start's budget.
                // Downstream credit still permits only one frame in flight.
            }
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        };
        // Do not print the error itself: transport/CDP errors may contain private data.
        // A control disconnect revokes delivery immediately, but must not drop
        // an in-flight CDP read: cancellation poisons the shared Chrome channel.
        // Drain bounded capture calls, then let authorize_delivery discard them.
        let _ = run.await;
        let reason = if current_connection.borrow().as_deref() != Some(&device) {
            "connection_changed"
        } else {
            "media_ended"
        };
        let mut authority = slot.authority.lock().unwrap();
        let paused_control = controller
            .as_ref()
            .is_some_and(|id| authority.human_allowed(epoch, id));
        if paused_control {
            authority.pause();
        }
        tracing::info!(
            component = "browser_media",
            event = "ended",
            reason,
            phase,
            epoch,
            frames,
            elapsed_ms = started.elapsed().as_millis() as u64,
            paused_control,
            "Browser media ended"
        );
        slot.media.store(false, Ordering::SeqCst);
    });
}
