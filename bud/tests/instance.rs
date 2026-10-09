//! Exercise the real CLI with isolated HOME/config and fake service managers.
use std::path::Path;
use std::process::Command;

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
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SERVICE_TEST_LOG\"\n",
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
