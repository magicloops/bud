//! Exercise the real CLI with isolated HOME/config and fake service managers.
use std::path::Path;
use std::process::Command;

static SHUTDOWN_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

extern "C" fn request_shutdown(_: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

// Child fixture runs only when explicitly selected by the integration test.
#[test]
fn managed_shutdown_fixture() {
    let Some(base) = std::env::var_os("SHUTDOWN_FIXTURE_BASE") else {
        return;
    };
    use clap::Parser;
    let base = std::path::PathBuf::from(base);
    let action = nix::sys::signal::SigAction::new(
        nix::sys::signal::SigHandler::Handler(request_shutdown),
        nix::sys::signal::SaFlags::empty(),
        nix::sys::signal::SigSet::empty(),
    );
    unsafe {
        nix::sys::signal::sigaction(nix::sys::signal::Signal::SIGTERM, &action).unwrap();
    }
    let args = bud::BudArgs::parse_from(["bud", "--base-dir", base.to_str().unwrap()]);
    let lock = bud::instance::InstanceLock::acquire(&args).unwrap();
    std::fs::write(base.join("fixture-ready"), "ready").unwrap();
    let started = std::time::Instant::now();
    while !SHUTDOWN_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "fixture was not stopped"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Exceed the previously loaded launchd job's five-second grace period.
    std::thread::sleep(std::time::Duration::from_secs(6));
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(std::env::var_os("SERVICE_TEST_LOG").unwrap())
        .unwrap()
        .write_all(b"cleanup_completed\n")
        .unwrap();
    drop(lock);
}

#[cfg(target_os = "macos")]
#[test]
fn launchd_upgrade_waits_for_old_daemon_cleanup_before_unload() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("dev");
    let tools = dir.path().join("tools");
    std::fs::create_dir(&base).unwrap();
    std::fs::create_dir(&tools).unwrap();
    std::fs::write(
        base.join("bud.env"),
        "BUD_SERVER_URL='ws://localhost:3000/ws'\n",
    )
    .unwrap();
    let log = dir.path().join("calls");
    std::fs::write(&log, "").unwrap();
    let script = tools.join("launchctl");
    std::fs::write(&script, r#"#!/bin/sh
printf '%s\n' "$*" >> "$SERVICE_TEST_LOG"
if [ "$1" = print ] && [ -n "$UNVERIFIED_PID" ]; then printf 'pid = %s\n' "$UNVERIFIED_PID"; exit 0; fi
if [ "$1" = print ]; then [ ! -f "$SERVICE_TEST_LOG.unloaded" ]; exit $?; fi
if [ "$1" = bootout ]; then
    if [ -f "$SHUTDOWN_FIXTURE_BASE/bud.pid" ]; then printf 'unload preceded cleanup' >&2; exit 1; fi
    : > "$SERVICE_TEST_LOG.unloaded"
fi
exit 0
"#).unwrap();
    std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .args(["--exact", "managed_shutdown_fixture"])
        .env("BUD_MANAGED_LAUNCH", "1")
        .env("SHUTDOWN_FIXTURE_BASE", &base)
        .env("SERVICE_TEST_LOG", &log)
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    while !base.join("fixture-ready").exists() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Reap concurrently: kill(pid,0) alone considers a zombie still alive.
    let child_pid = child.id();
    let reaper = std::thread::spawn(move || child.wait().unwrap());
    let output = cli(dir.path(), &base)
        .env("PATH", &tools)
        .env("SHUTDOWN_FIXTURE_BASE", &base)
        .env("SERVICE_TEST_LOG", &log)
        .args(["service", "install"])
        .output()
        .unwrap();
    if !output.status.success() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(child_pid as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    let status = reaper.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(status.success());
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.find("cleanup_completed").unwrap() < calls.find("bootout ").unwrap());
    assert!(calls.find("bootout ").unwrap() < calls.find("bootstrap ").unwrap());
    // A running loaded job without our instance lock is not safe to unload.
    let rejected = cli(dir.path(), &base)
        .env("PATH", &tools)
        .env("SERVICE_TEST_LOG", &log)
        .env("UNVERIFIED_PID", std::process::id().to_string())
        .args(["service", "install"])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    let after = std::fs::read_to_string(&log).unwrap();
    assert!(after[calls.len()..]
        .lines()
        .all(|line| line.starts_with("print ")));
}

fn cli(home: &Path, base: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bud"));
    command
        .env_clear()
        .env("HOME", home)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .args(["--base-dir", base.to_str().unwrap()]);
    command
}

#[test]
fn cli_and_shell_override_file_defaults_without_redirecting_base() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("dev");
    std::fs::create_dir(&base).unwrap();
    std::fs::write(base.join("bud.env"), "BUD_BASE_DIR='/wrong'\nBUD_SERVER_URL='ws://file.example/ws'\nBUD_DEVICE_NAME='from-file'\n").unwrap();
    let output = cli(dir.path(), &base)
        .args(["--server", "ws://cli.example/ws", "status"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("interactive server: ws://cli.example/ws"));
    assert!(stdout.contains("managed server: ws://file.example/ws"));
    let shell_output = cli(dir.path(), &base)
        .env("BUD_SERVER_URL", "ws://shell.example/ws")
        .arg("status")
        .output()
        .unwrap();
    assert!(shell_output.status.success());
    assert!(String::from_utf8_lossy(&shell_output.stdout)
        .contains("interactive server: ws://shell.example/ws"));
    let defaults = cli(dir.path(), &base).arg("status").output().unwrap();
    assert!(defaults.status.success());
    assert!(String::from_utf8_lossy(&defaults.stdout)
        .contains("interactive server: ws://file.example/ws"));
    // Status distinguishes the next managed configuration from interactive args.
    assert!(stdout.contains(&format!(
        "base: {}",
        std::fs::canonicalize(&base).unwrap().display()
    )));
}

#[test]
fn identity_origin_mismatch_is_rejected_without_deleting_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("dev");
    std::fs::create_dir(&base).unwrap();
    let identity = serde_json::json!({"bud_id":"test", "device_secret":"secret", "server_url":"wss://app.bud.dev/ws", "name":"prod", "default_cwd":"/tmp"}).to_string();
    std::fs::write(base.join("identity.json"), &identity).unwrap();
    let output = cli(dir.path(), &base)
        .args(["--server", "ws://localhost:3000/ws", "claim"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("different service origin"));
    assert_eq!(
        std::fs::read_to_string(base.join("identity.json")).unwrap(),
        identity
    );
}

#[test]
fn selected_service_install_restart_and_uninstall_preserve_other_instance() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("dev");
    let fake_bin = dir.path().join("tools");
    std::fs::create_dir_all(&base).unwrap();
    std::fs::create_dir(&fake_bin).unwrap();
    let log = dir.path().join("service-calls");
    for tool in ["launchctl", "systemctl", "loginctl"] {
        let path = fake_bin.join(tool);
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SERVICE_TEST_LOG\"\nif [ \"$1\" = print ]; then [ -f \"$SERVICE_TEST_LOG.loaded\" ]; exit $?; fi\nif [ \"$1\" = bootstrap ]; then : > \"$SERVICE_TEST_LOG.loaded\"; fi\nif [ \"$1\" = bootout ]; then /bin/rm -f \"$SERVICE_TEST_LOG.loaded\"; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let production = if cfg!(target_os = "macos") {
        dir.path().join("Library/LaunchAgents/dev.bud.daemon.plist")
    } else {
        dir.path().join(".config/systemd/user/bud.service")
    };
    std::fs::create_dir_all(production.parent().unwrap()).unwrap();
    std::fs::write(&production, "production sentinel").unwrap();
    std::fs::write(
        base.join("bud.env"),
        "BUD_SERVER_URL='ws://localhost:3000/ws'\n",
    )
    .unwrap();
    for args in [
        vec!["service", "install"],
        vec!["restart"],
        vec!["service", "uninstall"],
    ] {
        let output = cli(dir.path(), &base)
            .env("PATH", &fake_bin)
            .env("SERVICE_TEST_LOG", &log)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(&production).unwrap(),
            "production sentinel"
        );
    }
    // A service with the selected filename but foreign contents is refused
    // before any service-manager mutation.
    let before_calls = std::fs::read_to_string(&log).unwrap();
    let identity = bud::instance::key(&base).unwrap();
    let selected = if cfg!(target_os = "macos") {
        dir.path().join(format!(
            "Library/LaunchAgents/dev.bud.daemon.{identity}.plist"
        ))
    } else {
        dir.path()
            .join(format!(".config/systemd/user/bud-{identity}.service"))
    };
    std::fs::write(&selected, "foreign service sentinel").unwrap();
    let rejected = cli(dir.path(), &base)
        .env("PATH", &fake_bin)
        .env("SERVICE_TEST_LOG", &log)
        .args(["service", "uninstall"])
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("different base or executable"));
    // Linux detection's read-only show-environment probe is permitted.
    let after_calls = std::fs::read_to_string(&log).unwrap();
    assert!(after_calls[before_calls.len()..]
        .lines()
        .all(|line| line == "--user show-environment"));
    assert_eq!(
        std::fs::read_to_string(selected).unwrap(),
        "foreign service sentinel"
    );
    let calls = std::fs::read_to_string(log).unwrap();
    assert!(calls.contains(if cfg!(target_os = "macos") {
        "dev.bud.daemon."
    } else {
        "bud-"
    }));
    assert!(!calls
        .lines()
        .any(|line| line.ends_with("/dev.bud.daemon") || line.ends_with(" bud.service")));
}

#[cfg(target_os = "macos")]
#[test]
fn launchd_reload_retries_only_transient_bootstrap_eio_after_successful_bootout() {
    use std::os::unix::fs::PermissionsExt;
    for (scenario, success, retry) in [
        ("transient", true, true),
        ("persistent", false, true),
        ("other", false, false),
        ("not_loaded", false, false),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("dev");
        let tools = dir.path().join("tools");
        std::fs::create_dir(&base).unwrap();
        std::fs::create_dir(&tools).unwrap();
        std::fs::write(
            base.join("bud.env"),
            "BUD_SERVER_URL='ws://localhost:3000/ws'\n",
        )
        .unwrap();
        let script = tools.join("launchctl");
        std::fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' "$*" >> "$SERVICE_TEST_LOG"
if [ "$1" = print ]; then
    [ "$SCENARIO" != not_loaded ] && [ ! -f "$SERVICE_TEST_LOG.unloaded" ]; exit $?
fi
if [ "$1" = bootout ]; then
    : > "$SERVICE_TEST_LOG.unloaded"; exit 0
fi
if [ "$SCENARIO" = transient ] && [ -f "$SERVICE_TEST_MARKER" ]; then exit 0; fi
printf 'seen' > "$SERVICE_TEST_MARKER"
printf 'Bootstrap failed: diagnostic preserved\n' >&2
if [ "$SCENARIO" = other ]; then exit 64; fi
exit 5
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.path().join("calls");
        let started = std::time::Instant::now();
        let output = cli(dir.path(), &base)
            .env("PATH", &tools)
            .env("SCENARIO", scenario)
            .env("SERVICE_TEST_LOG", &log)
            .env("SERVICE_TEST_MARKER", dir.path().join("attempt"))
            .args(["service", "install"])
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{scenario}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let calls = std::fs::read_to_string(&log).unwrap();
        let attempts = calls
            .lines()
            .filter(|line| line.starts_with("bootstrap "))
            .count();
        assert_eq!(attempts > 1, retry, "{scenario}: {calls}");
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("bootout "))
                .count(),
            if scenario == "not_loaded" { 0 } else { 1 }
        );
        if !success {
            assert!(String::from_utf8_lossy(&output.stderr).contains("diagnostic preserved"));
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "retry must be bounded"
        );
    }
}
