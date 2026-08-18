use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::fs;

use stem::client::HolderClient;
use stem::pty::SpawnSpec;
use stem::registry::{HolderLauncher, Registry};

use crate::claim::api_base_url_from_ws_url;
use crate::config::{BudArgs, DoctorArgs, DoctorFormat};
use crate::util::{default_shell, new_message_id};

/// Overall time box for the holder smoke check. `Registry::ensure` itself
/// waits up to 5s for the holder socket; the extra headroom covers kill +
/// registry GC on slow machines.
const HOLDER_SMOKE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    ok: bool,
    checks: Vec<DoctorCheck>,
}

#[derive(Debug, Serialize)]
struct DoctorCheck {
    name: &'static str,
    status: DoctorStatus,
    message: String,
    remediation: Vec<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DoctorStatus {
    Ok,
    Warning,
    Error,
}

impl DoctorReport {
    fn new(checks: Vec<DoctorCheck>) -> Self {
        let ok = checks
            .iter()
            .all(|check| !matches!(check.status, DoctorStatus::Error));
        Self { ok, checks }
    }

    fn has_errors(&self) -> bool {
        !self.ok
    }
}

pub async fn run_doctor(args: &BudArgs, doctor_args: &DoctorArgs) -> Result<()> {
    if doctor_args.cleanup_tmux {
        cleanup_tmux_sessions();
        return Ok(());
    }

    let report = build_doctor_report(args).await;
    match doctor_args.format {
        DoctorFormat::Text => print_text_report(&report),
        DoctorFormat::Json => println!("{}", serde_json::to_string_pretty(&report)?),
    }

    if doctor_args.strict && report.has_errors() {
        bail!("bud doctor found blocking errors");
    }

    Ok(())
}

/// One-shot cleanup of tmux-era Bud terminal sessions (`s_*`-prefixed).
/// Best-effort: silently a no-op when no tmux binary exists; errors from
/// individual kills are ignored.
fn cleanup_tmux_sessions() {
    if !command_available("tmux") {
        return;
    }
    let output = std::process::Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output();
    let Ok(output) = output else {
        return;
    };
    if !output.status.success() {
        // No server running or tmux errored: nothing to clean.
        return;
    }
    let mut killed = 0usize;
    for name in String::from_utf8_lossy(&output.stdout).lines() {
        let name = name.trim();
        if !name.starts_with("s_") {
            continue;
        }
        let result = std::process::Command::new("tmux")
            .args(["kill-session", "-t", name])
            .output();
        if matches!(result, Ok(ref out) if out.status.success()) {
            killed += 1;
            println!("killed legacy tmux session {name}");
        }
    }
    if killed == 0 {
        println!("no legacy s_* tmux sessions found");
    } else {
        println!("cleaned up {killed} legacy tmux session(s)");
    }
}

async fn build_doctor_report(args: &BudArgs) -> DoctorReport {
    let paths = args.resolved_paths();
    let mut checks = Vec::new();
    checks.push(check_platform());
    checks.push(check_server_url(&args.server));
    if let Ok(api_base) = api_base_url_from_ws_url(&args.server) {
        checks.push(check_tls_trust(&api_base).await);
    }
    checks.push(check_directory("base_dir", &paths.base_dir).await);
    checks.push(check_identity_file(&paths.identity_file).await);
    checks.push(check_directory("terminal_base_dir", &paths.terminal_base_dir).await);
    checks.push(check_terminal_registry(&paths.terminal_base_dir.join("term")).await);
    checks.push(check_holder_smoke(args.terminal_enabled).await);
    checks.push(check_shell(default_shell()).await);
    checks.push(check_service_manager());
    checks.push(check_supervision_directives());
    DoctorReport::new(checks)
}

/// The stem terminal registry base (`<terminal base dir>/term`, the same path
/// the terminal manager passes to `stem::registry::Registry`). Must exist (or
/// be creatable), be a directory with mode 0700, and be writable.
async fn check_terminal_registry(path: &Path) -> DoctorCheck {
    match fs::metadata(path).await {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // Registry::new creates the base with mode 0700 — the production path.
            match Registry::new(path.to_path_buf()) {
                Ok(_) => check_ok(
                    "terminal_registry",
                    format!("{} created (mode 700)", path.display()),
                ),
                Err(err) => check_error(
                    "terminal_registry",
                    format!("cannot create terminal registry {}: {}", path.display(), err),
                    vec![format!(
                        "Choose a writable terminal base dir with --terminal-base-dir or BUD_TERMINAL_BASE_DIR (registry lives at <terminal base dir>/term)."
                    )],
                ),
            }
        }
        Err(err) => check_error(
            "terminal_registry",
            format!("cannot inspect {}: {}", path.display(), err),
            vec![format!("Fix permissions on {}.", path.display())],
        ),
        Ok(metadata) => {
            if !metadata.is_dir() {
                return check_error(
                    "terminal_registry",
                    format!("{} exists but is not a directory", path.display()),
                    vec![format!(
                        "Move the file aside; Bud needs {} as its terminal session registry.",
                        path.display()
                    )],
                );
            }

            let probe_path = path.join(format!(".bud-doctor-write-{}", new_message_id()));
            if let Err(err) = fs::write(&probe_path, b"ok").await {
                return check_error(
                    "terminal_registry",
                    format!("{} is not writable: {}", path.display(), err),
                    vec![format!(
                        "Fix permissions on {} or choose another terminal base dir.",
                        path.display()
                    )],
                );
            }
            let _ = fs::remove_file(&probe_path).await;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let mode = metadata.permissions().mode() & 0o777;
                if !registry_mode_ok(mode) {
                    return check_warning(
                        "terminal_registry",
                        format!(
                            "{} permissions are {:o}; expected 700 (holder sockets and rings live here)",
                            path.display(),
                            mode
                        ),
                        vec![format!("Run: chmod 700 {}", shell_quote_path(path))],
                    );
                }
            }

            check_ok(
                "terminal_registry",
                format!("{} is a writable directory with mode 700", path.display()),
            )
        }
    }
}

/// Terminal registry dirs must be private to the owning user: holder control
/// sockets and output rings live inside.
fn registry_mode_ok(mode: u32) -> bool {
    mode & 0o777 == 0o700
}

/// Spawn a real detached holder through the daemon's own executable
/// (`bud term-hold`, via `stem::registry` — the exact path the terminal
/// manager uses in production), verify the socket + Hello handshake, kill it,
/// and verify registry cleanup. Runs against a throwaway directory, never the
/// real registry.
async fn check_holder_smoke(terminal_enabled: bool) -> DoctorCheck {
    if !terminal_enabled {
        return check_ok(
            "holder_smoke",
            "skipped: terminal support is disabled (enable with --terminal-enabled)".to_string(),
        );
    }

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => {
            return check_warning(
                "holder_smoke",
                format!("cannot resolve the bud executable path: {err}"),
                vec!["Holder spawning re-executes the bud binary (bud term-hold); run doctor from a normal install.".to_string()],
            );
        }
    };

    // Keep the path short: holder.sock must fit the ~104-byte Unix socket
    // path limit even under macOS's long per-user temp dirs.
    let id = new_message_id();
    let suffix = &id[id.len().saturating_sub(8)..];
    let base = std::env::temp_dir().join(format!("bud-doc-{suffix}"));
    let outcome = tokio::time::timeout(HOLDER_SMOKE_TIMEOUT, run_holder_smoke(&exe, &base)).await;
    let _ = std::fs::remove_dir_all(&base);

    match outcome {
        Ok(Ok(())) => check_ok(
            "holder_smoke",
            "spawned, probed, and cleaned up a detached terminal holder (bud term-hold)".to_string(),
        ),
        Ok(Err(err)) => check_error(
            "holder_smoke",
            format!("holder smoke check failed: {err:#}"),
            vec![
                "Terminal sessions will not work until a holder can be spawned.".to_string(),
                format!("Check that {} is executable and that {} is writable.", exe.display(), std::env::temp_dir().display()),
            ],
        ),
        Err(_) => check_error(
            "holder_smoke",
            format!(
                "holder smoke check timed out after {}s (spawn, Hello probe, kill, cleanup)",
                HOLDER_SMOKE_TIMEOUT.as_secs()
            ),
            vec![
                "A holder process could not be spawned and torn down in time; terminal sessions are likely to fail.".to_string(),
                format!("Inspect holder.log under {} if the directory persists.", base.display()),
            ],
        ),
    }
}

async fn run_holder_smoke(exe: &Path, base: &Path) -> Result<()> {
    // Short id: the session dir contributes to the holder.sock path length.
    const SESSION: &str = "smoke";

    let registry = Registry::new(base.to_path_buf()).context("create smoke registry")?;
    let launcher = HolderLauncher {
        program: exe.to_path_buf(),
        args_prefix: vec!["term-hold".into()],
    };
    let spec = SpawnSpec {
        shell: "/bin/sh".into(),
        args: vec!["-c".into(), "sleep 300".into()],
        cwd: base.to_string_lossy().into_owned(),
        env: vec![],
        cols: 80,
        rows: 24,
    };

    // ensure() waits (bounded) for the holder socket and Hello.
    let dir = registry
        .ensure(SESSION, &launcher, &spec, 64 * 1024)
        .await
        .context("spawn holder (bud term-hold)")?;
    if !registry.session_alive(SESSION).await {
        bail!("holder socket did not answer a Hello probe after spawn");
    }
    let meta = registry.meta(SESSION).context("read holder meta.json")?;
    if meta.holder_pid <= 0 || meta.child_pid <= 0 {
        bail!(
            "holder meta.json reports invalid pids (holder={}, child={})",
            meta.holder_pid,
            meta.child_pid
        );
    }

    let (mut ctl, _pushes) = HolderClient::connect(&dir)
        .await
        .context("connect holder control socket")?;
    ctl.kill().await.context("send KILL to holder")?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while registry.session_alive(SESSION).await {
        if tokio::time::Instant::now() >= deadline {
            bail!("holder still answering probes 3s after KILL");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // gc_stale won't touch a dir whose pid is still alive — poll it briefly.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let removed = registry.gc_stale().context("registry gc")?;
        if removed.iter().any(|id| id == SESSION) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("registry GC did not reclaim the dead smoke session within 3s");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Best-effort probe of installed service-manager definitions for the
/// supervision directives validated by spikes/holder-survival/findings.md:
/// launchd `AbandonProcessGroup=true` (defense-in-depth on macOS) and systemd
/// `KillMode=process` (load-bearing on Linux — the distro-default
/// `control-group` kills every detached holder on daemon stop/restart/upgrade).
fn check_supervision_directives() -> DoctorCheck {
    match std::env::consts::OS {
        "macos" => {
            let dir = match home_dir() {
                Some(home) => home.join("Library/LaunchAgents"),
                None => {
                    return check_ok(
                        "supervision_directives",
                        "HOME is unset; launchd plist probe skipped".to_string(),
                    );
                }
            };
            let plists = find_service_files(&dir, ".plist");
            if plists.is_empty() {
                return check_ok(
                    "supervision_directives",
                    "bud is not service-managed (no bud launchd plist found); directive check skipped".to_string(),
                );
            }
            let mut offenders = Vec::new();
            for path in &plists {
                let content = std::fs::read_to_string(path).unwrap_or_default();
                if plist_abandon_process_group(&content) != Some(true) {
                    offenders.push(path.display().to_string());
                }
            }
            if offenders.is_empty() {
                check_ok(
                    "supervision_directives",
                    format!(
                        "launchd plist sets AbandonProcessGroup=true ({})",
                        join_paths(&plists)
                    ),
                )
            } else {
                check_warning(
                    "supervision_directives",
                    format!(
                        "launchd plist missing AbandonProcessGroup=true: {}",
                        offenders.join(", ")
                    ),
                    vec![
                        "Terminal holders survive via daemonization alone on current macOS, but AbandonProcessGroup=true is the validated defense-in-depth directive (spikes/holder-survival/findings.md).".to_string(),
                        "Add <key>AbandonProcessGroup</key><true/> to the plist, then reload it with launchctl.".to_string(),
                    ],
                )
            }
        }
        "linux" => {
            let dir = match systemd_user_dir() {
                Some(dir) => dir,
                None => {
                    return check_ok(
                        "supervision_directives",
                        "no systemd user config dir resolvable; unit probe skipped".to_string(),
                    );
                }
            };
            let units = find_service_files(&dir, ".service");
            if units.is_empty() {
                return check_ok(
                    "supervision_directives",
                    "bud is not service-managed (no bud systemd user unit found); directive check skipped".to_string(),
                );
            }
            let mut offenders = Vec::new();
            for path in &units {
                let content = std::fs::read_to_string(path).unwrap_or_default();
                if systemd_unit_kill_mode(&content).as_deref() != Some("process") {
                    offenders.push(path.display().to_string());
                }
            }
            if offenders.is_empty() {
                check_ok(
                    "supervision_directives",
                    format!(
                        "systemd user unit sets KillMode=process ({})",
                        join_paths(&units)
                    ),
                )
            } else {
                check_warning(
                    "supervision_directives",
                    format!(
                        "systemd user unit missing KillMode=process: {}",
                        offenders.join(", ")
                    ),
                    vec![
                        "Terminal sessions will NOT survive daemon restarts or upgrades under systemd without KillMode=process — the default control-group KillMode reaps detached holders (spikes/holder-survival/findings.md).".to_string(),
                        "Add KillMode=process under [Service], then run: systemctl --user daemon-reload && systemctl --user restart <unit>.".to_string(),
                    ],
                )
            }
        }
        _ => check_ok(
            "supervision_directives",
            "no supported service manager on this OS; directive check skipped".to_string(),
        ),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn systemd_user_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(xdg).join("systemd/user"));
    }
    home_dir().map(|home| home.join(".config/systemd/user"))
}

/// Files in `dir` whose name contains "bud" and ends with `suffix`
/// (e.g. `dev.bud.daemon.plist`, `bud.service`). Best-effort: unreadable dirs
/// yield an empty list.
fn find_service_files(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.contains("bud") && name.ends_with(suffix))
                .unwrap_or(false)
        })
        .collect();
    found.sort();
    found
}

fn join_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Value of `AbandonProcessGroup` in a launchd plist: `Some(true)` /
/// `Some(false)` when the key is present with a boolean value, `None` when
/// absent or unparseable. Text-level scan — good enough for the well-formed
/// plists our installer/templates produce.
fn plist_abandon_process_group(content: &str) -> Option<bool> {
    let key_pos = content.find("<key>AbandonProcessGroup</key>")?;
    let rest = content[key_pos + "<key>AbandonProcessGroup</key>".len()..].trim_start();
    if rest.starts_with("<true/>") || rest.starts_with("<true />") {
        Some(true)
    } else if rest.starts_with("<false/>") || rest.starts_with("<false />") {
        Some(false)
    } else {
        None
    }
}

/// First `KillMode=` value in a systemd unit file, ignoring comment lines.
fn systemd_unit_kill_mode(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(value) = line.strip_prefix("KillMode=") {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn check_platform() -> DoctorCheck {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let supported = matches!(
        (os, arch),
        ("macos", "aarch64") | ("macos", "x86_64") | ("linux", "x86_64")
    );

    if supported {
        check_ok("platform", format!("supported platform: {os}/{arch}"))
    } else {
        check_error(
            "platform",
            format!("unsupported platform for v1 managed installs: {os}/{arch}"),
            vec![
                "Supported v1 platforms are macOS arm64/x64 and Ubuntu x64.".to_string(),
                "Use foreground/manual mode only if you are deliberately testing another platform."
                    .to_string(),
            ],
        )
    }
}

fn check_server_url(server_url: &str) -> DoctorCheck {
    match api_base_url_from_ws_url(server_url) {
        Ok(api_base) => check_ok(
            "server_url",
            format!("server URL parses; claim/bootstrap origin is {api_base}"),
        ),
        Err(err) => check_error(
            "server_url",
            format!("server URL is invalid: {err}"),
            vec!["Set BUD_SERVER_URL to a ws://, wss://, http://, or https:// URL.".to_string()],
        ),
    }
}

async fn check_tls_trust(api_base: &reqwest::Url) -> DoctorCheck {
    if api_base.scheme() != "https" {
        return check_warning(
            "tls_trust",
            format!(
                "TLS trust check skipped for non-HTTPS claim/bootstrap origin {}",
                api_base
            ),
            vec!["Production installs should use wss://app.bud.dev/ws.".to_string()],
        );
    }

    let host = api_base.host_str().unwrap_or_default();
    if host != "app.bud.dev" {
        return check_ok(
            "tls_trust",
            format!("TLS trust check skipped for non-production host {host}"),
        );
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return check_warning(
                "tls_trust",
                format!("could not initialize TLS client: {err}"),
                vec!["Verify this system has a usable TLS trust store.".to_string()],
            );
        }
    };

    match client.head(api_base.clone()).send().await {
        Ok(_) => check_ok(
            "tls_trust",
            "validated TLS trust for https://app.bud.dev".to_string(),
        ),
        Err(err) => check_warning(
            "tls_trust",
            format!("could not validate TLS trust for https://app.bud.dev: {err}"),
            vec![
                "Check network connectivity to app.bud.dev.".to_string(),
                "On Ubuntu/Debian, install or update ca-certificates.".to_string(),
            ],
        ),
    }
}

async fn check_directory(name: &'static str, path: &Path) -> DoctorCheck {
    if let Err(err) = fs::create_dir_all(path).await {
        return check_error(
            name,
            format!("cannot create {}: {}", path.display(), err),
            vec![format!(
                "Choose a writable path with --{} or BUD_{}.",
                name.replace('_', "-"),
                name.to_ascii_uppercase()
            )],
        );
    }

    let probe_path = path.join(format!(".bud-doctor-write-{}", new_message_id()));
    match fs::write(&probe_path, b"ok").await {
        Ok(()) => {
            let _ = fs::remove_file(&probe_path).await;
            check_ok(name, format!("{} is writable", path.display()))
        }
        Err(err) => check_error(
            name,
            format!("{} is not writable: {}", path.display(), err),
            vec![format!(
                "Fix permissions on {} or choose another path.",
                path.display()
            )],
        ),
    }
}

async fn check_identity_file(path: &Path) -> DoctorCheck {
    match fs::metadata(path).await {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let mode = metadata.permissions().mode() & 0o777;
                if mode != 0o600 {
                    return check_warning(
                        "identity_file",
                        format!(
                            "{} permissions are {:o}; expected 600",
                            path.display(),
                            mode
                        ),
                        vec![format!("Run: chmod 600 {}", shell_quote_path(path))],
                    );
                }
            }
            check_ok(
                "identity_file",
                format!("{} exists with acceptable permissions", path.display()),
            )
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => check_ok(
            "identity_file",
            format!(
                "{} does not exist yet; first claim will create it",
                path.display()
            ),
        ),
        Err(err) => check_error(
            "identity_file",
            format!("cannot inspect {}: {}", path.display(), err),
            vec![format!("Fix permissions on {}.", path.display())],
        ),
    }
}

async fn check_shell(shell: &str) -> DoctorCheck {
    match fs::metadata(shell).await {
        Ok(metadata) if metadata.is_file() && is_executable_file(&metadata) => {
            check_ok("shell", format!("{shell} exists and is executable"))
        }
        Ok(metadata) if metadata.is_file() => check_error(
            "shell",
            format!("{shell} exists but is not executable"),
            vec!["Set SHELL to an executable shell path before starting Bud.".to_string()],
        ),
        Ok(_) => check_error(
            "shell",
            format!("{shell} is not a regular executable file"),
            vec!["Set SHELL to a valid shell path before starting Bud.".to_string()],
        ),
        Err(err) => check_error(
            "shell",
            format!("{shell} is not available: {err}"),
            vec!["Install bash/sh or set SHELL to a valid shell path.".to_string()],
        ),
    }
}

#[cfg(unix)]
fn is_executable_file(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(_metadata: &std::fs::Metadata) -> bool {
    true
}

fn check_service_manager() -> DoctorCheck {
    match std::env::consts::OS {
        "macos" => {
            if command_available("launchctl") {
                check_ok(
                    "service_manager",
                    "launchd user services are available".to_string(),
                )
            } else {
                check_warning(
                    "service_manager",
                    "launchctl was not found; managed background install may be unavailable"
                        .to_string(),
                    vec!["Use foreground mode on this machine.".to_string()],
                )
            }
        }
        "linux" => {
            if command_available("systemctl") && std::env::var_os("XDG_RUNTIME_DIR").is_some() {
                check_ok(
                    "service_manager",
                    "systemd user services appear available".to_string(),
                )
            } else {
                check_warning(
                    "service_manager",
                    "systemd user services were not detected".to_string(),
                    vec![
                        "Bud v1 managed Linux installs require systemd user services.".to_string(),
                        "Use foreground mode on non-systemd Linux.".to_string(),
                    ],
                )
            }
        }
        _ => check_warning(
            "service_manager",
            "managed user services are unsupported on this OS".to_string(),
            vec!["Use foreground mode on this platform.".to_string()],
        ),
    }
}

fn command_available(command: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(command);
        candidate.is_file()
    })
}

fn check_ok(name: &'static str, message: String) -> DoctorCheck {
    DoctorCheck {
        name,
        status: DoctorStatus::Ok,
        message,
        remediation: Vec::new(),
    }
}

fn check_warning(name: &'static str, message: String, remediation: Vec<String>) -> DoctorCheck {
    DoctorCheck {
        name,
        status: DoctorStatus::Warning,
        message,
        remediation,
    }
}

fn check_error(name: &'static str, message: String, remediation: Vec<String>) -> DoctorCheck {
    DoctorCheck {
        name,
        status: DoctorStatus::Error,
        message,
        remediation,
    }
}

fn print_text_report(report: &DoctorReport) {
    println!("Bud doctor");
    println!("==========");
    for check in &report.checks {
        let marker = match check.status {
            DoctorStatus::Ok => "ok",
            DoctorStatus::Warning => "warn",
            DoctorStatus::Error => "error",
        };
        println!("[{marker}] {}: {}", check.name, check.message);
        for remediation in &check.remediation {
            println!("       {remediation}");
        }
    }
    println!();
    if report.ok {
        println!("Bud doctor passed without blocking errors.");
    } else {
        println!("Bud doctor found blocking errors.");
    }
}

fn shell_quote_path(path: &Path) -> String {
    let rendered = path.to_string_lossy();
    let escaped = rendered.replace('\'', "'\"'\"'");
    format!("'{}'", escaped)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn command_available_rejects_unknown_command() {
        assert!(!command_available("bud-command-that-should-not-exist"));
    }

    #[tokio::test]
    async fn tls_check_skips_non_production_hosts() {
        let api_base = reqwest::Url::parse("https://localhost:8443/").expect("url");
        let check = check_tls_trust(&api_base).await;

        assert_eq!(check.status, DoctorStatus::Ok);
        assert_eq!(check.name, "tls_trust");
    }

    #[test]
    fn shell_quote_path_escapes_single_quotes() {
        assert_eq!(
            shell_quote_path(&PathBuf::from("/tmp/bud's/identity.json")),
            "'/tmp/bud'\"'\"'s/identity.json'"
        );
    }

    #[test]
    fn registry_mode_accepts_only_0700() {
        assert!(registry_mode_ok(0o700));
        assert!(!registry_mode_ok(0o755));
        assert!(!registry_mode_ok(0o750));
        assert!(!registry_mode_ok(0o777));
        assert!(!registry_mode_ok(0o600));
    }

    #[tokio::test]
    async fn terminal_registry_check_creates_missing_dir_with_0700() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("term");

        let check = check_terminal_registry(&path).await;

        assert_eq!(check.status, DoctorStatus::Ok, "{}", check.message);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_registry_check_warns_on_mode_drift() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("term");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

        let check = check_terminal_registry(&path).await;

        assert_eq!(check.status, DoctorStatus::Warning, "{}", check.message);
        assert!(check.message.contains("755"), "{}", check.message);
        assert!(
            check.remediation.iter().any(|r| r.contains("chmod 700")),
            "{:?}",
            check.remediation
        );
    }

    #[tokio::test]
    async fn terminal_registry_check_rejects_non_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("term");
        std::fs::write(&path, b"not a dir").unwrap();

        let check = check_terminal_registry(&path).await;

        assert_eq!(check.status, DoctorStatus::Error);
        assert!(
            check.message.contains("not a directory"),
            "{}",
            check.message
        );
    }

    #[tokio::test]
    async fn holder_smoke_skips_when_terminal_disabled() {
        let check = check_holder_smoke(false).await;

        assert_eq!(check.status, DoctorStatus::Ok);
        assert!(check.message.contains("skipped"), "{}", check.message);
    }

    #[test]
    fn plist_abandon_process_group_parses_presence_and_value() {
        let with_true = r#"
            <key>Label</key><string>dev.bud.daemon</string>
            <key>AbandonProcessGroup</key>
            <true/>
        "#;
        let with_false = "<key>AbandonProcessGroup</key><false/>";
        let absent = "<key>KeepAlive</key><true/>";
        let malformed = "<key>AbandonProcessGroup</key><string>yes</string>";

        assert_eq!(plist_abandon_process_group(with_true), Some(true));
        assert_eq!(plist_abandon_process_group(with_false), Some(false));
        assert_eq!(plist_abandon_process_group(absent), None);
        assert_eq!(plist_abandon_process_group(malformed), None);
    }

    #[test]
    fn systemd_unit_kill_mode_parses_first_uncommented_value() {
        let unit = "[Unit]\nDescription=Bud daemon\n\n[Service]\n# KillMode=control-group\nExecStart=/home/u/.bud/bin/bud\nKillMode=process\nRestart=on-failure\n";
        assert_eq!(systemd_unit_kill_mode(unit).as_deref(), Some("process"));

        let default_unit = "[Service]\nExecStart=/usr/bin/bud\n";
        assert_eq!(systemd_unit_kill_mode(default_unit), None);

        let spaced = "[Service]\n  KillMode= control-group \n";
        assert_eq!(
            systemd_unit_kill_mode(spaced).as_deref(),
            Some("control-group")
        );
    }

    #[test]
    fn find_service_files_filters_by_name_and_suffix() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("dev.bud.daemon.plist"), b"x").unwrap();
        std::fs::write(tmp.path().join("bud.service"), b"x").unwrap();
        std::fs::write(tmp.path().join("com.other.tool.plist"), b"x").unwrap();
        std::fs::write(tmp.path().join("bud.txt"), b"x").unwrap();

        let plists = find_service_files(tmp.path(), ".plist");
        assert_eq!(plists.len(), 1);
        assert!(plists[0].ends_with("dev.bud.daemon.plist"));

        let units = find_service_files(tmp.path(), ".service");
        assert_eq!(units.len(), 1);
        assert!(units[0].ends_with("bud.service"));

        assert!(find_service_files(&tmp.path().join("missing"), ".plist").is_empty());
    }
}
