//! Integration tests for the stem process layer: a REAL holder running
//! in-process (`run_holder(daemonize=false)` on a std thread) exercised by the
//! async `HolderClient` and the `Registry`.
//!
//! True daemonized spawning (double-fork via re-exec) cannot use the test
//! binary as the launcher cleanly; the re-exec spawn path is covered later by
//! the parent integration work (`bud term-hold`). Here `Registry::ensure` is
//! validated for its reuse/alive logic against an in-process holder.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use stem::client::{HolderClient, HolderPush};
use stem::holder::{run_holder, HolderConfig};
use stem::pty::SpawnSpec;
use stem::registry::{HolderLauncher, Registry};

fn tick_spec() -> SpawnSpec {
    SpawnSpec {
        shell: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "while true; do echo tick; sleep 1; done".to_string(),
        ],
        cwd: "/".to_string(),
        env: vec![],
        cols: 80,
        rows: 24,
    }
}

fn flood_spec() -> SpawnSpec {
    // Bounded flood (~64 KiB, far past the tiny ring cap) then idle: forces a
    // deterministic wrap without burning CPU for the rest of the test.
    SpawnSpec {
        shell: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "yes flood-payload | head -c 65536; while true; do sleep 1; done".to_string(),
        ],
        cwd: "/".to_string(),
        env: vec![],
        cols: 80,
        rows: 24,
    }
}

fn start_holder(
    dir: &Path,
    spawn: SpawnSpec,
    ring_cap: u64,
    ttl: u64,
) -> std::thread::JoinHandle<()> {
    let cfg = HolderConfig {
        session_dir: dir.to_path_buf(),
        spawn,
        ring_cap,
        post_exit_ttl_secs: ttl,
    };
    std::thread::spawn(move || run_holder(cfg, false).expect("holder body failed"))
}

async fn wait_for_holder(dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if HolderClient::connect(dir).await.is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "holder did not come up at {}",
            dir.display()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn pid_alive(pid: i32) -> bool {
    unsafe { nix::libc::kill(pid, 0) == 0 }
}

async fn wait_pid_dead(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        assert!(Instant::now() < deadline, "child pid {pid} still alive");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Deadline-bounded join that never parks a blocking-pool thread: a stuck
/// holder makes the test FAIL instead of hanging the runtime's shutdown.
async fn join_holder(handle: std::thread::JoinHandle<()>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !handle.is_finished() {
        assert!(
            Instant::now() < deadline,
            "holder thread did not exit in time"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    handle.join().expect("holder thread panicked");
}

#[tokio::test]
async fn stat_write_echo_subscribe_kill() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s1");
    let handle = start_holder(&dir, tick_spec(), 1 << 20, 3600);
    wait_for_holder(&dir).await;

    let (mut client, hello) = HolderClient::connect(&dir).await.unwrap();
    assert!(hello.child_pid > 0);
    assert_eq!(hello.proto_version, 1);

    let stat = client.stat().await.unwrap();
    assert!(stat.child_alive);
    assert_eq!(stat.child_pid, hello.child_pid);
    assert_eq!((stat.cols, stat.rows), (80, 24));
    assert_eq!(stat.ring_oldest_offset, 0);

    // Subscribe from 0: replay + live must be contiguous from offset 0.
    let mut rx = HolderClient::subscribe(&dir, 0).await.unwrap();

    // The tick loop never reads stdin, but tty-level ECHO reflects our input
    // into the output stream.
    let marker = b"bud-integration-marker-4242";
    client.write(marker).await.unwrap();

    let mut collected: Vec<u8> = Vec::new();
    let mut expected_next: Option<u64> = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !contains(&collected, marker) {
        assert!(
            Instant::now() < deadline,
            "marker never echoed; got {collected:?}"
        );
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(HolderPush::Output { offset, bytes })) => {
                if let Some(e) = expected_next {
                    assert_eq!(offset, e, "output offsets must be contiguous");
                } else {
                    assert_eq!(offset, 0, "subscribe-from-0 replay must start at 0");
                }
                expected_next = Some(offset + bytes.len() as u64);
                collected.extend_from_slice(&bytes);
            }
            Ok(Some(other)) => panic!("unexpected push: {other:?}"),
            Ok(None) => panic!("subscription closed early"),
            Err(_) => {} // keep polling until deadline
        }
    }

    // The same bytes must be in the ring (subscribe path == ring path).
    match client.ring_read(0, u64::MAX).await.unwrap() {
        stem::ipc::HolderMsg::RingData {
            start,
            bytes,
            truncated_from,
        } => {
            assert_eq!(start, 0);
            assert_eq!(truncated_from, None);
            assert!(contains(&bytes, marker));
        }
        other => panic!("unexpected: {other:?}"),
    }

    // Kill: child dies, holder thread joins, socket removed.
    client.kill().await.unwrap();
    join_holder(handle).await;
    wait_pid_dead(hello.child_pid).await;
    assert!(!dir.join("holder.sock").exists());
}

#[tokio::test]
async fn subscribe_beyond_retention_gets_truncated_first() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s2");
    // Tiny ring + `yes` flood forces a wrap quickly.
    let handle = start_holder(&dir, flood_spec(), 2048, 3600);
    wait_for_holder(&dir).await;

    let (mut client, hello) = HolderClient::connect(&dir).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let stat = client.stat().await.unwrap();
        if stat.ring_next_offset > 8192 {
            assert!(stat.ring_oldest_offset > 0, "ring should have evicted");
            break;
        }
        assert!(Instant::now() < deadline, "ring never wrapped");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let mut rx = HolderClient::subscribe(&dir, 0).await.unwrap();
    match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        Ok(Some(HolderPush::Truncated { oldest_offset })) => {
            assert!(oldest_offset > 0);
            // The first Output must begin exactly at the reported oldest offset.
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(HolderPush::Output { offset, bytes })) => {
                    assert_eq!(offset, oldest_offset);
                    assert!(!bytes.is_empty());
                }
                other => panic!("expected Output after Truncated, got {other:?}"),
            }
        }
        other => panic!("expected Truncated first, got {other:?}"),
    }

    client.kill().await.unwrap();
    join_holder(handle).await;
    wait_pid_dead(hello.child_pid).await;
}

#[tokio::test]
async fn holder_outlives_client_reconnect() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s3");
    let handle = start_holder(&dir, tick_spec(), 1 << 20, 3600);
    wait_for_holder(&dir).await;

    let first_next;
    {
        let (mut client, _) = HolderClient::connect(&dir).await.unwrap();
        first_next = client.stat().await.unwrap().ring_next_offset;
        // client dropped here: connection closes, holder must keep serving.
    }

    let (mut client, hello) = HolderClient::connect(&dir).await.unwrap();
    let stat = client.stat().await.unwrap();
    assert!(stat.child_alive);
    assert!(stat.ring_next_offset >= first_next);
    client.write(b"still-here").await.unwrap();

    client.kill().await.unwrap();
    join_holder(handle).await;
    wait_pid_dead(hello.child_pid).await;
}

#[tokio::test]
async fn zero_ttl_holder_exits_after_child_exit_with_notification() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("s4");
    // Child exits (code 7) only once we poke it over stdin, so the
    // subscription is deterministically attached before the exit.
    let spec = SpawnSpec {
        shell: "/bin/sh".to_string(),
        args: vec!["-c".to_string(), "read _line; exit 7".to_string()],
        cwd: "/".to_string(),
        env: vec![],
        cols: 80,
        rows: 24,
    };
    let handle = start_holder(&dir, spec, 1 << 20, 0);
    wait_for_holder(&dir).await;

    let mut rx = HolderClient::subscribe(&dir, 0).await.unwrap();
    let (mut client, _) = HolderClient::connect(&dir).await.unwrap();
    client.write(b"go\n").await.unwrap();
    drop(client);
    let mut saw_exit = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while saw_exit.is_none() {
        assert!(Instant::now() < deadline, "never saw ChildExited");
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(HolderPush::ChildExited { exit_code, signal })) => {
                saw_exit = Some((exit_code, signal));
            }
            Ok(Some(_)) => {}
            Ok(None) => panic!("subscription closed before ChildExited"),
            Err(_) => {}
        }
    }
    assert_eq!(saw_exit, Some((Some(7), None)));
    // ttl=0: holder exits promptly once subscribers were notified.
    join_holder(handle).await;
    assert!(!dir.join("holder.sock").exists());
}

#[tokio::test]
async fn registry_reuse_alive_list_and_gc() {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().join("term");
    let reg = Registry::new(base.clone()).unwrap();

    // Live session backed by an in-process holder.
    let live_dir = reg.session_dir("sess_live").unwrap();
    let handle = start_holder(&live_dir, tick_spec(), 1 << 20, 3600);
    wait_for_holder(&live_dir).await;

    assert!(reg.session_alive("sess_live").await);
    assert!(!reg.session_alive("sess_missing").await);

    let meta = reg.meta("sess_live").unwrap();
    assert_eq!(meta.holder_pid, std::process::id() as i32); // in-process holder
    assert!(meta.child_pid > 0);
    assert_eq!(meta.ipc_proto_version, 1);

    // ensure() on a live session must reuse it, never spawn: /usr/bin/false as
    // launcher would fail loudly if the spawn path ran.
    let launcher = HolderLauncher {
        program: PathBuf::from("/usr/bin/false"),
        args_prefix: vec![],
    };
    let got = reg
        .ensure("sess_live", &launcher, &tick_spec(), 1 << 20)
        .await
        .unwrap();
    assert_eq!(got, live_dir);

    // Stale dir: valid meta with a dead pid and no socket.
    let stale_dir = base.join("sess_stale");
    std::fs::create_dir_all(&stale_dir).unwrap();
    std::fs::write(
        stale_dir.join("meta.json"),
        r#"{"pid":1999999999,"started_at_unix":1,"holder_version":"0.0.0","ipc_proto_version":1,"shell":"/bin/sh","cwd":"/","child_pid":1999999998}"#,
    )
    .unwrap();

    let mut ids = reg.list().unwrap();
    ids.sort();
    assert_eq!(ids, vec!["sess_live".to_string(), "sess_stale".to_string()]);

    let removed = reg.gc_stale().unwrap();
    assert_eq!(removed, vec!["sess_stale".to_string()]);
    assert!(!stale_dir.exists());
    assert!(live_dir.exists(), "gc must never touch live holders");
    assert!(reg.session_alive("sess_live").await);

    // Cleanup.
    let (mut client, hello) = HolderClient::connect(&live_dir).await.unwrap();
    client.kill().await.unwrap();
    join_holder(handle).await;
    wait_pid_dead(hello.child_pid).await;
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}
