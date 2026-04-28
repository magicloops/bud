use anyhow::{bail, Context, Result};
use std::env;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio::time::{self, Instant};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Channel, Endpoint};
use tonic::{Code, Request, Status};
use tracing::info;

pub mod bud {
    pub mod interop {
        pub mod v1 {
            tonic::include_proto!("bud.interop.v1");
        }
    }
}

use bud::interop::v1::{
    bud_attach_interop_service_client::BudAttachInteropServiceClient,
    bud_control_interop_service_client::BudControlInteropServiceClient, ClientControlEvent,
    DataFrame,
};

#[tokio::main]
async fn main() -> Result<()> {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let endpoint =
        env::var("BUD_INTEROP_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:50051".to_owned());
    let command = env::args().nth(1).unwrap_or_else(|| "control".to_owned());

    match command.as_str() {
        "control" => run_control(&endpoint).await,
        "metadata" => run_metadata(&endpoint).await,
        "client-cancel" => run_client_cancel(&endpoint).await,
        "server-cancel" => run_server_cancel(&endpoint).await,
        "status-details" => run_status_details(&endpoint).await,
        "deadline" => run_deadline(&endpoint).await,
        "max-message" => run_max_message(&endpoint).await,
        "drain" => run_drain(&endpoint).await,
        "churn" => run_churn(&endpoint).await,
        "attach" => run_attach(&endpoint).await,
        "proxy-file" => run_proxy_file(&endpoint).await,
        "reconnect" => run_reconnect(&endpoint).await,
        other => bail!("unknown command {other}; expected control, metadata, client-cancel, server-cancel, status-details, deadline, max-message, drain, churn, attach, proxy-file, or reconnect"),
    }
}

async fn run_control(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(64);

    tx.send(control_event("control-session", 1, "hello", b"{}".to_vec()))
        .await
        .context("send initial hello")?;

    let mut request = Request::new(ReceiverStream::new(rx));
    request.metadata_mut().insert(
        "x-bud-correlation-id",
        "control-basic".parse().context("parse metadata value")?,
    );

    let response = client.connect(request).await?;
    assert_metadata(response.metadata(), "x-bud-correlation-id", "control-basic")?;
    let mut response = response.into_inner();
    let heartbeat_tx = tx.clone();
    let duration_ms = env_u64("BUD_INTEROP_DURATION_MS", 3_000);
    let heartbeat_ms = env_u64("BUD_INTEROP_HEARTBEAT_MS", 250);

    let heartbeat_task = tokio::spawn(async move {
        let deadline = Instant::now() + Duration::from_millis(duration_ms);
        let mut seq = 2;
        while Instant::now() < deadline {
            if heartbeat_tx
                .send(control_event(
                    "control-session",
                    seq,
                    "heartbeat",
                    Vec::new(),
                ))
                .await
                .is_err()
            {
                break;
            }
            seq += 1;
            time::sleep(Duration::from_millis(heartbeat_ms)).await;
        }
    });

    let mut saw_hello_ack = false;
    let mut saw_directive = false;
    let mut received = 0_u64;
    let read_deadline = time::sleep(Duration::from_millis(duration_ms + 2_000));
    tokio::pin!(read_deadline);

    loop {
        tokio::select! {
            message = response.message() => {
                let Some(message) = message? else {
                    break;
                };
                received += 1;
                info!(kind = %message.kind, seq = message.seq, "received control message");
                saw_hello_ack |= message.kind == "hello_ack";
                saw_directive |= message.kind == "server_directive";
            }
            _ = &mut read_deadline => {
                break;
            }
        }
    }

    drop(tx);
    heartbeat_task.await.context("heartbeat task join")?;

    if !saw_hello_ack {
        bail!("control stream did not receive hello_ack");
    }
    if !saw_directive {
        bail!("control stream did not receive server_directive during heartbeats");
    }

    println!("control: pass ({received} responses)");
    Ok(())
}

async fn run_metadata(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "metadata-session",
        1,
        "hello",
        b"{}".to_vec(),
    ))
    .await
    .context("send metadata hello")?;
    drop(tx);

    let mut request = Request::new(ReceiverStream::new(rx));
    request.metadata_mut().insert(
        "x-bud-correlation-id",
        "metadata-probe".parse().context("parse metadata value")?,
    );

    let response = client.connect(request).await?;
    assert_metadata(
        response.metadata(),
        "x-bud-correlation-id",
        "metadata-probe",
    )?;

    let mut stream = response.into_inner();
    let message = stream
        .message()
        .await?
        .context("missing metadata response")?;
    if message.kind != "hello_ack" {
        bail!("metadata expected hello_ack, got {}", message.kind);
    }

    println!("metadata: pass");
    Ok(())
}

async fn run_client_cancel(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "client-cancel-session",
        1,
        "hello",
        b"{}".to_vec(),
    ))
    .await
    .context("send hello")?;

    let mut response = client
        .connect(Request::new(ReceiverStream::new(rx)))
        .await?
        .into_inner();
    let first = response
        .message()
        .await?
        .context("missing hello_ack before cancel")?;
    if first.kind != "hello_ack" {
        bail!(
            "expected hello_ack before client cancel, received {}",
            first.kind
        );
    }

    drop(response);
    drop(tx);
    time::sleep(Duration::from_millis(250)).await;
    println!("client-cancel: pass (client dropped response stream)");
    Ok(())
}

async fn run_server_cancel(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "server-cancel-session",
        1,
        "cancel_me",
        Vec::new(),
    ))
    .await
    .context("send cancel request")?;
    drop(tx);

    match client.connect(Request::new(ReceiverStream::new(rx))).await {
        Err(status) if status.code() == Code::Cancelled => {
            println!("server-cancel: pass ({status})");
            Ok(())
        }
        Err(status) => bail!("expected CANCELLED from server, got {status}"),
        Ok(response) => {
            let mut stream = response.into_inner();
            match stream.message().await {
                Err(status) if status.code() == Code::Cancelled => {
                    println!("server-cancel: pass ({status})");
                    Ok(())
                }
                Err(status) => bail!("expected CANCELLED from server stream, got {status}"),
                Ok(message) => bail!("expected server cancellation, got message {message:?}"),
            }
        }
    }
}

async fn run_status_details(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "status-details-session",
        1,
        "failed_precondition",
        Vec::new(),
    ))
    .await
    .context("send status-details request")?;
    drop(tx);

    match client.connect(Request::new(ReceiverStream::new(rx))).await {
        Err(status) => assert_status_details(status),
        Ok(response) => {
            let mut stream = response.into_inner();
            match stream.message().await {
                Err(status) => assert_status_details(status),
                Ok(message) => bail!("expected failed precondition, got message {message:?}"),
            }
        }
    }
}

async fn run_deadline(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "deadline-session",
        1,
        "deadline_probe",
        Vec::new(),
    ))
    .await
    .context("send deadline probe")?;
    drop(tx);

    let mut request = Request::new(ReceiverStream::new(rx));
    request.set_timeout(Duration::from_millis(env_u64(
        "BUD_INTEROP_DEADLINE_MS",
        250,
    )));

    let response = client.connect(request).await;
    assert_status(response, Code::DeadlineExceeded, "deadline").await
}

async fn run_max_message(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(1);
    let payload_size = env_u64("BUD_INTEROP_MAX_PAYLOAD_BYTES", 4 * 1024 * 1024) + 1;
    tx.send(control_event(
        "max-message-session",
        1,
        "hello",
        vec![b'x'; payload_size as usize],
    ))
    .await
    .context("send oversized message")?;
    drop(tx);

    let response = client.connect(Request::new(ReceiverStream::new(rx))).await;
    assert_status(response, Code::ResourceExhausted, "max-message").await
}

async fn run_drain(endpoint: &str) -> Result<()> {
    let mut client = control_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
    tx.send(control_event(
        "drain-session",
        1,
        "drain_request",
        Vec::new(),
    ))
    .await
    .context("send drain request")?;
    drop(tx);

    let mut response = client
        .connect(Request::new(ReceiverStream::new(rx)))
        .await?
        .into_inner();
    while let Some(message) = response.message().await? {
        if message.kind == "drain_notice" {
            println!("drain: pass");
            return Ok(());
        }
    }

    bail!("drain stream closed without drain_notice")
}

async fn run_churn(endpoint: &str) -> Result<()> {
    let cycles = env_u64("BUD_INTEROP_CHURN", 1_000);
    let mut client = control_client(endpoint).await?;

    for cycle in 0..cycles {
        let (tx, rx) = mpsc::channel::<ClientControlEvent>(2);
        tx.send(control_event(
            &format!("churn-session-{cycle}"),
            1,
            "hello",
            b"{}".to_vec(),
        ))
        .await
        .context("send churn hello")?;
        drop(tx);

        let mut response = client
            .connect(Request::new(ReceiverStream::new(rx)))
            .await
            .with_context(|| format!("open churn stream {cycle}"))?
            .into_inner();

        let mut saw_hello_ack = false;
        while let Some(message) = response
            .message()
            .await
            .with_context(|| format!("read churn stream {cycle}"))?
        {
            if message.kind == "hello_ack" {
                saw_hello_ack = true;
            }
        }

        if !saw_hello_ack {
            bail!("churn stream {cycle} did not receive hello_ack");
        }

        if cycle > 0 && cycle % 100 == 0 {
            info!(cycle, "completed churn cycle");
        }
    }

    println!("churn: pass ({cycles} streams)");
    Ok(())
}

async fn run_attach(endpoint: &str) -> Result<()> {
    let stream_count = env_u64("BUD_INTEROP_ATTACH_STREAMS", 8);
    let frames_per_stream = env_u64("BUD_INTEROP_ATTACH_FRAMES", 16);
    let mut tasks = Vec::new();

    for stream_index in 0..stream_count {
        let endpoint = endpoint.to_owned();
        tasks.push(tokio::spawn(async move {
            let mut client = attach_client(&endpoint).await?;
            let (tx, rx) = mpsc::channel::<DataFrame>(16);
            let stream_id = format!("attach-stream-{stream_index}");

            for frame_index in 0..frames_per_stream {
                tx.send(data_frame(
                    &stream_id,
                    frame_index + 1,
                    "data",
                    format!("payload-{stream_index}-{frame_index}").into_bytes(),
                    frame_index * 128,
                ))
                .await
                .context("send attach frame")?;
            }
            drop(tx);

            let mut response = client
                .attach(Request::new(ReceiverStream::new(rx)))
                .await?
                .into_inner();
            let mut received = 0_u64;
            while let Some(frame) = response.message().await? {
                if frame.kind == "data_echo" {
                    received += 1;
                }
            }

            if received != frames_per_stream {
                bail!(
                    "attach stream {stream_index} expected {frames_per_stream} echoes, received {received}"
                );
            }

            Ok::<(), anyhow::Error>(())
        }));
    }

    for task in tasks {
        task.await.context("attach task join")??;
    }

    println!("attach: pass ({stream_count} streams x {frames_per_stream} frames)");
    Ok(())
}

async fn run_proxy_file(endpoint: &str) -> Result<()> {
    let mut client = attach_client(endpoint).await?;
    let (tx, rx) = mpsc::channel::<DataFrame>(8);
    let frames = [
        (
            "proxy_request_body",
            b"GET /assets/app.js HTTP/1.1\r\n\r\n".to_vec(),
        ),
        (
            "proxy_response_body",
            b"HTTP/1.1 200 OK\r\n\r\nconsole.log('bud');".to_vec(),
        ),
        ("file_range_chunk", b"range-bytes-0-1023".to_vec()),
        ("stream_close", Vec::new()),
    ];

    for (index, (kind, payload)) in frames.into_iter().enumerate() {
        tx.send(data_frame(
            "proxy-file-stream",
            index as u64 + 1,
            kind,
            payload,
            index as u64 * 1024,
        ))
        .await
        .context("send proxy/file frame")?;
    }
    drop(tx);

    let mut response = client
        .attach(Request::new(ReceiverStream::new(rx)))
        .await?
        .into_inner();
    let mut received = 0_u64;
    while let Some(frame) = response.message().await? {
        if frame.kind == "data_echo" {
            received += 1;
        }
    }

    if received != 4 {
        bail!("proxy-file expected 4 echoed frames, got {received}");
    }

    println!("proxy-file: pass");
    Ok(())
}

async fn run_reconnect(endpoint: &str) -> Result<()> {
    let attach_task = tokio::spawn({
        let endpoint = endpoint.to_owned();
        async move { run_attach(&endpoint).await }
    });

    for attempt in 0..5 {
        let mut client = control_client(endpoint).await?;
        let (tx, rx) = mpsc::channel::<ClientControlEvent>(4);
        tx.send(control_event(
            &format!("reconnect-session-{attempt}"),
            1,
            "hello",
            b"{}".to_vec(),
        ))
        .await
        .context("send reconnect hello")?;
        drop(tx);

        let mut response = client
            .connect(Request::new(ReceiverStream::new(rx)))
            .await?
            .into_inner();
        let message = response
            .message()
            .await?
            .with_context(|| format!("missing reconnect response {attempt}"))?;
        if message.kind != "hello_ack" {
            bail!(
                "reconnect attempt {attempt} expected hello_ack, got {}",
                message.kind
            );
        }
    }

    attach_task.await.context("attach task join")??;
    println!("reconnect: pass");
    Ok(())
}

async fn assert_status<T>(
    response: Result<tonic::Response<tonic::Streaming<T>>, Status>,
    expected: Code,
    label: &str,
) -> Result<()>
where
    T: prost::Message + Default + std::fmt::Debug + 'static,
{
    match response {
        Err(status) if status.code() == expected => {
            println!("{label}: pass ({status})");
            Ok(())
        }
        Err(status) => bail!("expected {expected:?} status for {label}, got {status}"),
        Ok(response) => {
            let mut stream = response.into_inner();
            match stream.message().await {
                Err(status) if status.code() == expected => {
                    println!("{label}: pass ({status})");
                    Ok(())
                }
                Err(status) => {
                    bail!("expected {expected:?} stream status for {label}, got {status}")
                }
                Ok(message) => bail!("expected {expected:?} for {label}, got message {message:?}"),
            }
        }
    }
}

fn assert_status_details(status: Status) -> Result<()> {
    if status.code() != Code::FailedPrecondition {
        bail!("expected FailedPrecondition for status-details, got {status}");
    }
    if !status.message().contains("typed status detail probe") {
        bail!(
            "expected status-details message to contain probe text, got {}",
            status.message()
        );
    }
    assert_metadata(
        status.metadata(),
        "x-bud-error-kind",
        "interop_precondition",
    )?;
    assert_metadata(status.metadata(), "x-bud-error-retryable", "false")?;
    println!("status-details: pass ({status})");
    Ok(())
}

fn assert_metadata(
    metadata: &tonic::metadata::MetadataMap,
    key: &'static str,
    expected: &'static str,
) -> Result<()> {
    let actual = metadata
        .get(key)
        .and_then(|value| value.to_str().ok())
        .with_context(|| format!("missing metadata {key}"))?;
    if actual != expected {
        bail!("metadata {key} expected {expected}, got {actual}");
    }
    Ok(())
}

async fn control_client(endpoint: &str) -> Result<BudControlInteropServiceClient<Channel>> {
    Ok(BudControlInteropServiceClient::new(
        channel(endpoint).await?,
    ))
}

async fn attach_client(endpoint: &str) -> Result<BudAttachInteropServiceClient<Channel>> {
    Ok(BudAttachInteropServiceClient::new(channel(endpoint).await?))
}

async fn channel(endpoint: &str) -> Result<Channel> {
    Endpoint::from_shared(endpoint.to_owned())
        .context("parse gRPC endpoint")?
        .connect()
        .await
        .context("connect gRPC channel")
}

fn control_event(session_id: &str, seq: u64, kind: &str, payload: Vec<u8>) -> ClientControlEvent {
    ClientControlEvent {
        session_id: session_id.to_owned(),
        seq,
        kind: kind.to_owned(),
        payload,
        sent_at_unix_ms: now_ms(),
    }
}

fn data_frame(stream_id: &str, seq: u64, kind: &str, payload: Vec<u8>, offset: u64) -> DataFrame {
    DataFrame {
        stream_id: stream_id.to_owned(),
        seq,
        kind: kind.to_owned(),
        payload,
        offset,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
}
