//! `bud doctor` end-to-end: run the real binary and assert the stem-era
//! terminal checks (registry dir + holder spawn/probe/kill smoke) pass on a
//! healthy install. The holder smoke re-execs this same binary as
//! `bud term-hold`, so this exercises the production spawn path.

use std::path::PathBuf;
use std::process::Command;

#[test]
fn doctor_json_reports_terminal_registry_and_holder_smoke_ok() {
    let bud_exe = PathBuf::from(env!("CARGO_BIN_EXE_bud"));
    let tmp = tempfile::tempdir().unwrap();
    let base_dir = tmp.path().join("base");
    let home_dir = tmp.path().join("home");
    std::fs::create_dir_all(&home_dir).unwrap();

    let output = Command::new(&bud_exe)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home_dir)
        .env("TMPDIR", tmp.path())
        .env("BUD_BASE_DIR", &base_dir)
        .env("BUD_TERMINAL_ENABLED", "true")
        .args(["doctor", "--format", "json"])
        .output()
        .expect("run bud doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "doctor exited nonzero\nstdout: {stdout}\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let report: serde_json::Value = serde_json::from_str(&stdout).expect("doctor JSON output");
    let checks = report["checks"].as_array().expect("checks array");
    let status_of = |name: &str| -> String {
        checks
            .iter()
            .find(|check| check["name"] == name)
            .unwrap_or_else(|| panic!("missing check {name} in {stdout}"))["status"]
            .as_str()
            .unwrap()
            .to_string()
    };

    assert_eq!(status_of("terminal_registry"), "ok", "output: {stdout}");
    assert_eq!(status_of("holder_smoke"), "ok", "output: {stdout}");
    // Fresh HOME → not service-managed is informational, never a failure.
    assert_eq!(
        status_of("supervision_directives"),
        "ok",
        "output: {stdout}"
    );

    // Registry base was created with the production layout and mode.
    let registry_dir = base_dir.join("term");
    assert!(registry_dir.is_dir());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&registry_dir)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
    }
}
