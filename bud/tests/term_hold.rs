//! True single-binary holder spawn: `bud term-hold` re-exec with real
//! daemonization (double-fork + setsid), driven through stem's Registry —
//! the path production uses, which in-process holder tests cannot cover.

use std::path::PathBuf;
use std::time::Duration;

use stem::client::{HolderClient, HolderPush};
use stem::pty::SpawnSpec;
use stem::registry::{HolderLauncher, Registry};

const SESSION: &str = "sess_reexec_test";

#[tokio::test]
async fn term_hold_reexec_spawns_reuses_and_kills_daemonized_holder() {
    let bud_exe = PathBuf::from(env!("CARGO_BIN_EXE_bud"));
    let tmp = tempfile::tempdir().unwrap();
    let registry = Registry::new(tmp.path().join("term")).unwrap();
    let launcher = HolderLauncher {
        program: bud_exe,
        args_prefix: vec!["term-hold".into()],
    };
    let spec = SpawnSpec {
        shell: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "i=0; while true; do echo tick $i; i=$((i+1)); sleep 1; done".into(),
        ],
        cwd: tmp.path().to_string_lossy().into_owned(),
        env: vec![],
        cols: 80,
        rows: 24,
    };

    // Spawn through the real binary; ensure() waits for the socket + Hello.
    let dir = registry
        .ensure(SESSION, &launcher, &spec, 256 * 1024)
        .await
        .unwrap();
    assert!(
        registry.session_alive(SESSION).await,
        "holder should be alive after ensure"
    );
    let meta1 = registry.meta(SESSION).unwrap();
    assert!(meta1.holder_pid > 0);
    assert!(meta1.child_pid > 0);

    // Second ensure must REUSE (reattach), not respawn.
    let dir2 = registry
        .ensure(SESSION, &launcher, &spec, 256 * 1024)
        .await
        .unwrap();
    assert_eq!(dir, dir2);
    let meta2 = registry.meta(SESSION).unwrap();
    assert_eq!(
        meta1.holder_pid, meta2.holder_pid,
        "ensure respawned instead of reusing"
    );

    // The daemonized holder's PTY child is really producing output.
    let mut pushes = HolderClient::subscribe(&dir, 0).await.unwrap();
    let mut saw_tick = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !saw_tick && tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), pushes.recv()).await {
            Ok(Some(HolderPush::Output { bytes, .. })) => {
                saw_tick = String::from_utf8_lossy(&bytes).contains("tick");
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    assert!(saw_tick, "no PTY output observed from re-exec'd holder");

    // Kill tears the detached holder down; registry sees it dead.
    let (mut ctl, _) = HolderClient::connect(&dir).await.unwrap();
    ctl.kill().await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while registry.session_alive(SESSION).await && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !registry.session_alive(SESSION).await,
        "holder still alive after kill"
    );

    // The socket disappears before the holder process fully exits; gc_stale
    // (correctly) won't touch a dir whose pid is still alive — poll it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let removed = registry.gc_stale().unwrap();
        if removed == vec![SESSION.to_string()] {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "gc_stale never collected the dead session (last: {removed:?})"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(registry.list().unwrap().is_empty());
}
