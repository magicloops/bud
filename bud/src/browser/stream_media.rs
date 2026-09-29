//! Experimental private binary stream; existing media admission owns authority.
use super::{manager::Slot, screencast::Source};
use anyhow::{bail, Context, Result};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Feedback {
    FrameAck {
        media_generation: String,
        frame_sequence: u64,
        disposition: String,
    },
    Target {
        target_id: String,
    },
}
struct Credit {
    generation: String,
    sequence: u64,
    bytes: usize,
    sent: Instant,
}

pub(super) async fn run(
    socket: &mut Socket,
    slot: &Arc<Slot>,
    connection: &watch::Receiver<Option<String>>,
    device: &str,
    epoch: u64,
    controller: &str,
    mut target: Option<String>,
) -> Result<()> {
    let allowed = || {
        connection.borrow().as_deref() == Some(device)
            && slot
                .authority
                .lock()
                .unwrap()
                .media_allowed(epoch, Some(controller), None)
    };
    let mut source: Option<Source> = None;
    let mut generation = String::new();
    let mut live = None;
    let mut credits: VecDeque<Credit> = VecDeque::new();
    let mut sequence = 0u64;
    let mut next_send = Instant::now();
    let mut restarts: VecDeque<Instant> = VecDeque::new();
    let result = async {
        loop {
            if !allowed() { bail!("browser_media_revoked"); }
            if credits.front().is_some_and(|c| c.sent.elapsed() > Duration::from_secs(1)) { bail!("browser_stream_stalled"); }
            if source.is_none() || live.as_ref().is_some_and(|v: &Arc<std::sync::atomic::AtomicBool>| !v.load(Ordering::SeqCst)) {
                // Bound crash/navigation churn instead of hiding it with reconnects.
                while restarts.front().is_some_and(|t| t.elapsed() > Duration::from_secs(10)) { restarts.pop_front(); }
                if restarts.len() >= 8 { bail!("browser_stream_transition_limit"); }
                restarts.push_back(Instant::now());
                if let Some(mut old) = source.take() { old.stop().await?; }
                let (config, next_generation, targets) = {
                    let _page = tokio::time::timeout(Duration::from_secs(4), slot.page_lock.lock()).await?;
                    let mut entry = slot.state.lock().await;
                    if !allowed() { bail!("browser_media_revoked"); }
                    let selected = target.clone().or(entry.target.clone());
                    let browser = entry.browser.as_mut().context("browser_interrupted")?;
                    let targets = browser.targets().await?;
                    let selected = match selected {
                        Some(id) if targets.iter().any(|t| t.target_id == id) => id,
                        Some(_) => bail!("browser_target_not_found"),
                        None => targets.first().map(|t| t.target_id.clone()).context("browser_no_target")?,
                    };
                    let (config, generation) = browser.prepare_stream(&selected).await?;
                    entry.target = Some(selected.clone()); target = Some(selected);
                    let targets = targets.iter().map(|t| json!({"target_id":t.target_id,
                        "origin":url::Url::parse(&t.url).map(|u|u.origin().ascii_serialization()).unwrap_or_default()})).collect::<Vec<_>>();
                    (config, generation, targets)
                };
                generation = next_generation;
                live = Some(config.live.clone());
                send(socket, Message::Text(json!({"type":"reset","media_version":1,"media_generation":generation,"targets":targets}).to_string())).await?;
                // Authority retirement must reach the source even during bounded
                // setup/cleanup or a blocked network write in this task.
                let watched_live = config.live.clone();
                let watched_slot = slot.clone();
                let watched_connection = connection.clone();
                let watched_device = device.to_owned();
                let watched_controller = controller.to_owned();
                tokio::spawn(async move {
                    while watched_live.load(Ordering::SeqCst) {
                        if watched_connection.borrow().as_deref() != Some(&watched_device)
                            || !watched_slot.authority.lock().unwrap().media_allowed(epoch, Some(&watched_controller), None) {
                            watched_live.store(false, Ordering::SeqCst); break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                });
                source = Some(Source::start(config).await?);
                continue;
            }
            match tokio::time::timeout(Duration::from_millis(5), socket.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    match serde_json::from_str::<Feedback>(&text)? {
                        Feedback::FrameAck { media_generation, frame_sequence, disposition } => {
                            if !matches!(disposition.as_str(), "presented" | "discarded") { bail!("browser_stream_invalid_ack"); }
                            let index = credits.iter().position(|c| c.generation == media_generation && c.sequence == frame_sequence)
                                .context("browser_stream_invalid_ack")?;
                            credits.remove(index);
                        }
                        Feedback::Target { target_id } => {
                            if target_id.is_empty() || target_id.len() > 128 { bail!("browser_invalid_target"); }
                            target = Some(target_id);
                            if let Some(live) = &live { live.store(false, Ordering::SeqCst); }
                        }
                    }
                }
                Ok(Some(Ok(Message::Ping(_)))) => { tokio::time::timeout(Duration::from_secs(1), socket.flush()).await??; }
                Ok(Some(Ok(Message::Pong(_)))) | Err(_) => {},
                _ => bail!("browser_stream_closed"),
            }
            if !allowed() { bail!("browser_media_revoked"); }
            if credits.len() >= 3 || Instant::now() < next_send { continue; }
            let source = source.as_mut().unwrap();
            if !source.latest.has_changed().unwrap_or(false) { continue; }
            let frame = source.latest.borrow().clone();
            let Some(frame) = frame else { continue; };
            if frame.received.elapsed() > Duration::from_millis(150) { source.latest.borrow_and_update(); continue; }
            let bytes_in_flight: usize = credits.iter().map(|c| c.bytes).sum();
            if bytes_in_flight + frame.image.len() + 4104 > 2 * 1024 * 1024 { continue; }
            source.latest.borrow_and_update();
            let (bitmap_width, bitmap_height) = super::image_bounds::jpeg_dimensions(&frame.image).context("browser_invalid_image")?;
            if !super::image_bounds::within_bounds((bitmap_width, bitmap_height), true) { bail!("browser_invalid_image"); }
            let mut header = {
                // Registration alone: no CDP capture/read or network wait under this lock.
                let Ok(mut entry) = slot.state.try_lock() else { continue; };
                if !allowed() { bail!("browser_media_revoked"); }
                match entry.browser.as_mut().context("browser_interrupted")?.stream_frame(&generation, &frame) {
                    Ok(header) => header,
                    Err(_) => continue,
                }
            };
            sequence += 1;
            header["media_generation"] = json!(generation);
            header["frame_sequence"] = json!(sequence);
            header["bitmap_width"] = json!(bitmap_width); header["bitmap_height"] = json!(bitmap_height);
            header["image_bytes"] = json!(frame.image.len());
            header["source_age_ms"] = json!(frame.received.elapsed().as_millis() as u64);
            let header = serde_json::to_vec(&header)?;
            if header.len() > 4096 { bail!("browser_stream_header_bounds"); }
            let mut packet = b"BSC1".to_vec(); packet.extend((header.len() as u32).to_be_bytes());
            packet.extend(header); packet.extend(frame.image.as_slice());
            let bytes = packet.len();
            if !allowed() || !live.as_ref().unwrap().load(Ordering::SeqCst) { continue; }
            credits.push_back(Credit { generation: generation.clone(), sequence, bytes, sent: Instant::now() });
            send(socket, Message::Binary(packet)).await?;
            next_send = Instant::now() + Duration::from_millis(34);
        }
    }.await;
    if let Some(live) = live {
        live.store(false, Ordering::SeqCst);
    }
    if let Some(mut source) = source {
        let _ = source.stop().await;
    }
    tracing::info!(
        component = "browser_media",
        event = "stream_ended",
        epoch,
        frames_sent = sequence,
        unacknowledged_frames = credits.len(),
        "Private browser stream ended"
    );
    result
}
async fn send(socket: &mut Socket, message: Message) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(1), socket.send(message)).await??;
    Ok(())
}
