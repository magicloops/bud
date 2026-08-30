//! Integration tests for the stem-backed terminal manager: real holders
//! spawned through the shipped binary (`CARGO_BIN_EXE_bud term-hold`), real
//! `/bin/sh` sessions, and the proto 0.3 frame surface end to end.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message;

use bud::protocol::{
    Envelope, TerminalCloseFrame, TerminalEnsureConfig, TerminalEnsureFrame,
    TerminalGridWatchFrame, TerminalInputFrame, TerminalObserveFrame, TerminalResizeFrame,
    TerminalSendAwait, TerminalSendFrame,
};
use bud::terminal::{TerminalConfig, TerminalManager};
use bud::transport::TransportSender;

type FrameRx = mpsc::UnboundedReceiver<Message>;

fn envelope(kind: &str) -> Envelope {
    serde_json::from_value(json!({
        "type": kind,
        "proto": "0.3",
        "id": "01TEST",
        "ts": 0,
        "ext": {},
    }))
    .unwrap()
}

async fn manager_with_sender(tmp: &tempfile::TempDir) -> (TerminalManager, FrameRx) {
    let config = TerminalConfig {
        enabled: true,
        term_base_dir: tmp.path().join("term"),
        default_cwd: tmp.path().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        shell: "/bin/sh".into(),
        launcher_program: PathBuf::from(env!("CARGO_BIN_EXE_bud")),
        debug_enabled: false,
    };
    let manager = TerminalManager::new(config);
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    manager
        .set_sender(TransportSender::websocket(tx, false))
        .await;
    (manager, rx)
}

fn parse(message: Message) -> Option<Value> {
    match message {
        Message::Text(text) => serde_json::from_str(&text).ok(),
        _ => None,
    }
}

/// Consume frames until `pred` matches (discarding others) or panic at the
/// deadline. Returns the matching frame.
async fn wait_frame(
    rx: &mut FrameRx,
    timeout: Duration,
    what: &str,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_else(|| panic!("timed out waiting for {what}"));
        let message = tokio::time::timeout(remaining, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .unwrap_or_else(|| panic!("frame channel closed waiting for {what}"));
        if let Some(frame) = parse(message) {
            if pred(&frame) {
                return frame;
            }
        }
    }
}

/// Drain every frame that arrives within `window`.
async fn collect_frames(rx: &mut FrameRx, window: Duration) -> Vec<Value> {
    let deadline = Instant::now() + window;
    let mut frames = Vec::new();
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return frames;
        };
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(message)) => {
                if let Some(frame) = parse(message) {
                    frames.push(frame);
                }
            }
            _ => return frames,
        }
    }
}

fn is_type(frame: &Value, kind: &str) -> bool {
    frame.get("type").and_then(Value::as_str) == Some(kind)
}

fn is_status(frame: &Value, state: &str) -> bool {
    is_type(frame, "terminal_status") && frame.get("state").and_then(Value::as_str) == Some(state)
}

fn ensure_frame(session_id: &str, resume_from_offset: Option<u64>) -> TerminalEnsureFrame {
    TerminalEnsureFrame {
        envelope: envelope("terminal_ensure"),
        session_id: session_id.to_string(),
        config: None,
        resume_from_offset,
    }
}

fn ensure_frame_with_shell(session_id: &str, shell: &str, home: &str) -> TerminalEnsureFrame {
    TerminalEnsureFrame {
        envelope: envelope("terminal_ensure"),
        session_id: session_id.to_string(),
        config: Some(TerminalEnsureConfig {
            shell: Some(shell.to_string()),
            cwd: None,
            env: Some(std::collections::HashMap::from([(
                "HOME".to_string(),
                home.to_string(),
            )])),
            cols: None,
            rows: None,
        }),
        resume_from_offset: None,
    }
}

fn send_frame(
    session_id: &str,
    request_id: &str,
    text: &str,
    await_mode: Option<TerminalSendAwait>,
) -> TerminalSendFrame {
    TerminalSendFrame {
        envelope: envelope("terminal_send"),
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        text: Some(text.to_string()),
        submit: Some(true),
        key: None,
        r#await: await_mode,
    }
}

fn observe_frame(session_id: &str, request_id: &str, view: &str) -> TerminalObserveFrame {
    TerminalObserveFrame {
        envelope: envelope("terminal_observe"),
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        view: Some(view.to_string()),
        lines: None,
        r#await: None,
        quiet_ms: None,
    }
}

fn awaited_observe_frame(
    session_id: &str,
    request_id: &str,
    await_mode: TerminalSendAwait,
    quiet_ms: Option<u64>,
) -> TerminalObserveFrame {
    TerminalObserveFrame {
        r#await: Some(await_mode),
        quiet_ms,
        ..observe_frame(session_id, request_id, "delta")
    }
}

/// Inline awaited observe with a hard timeout so a wait regression fails the
/// test instead of hanging it (the daemon's own cap is 4h).
async fn awaited_observe(
    manager: &TerminalManager,
    frame: TerminalObserveFrame,
) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(20), manager.handle_observe(frame))
        .await
        .expect("awaited observe must resolve within 20s")
}

fn is_result_for(frame: &Value, kind: &str, request_id: &str) -> bool {
    is_type(frame, kind) && frame.get("request_id").and_then(Value::as_str) == Some(request_id)
}

fn is_event(frame: &Value, event: &str) -> bool {
    is_type(frame, "terminal_event") && frame.get("event").and_then(Value::as_str) == Some(event)
}

fn decoded_output(frame: &Value) -> String {
    let b64 = frame.get("output").and_then(Value::as_str).unwrap_or("");
    String::from_utf8_lossy(&BASE64_STANDARD.decode(b64).unwrap_or_default()).into_owned()
}

#[tokio::test]
async fn ensure_reports_stem_backed_ready_status() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;

    manager
        .handle_ensure(ensure_frame("sess-ready", None))
        .await
        .unwrap();

    let status = wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;
    assert_eq!(
        status.get("proto").and_then(Value::as_str),
        Some("0.3"),
        "terminal_status must be proto 0.3"
    );
    let info = status.get("info").expect("status info");
    assert!(info.get("pid").and_then(Value::as_i64).unwrap_or(0) > 0);
    assert_eq!(info.get("cols").and_then(Value::as_u64), Some(80));
    assert_eq!(info.get("rows").and_then(Value::as_u64), Some(24));
    assert!(info
        .get("ring_next_offset")
        .and_then(Value::as_u64)
        .is_some());
    assert!(info.get("mode").and_then(Value::as_str).is_some());
    assert!(info.get("integration").and_then(Value::as_str).is_some());
    assert!(info.get("output_log_bytes").is_none(), "0.2 field retired");

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-ready".into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn sentinel_run_semantics_report_real_exit_codes() {
    // /bin/sh (bash-without-rcfile on macOS) has no OSC 133 integration, so
    // text+submit+await:"command" exercises the sentinel path naturally.
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-run", None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;

    manager
        .handle_send(send_frame(
            "sess-run",
            "req-true",
            "true",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "send result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-true")
    })
    .await;
    assert_eq!(
        result.get("dispatched").and_then(Value::as_bool),
        Some(true)
    );
    assert!(result.get("error").unwrap().is_null());
    let outcome = result.get("outcome").expect("outcome");
    assert_eq!(
        outcome.get("event").and_then(Value::as_str),
        Some("command_finished")
    );
    let data = outcome.get("data").expect("outcome data");
    assert_eq!(data.get("exit_code").and_then(Value::as_i64), Some(0));
    assert!(data
        .get("command_id")
        .and_then(Value::as_str)
        .unwrap()
        .starts_with("cmd_"));

    manager
        .handle_send(send_frame(
            "sess-run",
            "req-false",
            "false",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "send result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-false")
    })
    .await;
    let data = result
        .get("outcome")
        .and_then(|outcome| outcome.get("data"))
        .expect("outcome data");
    assert_eq!(data.get("exit_code").and_then(Value::as_i64), Some(1));

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-run".into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn observe_screen_contains_echoed_output_and_resize_reports_geometry() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-observe", None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;

    manager
        .handle_send(send_frame(
            "sess-observe",
            "req-echo",
            "echo bud_observe_marker",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "send result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-echo")
    })
    .await;

    manager
        .handle_observe(observe_frame("sess-observe", "req-screen", "screen"))
        .await
        .unwrap();
    let observed = wait_frame(
        &mut rx,
        Duration::from_secs(10),
        "observe result",
        |frame| {
            is_type(frame, "terminal_observe_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-screen")
        },
    )
    .await;
    let text = decoded_output(&observed);
    assert!(
        text.contains("bud_observe_marker"),
        "screen should contain echoed output, got: {text:?}"
    );
    assert!(observed.get("mode").and_then(Value::as_str).is_some());
    assert_eq!(
        observed.get("alt_screen").and_then(Value::as_bool),
        Some(false)
    );
    assert!(observed.get("error").unwrap().is_null());

    // Resize reports the new geometry via terminal_status.
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: "sess-observe".into(),
            cols: 100,
            rows: 30,
        })
        .await
        .unwrap();
    let status = wait_frame(&mut rx, Duration::from_secs(10), "resize status", |frame| {
        is_status(frame, "ready")
            && frame
                .get("info")
                .and_then(|info| info.get("cols"))
                .and_then(Value::as_u64)
                == Some(100)
    })
    .await;
    assert_eq!(
        status
            .get("info")
            .and_then(|info| info.get("rows"))
            .and_then(Value::as_u64),
        Some(30)
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-observe".into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn close_kills_holder_and_reports_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-close", None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-close".into(),
            reason: Some("test".into()),
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "closed status", |frame| {
        is_status(frame, "closed")
    })
    .await;

    let registry = stem::registry::Registry::new(tmp.path().join("term")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while registry.session_alive("sess-close").await {
        assert!(
            Instant::now() < deadline,
            "holder still alive after terminal_close"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn reattach_with_resume_offset_is_gap_free_and_duplicate_free() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-resume", None))
        .await
        .unwrap();
    manager
        .handle_send(send_frame(
            "sess-resume",
            "req-fill",
            "echo resume_fill_marker",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();

    // Track the committed offset (highest output end offset) across every
    // frame until the send result plus a settle window.
    let mut committed = 0u64;
    let track = |frame: &Value, committed: &mut u64| {
        if is_type(frame, "terminal_output") {
            let offset = frame.get("byte_offset").and_then(Value::as_u64).unwrap();
            let len = BASE64_STANDARD
                .decode(frame.get("data").and_then(Value::as_str).unwrap())
                .unwrap()
                .len() as u64;
            *committed = (*committed).max(offset + len);
        }
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .expect("timed out waiting for send result");
        let message = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out waiting for send result")
            .expect("channel closed");
        if let Some(frame) = parse(message) {
            track(&frame, &mut committed);
            if is_type(&frame, "terminal_send_result") {
                break;
            }
        }
    }
    for frame in collect_frames(&mut rx, Duration::from_millis(500)).await {
        track(&frame, &mut committed);
    }
    assert!(committed > 0, "expected output before reattach");

    // Simulate transport loss: attachments dropped, holder survives.
    manager.clear_sender().await;
    let (tx, mut rx2) = mpsc::unbounded_channel::<Message>();
    manager
        .set_sender(TransportSender::websocket(tx, false))
        .await;

    manager
        .handle_ensure(ensure_frame("sess-resume", Some(committed)))
        .await
        .unwrap();
    wait_frame(&mut rx2, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;

    let frames = collect_frames(&mut rx2, Duration::from_secs(1)).await;
    for frame in &frames {
        if is_type(frame, "terminal_output") {
            let offset = frame.get("byte_offset").and_then(Value::as_u64).unwrap();
            assert!(
                offset >= committed,
                "duplicate output below committed offset {committed}: frame at {offset}"
            );
        }
        assert!(
            !(is_type(frame, "terminal_event")
                && frame.get("event").and_then(Value::as_str) == Some("output_gap")),
            "unexpected output_gap on in-ring resume"
        );
    }

    // The session still works after reattach.
    manager
        .handle_send(send_frame(
            "sess-resume",
            "req-after",
            "echo after_reattach",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx2, Duration::from_secs(15), "send result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-after")
    })
    .await;
    assert_eq!(
        result
            .get("outcome")
            .and_then(|o| o.get("data"))
            .and_then(|d| d.get("exit_code"))
            .and_then(Value::as_i64),
        Some(0)
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-resume".into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn slow_awaited_send_does_not_block_other_sessions() {
    // Required regression for review finding D-H1: a send awaiting a slow
    // command on session A must not delay a concurrent observe on session B.
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-slow", None))
        .await
        .unwrap();
    manager
        .handle_ensure(ensure_frame("sess-fast", None))
        .await
        .unwrap();
    // Both sessions ready.
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
            && frame.get("session_id").and_then(Value::as_str) == Some("sess-slow")
    })
    .await;
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
            && frame.get("session_id").and_then(Value::as_str) == Some("sess-fast")
    })
    .await;

    let slow_manager = manager.clone();
    let slow = tokio::spawn(async move {
        slow_manager
            .handle_send(send_frame(
                "sess-slow",
                "req-slow",
                "sleep 3",
                Some(TerminalSendAwait::Command),
            ))
            .await
            .unwrap();
    });

    // Give the slow dispatch a moment to be in-flight, then observe B.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let observe_started = Instant::now();
    manager
        .handle_observe(observe_frame("sess-fast", "req-fast", "screen"))
        .await
        .unwrap();
    let observed = wait_frame(
        &mut rx,
        Duration::from_secs(10),
        "observe result",
        |frame| {
            is_type(frame, "terminal_observe_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-fast")
        },
    )
    .await;
    let elapsed = observe_started.elapsed();
    assert!(observed.get("error").unwrap().is_null());
    assert!(
        elapsed < Duration::from_secs(2),
        "observe on another session was delayed by a slow awaited send: {elapsed:?}"
    );

    // The slow send still completes with its real outcome.
    let result = wait_frame(
        &mut rx,
        Duration::from_secs(20),
        "slow send result",
        |frame| {
            is_type(frame, "terminal_send_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-slow")
        },
    )
    .await;
    assert_eq!(
        result
            .get("outcome")
            .and_then(|o| o.get("data"))
            .and_then(|d| d.get("exit_code"))
            .and_then(Value::as_i64),
        Some(0)
    );
    slow.await.unwrap();

    for session_id in ["sess-slow", "sess-fast"] {
        manager
            .handle_close(TerminalCloseFrame {
                envelope: envelope("terminal_close"),
                session_id: session_id.into(),
                reason: None,
            })
            .await
            .unwrap();
    }
}

async fn shell_integration_markers_flow(shell: &str, session_id: &str) {
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();

    // The shim's precmd must produce OSC 133 evidence: a prompt_ready event
    // or an osc133 mode upgrade.
    wait_frame(
        &mut rx,
        Duration::from_secs(15),
        "osc133 integration evidence",
        |frame| {
            (is_type(frame, "terminal_event")
                && frame.get("event").and_then(Value::as_str) == Some("prompt_ready"))
                || (is_type(frame, "terminal_event")
                    && frame.get("event").and_then(Value::as_str) == Some("mode_changed")
                    && frame
                        .get("data")
                        .and_then(|d| d.get("integration"))
                        .and_then(Value::as_str)
                        == Some("osc133"))
        },
    )
    .await;

    // A real command runs through the marker lifecycle with a real exit code
    // (no sentinel wrap once integration is osc133).
    manager
        .handle_send(send_frame(
            session_id,
            "req-marker",
            "false",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "send result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-marker")
    })
    .await;
    assert_eq!(
        result
            .get("outcome")
            .and_then(|o| o.get("data"))
            .and_then(|d| d.get("exit_code"))
            .and_then(Value::as_i64),
        Some(1)
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn zsh_shim_emits_osc133_markers() {
    shell_integration_markers_flow("/bin/zsh", "sess-zsh").await;
}

#[tokio::test]
async fn bash_shim_emits_osc133_markers() {
    shell_integration_markers_flow("/bin/bash", "sess-bash").await;
}

#[tokio::test]
async fn command_await_into_open_program_is_delivered_after_it_yields() {
    // Unified send: nothing is refused while a command is open. A run-style
    // send (text+submit) arriving during `sleep 2` waits at the input gate
    // (sleep never paints) until the program yields, then the line lands
    // at the prompt and executes like any command.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-busy-guard";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |frame| {
        is_type(frame, "terminal_event")
            && frame.get("event").and_then(Value::as_str) == Some("prompt_ready")
    })
    .await;
    manager
        .handle_send(send_frame(session_id, "req-long", "sleep 2", None))
        .await
        .unwrap();
    wait_frame(
        &mut rx,
        Duration::from_secs(15),
        "command started",
        |frame| {
            is_type(frame, "terminal_event")
                && frame.get("event").and_then(Value::as_str) == Some("command_started")
        },
    )
    .await;

    let (result, elapsed) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-after",
        "echo after-marker",
    )
    .await;
    assert!(result["error"].is_null(), "{result}");
    assert_eq!(result["dispatched"], true, "{result}");
    // Gated until sleep yielded (~2 s), never typed into it.
    assert!(result["gated_ms"].as_u64().unwrap_or(0) >= 500, "{result}");
    assert!(elapsed >= Duration::from_millis(500), "{elapsed:?}");
    let screen = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        screen.contains("after-marker"),
        "line not executed after the program yielded:\n{screen}"
    );
}

#[tokio::test]
async fn settled_await_resolves_on_prompt_return() {
    // A send that carries the terminal back to a shell prompt (e.g. `/quit`
    // exiting an inline TUI) must resolve its settled-await on prompt_ready —
    // an idle prompt never emits `settled` by design, so this transition
    // previously rode the full service timeout budget.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-settle-prompt";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |frame| {
        is_type(frame, "terminal_event")
            && frame.get("event").and_then(Value::as_str) == Some("prompt_ready")
    })
    .await;

    // A settled-await whose gesture ends back at the prompt.
    manager
        .handle_send(send_frame(
            session_id,
            "req-settle",
            "true",
            Some(TerminalSendAwait::Settled),
        ))
        .await
        .unwrap();
    let result = wait_frame(
        &mut rx,
        Duration::from_secs(10),
        "settled result",
        |frame| {
            is_type(frame, "terminal_send_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-settle")
        },
    )
    .await;
    let outcome = result.get("outcome").cloned().unwrap_or(Value::Null);
    let outcome_event = outcome.get("event").and_then(Value::as_str);
    // A shell command sent via settled-await resolves on its completion (the
    // richest transition — send/run substitutability for weaker models);
    // prompt_ready/settled remain valid for gestures with no command
    // lifecycle.
    assert!(
        matches!(
            outcome_event,
            Some("command_finished") | Some("prompt_ready") | Some("settled")
        ),
        "settled await must resolve promptly at the prompt: {result:?}"
    );
    if outcome_event == Some("command_finished") {
        assert_eq!(
            outcome
                .get("data")
                .and_then(|d| d.get("exit_code"))
                .and_then(Value::as_i64),
            Some(0),
            "exit code must ride along: {result:?}"
        );
    }

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

/// All dirty-row run text of a `terminal_grid` frame, concatenated.
fn grid_frame_text(frame: &Value) -> String {
    frame["dirty_rows"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|row| row["runs"].as_array().into_iter().flatten())
        .filter_map(|run| run["t"].as_str())
        .collect()
}

#[tokio::test]
async fn grid_watch_streams_full_then_deltas_and_stops_on_unwatch() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-grid";
    manager
        .handle_ensure(ensure_frame(session_id, None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "ready status", |frame| {
        is_status(frame, "ready")
    })
    .await;

    let watch = |enabled: bool| TerminalGridWatchFrame {
        envelope: envelope("terminal_grid_watch"),
        session_id: session_id.to_string(),
        enabled,
    };

    // Enable: an immediate full frame with the session's geometry.
    manager.handle_grid_watch(watch(true)).await.unwrap();
    let full = wait_frame(&mut rx, Duration::from_secs(10), "full grid frame", |f| {
        is_type(f, "terminal_grid")
    })
    .await;
    assert_eq!(full["full"], true);
    assert_eq!(full["cols"], 80);
    assert_eq!(full["rows"], 24);
    assert_eq!(full["proto"], "0.3");
    assert!(full["generation"].as_u64().unwrap() >= 1);
    assert_eq!(full["dirty_rows"].as_array().unwrap().len(), 24);

    // New output shows up in a subsequent frame's dirty rows.
    manager
        .handle_send(send_frame(
            session_id,
            "req-grid-echo",
            "echo grid_sync_marker",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let mut seen_marker = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last_generation = full["generation"].as_u64().unwrap();
    while !seen_marker {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .expect("timed out waiting for marker grid frame");
        let message = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out waiting for marker grid frame")
            .expect("channel closed");
        if let Some(frame) = parse(message) {
            if is_type(&frame, "terminal_grid") {
                let generation = frame["generation"].as_u64().unwrap();
                assert!(generation > last_generation, "generation must be monotonic");
                last_generation = generation;
                if grid_frame_text(&frame).contains("grid_sync_marker") {
                    seen_marker = true;
                }
            }
        }
    }

    // Disable: no grid frames for further activity.
    manager.handle_grid_watch(watch(false)).await.unwrap();
    // Drain anything already in flight before asserting silence.
    collect_frames(&mut rx, Duration::from_millis(300)).await;
    manager
        .handle_send(send_frame(
            session_id,
            "req-grid-quiet",
            "echo after_unwatch",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_millis(800)).await;
    assert!(
        !frames.iter().any(|f| is_type(f, "terminal_grid")),
        "grid frames must stop after unwatch"
    );

    // Re-enable: a fresh full frame (re-arm semantics).
    manager.handle_grid_watch(watch(true)).await.unwrap();
    let rearmed = wait_frame(&mut rx, Duration::from_secs(10), "re-armed full", |f| {
        is_type(f, "terminal_grid")
    })
    .await;
    assert_eq!(rearmed["full"], true);
    assert!(grid_frame_text(&rearmed).contains("after_unwatch"));

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn grid_frames_carry_predict_gate_and_applied_input_seq() {
    // Predictive echo substrate (§6.8.3): frames carry predict_ok (mode +
    // alt-screen + live termios ECHO/ICANON) and applied_input_seq (highest
    // client input_seq written to the PTY). `stty -echo` must close the gate
    // even though it paints nothing (forced emission on gate flips).
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-predict";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |frame| {
        is_type(frame, "terminal_event")
            && frame.get("event").and_then(Value::as_str) == Some("prompt_ready")
    })
    .await;

    manager
        .handle_grid_watch(TerminalGridWatchFrame {
            envelope: envelope("terminal_grid_watch"),
            session_id: session_id.to_string(),
            enabled: true,
        })
        .await
        .unwrap();
    let full = wait_frame(&mut rx, Duration::from_secs(10), "full grid frame", |f| {
        is_type(f, "terminal_grid")
    })
    .await;
    assert_eq!(
        full["predict_ok"], true,
        "integrated shell at prompt must open the predict gate: {full}"
    );

    // Sequenced raw input: the echo damage frame must carry the ack.
    manager
        .handle_input(bud::protocol::TerminalInputFrame {
            envelope: envelope("terminal_input"),
            session_id: session_id.to_string(),
            data: BASE64_STANDARD.encode(b"x"),
            input_seq: Some(7),
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "seq-acked frame", |f| {
        is_type(f, "terminal_grid") && f["applied_input_seq"].as_u64() == Some(7)
    })
    .await;

    // A foreground command closes the gate for its whole run (this is what
    // covers sudo/read -s/inline raw TUIs — anything a prediction could type
    // into blindly), and prompt return reopens it. Clear the pending 'x'
    // first (ctrl+u), then run a short sleep.
    manager
        .handle_input(bud::protocol::TerminalInputFrame {
            envelope: envelope("terminal_input"),
            session_id: session_id.to_string(),
            data: BASE64_STANDARD.encode(b"\x15sleep 2\r"),
            input_seq: Some(8),
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "gate closed", |f| {
        is_type(f, "terminal_grid") && f["predict_ok"] == false
    })
    .await;
    let reopened = wait_frame(&mut rx, Duration::from_secs(15), "gate reopened", |f| {
        is_type(f, "terminal_grid") && f["predict_ok"] == true
    })
    .await;
    assert!(reopened["applied_input_seq"].as_u64() >= Some(8));

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn command_await_resolves_early_when_command_turns_interactive() {
    // `terminal.run codex`: the command never finishes on its own. A
    // mid-command bracketed-paste enable (or alt-screen entry) is crisp
    // evidence the child is interactive — the command-await must resolve
    // with `interactive_started` instead of riding the timeout budget.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-interactive";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |frame| {
        is_type(frame, "terminal_event")
            && frame.get("event").and_then(Value::as_str) == Some("prompt_ready")
    })
    .await;

    // An inline-TUI stand-in: enables bracketed paste, then sits interactive.
    manager
        .handle_send(send_frame(
            session_id,
            "req-tui-launch",
            "printf '\\033[?2004h'; sleep 300",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(
        &mut rx,
        Duration::from_secs(10),
        "interactive result",
        |frame| {
            is_type(frame, "terminal_send_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-tui-launch")
        },
    )
    .await;
    let outcome = result.get("outcome").cloned().unwrap_or(Value::Null);
    assert_eq!(
        outcome.get("event").and_then(Value::as_str),
        Some("interactive_started"),
        "expected early interactive resolution: {result:?}"
    );
    assert_eq!(
        outcome
            .get("data")
            .and_then(|d| d.get("signal"))
            .and_then(Value::as_str),
        Some("bracketed_paste")
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn awaited_observe_resolves_immediately_when_already_quiet() {
    // terminal.wait on a terminal that is already settled must not hang until
    // the NEXT quiet point (which may never come at an idle prompt): the
    // daemon checks `Session::is_quiet` after subscribing and resolves with
    // `outcome.data.immediate: true`.
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    manager
        .handle_ensure(ensure_frame("sess-wait-idle", None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "ready", |f| {
        is_status(f, "ready")
    })
    .await;
    manager
        .handle_send(send_frame(
            "sess-wait-idle",
            "req-echo",
            "echo wait_idle_marker",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "echo result", |f| {
        is_result_for(f, "terminal_send_result", "req-echo")
    })
    .await;
    // Let the post-command quiet point pass, then set the observe baseline —
    // the knobless wait treats quiet UNSEEN content as an immediate stall, so
    // "immediately settled" requires having looked first (as the agent
    // always has: send proof / prior observe).
    tokio::time::sleep(Duration::from_millis(600)).await;
    manager
        .handle_observe(observe_frame("sess-wait-idle", "req-baseline", "screen"))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "baseline observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-baseline")
    })
    .await;

    let started = Instant::now();
    awaited_observe(
        &manager,
        awaited_observe_frame(
            "sess-wait-idle",
            "req-wait",
            TerminalSendAwait::Settled,
            None,
        ),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(10), "awaited observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait")
    })
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "already-quiet wait must resolve promptly, took {:?}",
        started.elapsed()
    );
    let outcome = result
        .get("outcome")
        .expect("awaited observe carries outcome");
    assert_eq!(
        outcome.get("event").and_then(Value::as_str),
        Some("settled")
    );
    assert_eq!(
        outcome.pointer("/data/immediate").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(result.get("view").and_then(Value::as_str), Some("delta"));
    assert!(result.get("mode").and_then(Value::as_str).is_some());

    // `await:"command"` is a synonym of the knobless wait now: same result.
    awaited_observe(
        &manager,
        awaited_observe_frame(
            "sess-wait-idle",
            "req-wait-cmd",
            TerminalSendAwait::Command,
            None,
        ),
    )
    .await
    .unwrap();
    let result = wait_frame(
        &mut rx,
        Duration::from_secs(10),
        "awaited observe (command)",
        |f| is_result_for(f, "terminal_observe_result", "req-wait-cmd"),
    )
    .await;
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("settled")
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: "sess-wait-idle".into(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn awaited_observe_resolves_on_the_open_commands_finish() {
    // terminal.wait until:"command_finished" while a command is open: the
    // observe blocks (lock-free) and snapshots AFTER the command finishes.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-wait-cmd";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;

    manager
        .handle_send(send_frame(
            session_id,
            "req-long",
            "sleep 1; echo wait_cmd_done",
            None,
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "command started", |f| {
        is_event(f, "command_started")
    })
    .await;

    let started = Instant::now();
    // Stall window raised above the command duration: the exact boundary
    // must win the race even though the command echo settles early. The
    // baseline is unseen here, so a quiet start would stall immediately —
    // the send dispatch keeps the session un-quiet long enough that the
    // race is entered; raise the window and let command_finished win.
    awaited_observe(
        &manager,
        awaited_observe_frame(
            session_id,
            "req-wait",
            TerminalSendAwait::Command,
            Some(10_000),
        ),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "awaited observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait")
    })
    .await;
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "must have actually waited for the sleep, took {:?}",
        started.elapsed()
    );
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("command_finished"),
        "{result:?}"
    );
    assert!(result.pointer("/outcome/data/command_id").is_some());
    assert!(
        decoded_output(&result).contains("wait_cmd_done"),
        "snapshot is taken after the fact: {:?}",
        decoded_output(&result)
    );

    // The wait's own snapshot updated the observe baseline, so an immediate
    // re-wait on the idle prompt resolves `settled` right away (idle, seen).
    let started = Instant::now();
    awaited_observe(
        &manager,
        awaited_observe_frame(
            session_id,
            "req-wait-quiet",
            TerminalSendAwait::Settled,
            Some(800),
        ),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "idle re-wait", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait-quiet")
    })
    .await;
    // Timing-dependent but both correct: `settled` when the first wait's
    // snapshot already covered the returned prompt, `stalled` when the
    // prompt painted after that snapshot (quiet + unseen content). The
    // contract is: resolve promptly, never hang.
    let outcome = result.pointer("/outcome/event").and_then(Value::as_str);
    assert!(
        outcome == Some("settled") || outcome == Some("stalled"),
        "idle re-wait resolves settled or stalled, got {outcome:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(5));

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn command_await_reports_input_absorbed_when_nothing_starts() {
    // On a genuinely OSC 133-integrated shell a submitted command-await
    // expects a `command_started`. A fresh prompt / quiet point with none
    // means the text did not run as a shell command (here: a whitespace-only
    // line the shell simply re-prompts on). The await must resolve with
    // `input_absorbed` instead of waiting for a `command_finished` that can
    // never arrive — the backstop behind the busy guard for the codex shape.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-absorbed";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
    // Establish genuine markers with one real command first.
    manager
        .handle_send(send_frame(
            session_id,
            "req-real",
            "true",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let real = wait_frame(&mut rx, Duration::from_secs(15), "real result", |f| {
        is_result_for(f, "terminal_send_result", "req-real")
    })
    .await;
    assert_eq!(
        real.pointer("/outcome/event").and_then(Value::as_str),
        Some("command_finished")
    );

    let started = Instant::now();
    manager
        .handle_send(send_frame(
            session_id,
            "req-blank",
            "   ",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "absorbed result", |f| {
        is_result_for(f, "terminal_send_result", "req-blank")
    })
    .await;
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("input_absorbed"),
        "{result:?}"
    );
    assert!(result
        .pointer("/outcome/data/signal")
        .and_then(Value::as_str)
        .is_some());
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "resolved within the grace, took {:?}",
        started.elapsed()
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn awaited_observe_stalls_when_mid_command_activity_goes_quiet() {
    // The codex-question shape: a command is open (inline TUI), the caller
    // has seen the current screen, and NEW output paints during the wait and
    // then stops changing. The knobless wait must return control with a
    // `stalled` outcome after the stall window — not hold for a
    // command_finished that may be minutes away.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present on this machine");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-stall";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;

    // Open a long command that paints a "question" after a beat and then
    // waits silently for input (never finishing on its own).
    manager
        .handle_send(send_frame(
            session_id,
            "req-open",
            "sleep 2; printf 'Continue? [y/n] '; read answer",
            None,
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "command started", |f| {
        is_event(f, "command_started")
    })
    .await;
    // Let the command-echo settle, then set the baseline: the caller has
    // seen everything up to the silent stretch (the send-proof shape).
    tokio::time::sleep(Duration::from_millis(600)).await;
    // Baseline: the caller has seen the screen as of command start.
    manager
        .handle_observe(observe_frame(session_id, "req-baseline", "screen"))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "baseline observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-baseline")
    })
    .await;

    let started = Instant::now();
    awaited_observe(
        &manager,
        awaited_observe_frame(
            session_id,
            "req-wait",
            TerminalSendAwait::Settled,
            Some(1000),
        ),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "stalled wait", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait")
    })
    .await;
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("stalled"),
        "{result:?}"
    );
    assert_eq!(
        result
            .pointer("/outcome/data/quiet_ms")
            .and_then(Value::as_u64),
        Some(1000)
    );
    // Waited through the sleep + paint + stall window, not the full budget.
    assert!(started.elapsed() >= Duration::from_millis(1500));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert!(
        decoded_output(&result).contains("Continue?"),
        "the stalled snapshot carries the question: {:?}",
        decoded_output(&result)
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn grid_watch_never_ships_history_as_scrollback_push() {
    // Regression for the mobile cumulative-scrollback report
    // (debug/terminal-grid-cumulative-scrollback.md): a fresh watch after
    // seeded history must start scrollback-clean (the snapshot covers it),
    // and resize cycles / input must push only genuinely scrolled rows.
    let shell = "/bin/zsh";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-push-diag";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;

    // Match the mobile geometry.
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 22,
        })
        .await
        .unwrap();
    // Seed ~600 history lines.
    manager
        .handle_send(send_frame(
            session_id,
            "req-seed",
            "for i in {1..600}; do echo hist-$i; done",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(20), "seed done", |f| {
        is_result_for(f, "terminal_send_result", "req-seed")
    })
    .await;

    let watch = TerminalGridWatchFrame {
        envelope: envelope("terminal_grid_watch"),
        session_id: session_id.to_string(),
        enabled: true,
    };
    manager.handle_grid_watch(watch).await.unwrap();

    let push_total = |frames: &[Value]| -> usize {
        frames
            .iter()
            .filter(|f| is_type(f, "terminal_grid"))
            .map(|f| {
                f["scrollback_push"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0)
            })
            .sum()
    };
    let dropped_total = |frames: &[Value]| -> u64 {
        frames
            .iter()
            .filter(|f| is_type(f, "terminal_grid"))
            .map(|f| f["scrollback_dropped"].as_u64().unwrap_or(0))
            .sum()
    };

    let frames = collect_frames(&mut rx, Duration::from_millis(1500)).await;
    let first = frames
        .iter()
        .find(|f| is_type(f, "terminal_grid"))
        .expect("watch produces a first frame");
    assert_eq!(first["full"], true);
    // THE bug: this used to be the entire seeded history (581 rows).
    assert_eq!(
        first["scrollback_push"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0),
        0,
        "fresh watch must not ship history as scrollback_push: {first:?}"
    );
    assert_eq!(first["scrollback_dropped"], 0);
    assert_eq!(
        push_total(&frames),
        0,
        "no pushes without new scrolling output"
    );

    // grow 22 -> 39 (keyboard hidden / measured geometry)
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 39,
        })
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_millis(2500)).await;
    assert_eq!(push_total(&frames), 0, "grow resize must not push history");
    assert_eq!(dropped_total(&frames), 0);

    // shrink 39 -> 22 (keyboard shown)
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 22,
        })
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_millis(2500)).await;
    assert_eq!(
        push_total(&frames),
        0,
        "shrink resize must not push history"
    );
    assert_eq!(dropped_total(&frames), 0);

    // Enter keypress (submit input)
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-enter".to_string(),
            text: None,
            submit: Some(false),
            key: Some("enter".to_string()),
            r#await: None,
        })
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_millis(2000)).await;
    // Enter at a zsh prompt scrolls at most a couple of rows.
    assert!(
        push_total(&frames) <= 4,
        "input must push only genuinely scrolled rows, got {}",
        push_total(&frames)
    );

    // Re-arm (watch enable while live) keeps the loop and its baseline:
    // an in-place force-full frame, generation continuous, no history dump.
    let last_gen = frames
        .iter()
        .rev()
        .chain(std::iter::empty())
        .filter(|f| is_type(f, "terminal_grid"))
        .filter_map(|f| f["generation"].as_u64())
        .next()
        .unwrap_or(1);
    manager
        .handle_grid_watch(TerminalGridWatchFrame {
            envelope: envelope("terminal_grid_watch"),
            session_id: session_id.to_string(),
            enabled: true,
        })
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_millis(1500)).await;
    let rearmed = frames
        .iter()
        .find(|f| is_type(f, "terminal_grid"))
        .expect("re-arm produces a full frame");
    assert_eq!(rearmed["full"], true);
    assert!(
        rearmed["generation"].as_u64().unwrap() > last_gen,
        "generation continuous"
    );
    assert_eq!(
        rearmed["scrollback_push"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0),
        0,
        "re-arm must not dump history either"
    );

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn grid_watch_saturated_history_and_resize_races_stay_incremental() {
    // Companion regression: saturated emulator history (5000-line cap) and
    // resize storms racing live output never produce cumulative pushes.
    let shell = "/bin/zsh";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-push-sat";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 22,
        })
        .await
        .unwrap();
    // Saturate the 5000-line emulator history.
    manager
        .handle_send(send_frame(
            session_id,
            "req-sat",
            "for i in {1..5300}; do echo sat-$i; done",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(60), "sat done", |f| {
        is_result_for(f, "terminal_send_result", "req-sat")
    })
    .await;

    let watch = TerminalGridWatchFrame {
        envelope: envelope("terminal_grid_watch"),
        session_id: session_id.to_string(),
        enabled: true,
    };
    manager.handle_grid_watch(watch).await.unwrap();
    let push_total = |frames: &[Value]| -> usize {
        frames
            .iter()
            .filter(|f| is_type(f, "terminal_grid"))
            .map(|f| {
                f["scrollback_push"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0)
            })
            .sum()
    };
    let frames = collect_frames(&mut rx, Duration::from_millis(1500)).await;
    assert_eq!(
        push_total(&frames),
        0,
        "fresh watch on saturated history must not ship pushes"
    );

    for (c, r, label) in [(48u16, 39u16, "sat-grow"), (48, 22, "sat-shrink")] {
        manager
            .handle_resize(TerminalResizeFrame {
                envelope: envelope("terminal_resize"),
                session_id: session_id.to_string(),
                cols: c,
                rows: r,
            })
            .await
            .unwrap();
        let frames = collect_frames(&mut rx, Duration::from_millis(2000)).await;
        assert_eq!(
            push_total(&frames),
            0,
            "{label}: resize must not push history"
        );
    }

    // Variant C: output racing resizes.
    manager
        .handle_send(send_frame(
            session_id,
            "req-race",
            "for i in {1..800}; do echo race-$i; sleep 0.002; done",
            None,
        ))
        .await
        .unwrap();
    for (c, r) in [(48u16, 39u16), (48, 22), (48, 39), (48, 22)] {
        tokio::time::sleep(Duration::from_millis(350)).await;
        manager
            .handle_resize(TerminalResizeFrame {
                envelope: envelope("terminal_resize"),
                session_id: session_id.to_string(),
                cols: c,
                rows: r,
            })
            .await
            .unwrap();
    }
    let frames = collect_frames(&mut rx, Duration::from_secs(6)).await;
    let total_push = push_total(&frames);
    let total_dropped: u64 = frames
        .iter()
        .filter(|f| is_type(f, "terminal_grid"))
        .map(|f| f["scrollback_dropped"].as_u64().unwrap_or(0))
        .sum();
    // 800 output lines scroll ~800 rows; cumulative duplication would be
    // thousands. Allow slack for prompt/redraw scrolls, require the total to
    // stay in the incremental ballpark and the seam counter quiet.
    assert!(
        (700..=900).contains(&total_push),
        "racing pushes must stay incremental, got {total_push}"
    );
    assert_eq!(total_dropped, 0);

    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn restart_reattach_mid_tui_never_pushes_replayed_history() {
    // Mobile follow-up (v0.1.11 still reproduced): daemon restart (upgrade)
    // with a TUI open, sessions reattach from the ring — the replay ends
    // inside the alt screen, and pre-fix the first alt-exit shipped the
    // ENTIRE replayed history (588 rows here) as scrollback_push. The
    // replayed history predates the attachment and is snapshot-covered:
    // no phase below may push it.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-restart-tui";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 22,
        })
        .await
        .unwrap();
    // Seed history + a file for the pager.
    manager
        .handle_send(send_frame(
            session_id,
            "req-seed",
            "for i in {1..600}; do echo hist-$i; done; seq 1 500 > lessfile",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(30), "seed done", |f| {
        is_result_for(f, "terminal_send_result", "req-seed")
    })
    .await;
    // Open an alt-screen TUI and leave it open.
    manager
        .handle_send(send_frame(session_id, "req-less", "less lessfile", None))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // ---- simulate the daemon restart: drop the manager, build a new one ----
    drop(rx);
    drop(manager);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (manager2, mut rx) = manager_with_sender(&tmp).await;
    manager2
        .handle_ensure(ensure_frame(session_id, None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "reattach ready", |f| {
        is_status(f, "ready")
    })
    .await;

    manager2
        .handle_grid_watch(TerminalGridWatchFrame {
            envelope: envelope("terminal_grid_watch"),
            session_id: session_id.to_string(),
            enabled: true,
        })
        .await
        .unwrap();
    let dump = |label: &str, frames: &[Value]| {
        for f in frames {
            if is_type(f, "terminal_grid") {
                let p = f["scrollback_push"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);
                eprintln!(
                    "[{label}] gen={} full={} push={} dropped={} alt={} rows={}",
                    f["generation"],
                    f["full"],
                    p,
                    f["scrollback_dropped"],
                    f["alt_screen"],
                    f["rows"],
                );
            }
        }
    };
    let push_total = |frames: &[Value]| -> usize {
        frames
            .iter()
            .filter(|f| is_type(f, "terminal_grid"))
            .map(|f| {
                f["scrollback_push"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0)
            })
            .sum()
    };
    let frames = collect_frames(&mut rx, Duration::from_millis(1500)).await;
    dump("watch-after-restart", &frames);
    assert_eq!(
        push_total(&frames),
        0,
        "fresh watch after restart pushes nothing"
    );

    // Mobile keystrokes into the TUI (scroll down/up in less).
    for (i, key) in [b"j", b"j", b"k", b"j"].iter().enumerate() {
        manager2
            .handle_input(TerminalInputFrame {
                envelope: envelope("terminal_input"),
                session_id: session_id.to_string(),
                data: BASE64_STANDARD.encode(key),
                input_seq: Some(i as u64 + 1),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let frames = collect_frames(&mut rx, Duration::from_millis(1500)).await;
    dump("after-keys", &frames);
    assert_eq!(push_total(&frames), 0, "alt-screen keystrokes push nothing");

    // Exit the TUI (alt-screen leave) — the alt-exit accounting moment.
    manager2
        .handle_input(TerminalInputFrame {
            envelope: envelope("terminal_input"),
            session_id: session_id.to_string(),
            data: BASE64_STANDARD.encode(b"q"),
            input_seq: Some(99),
        })
        .await
        .unwrap();
    let frames = collect_frames(&mut rx, Duration::from_secs(3)).await;
    dump("after-quit", &frames);
    // THE regression: pre-fix this was push=588 (whole replayed history).
    assert_eq!(
        push_total(&frames),
        0,
        "alt exit after restart-reattach must not push replayed history"
    );

    // Anchor must be healthy afterwards: new output pushes incrementally.
    manager2
        .handle_send(send_frame(
            session_id,
            "req-fresh",
            "for i in {1..30}; do echo fresh-$i; done",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "fresh done", |f| {
        is_result_for(f, "terminal_send_result", "req-fresh")
    })
    .await;
    let frames = collect_frames(&mut rx, Duration::from_millis(1200)).await;
    let fresh_pushes = push_total(&frames);
    assert!(
        (20..=45).contains(&fresh_pushes),
        "post-exit pushes stay incremental and alive, got {fresh_pushes}"
    );

    manager2
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn restart_reattach_primary_input_stays_scrollback_clean() {
    // v0.1.12 mobile retest shape: history at a PRIMARY prompt (no TUI),
    // daemon restart, reattach, geometry convergence, then printable input.
    let shell = "/bin/bash";
    if !std::path::Path::new(shell).exists() {
        eprintln!("skipping: {shell} not present");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let session_id = "sess-restart-primary";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
    manager
        .handle_resize(TerminalResizeFrame {
            envelope: envelope("terminal_resize"),
            session_id: session_id.to_string(),
            cols: 48,
            rows: 38,
        })
        .await
        .unwrap();
    manager
        .handle_send(send_frame(
            session_id,
            "req-seed",
            "for i in {1..1000}; do echo hist-$i; done",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(30), "seed done", |f| {
        is_result_for(f, "terminal_send_result", "req-seed")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;

    // ---- daemon restart ----
    drop(rx);
    drop(manager);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (manager2, mut rx) = manager_with_sender(&tmp).await;
    manager2
        .handle_ensure(ensure_frame(session_id, None))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "reattach ready", |f| {
        is_status(f, "ready")
    })
    .await;

    manager2
        .handle_grid_watch(TerminalGridWatchFrame {
            envelope: envelope("terminal_grid_watch"),
            session_id: session_id.to_string(),
            enabled: true,
        })
        .await
        .unwrap();
    // Regression contract (mobile v0.1.12 input-path report): after a
    // restart+reattach at a PRIMARY prompt, no frame across attach, resize
    // convergence, ready re-arms, or printable input may ship replayed
    // history as `scrollback_push` (the inputs never scroll a line).
    let assert_clean = |label: &str, frames: &[Value]| {
        for f in frames {
            if is_type(f, "terminal_grid") {
                let p = f["scrollback_push"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);
                eprintln!(
                    "[{label}] gen={} full={} push={} dropped={} alt={} rows={}",
                    f["generation"],
                    f["full"],
                    p,
                    f["scrollback_dropped"],
                    f["alt_screen"],
                    f["rows"],
                );
                assert_eq!(p, 0, "[{label}] frame shipped scrollback_push rows");
                assert_eq!(
                    f["scrollback_dropped"].as_u64().unwrap_or(0),
                    0,
                    "[{label}] frame reported dropped scrollback"
                );
                assert_eq!(
                    f["alt_screen"].as_bool(),
                    Some(false),
                    "[{label}] unexpected alt screen"
                );
            }
        }
    };
    let frames = collect_frames(&mut rx, Duration::from_millis(1200)).await;
    assert_clean("watch", &frames);

    // Geometry convergence with ready-driven re-arms like production.
    for rows in [38u16, 20, 20] {
        manager2
            .handle_resize(TerminalResizeFrame {
                envelope: envelope("terminal_resize"),
                session_id: session_id.to_string(),
                cols: 48,
                rows,
            })
            .await
            .unwrap();
        manager2
            .handle_grid_watch(TerminalGridWatchFrame {
                envelope: envelope("terminal_grid_watch"),
                session_id: session_id.to_string(),
                enabled: true,
            })
            .await
            .unwrap();
        let frames = collect_frames(&mut rx, Duration::from_millis(900)).await;
        assert_clean("resize-rearm", &frames);
    }

    // Two separately posted printable characters.
    for (i, ch) in [b"a", b"b"].iter().enumerate() {
        manager2
            .handle_input(TerminalInputFrame {
                envelope: envelope("terminal_input"),
                session_id: session_id.to_string(),
                data: BASE64_STANDARD.encode(ch),
                input_seq: Some(i as u64 + 1),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let frames = collect_frames(&mut rx, Duration::from_secs(2)).await;
    assert_clean("after-input", &frames);

    manager2
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

/// bash 5.x readline regression harness: needs a bash with bracketed paste
/// (macOS ships 3.2). `BUD_REGRESSION_BASH` overrides; skipped when absent.
fn regression_bash() -> Option<String> {
    let shell =
        std::env::var("BUD_REGRESSION_BASH").unwrap_or_else(|_| "/opt/homebrew/bin/bash".into());
    if std::path::Path::new(&shell).exists() {
        Some(shell)
    } else {
        eprintln!("skipping: {shell} not present");
        None
    }
}

fn ubuntu_style_home(tmp: &tempfile::TempDir) -> std::path::PathBuf {
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    // Ubuntu-style colored/titled PS1 with a FIXED 28-char path segment
    // (the report's prompt width). A `\w` prompt longer than the narrow
    // viewer's width wraps, and readline's own multi-row prompt redisplay on
    // a later width change is a separate, known readline-vs-reflow artifact
    // that would confound these assertions.
    std::fs::write(
        home.join(".bashrc"),
        "PS1='\\[\\e]0;\\u@\\h: \\w\\a\\]\\[\\033[01;32m\\]adam@spark-1\\[\\033[00m\\]:\\[\\033[01;34m\\]~/doner-atlas\\[\\033[00m\\]\\$ '\n",
    )
    .unwrap();
    home
}

const LONG_CMD: &str = "echo start && echo \"app.js OK\" && echo ZIGZAG-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789-0123456789 && ls / >/dev/null && echo done-marker";

fn resize_frame(session_id: &str, cols: u16, rows: u16) -> TerminalResizeFrame {
    TerminalResizeFrame {
        envelope: envelope("terminal_resize"),
        session_id: session_id.to_string(),
        cols,
        rows,
    }
}

async fn screen_text(manager: &TerminalManager, rx: &mut FrameRx, session_id: &str) -> String {
    manager
        .handle_observe(observe_frame(session_id, "req-obs", "screen"))
        .await
        .unwrap();
    let result = wait_frame(rx, Duration::from_secs(10), "observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-obs")
    })
    .await;
    result["output"]
        .as_str()
        .and_then(|s| BASE64_STANDARD.decode(s).ok())
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_else(|| result.to_string())
}

/// The readline-garble invariants for LONG_CMD: the prompt appears only at
/// column 0 (never redrawn mid-row), and every output line is intact.
fn assert_clean_long_cmd_screen(label: &str, text: &str) {
    let rows: Vec<&str> = text.lines().collect();
    for l in &rows {
        eprintln!("[{label}] {l}");
    }
    for row in &rows {
        if let Some(pos) = row.find("adam@") {
            assert_eq!(pos, 0, "[{label}] prompt redrawn mid-row: {row:?}");
        }
    }
    for expected in ["start", "app.js OK", "done-marker"] {
        assert!(
            rows.contains(&expected),
            "[{label}] output line {expected:?} missing or overwritten"
        );
    }
}

/// A width shrink queued during an atomic paste→Enter submit (mobile taking
/// geometry while the agent runs a long command) used to land right after
/// the Enter byte, before bash consumed it: readline redrew the multi-row
/// line against the reflowed grid and every following row landed too high
/// (duplicated command, `done-markersta/rt`). The shrink now defers until
/// `command_started`.
#[tokio::test]
async fn resize_shrink_defers_behind_pasted_submit() {
    let Some(shell) = regression_bash() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let manager = std::sync::Arc::new(manager);
    let home = ubuntu_style_home(&tmp);
    for (i, delay_ms) in [10u64, 40].iter().enumerate() {
        let session_id = format!("sess-queued-{i}");
        manager
            .handle_ensure(ensure_frame_with_shell(
                &session_id,
                &shell,
                &home.to_string_lossy(),
            ))
            .await
            .unwrap();
        wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
            is_event(f, "prompt_ready")
        })
        .await;
        manager
            .handle_resize(resize_frame(&session_id, 122, 61))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let m2 = std::sync::Arc::clone(&manager);
        let sid2 = session_id.clone();
        let delay = *delay_ms;
        let resizer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            m2.handle_resize(resize_frame(&sid2, 48, 38)).await.unwrap();
        });
        manager
            .handle_send(send_frame(
                &session_id,
                "req-long",
                LONG_CMD,
                Some(TerminalSendAwait::Command),
            ))
            .await
            .unwrap();
        resizer.await.unwrap();
        wait_frame(&mut rx, Duration::from_secs(20), "command finished", |f| {
            is_result_for(f, "terminal_send_result", "req-long")
        })
        .await;
        // The deferred shrink applied once the command started: a `ready`
        // status for THIS session arrives (the service re-arms watches on it).
        tokio::time::sleep(Duration::from_millis(600)).await;
        // View at web width like the report; content must be intact.
        manager
            .handle_resize(resize_frame(&session_id, 122, 61))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let text = screen_text(&manager, &mut rx, &session_id).await;
        assert_clean_long_cmd_screen(&format!("shrink at +{delay_ms}ms"), &text);
        manager
            .handle_close(TerminalCloseFrame {
                envelope: envelope("terminal_close"),
                session_id: session_id.clone(),
                reason: None,
            })
            .await
            .unwrap();
    }
}

/// A long line composed at the prompt (no submit), then a width shrink, then
/// Enter: the shrink defers until the line is consumed, so readline never
/// redisplays it against a reflowed grid. Growing with a line pending and
/// rows-only changes were always clean and still apply immediately.
#[tokio::test]
async fn resize_shrink_defers_while_line_pending_at_prompt() {
    let Some(shell) = regression_bash() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let home = ubuntu_style_home(&tmp);
    let session_id = "sess-pending-line";
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            &shell,
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
    manager
        .handle_resize(resize_frame(session_id, 122, 61))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-paste".into(),
            text: Some(LONG_CMD.to_string()),
            submit: Some(false),
            key: None,
            r#await: Some(TerminalSendAwait::Settled),
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(15), "paste settled", |f| {
        is_result_for(f, "terminal_send_result", "req-paste")
    })
    .await;
    // Shrink with the line pending: deferred (no `ready` until the line is
    // consumed), so the grid stays at 122 for now.
    manager
        .handle_resize(resize_frame(session_id, 48, 38))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        before.lines().any(|l| l.len() > 48),
        "shrink applied while a line was pending at the prompt"
    );
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-enter".into(),
            text: None,
            submit: None,
            key: Some("enter".into()),
            r#await: Some(TerminalSendAwait::Command),
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(20), "command finished", |f| {
        is_result_for(f, "terminal_send_result", "req-enter")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    // The deferred shrink applied after command start: rows now wrap at 48.
    let after = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        after.lines().all(|l| l.len() <= 48),
        "deferred shrink never applied: {after}"
    );
    manager
        .handle_resize(resize_frame(session_id, 122, 61))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let text = screen_text(&manager, &mut rx, session_id).await;
    assert_clean_long_cmd_screen("line pending then shrink", &text);
    manager
        .handle_close(TerminalCloseFrame {
            envelope: envelope("terminal_close"),
            session_id: session_id.to_string(),
            reason: None,
        })
        .await
        .unwrap();
}

/// A scripted inline TUI with codex's startup shape: an early bracketed-
/// paste enable (the interactive signal), a `paint_delay` pause, THEN the
/// UI paints; afterwards it echoes every submitted line as `GOT: <line>`
/// after an optional `reply_delay` (argv[2]) spent animating a working
/// indicator — a chat TUI "thinking" (spinner damage is what holds a send).
fn fake_tui_script(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("fake_tui.py");
    std::fs::write(
        &path,
        r#"import sys, time
w = sys.stdout.write
w("\x1b[?2004h"); sys.stdout.flush()
time.sleep(float(sys.argv[1]) if len(sys.argv) > 1 else 2.0)
reply_delay = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
w("+------ fake tui ------+\r\n| ask me anything      |\r\n> "); sys.stdout.flush()
for line in sys.stdin:
    line = line.replace("\x1b[200~", "").replace("\x1b[201~", "").strip()
    if not line:
        continue
    # Think like codex: an animated working indicator (continuous damage)
    # for reply_delay, then the reply. A SILENT pause would be
    # indistinguishable from an ignored gesture and settle early by design.
    waited = 0.0
    while waited < reply_delay:
        w("\r* Working (%.1fs)" % waited); sys.stdout.flush()
        time.sleep(0.2)
        waited += 0.2
    w("\r" + " " * 24 + "\rGOT: " + line + "\r\n> "); sys.stdout.flush()
    if line == "quit":
        break
w("\x1b[?2004l"); sys.stdout.flush()
"#,
    )
    .unwrap();
    path
}

fn send_auto(session_id: &str, request_id: &str, text: &str) -> TerminalSendFrame {
    TerminalSendFrame {
        envelope: envelope("terminal_send"),
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        text: Some(text.to_string()),
        submit: Some(true),
        key: None,
        r#await: Some(TerminalSendAwait::Auto),
    }
}

async fn send_auto_result(
    manager: &TerminalManager,
    rx: &mut FrameRx,
    session_id: &str,
    request_id: &str,
    text: &str,
) -> (Value, Duration) {
    let started = Instant::now();
    manager
        .handle_send(send_auto(session_id, request_id, text))
        .await
        .unwrap();
    let result = wait_frame(rx, Duration::from_secs(30), request_id, |f| {
        is_result_for(f, "terminal_send_result", request_id)
    })
    .await;
    (result, started.elapsed())
}

async fn ensure_bash_prompt(
    manager: &TerminalManager,
    rx: &mut FrameRx,
    tmp: &tempfile::TempDir,
    session_id: &str,
) {
    let home = tmp.path().join(format!("home-{session_id}"));
    std::fs::create_dir_all(&home).unwrap();
    manager
        .handle_ensure(ensure_frame_with_shell(
            session_id,
            "/bin/bash",
            &home.to_string_lossy(),
        ))
        .await
        .unwrap();
    wait_frame(rx, Duration::from_secs(15), "prompt", |f| {
        is_event(f, "prompt_ready")
    })
    .await;
}

/// Unified send at a shell prompt resolves as a COMMAND (boundary + real
/// exit code) — `terminal.run` semantics without a second tool.
#[tokio::test]
async fn unified_send_at_prompt_is_a_command() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-auto-cmd";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let (result, _) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-cmd",
        "echo hi && (exit 3)",
    )
    .await;
    assert_eq!(result["resolved_await"], "command", "{result}");
    assert_eq!(result["outcome"]["event"], "command_finished", "{result}");
    assert_eq!(result["outcome"]["data"]["exit_code"], 3, "{result}");
    // Nothing was open: no gate.
    assert!(result.get("gated_ms").is_none(), "{result}");
}

/// Launching a program via the unified send holds the result until the
/// program has PAINTED and gone quiet (ready), not at its first escape
/// sequence; the follow-up send then lands and is echoed back.
#[tokio::test]
async fn unified_send_launching_a_tui_waits_until_ready_then_drives_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-auto-tui";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    let launch = format!("python3 {} 2.0", script.display());
    let (result, elapsed) =
        send_auto_result(&manager, &mut rx, session_id, "req-launch", &launch).await;
    assert_eq!(result["resolved_await"], "command", "{result}");
    assert_eq!(
        result["outcome"]["event"], "interactive_started",
        "{result}"
    );
    assert_eq!(result["outcome"]["data"]["ready"], true, "{result}");
    assert_eq!(result["outcome"]["data"]["painted"], true, "{result}");
    assert!(
        elapsed >= Duration::from_millis(1900),
        "returned before the paint: {elapsed:?}"
    );

    // Drive it: inside a program the unified send settles; it was already
    // ready so the gate is ~free.
    let (result, _) =
        send_auto_result(&manager, &mut rx, session_id, "req-hello", "hello there").await;
    assert_eq!(result["resolved_await"], "settled", "{result}");
    assert_eq!(result["program_ready"], true, "{result}");
    assert!(result["gated_ms"].as_u64().unwrap() < 1000, "{result}");
    let screen = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        screen.contains("GOT: hello there"),
        "input not delivered:\n{screen}"
    );

    let (result, _) = send_auto_result(&manager, &mut rx, session_id, "req-quit", "quit").await;
    assert!(
        matches!(
            result["outcome"]["event"].as_str(),
            Some("prompt_ready") | Some("command_finished") | Some("settled")
        ),
        "{result}"
    );
}

/// The input gate: a send issued while the program is still starting
/// (interactive signal seen, nothing painted) waits for readiness before
/// typing, so the text is not discarded by raw-mode init.
#[tokio::test]
async fn unified_send_gates_input_until_the_program_paints() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-auto-gate";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    // Dispatch-only launch (no await) mimics an agent racing ahead.
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-launch".into(),
            text: Some(format!("python3 {} 2.0", script.display())),
            submit: Some(true),
            key: None,
            r#await: None,
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "launch dispatched", |f| {
        is_result_for(f, "terminal_send_result", "req-launch")
    })
    .await;
    // Give the shell time to start the program (command_started), then
    // send immediately — well before the 2 s paint.
    wait_frame(&mut rx, Duration::from_secs(10), "command started", |f| {
        is_event(f, "command_started")
    })
    .await;
    let (result, elapsed) =
        send_auto_result(&manager, &mut rx, session_id, "req-early", "early bird").await;
    assert_eq!(result["program_ready"], true, "{result}");
    assert!(
        result["gated_ms"].as_u64().unwrap() >= 1000,
        "gate did not wait: {result}"
    );
    assert!(elapsed >= Duration::from_millis(1500), "{elapsed:?}");
    let screen = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        screen.contains("GOT: early bird"),
        "early input lost:\n{screen}"
    );
    let _ = send_auto_result(&manager, &mut rx, session_id, "req-quit", "quit").await;
}

/// Readiness cap: a program that signals interactive but never paints
/// returns `ready:false, painted:false` after PROGRAM_READY_CAP instead of
/// hanging the launch.
#[tokio::test]
async fn unified_send_readiness_cap_when_program_never_paints() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-auto-cap";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    let (result, elapsed) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-launch",
        &format!("python3 {} 40", script.display()),
    )
    .await;
    assert_eq!(
        result["outcome"]["event"], "interactive_started",
        "{result}"
    );
    assert_eq!(result["outcome"]["data"]["ready"], false, "{result}");
    assert_eq!(result["outcome"]["data"]["painted"], false, "{result}");
    assert!(
        elapsed >= Duration::from_secs(9) && elapsed < Duration::from_secs(20),
        "{elapsed:?}"
    );
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-int".into(),
            text: None,
            submit: None,
            key: Some("ctrl+c".into()),
            r#await: None,
        })
        .await
        .unwrap();
}

/// A send into a program resolves on the program's REACTION, settled — not
/// on the input echo. A reply that lands 2 s later is part of this result
/// (the codex `exit` → `• Goodbye!` misread: the old send returned on the
/// echo, the reply surfaced as an unrelated wait, and the model assumed an
/// exit). A gesture the program ignores still returns after the quiet
/// window.
#[tokio::test]
async fn unified_send_into_program_waits_for_its_reply_to_settle() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-auto-reply";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    let (result, _) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-launch",
        &format!("python3 {} 0.3 2.0", script.display()),
    )
    .await;
    assert_eq!(
        result["outcome"]["event"], "interactive_started",
        "{result}"
    );

    // Reply arrives 2 s after the input: the send must hold through it and
    // the 1.5 s quiet window (≥ 3.3 s), and the reply must be on screen.
    let (result, elapsed) =
        send_auto_result(&manager, &mut rx, session_id, "req-ping", "ping").await;
    assert_eq!(result["outcome"]["event"], "settled", "{result}");
    assert_eq!(result["outcome"]["data"]["reacted"], true, "{result}");
    assert!(
        elapsed >= Duration::from_millis(3300),
        "returned before the reply settled: {elapsed:?}"
    );
    let screen = screen_text(&manager, &mut rx, session_id).await;
    assert!(
        screen.contains("GOT: ping"),
        "reply missing at resolve time:\n{screen}"
    );

    // A gesture the program ignores (a bare arrow key: no line, no echo)
    // returns after the quiet window without waiting for a boundary.
    let started = Instant::now();
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-key".into(),
            text: None,
            submit: None,
            key: Some("up".into()),
            r#await: Some(TerminalSendAwait::Auto),
        })
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "key settled", |f| {
        is_result_for(f, "terminal_send_result", "req-key")
    })
    .await;
    let elapsed = started.elapsed();
    assert_eq!(result["outcome"]["event"], "settled", "{result}");
    assert!(
        elapsed >= Duration::from_millis(1400) && elapsed < Duration::from_secs(5),
        "no-reaction send should return after the quiet window: {elapsed:?}"
    );
    let _ = send_auto_result(&manager, &mut rx, session_id, "req-quit", "quit").await;
}

/// Active-hold wait: a wait against an open program whose screen is visually
/// static cedes control with `no_activity` after WAIT_STATIC_CAP (10 s) —
/// the long wait budget is for a CHANGING terminal, never a static one.
#[tokio::test]
async fn wait_returns_no_activity_on_a_static_open_program() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-wait-static";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    let (result, _) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-launch",
        &format!("python3 {} 0.3", script.display()),
    )
    .await;
    assert_eq!(
        result["outcome"]["event"], "interactive_started",
        "{result}"
    );

    // Mark the idle TUI screen as seen: the hold case is quiet + seen + open
    // (unseen quiet content is an immediate stall, a different path).
    manager
        .handle_observe(observe_frame(session_id, "req-baseline", "screen"))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "baseline observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-baseline")
    })
    .await;

    let started = Instant::now();
    awaited_observe(
        &manager,
        awaited_observe_frame(session_id, "req-wait", TerminalSendAwait::Settled, None),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(15), "no_activity wait", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait")
    })
    .await;
    let elapsed = started.elapsed();
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("no_activity"),
        "{result:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(9500) && elapsed < Duration::from_secs(15),
        "static wait must cede control at ~WAIT_STATIC_CAP, took {elapsed:?}"
    );
    assert!(
        result
            .pointer("/outcome/data/static_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            >= 10_000,
        "{result:?}"
    );
    let _ = send_auto_result(&manager, &mut rx, session_id, "req-quit", "quit").await;
}

/// Active-hold wait: visible changes (an animated working indicator) reset
/// the static clock, so the wait holds through an animation LONGER than
/// WAIT_STATIC_CAP and then resolves `stalled` once the reply goes quiet.
#[tokio::test]
async fn wait_holds_through_animation_then_stalls_on_the_reply() {
    let tmp = tempfile::tempdir().unwrap();
    let (manager, mut rx) = manager_with_sender(&tmp).await;
    let session_id = "sess-wait-anim";
    ensure_bash_prompt(&manager, &mut rx, &tmp, session_id).await;
    let script = fake_tui_script(tmp.path());
    // 12 s working animation: longer than the 10 s static cap.
    let (result, _) = send_auto_result(
        &manager,
        &mut rx,
        session_id,
        "req-launch",
        &format!("python3 {} 0.3 12.0", script.display()),
    )
    .await;
    assert_eq!(
        result["outcome"]["event"], "interactive_started",
        "{result}"
    );
    manager
        .handle_observe(observe_frame(session_id, "req-baseline", "screen"))
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "baseline observe", |f| {
        is_result_for(f, "terminal_observe_result", "req-baseline")
    })
    .await;

    // Dispatch-only send (no await): the wait below, not the send, rides out
    // the animation.
    manager
        .handle_send(TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: session_id.to_string(),
            request_id: "req-ping".into(),
            text: Some("ping".into()),
            submit: Some(true),
            key: None,
            r#await: None,
        })
        .await
        .unwrap();
    wait_frame(&mut rx, Duration::from_secs(10), "ping dispatched", |f| {
        is_result_for(f, "terminal_send_result", "req-ping")
    })
    .await;

    let started = Instant::now();
    awaited_observe(
        &manager,
        awaited_observe_frame(session_id, "req-wait", TerminalSendAwait::Settled, None),
    )
    .await
    .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(18), "stalled wait", |f| {
        is_result_for(f, "terminal_observe_result", "req-wait")
    })
    .await;
    let elapsed = started.elapsed();
    assert_eq!(
        result.pointer("/outcome/event").and_then(Value::as_str),
        Some("stalled"),
        "{result:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(10_500),
        "the static cap must not fire mid-animation, took {elapsed:?}"
    );
    assert!(
        decoded_output(&result).contains("GOT: ping"),
        "the stalled snapshot carries the reply: {:?}",
        decoded_output(&result)
    );
    let _ = send_auto_result(&manager, &mut rx, session_id, "req-quit", "quit").await;
}
