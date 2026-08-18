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
    Envelope, TerminalCloseFrame, TerminalEnsureConfig, TerminalEnsureFrame, TerminalObserveFrame,
    TerminalResizeFrame, TerminalSendAwait, TerminalSendFrame,
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
    }
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
async fn run_refused_while_a_command_is_open() {
    // The codex incident (§A follow-up): an inline TUI keeps the session in
    // mode=shell with an OPEN command (started, no finish). A terminal.run
    // (text+submit+await:command) must be refused — typing would feed the
    // foreground program and the await could only resolve when it exits.
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

    // Open a command WITHOUT awaiting (mirrors a human launching an inline
    // TUI through the browser input path). Short sleep: the guard must
    // refuse DURING it and naturally unblock after it finishes.
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

    // A run-style send must now be refused with the typed error, without
    // typing anything into the PTY.
    manager
        .handle_send(send_frame(
            session_id,
            "req-guarded",
            "echo should-not-run",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let result = wait_frame(&mut rx, Duration::from_secs(10), "guard result", |frame| {
        is_type(frame, "terminal_send_result")
            && frame.get("request_id").and_then(Value::as_str) == Some("req-guarded")
    })
    .await;
    assert_eq!(
        result.get("error").and_then(Value::as_str),
        Some("command_in_flight"),
        "expected the busy guard: {result:?}"
    );
    assert_eq!(
        result.get("dispatched").and_then(Value::as_bool),
        Some(false)
    );

    // The sleep finishes on its own; the guard clears and runs work again.
    wait_frame(
        &mut rx,
        Duration::from_secs(15),
        "open command finished",
        |frame| {
            is_type(frame, "terminal_event")
                && frame.get("event").and_then(Value::as_str) == Some("command_finished")
        },
    )
    .await;
    manager
        .handle_send(send_frame(
            session_id,
            "req-after",
            "true",
            Some(TerminalSendAwait::Command),
        ))
        .await
        .unwrap();
    let after = wait_frame(
        &mut rx,
        Duration::from_secs(15),
        "post-finish run",
        |frame| {
            is_type(frame, "terminal_send_result")
                && frame.get("request_id").and_then(Value::as_str) == Some("req-after")
        },
    )
    .await;
    assert!(after.get("error").is_none() || after["error"].is_null());
    // The guarded text never reached the PTY.
    let recent = collect_frames(&mut rx, Duration::from_millis(600)).await;
    for frame in &recent {
        if is_type(frame, "terminal_output") {
            assert!(
                !decoded_output(frame).contains("should-not-run"),
                "guarded text leaked into the PTY"
            );
        }
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
