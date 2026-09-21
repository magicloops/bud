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
    session_id: String,
    slot: Arc<Slot>,
    mut connection: watch::Receiver<Option<String>>,
    device: String,
    epoch: u64,
    controller: Option<String>,
    endpoint: String,
    ticket: String,
    operation_driven: bool,
    media_fence: Option<u64>,
) {
    tokio::spawn(async move {
        let started = Instant::now();
        let mut phase = "connect";
        let mut frames = 0_u64;
        let mut target_count: Option<usize> = None;
        let mut close_code: Option<u16> = None;
        let current_connection = connection.clone();
        let mut refresh = slot.refresh.subscribe();
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
                // Idle sockets still process pings and revocation, without touching Chrome.
                if current_connection.borrow().as_deref() != Some(&device)
                    || !slot.authority.lock().unwrap().media_allowed(
                        epoch,
                        controller.as_deref(),
                        media_fence,
                    )
                {
                    anyhow::bail!("browser_media_revoked");
                }
                phase = "receive_demand";
                let message = tokio::select! {
                    biased;
                    _ = connection.changed() => anyhow::bail!("browser_media_revoked"),
                    changed = refresh.changed(), if operation_driven => {
                        changed?;
                        refresh.borrow_and_update();
                        // No pixels/URLs in this coalesced notification. Credit remains service-owned.
                        tokio::time::timeout(Duration::from_secs(3), socket.send(Message::Text(json!({"refresh":true}).to_string()))).await??;
                        continue;
                    }
                    message = tokio::time::timeout(Duration::from_secs(10), socket.next()) => message?,
                };
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_))) if operation_driven => {
                        // tungstenite queues the protocol pong; flush without capture.
                        tokio::time::timeout(Duration::from_secs(3), socket.flush()).await??;
                        continue;
                    }
                    Some(Ok(Message::Pong(_))) if operation_driven => continue,
                    Some(Ok(Message::Close(frame))) => {
                        close_code = frame.map(|f| u16::from(f.code));
                        anyhow::bail!("browser_media_peer_close");
                    }
                    None => anyhow::bail!("browser_media_eof"),
                    Some(Err(error)) => return Err(error.into()),
                    _ => anyhow::bail!("browser_media_unexpected_message"),
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
                    || !slot.authority.lock().unwrap().media_allowed(
                        epoch,
                        controller.as_deref(),
                        media_fence,
                    )
                {
                    anyhow::bail!("browser_media_revoked");
                }
                // Join input's FIFO lock instead of repeatedly losing a try_lock
                // race during sustained wheel input. No CDP call is cancelled here.
                phase = "wait_capture";
                let wait_started = Instant::now();
                let data = if let Ok((_page, mut entry)) =
                    tokio::time::timeout(Duration::from_secs(1), async {
                        let page = slot.page_lock.lock().await;
                        let state = slot.state.lock().await;
                        (page, state)
                    })
                    .await
                {
                    let wait_ms = wait_started.elapsed().as_millis() as u64;
                    let hold_started = Instant::now();
                    phase = "authorize_capture";
                    if current_connection.borrow().as_deref() != Some(&device)
                        || !slot.authority.lock().unwrap().media_allowed(
                            epoch,
                            controller.as_deref(),
                            media_fence,
                        )
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
                    target_count = None;
                    let targets_result = browser.targets().await;
                    let targets_ms = hold_started.elapsed().as_millis() as u64;
                    if targets_result.is_err() && targets_ms >= 250 {
                        tracing::info!(component = "browser_timing", event = "media_capture",
                            session_id = %session_id, epoch, wait_ms, targets_ms,
                            ok = false, phase = "list_targets", "Slow browser capture");
                    }
                    let targets = targets_result?;
                    target_count = Some(targets.len());
                    if targets.is_empty() {
                        refresh.borrow_and_update();
                        entry.target = None;
                        next_capture = tokio::time::Instant::now() + Duration::from_secs(1);
                        json!({"empty":true})
                    } else {
                        phase = "select_target";
                        let target = preferred
                            .filter(|id| targets.iter().any(|t| &t.target_id == id))
                            .or_else(|| targets.first().map(|t| t.target_id.clone()))
                            .ok_or_else(|| anyhow::anyhow!("browser_no_target"))?;
                        phase = "capture";
                        // This capture includes all operations completed before taking the lock.
                        refresh.borrow_and_update();
                        let capture_started = Instant::now();
                        let mut timing = super::adapter::CaptureTiming::default();
                        let captured = browser
                            .capture_scaled_timed(&target, request.pixel_ratio, &mut timing)
                            .await;
                        let capture_ms = capture_started.elapsed().as_millis() as u64;
                        let hold_ms = hold_started.elapsed().as_millis() as u64;
                        if hold_ms >= 250 || wait_ms >= 250 {
                            tracing::info!(component = "browser_timing", event = "media_capture",
                            session_id = %session_id, epoch, wait_ms, targets_ms, capture_ms, hold_ms,
                            ok = captured.is_ok(), capture_stages = ?timing, "Slow browser capture");
                        }
                        let mut data = match captured {
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
                    }
                } else {
                    tracing::info!(component = "browser_timing", event = "media_lock_wait",
                        session_id = %session_id, epoch,
                        wait_ms = wait_started.elapsed().as_millis() as u64,
                        timed_out = true, "Browser capture lock wait");
                    json!({"busy":true})
                };
                phase = "authorize_delivery";
                if current_connection.borrow().as_deref() != Some(&device)
                    || !slot.authority.lock().unwrap().media_allowed(
                        epoch,
                        controller.as_deref(),
                        media_fence,
                    )
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
        let result = run.await;
        let reason = if current_connection.borrow().as_deref() != Some(&device) {
            "connection_changed"
        } else if let Err(error) = &result {
            if error.is::<tokio::time::error::Elapsed>() {
                "timeout"
            } else if error.is::<tokio_tungstenite::tungstenite::Error>() {
                "transport_error"
            } else {
                match error.to_string().as_str() {
                    "browser_media_revoked" => "authority_revoked",
                    "browser_media_peer_close" => "peer_close",
                    "browser_media_eof" => "peer_eof",
                    "browser_media_unexpected_message" => "unexpected_message",
                    _ => "operation_error",
                }
            }
        } else {
            "completed"
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
            session_id = %session_id,
            event = "ended",
            reason,
            error_code = result.as_ref().err().map(media_error_code),
            target_count,
            phase,
            epoch,
            frames,
            elapsed_ms = started.elapsed().as_millis() as u64,
            paused_control,
            operation_driven,
            close_code,
            "Browser media ended"
        );
        slot.media.store(false, Ordering::SeqCst);
    });
}

// Return only internal constants, never arbitrary exception or page content.
fn media_error_code(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "browser_no_target" => "browser_no_target",
        "browser_invalid_targets" => "browser_invalid_targets",
        "browser_window_unconfirmed" => "browser_window_unconfirmed",
        "browser_command_rejected" => "browser_command_rejected",
        "browser_channel_interrupted" => "browser_channel_interrupted",
        "browser_channel_closed" => "browser_channel_closed",
        "browser_interrupted" => "browser_interrupted",
        "browser_target_not_found" => "browser_target_not_found",
        "browser_media_revoked" => "browser_media_revoked",
        _ => "redacted",
    }
}

#[cfg(test)]
mod tests {
    use super::media_error_code;

    #[test]
    fn media_errors_never_emit_untrusted_details() {
        assert_eq!(
            media_error_code(&anyhow::anyhow!("browser_no_target")),
            "browser_no_target"
        );
        assert_eq!(
            media_error_code(&anyhow::anyhow!("browser_window_unconfirmed")),
            "browser_window_unconfirmed"
        );
        for message in [
            "https://private.example/token",
            "browser_no_target https://private.example/token",
        ] {
            assert_eq!(media_error_code(&anyhow::anyhow!(message)), "redacted");
        }
    }
}
