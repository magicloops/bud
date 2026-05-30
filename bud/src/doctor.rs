use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::Serialize;
use tokio::fs;

use crate::claim::api_base_url_from_ws_url;
use crate::config::{BudArgs, DoctorArgs, DoctorFormat};
use crate::terminal::probe_tmux;
use crate::util::{default_shell, new_message_id};

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
    checks.push(check_shell(default_shell()).await);
    checks.push(check_tmux(args.terminal_enabled));
    checks.push(check_service_manager());
    DoctorReport::new(checks)
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
            vec!["Production installs should use wss://api.bud.dev/ws.".to_string()],
        );
    }

    let host = api_base.host_str().unwrap_or_default();
    if host != "api.bud.dev" {
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
            "validated TLS trust for https://api.bud.dev".to_string(),
        ),
        Err(err) => check_warning(
            "tls_trust",
            format!("could not validate TLS trust for https://api.bud.dev: {err}"),
            vec![
                "Check network connectivity to api.bud.dev.".to_string(),
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

fn check_tmux(terminal_enabled: bool) -> DoctorCheck {
    if probe_tmux() {
        return check_ok("tmux", "tmux is available".to_string());
    }

    let remediation = tmux_remediation();
    if terminal_enabled {
        check_error(
            "tmux",
            "tmux is required for Bud terminal support and was not found".to_string(),
            remediation,
        )
    } else {
        check_warning(
            "tmux",
            "tmux was not found; terminal support is currently disabled".to_string(),
            remediation,
        )
    }
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

fn tmux_remediation() -> Vec<String> {
    match std::env::consts::OS {
        "macos" => vec![
            "Homebrew: brew install tmux".to_string(),
            "MacPorts: sudo port install tmux".to_string(),
        ],
        "linux" => linux_tmux_remediation(),
        _ => vec!["Install tmux with your OS package manager.".to_string()],
    }
}

fn linux_tmux_remediation() -> Vec<String> {
    let os_release = std::fs::read_to_string("/etc/os-release")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if os_release.contains("id=ubuntu") || os_release.contains("id=debian") {
        vec![
            "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y tmux ca-certificates"
                .to_string(),
        ]
    } else if os_release.contains("id=fedora")
        || os_release.contains("id=\"rhel\"")
        || os_release.contains("id=rhel")
        || os_release.contains("id=centos")
    {
        vec!["Fedora/RHEL: sudo dnf install -y tmux ca-certificates".to_string()]
    } else if os_release.contains("id=arch") {
        vec!["Arch: sudo pacman -S tmux".to_string()]
    } else {
        vec![
            "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y tmux ca-certificates"
                .to_string(),
            "Fedora/RHEL: sudo dnf install -y tmux ca-certificates".to_string(),
            "Arch: sudo pacman -S tmux".to_string(),
        ]
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
    fn linux_unknown_remediation_includes_supported_package_managers() {
        let commands = linux_tmux_remediation();
        assert!(!commands.is_empty());
    }

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
}
