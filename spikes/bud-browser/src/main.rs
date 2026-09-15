//! Outbound experimental host. Environment contains only launch configuration
//! and short-lived relay tickets; no debugging endpoint leaves this process.
use anyhow::{bail, Context, Result};
use bud_browser_spike::Browser;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

#[derive(Deserialize)]
struct Request {
    id: String,
    epoch: u64,
    viewer: Option<String>,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Command {
    Targets,
    Observe { target: String },
    Navigate { target: String, url: String },
    Focus { reference: String },
    InsertText { text: String },
    Click { reference: String },
    Takeover,
    Heartbeat,
    Return { target: String },
    Pause,
    Capture { target: String },
}

async fn execute(browser: &mut Browser, request: Request, media: bool) -> Result<Value> {
    let epoch = request.epoch;
    let viewer = request.viewer.as_deref();
    if media != matches!(request.command, Command::Capture { .. }) {
        bail!("wrong_channel");
    }
    Ok(match request.command {
        Command::Targets => json!(browser.targets(epoch, viewer).await?),
        Command::Observe { target } => json!(browser.observe(epoch, viewer, &target).await?),
        Command::Navigate { target, url } => {
            browser.navigate(epoch, viewer, &target, &url).await?;
            Value::Null
        }
        Command::Focus { reference } => {
            browser.focus(epoch, viewer, &reference).await?;
            Value::Null
        }
        Command::InsertText { text } => {
            browser.insert_text(epoch, viewer, &text).await?;
            Value::Null
        }
        Command::Click { reference } => {
            browser.click(epoch, viewer, &reference).await?;
            Value::Null
        }
        Command::Takeover => {
            json!({"epoch":browser.takeover(epoch, viewer.context("viewer_required")?)?})
        }
        Command::Heartbeat => {
            browser
                .control
                .heartbeat(epoch, viewer.context("viewer_required")?, Instant::now())?;
            Value::Null
        }
        Command::Return { target } => json!(
            browser
                .return_to_agent(epoch, viewer.context("viewer_required")?, &target)
                .await?
        ),
        Command::Pause => {
            browser.control.admit(epoch, viewer, Instant::now())?;
            browser.control.pause();
            Value::Null
        }
        Command::Capture { .. } => unreachable!("capture uses binary channel"),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let executable =
        std::env::var("BUD_BROWSER_EXECUTABLE").context("BUD_BROWSER_EXECUTABLE required")?;
    let relay = url::Url::parse(
        &std::env::var("BUD_BROWSER_SPIKE_RELAY").context("BUD_BROWSER_SPIKE_RELAY required")?,
    )?;
    if relay.scheme() != "wss"
        && !(relay.scheme() == "ws"
            && matches!(relay.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        bail!("relay_requires_tls_or_loopback");
    }
    let ticket = std::env::var("BUD_BROWSER_SPIKE_HOST_TICKET").context("host ticket required")?;
    let media_ticket =
        std::env::var("BUD_BROWSER_SPIKE_MEDIA_TICKET").context("media ticket required")?;
    let mut request = relay
        .join("/ws/browser-spike/host")?
        .as_str()
        .into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {ticket}").parse()?);
    let socket_config = WebSocketConfig {
        max_message_size: Some(16384),
        max_frame_size: Some(16384),
        ..Default::default()
    };
    let (mut control, _) = connect_async_with_config(request, Some(socket_config), false)
        .await
        .map_err(|_| anyhow::anyhow!("relay_connection_failed"))?;
    let mut request = relay
        .join("/ws/browser-spike/media")?
        .as_str()
        .into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {media_ticket}").parse()?);
    let (mut media, _) = connect_async_with_config(request, Some(socket_config), false)
        .await
        .map_err(|_| anyhow::anyhow!("media_connection_failed"))?;
    let mut browser = Browser::launch(Path::new(&executable)).await?;
    control
        .send(Message::Text(
            json!({"ready":true,"epoch":1,"browser":browser.version().await?}).to_string(),
        ))
        .await?;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        let (frame, is_media) = tokio::select! {
            biased;
            _ = tokio::signal::ctrl_c() => break,
            _ = tick.tick() => { browser.control.expire(Instant::now()); continue; },
            frame = control.next() => (frame, false),
            frame = media.next() => (frame, true),
        };
        let text = match frame {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Ping(bytes))) => {
                let socket = if is_media { &mut media } else { &mut control };
                socket.send(Message::Pong(bytes)).await?;
                continue;
            }
            Some(Ok(Message::Pong(_))) => continue,
            _ => break,
        };
        if text.len() > 16384 {
            break;
        }
        let request: Request = match serde_json::from_str(&text) {
            Ok(request) => request,
            Err(_) => break,
        };
        if request.id.len() > 64 {
            break;
        }
        let id = request.id.clone();
        if is_media {
            if let Command::Capture { target } = request.command {
                match browser
                    .capture(request.epoch, request.viewer.as_deref(), &target)
                    .await
                {
                    Ok(bytes) => {
                        if !matches!(
                            tokio::time::timeout(
                                Duration::from_secs(2),
                                media.send(Message::Binary(bytes))
                            )
                            .await,
                            Ok(Ok(()))
                        ) {
                            break;
                        }
                    }
                    Err(_) => {
                        media.send(Message::Text(json!({"id":id,"error":"capture_unavailable","epoch":browser.control.epoch}).to_string())).await?;
                    }
                }
            } else {
                break;
            }
        } else {
            let result = execute(&mut browser, request, false).await;
            // Do not log input, URLs, page contents, grant headers, CDP errors.
            let response = match result {
                Ok(result) => json!({"id":id,"result":result,"epoch":browser.control.epoch}),
                Err(_) => {
                    json!({"id":id,"error":"browser_command_rejected","epoch":browser.control.epoch})
                }
            };
            control.send(Message::Text(response.to_string())).await?;
        }
    }
    // This disposable harness closes on relay loss. Production ownership must
    // instead preserve the process and pause control across transport reconnect.
    browser.close().await
}
