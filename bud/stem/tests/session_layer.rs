//! End-to-end Session tests against a real in-process holder + /bin/sh.

use std::path::PathBuf;
use std::time::Duration;

use stem::client::HolderClient;
use stem::events::{Event, Integration, Mode};
use stem::holder::{run_holder, HolderConfig};
use stem::modes::NoRepl;
use stem::pty::SpawnSpec;
use stem::session::{Session, SessionConfig};
use tokio::sync::mpsc;
use tokio::time::timeout;

/// A shell loop that emits real OSC 133 markers around each command it reads.
const OSC133_LOOP: &str = r#"while true; do printf '\033]133;A\a'; read -r cmd || exit 0; printf '\033]133;B\a'; printf '\033]133;C\a'; eval "$cmd"; printf '\033]133;D;%s\a' "$?"; done"#;

fn start_holder(script: &str, ring_cap: u64) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("sess");
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = HolderConfig {
        session_dir: dir.to_path_buf(),
        spawn: SpawnSpec {
            shell: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: tmp.path().to_string_lossy().into_owned(),
            env: vec![],
            cols: 80,
            rows: 24,
        },
        ring_cap,
        post_exit_ttl_secs: 5,
    };
    std::thread::spawn(move || {
        let _ = run_holder(cfg, false);
    });
    (tmp, dir)
}

async fn wait_for_holder(dir: &std::path::Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if HolderClient::connect(dir).await.is_ok() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "holder never came up"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Await the next event matching `pred`, discarding others, within 5s.
async fn expect_event<F: Fn(&Event) -> bool>(
    rx: &mut mpsc::Receiver<Event>,
    what: &str,
    pred: F,
) -> Event {
    let deadline = Duration::from_secs(5);
    loop {
        let ev = timeout(deadline, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .unwrap_or_else(|| panic!("event channel closed waiting for {what}"));
        if pred(&ev) {
            return ev;
        }
    }
}

fn config(dir: &std::path::Path, resume: u64) -> SessionConfig {
    SessionConfig {
        session_dir: dir.to_path_buf(),
        quiet_ms: 100,
        resume_from_offset: resume,
        scrollback_lines: 1000,
        repl_matcher: Box::new(NoRepl),
    }
}

#[tokio::test]
async fn integrated_shell_lifecycle_exit_codes_and_tui() {
    let (_tmp, dir) = start_holder(OSC133_LOOP, 256 * 1024);
    wait_for_holder(&dir).await;

    let (mut session, mut rx) = Session::attach(config(&dir, 0)).await.unwrap();

    // The first prompt marker classifies the session Shell/Osc133.
    expect_event(&mut rx, "shell mode", |e| {
        matches!(
            e,
            Event::ModeChanged {
                mode: Mode::Shell,
                integration: Integration::Osc133
            }
        )
    })
    .await;
    expect_event(&mut rx, "prompt", |e| {
        matches!(e, Event::PromptReady { .. })
    })
    .await;

    session.write_text("true\n").await.unwrap();
    expect_event(&mut rx, "command started", |e| {
        matches!(e, Event::CommandStarted { .. })
    })
    .await;
    let fin = expect_event(&mut rx, "exit 0", |e| {
        matches!(e, Event::CommandFinished { .. })
    })
    .await;
    match fin {
        Event::CommandFinished {
            exit_code,
            output_byte_start,
            output_byte_end,
            ..
        } => {
            assert_eq!(exit_code, Some(0));
            assert!(output_byte_end >= output_byte_start);
        }
        _ => unreachable!(),
    }

    session.write_text("false\n").await.unwrap();
    let fin = expect_event(&mut rx, "exit 1", |e| {
        matches!(e, Event::CommandFinished { .. })
    })
    .await;
    assert!(matches!(
        fin,
        Event::CommandFinished {
            exit_code: Some(1),
            ..
        }
    ));

    // Alt-screen round trip: Tui on enter, Shell restored on leave.
    session.write_text("printf '\\033[?1049h'\n").await.unwrap();
    expect_event(&mut rx, "tui mode", |e| {
        matches!(
            e,
            Event::ModeChanged {
                mode: Mode::Tui,
                ..
            }
        )
    })
    .await;
    assert!(session.alt_screen_active());
    session.write_text("printf '\\033[?1049l'\n").await.unwrap();
    expect_event(&mut rx, "shell restored", |e| {
        matches!(
            e,
            Event::ModeChanged {
                mode: Mode::Shell,
                ..
            }
        )
    })
    .await;

    session.kill().await.unwrap();
}

#[tokio::test]
async fn reattach_replays_backfill_and_suppresses_seen_history() {
    let (_tmp, dir) = start_holder(OSC133_LOOP, 256 * 1024);
    wait_for_holder(&dir).await;

    // First attach: run two commands, then detach.
    {
        let (mut session, mut rx) = Session::attach(config(&dir, 0)).await.unwrap();
        session.write_text("echo first-marker\n").await.unwrap();
        expect_event(&mut rx, "cmd 1 done", |e| {
            matches!(e, Event::CommandFinished { .. })
        })
        .await;
        session.write_text("false\n").await.unwrap();
        expect_event(&mut rx, "cmd 2 done", |e| {
            matches!(
                e,
                Event::CommandFinished {
                    exit_code: Some(1),
                    ..
                }
            )
        })
        .await;
        // Drop without kill: the holder must outlive its client.
    }

    // Second attach from 0: full backfill — historical commands re-emitted,
    // mode arrives as one snapshot, screen state reconstructed from the ring.
    let (session2, mut rx2) = Session::attach(config(&dir, 0)).await.unwrap();
    let mut finished = 0;
    let mut saw_snapshot = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while (finished < 2 || !saw_snapshot) && tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(500), rx2.recv()).await {
            Ok(Some(Event::CommandFinished { .. })) => finished += 1,
            Ok(Some(Event::ModeChanged {
                mode: Mode::Shell, ..
            })) => saw_snapshot = true,
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    assert!(
        finished >= 2,
        "backfill should re-emit historical command events, got {finished}"
    );
    assert!(saw_snapshot, "replay should end with a mode snapshot");
    let screen = session2.screen_lines().join("\n");
    assert!(
        screen.contains("first-marker"),
        "replayed screen should show history:\n{screen}"
    );

    // Third attach from the current stream end: no backfill events at all.
    let next_offset = {
        let (mut ctl, _) = HolderClient::connect(&dir).await.unwrap();
        ctl.stat().await.unwrap().ring_next_offset
    };
    let (mut session3, mut rx3) = Session::attach(config(&dir, next_offset)).await.unwrap();
    // First event must be the mode snapshot — never Output/Command backfill.
    let first = timeout(Duration::from_secs(2), rx3.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            first,
            Event::ModeChanged {
                mode: Mode::Shell,
                integration: Integration::Osc133
            }
        ),
        "expected clean snapshot, got {first:?}"
    );
    let screen = session3.screen_lines().join("\n");
    assert!(
        screen.contains("first-marker"),
        "state still replays even when events suppressed"
    );

    session3.kill().await.unwrap();
}

#[tokio::test]
async fn mid_command_shell_settles_for_inline_tuis() {
    // A command that draws and then stays interactive WITHOUT entering the
    // alternate screen (codex-style inline TUI): mode remains Shell, but
    // damage-quiet must still emit Settled while the command is open —
    // interactive callers await it. Regression for the codex hang.
    let (_tmp, dir) = start_holder(OSC133_LOOP, 256 * 1024);
    wait_for_holder(&dir).await;

    let (mut session, mut rx) = Session::attach(config(&dir, 0)).await.unwrap();
    expect_event(&mut rx, "prompt", |e| matches!(e, Event::PromptReady { .. })).await;

    session
        .write_text("printf inline-tui-drawing; sleep 300\n")
        .await
        .unwrap();
    expect_event(&mut rx, "command started", |e| {
        matches!(e, Event::CommandStarted { .. })
    })
    .await;
    let settled = expect_event(&mut rx, "mid-command settled", |e| {
        matches!(e, Event::Settled { .. })
    })
    .await;
    assert!(
        matches!(settled, Event::Settled { mode: Mode::Shell, .. }),
        "inline TUI stays Shell mode but must settle: {settled:?}"
    );

    session.kill().await.unwrap();
}

#[tokio::test]
async fn unintegrated_output_settles_in_unknown_mode() {
    let (_tmp, dir) = start_holder("printf 'plain-output-no-markers'; sleep 300", 64 * 1024);
    wait_for_holder(&dir).await;

    let (mut session, mut rx) = Session::attach(config(&dir, 0)).await.unwrap();
    let settled = expect_event(&mut rx, "settled", |e| matches!(e, Event::Settled { .. })).await;
    match settled {
        Event::Settled { mode, quiet_ms } => {
            assert_eq!(mode, Mode::Unknown);
            assert_eq!(quiet_ms, 100);
        }
        _ => unreachable!(),
    }
    assert!(session
        .screen_lines()
        .join("\n")
        .contains("plain-output-no-markers"));
    session.kill().await.unwrap();
}
