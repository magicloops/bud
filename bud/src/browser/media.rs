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
    mode: Option<String>,
    target_id: Option<String>,
    pixel_ratio: Option<f64>,
}

/// Everything one media stream needs; built by the manager at admission.
pub(super) struct MediaStart {
    pub session_id: String,
    pub slot: Arc<Slot>,
    pub connection: watch::Receiver<Option<String>>,
    pub device: String,
    pub epoch: u64,
    pub controller: Option<String>,
    pub endpoint: String,
    pub ticket: String,
    pub operation_driven: bool,
    pub media_fence: Option<u64>,
}

pub(super) fn start(args: MediaStart) {
    let MediaStart {
        session_id,
        slot,
        mut connection,
        device,
        epoch,
        controller,
        endpoint,
        ticket,
        operation_driven,
        media_fence,
    } = args;
    tokio::spawn(async move {
        // The busy flag must clear on every exit, including a panic in this
        // task; otherwise the slot reports browser_media_busy until restart.
        let _busy = OnDrop::new({
            let slot = slot.clone();
            move || slot.media.store(false, Ordering::SeqCst)
        });
        let started = Instant::now();
        let mut phase = "connect";
        let mut frames = 0_u64;
        let mut send_diagnostics = 0_u8;
        let mut target_count: Option<usize> = None;
        let mut close_code: Option<u16> = None;
        let current_connection = connection.clone();
        // Subscribe before admission checks; a fence racing startup remains visible.
        let mut authority_changed = slot.authority.lock().unwrap().subscribe();
        let mut refresh = slot.refresh.subscribe();
        let run = async {
            if current_connection.borrow().as_deref() != Some(&device) {
                anyhow::bail!("browser_media_revoked");
            }
            let config = WebSocketConfig {
                max_message_size: Some(4096),
                max_frame_size: Some(4096),
                max_write_buffer_size: 2 * 1024 * 1024,
                ..Default::default()
            };
            let mut socket = tokio::select! {
                biased;
                _ = connection.changed() => anyhow::bail!("browser_media_revoked"),
                _ = authority_revoked(&slot.authority, &mut authority_changed,
                    epoch, controller.as_deref(), media_fence) => anyhow::bail!("browser_media_revoked"),
                result = async {
                    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5),
                        connect_async_with_config(endpoint, Some(config), false)).await??;
                    phase = "authenticate";
                    tokio::time::timeout(Duration::from_secs(3),
                        socket.send(Message::Text(json!({"ticket":ticket}).to_string()))).await??;
                    Ok::<_, anyhow::Error>(socket)
                } => result?,
            };
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
                    _ = authority_revoked(&slot.authority, &mut authority_changed,
                        epoch, controller.as_deref(), media_fence) => anyhow::bail!("browser_media_revoked"),
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
                if let Some(mode) = request.mode.as_deref() {
                    if mode != "screencast_v1" || controller.is_none() {
                        anyhow::bail!("browser_invalid_media_mode");
                    }
                    phase = "private_stream";
                    return super::stream_media::run(
                        &mut socket,
                        &slot,
                        &current_connection,
                        &device,
                        epoch,
                        controller.as_deref().unwrap(),
                        request.target_id,
                    )
                    .await;
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
                    if targets.is_empty()
                        || (browser.selection_unavailable() && request.target_id.is_none())
                    {
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
                        if request.target_id.is_some() {
                            browser.selected_explicitly();
                        }
                        phase = "capture";
                        // This capture includes all operations completed before taking the lock.
                        refresh.borrow_and_update();
                        let capture_started = Instant::now();
                        let mut timing = super::adapter::CaptureTiming::default();
                        let captured = if controller.is_some() {
                            browser
                                .capture_scaled_timed(&target, request.pixel_ratio, &mut timing)
                                .await
                        } else {
                            browser
                                .capture_scaled_timed_with_repair(
                                    &target,
                                    request.pixel_ratio,
                                    &mut timing,
                                    || {
                                        current_connection.borrow().as_deref() == Some(&device)
                                            && slot.authority.lock().unwrap().media_allowed(
                                                epoch,
                                                None,
                                                media_fence,
                                            )
                                    },
                                )
                                .await
                        };
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
                let payload = data.to_string();
                let payload_bytes = payload.len();
                let format = if data.get("image").is_none() {
                    "control"
                } else if data.get("image_format").is_some() {
                    "png"
                } else {
                    "jpeg"
                };
                let send_started = Instant::now();
                if frames < 3 && send_diagnostics < 24 {
                    send_diagnostics += 1;
                    tracing::info!(component = "browser_media", event = "frame_write_started",
                        session_id = %session_id, epoch, frame_index = frames + 1,
                        mode = "screenshots", format, payload_bytes, "Browser media delivery");
                }
                let sent = tokio::time::timeout(
                    Duration::from_secs(3),
                    socket.send(Message::Text(payload)),
                )
                .await;
                let write_ms = send_started.elapsed().as_millis() as u64;
                if send_diagnostics < 24
                    && (frames < 3 || write_ms >= 250 || !matches!(&sent, Ok(Ok(()))))
                {
                    send_diagnostics += 1;
                    tracing::info!(component = "browser_media", event = "frame_write_completed",
                        session_id = %session_id, epoch, frame_index = frames + 1,
                        mode = "screenshots", format, payload_bytes, write_ms,
                        ok = matches!(&sent, Ok(Ok(()))), timed_out = sent.is_err(),
                        "Browser media delivery");
                }
                sent??;
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
        // Only the drop guard releases admission, after all source cleanup. An
        // extra early store could let its later drop clear a replacement's flag.
    });
}

async fn authority_revoked(
    authority: &std::sync::Mutex<super::control::Authority>,
    changed: &mut watch::Receiver<()>,
    epoch: u64,
    controller: Option<&str>,
    fence: Option<u64>,
) {
    loop {
        let deadline = {
            let mut authority = authority.lock().unwrap();
            if !authority.media_allowed(epoch, controller, fence) {
                return;
            }
            authority.deadline()
        };
        tokio::select! {
            result = changed.changed() => { if result.is_err() { return; } }
            _ = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                    None => std::future::pending().await,
                }
            } => {}
        }
    }
}

/// Runs a closure when dropped, including during unwinding.
pub(super) struct OnDrop<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> OnDrop<F> {
    pub fn new(f: F) -> Self {
        Self(Some(f))
    }
}
impl<F: FnOnce()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
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
        "browser_capture_cleanup_unconfirmed" => "browser_capture_cleanup_unconfirmed",
        "browser_interrupted" => "browser_interrupted",
        "browser_target_not_found" => "browser_target_not_found",
        "browser_media_revoked" => "browser_media_revoked",
        "browser_stream_stalled" => "browser_stream_stalled",
        "browser_stream_invalid_ack" => "browser_stream_invalid_ack",
        "browser_stream_transition_limit" => "browser_stream_transition_limit",
        "browser_stream_start_failed" => "browser_stream_start_failed",
        "browser_stream_cleanup_unconfirmed" => "browser_stream_cleanup_unconfirmed",
        "browser_stream_unsupported_viewport" => "browser_stream_unsupported_viewport",
        "browser_stream_closed" => "browser_stream_closed",
        "browser_stream_command_rejected" => "browser_stream_command_rejected",
        "browser_stream_generation_changed" => "browser_stream_generation_changed",
        "browser_stream_ack_capacity" => "browser_stream_ack_capacity",
        "browser_stream_invalid_frame" => "browser_stream_invalid_frame",
        "browser_stream_frame_bounds" => "browser_stream_frame_bounds",
        "browser_stream_attach_failed" => "browser_stream_attach_failed",
        "browser_invalid_media_mode" => "browser_invalid_media_mode",
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

#[cfg(test)]
mod busy_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[tokio::test]
    #[ignore = "requires local Chrome; disposable headless profile only"]
    async fn live_takeover_admits_replacement_while_passive_peer_stays_open() {
        use super::super::{
            control::ControlCommand,
            manager::{Action, BrowserManager, Request},
        };
        let request = |sequence, epoch, command| Request {
            browser_color: None,
            browser_viewport: None,
            repl_images: None,
            request_id: format!("request-{sequence}"),
            device_session_id: "device".into(),
            session_id: "browser".into(),
            generation: "generation".into(),
            thread_id: "thread".into(),
            owner_user_id: "owner".into(),
            browser_id: "resource".into(),
            browser_epoch: epoch,
            private_content: false,
            browser_paused: false,
            control_epoch: epoch,
            sequence,
            expires_at_ms: crate::util::now_millis() + 30_000,
            invocation_id: "invocation".into(),
            invocation_fence: 1,
            command,
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(
            std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
        )));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, 1, Action::Open { url: None }))
                .await
                .ok
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let attach = |controller| Action::MediaAttach {
            endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
            ticket: "takeover-fixture-ticket-0123456789".into(),
            controller_id: controller,
            operation_driven: Some(true),
        };
        assert!(manager.execute(request(2, 1, attach(None))).await.ok);
        let (tcp, _) = listener.accept().await.unwrap();
        let mut old_peer = tokio_tungstenite::accept_async(tcp).await.unwrap();
        old_peer.next().await.unwrap().unwrap(); // Authentication, no demand/EOF.
        assert!(
            manager
                .execute(request(
                    3,
                    2,
                    Action::Control {
                        control: ControlCommand::Pause
                    }
                ))
                .await
                .ok
        );
        assert!(
            manager
                .execute(request(
                    4,
                    3,
                    Action::Control {
                        control: ControlCommand::Acquire {
                            controller_id: "controller".into(),
                            lease_expires_at_ms: crate::util::now_millis() + 6000,
                        }
                    }
                ))
                .await
                .ok
        );
        tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                let reply = manager
                    .execute(request(5, 3, attach(Some("controller".into()))))
                    .await;
                if reply.ok {
                    break;
                }
                assert_eq!(reply.error, Some("browser_media_busy"));
                tokio::task::yield_now().await;
            }
            let (tcp, _) = listener.accept().await.unwrap();
            let mut private_peer = tokio_tungstenite::accept_async(tcp).await.unwrap();
            private_peer.next().await.unwrap().unwrap();
        })
        .await
        .expect("local fence must admit replacement within 500 ms");
        drop(old_peer);
        assert!(
            manager
                .execute(request(
                    6,
                    4,
                    Action::Control {
                        control: ControlCommand::End
                    }
                ))
                .await
                .ok
        );
        assert!(manager.execute(request(7, 4, Action::Close)).await.ok);
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn busy_flag_clears_when_the_media_task_panics() {
        let busy = Arc::new(AtomicBool::new(true));
        let flag = busy.clone();
        let task = tokio::spawn(async move {
            let _guard = OnDrop::new(move || flag.store(false, Ordering::SeqCst));
            panic!("simulated media task failure");
        });
        assert!(task.await.is_err(), "task must have panicked");
        assert!(!busy.load(Ordering::SeqCst), "busy flag stuck after panic");
    }

    #[tokio::test]
    async fn local_fence_releases_idle_media_without_peer_eof() {
        use super::super::control::{Authority, ControlCommand};
        let authority = Arc::new(std::sync::Mutex::new(Authority::default()));
        let mut changed = authority.lock().unwrap().subscribe();
        let fence = authority.lock().unwrap().media_fence();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let (accepted, ready) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let _socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            accepted.send(()).unwrap();
            std::future::pending::<()>().await; // Never acknowledges or sends EOF.
        });
        let (mut socket, _) = tokio_tungstenite::connect_async(endpoint).await.unwrap();
        ready.await.unwrap();
        let busy = Arc::new(AtomicBool::new(true));
        let flag = busy.clone();
        let watched = authority.clone();
        let task = tokio::spawn(async move {
            let _guard = OnDrop::new(move || flag.store(false, Ordering::SeqCst));
            tokio::select! {
                biased;
                _ = authority_revoked(&watched, &mut changed, 0, None, Some(fence)) => {},
                _ = socket.next() => panic!("peer unexpectedly completed"),
            }
        });
        // Ordinary agent epoch changes keep passive media alive.
        authority.lock().unwrap().epoch = 1;
        tokio::task::yield_now().await;
        assert!(busy.load(Ordering::SeqCst));
        // Also covers fencing before the idle future is first polled.
        authority
            .lock()
            .unwrap()
            .transition(2, &ControlCommand::Pause)
            .unwrap();
        {
            let mut current = authority.lock().unwrap();
            current
                .transition(
                    3,
                    &ControlCommand::Acquire {
                        controller_id: "controller".into(),
                        lease_expires_at_ms: crate::util::now_millis() + 6000,
                    },
                )
                .unwrap();
            current.transition(4, &ControlCommand::End).unwrap();
            current.resume_after_stop(4);
        }
        // Even a fully coalesced takeover/return must retire the old socket.
        tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !busy.swap(true, Ordering::SeqCst),
            "replacement must be admitted"
        );
        tokio::task::yield_now().await;
        assert!(
            busy.load(Ordering::SeqCst),
            "old cleanup cleared new admission"
        );
        peer.abort();
    }

    #[tokio::test]
    async fn private_idle_media_expires_without_a_remote_message() {
        use super::super::control::{Authority, ControlCommand};
        let mut authority = Authority::default();
        authority.transition(1, &ControlCommand::Pause).unwrap();
        authority
            .transition(
                2,
                &ControlCommand::Acquire {
                    controller_id: "controller".into(),
                    lease_expires_at_ms: crate::util::now_millis() + 100,
                },
            )
            .unwrap();
        let mut changed = authority.subscribe();
        let authority = std::sync::Mutex::new(authority);
        tokio::time::timeout(
            Duration::from_millis(500),
            authority_revoked(&authority, &mut changed, 2, Some("controller"), None),
        )
        .await
        .unwrap();
        assert!(authority.lock().unwrap().end_pending);
    }
}
