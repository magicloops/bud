//! Managed daemon lifecycle: platform service install and the standard-user
//! verbs (`bud start|stop|restart|status|logs`), per
//! design/managed-daemon-lifecycle.md Option A.
//!
//! Invariants:
//! - Terminal holders (`bud term-hold`) must outlive the daemon. The
//!   generated supervision directives (`KillMode=process`,
//!   `AbandonProcessGroup`) and the pidfile fallback (SIGTERM to the daemon
//!   pid only, never a process group) both encode this.
//! - `bud.env` is the single configuration home. Both service files and the
//!   pidfile fallback source it; nothing else writes daemon env.
//! - Identity is never touched by install/uninstall/start/stop.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::config::BudArgs;
use crate::identity::load_identity;

pub const LAUNCHD_LABEL: &str = "dev.bud.daemon";
pub const SYSTEMD_UNIT_NAME: &str = "bud.service";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceManager {
    Launchd,
    SystemdUser,
    None,
}

impl ServiceManager {
    pub fn detect() -> Self {
        if cfg!(target_os = "macos") {
            return ServiceManager::Launchd;
        }
        if cfg!(target_os = "linux") && systemd_user_available() {
            return ServiceManager::SystemdUser;
        }
        ServiceManager::None
    }

    pub fn describe(&self) -> &'static str {
        match self {
            ServiceManager::Launchd => "launchd user agent",
            ServiceManager::SystemdUser => "systemd user service",
            ServiceManager::None => "no supported service manager",
        }
    }
}

fn systemd_user_available() -> bool {
    Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Everything the generators and verbs need, resolved once.
pub struct LifecyclePaths {
    pub base_dir: PathBuf,
    pub binary: PathBuf,
    pub env_file: PathBuf,
    pub log_dir: PathBuf,
    pub log_file: PathBuf,
    pub pid_file: PathBuf,
    pub identity_file: PathBuf,
}

impl LifecyclePaths {
    pub fn resolve(args: &BudArgs) -> Result<Self> {
        let resolved = args.resolved_paths();
        let base_dir = resolved.base_dir.clone();
        // Prefer the installed binary path when it exists (the service file
        // must survive `cargo` dev binaries moving around); fall back to the
        // current executable for dev installs.
        let installed = base_dir.join("bin").join("bud");
        let binary = if installed.is_file() {
            installed
        } else {
            std::env::current_exe().context("cannot resolve current executable")?
        };
        Ok(Self {
            env_file: base_dir.join("bud.env"),
            log_dir: base_dir.join("logs"),
            log_file: base_dir.join("logs").join("daemon.log"),
            pid_file: base_dir.join("bud.pid"),
            identity_file: resolved.identity_file,
            base_dir,
            binary,
        })
    }

    pub fn launchd_plist_path(&self) -> PathBuf {
        home_dir()
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"))
    }

    pub fn systemd_unit_path(&self) -> PathBuf {
        home_dir()
            .join(".config")
            .join("systemd")
            .join("user")
            .join(SYSTEMD_UNIT_NAME)
    }

    pub fn service_file_path(&self, manager: ServiceManager) -> Option<PathBuf> {
        match manager {
            ServiceManager::Launchd => Some(self.launchd_plist_path()),
            ServiceManager::SystemdUser => Some(self.systemd_unit_path()),
            ServiceManager::None => None,
        }
    }

    pub fn service_installed(&self, manager: ServiceManager) -> bool {
        self.service_file_path(manager)
            .map(|p| p.is_file())
            .unwrap_or(false)
    }
}

fn home_dir() -> PathBuf {
    PathBuf::from(shellexpand::tilde("~").into_owned())
}

// ---------------------------------------------------------------------------
// Service file generation (pure — fixture-tested)
// ---------------------------------------------------------------------------

/// launchd has no EnvironmentFile: source `bud.env` in a shell wrapper so it
/// stays the single configuration home.
pub fn launchd_plist(paths: &LifecyclePaths) -> String {
    let exec = format!(
        "set -a; [ -f {env} ] && . {env}; set +a; exec {bin} --terminal-enabled",
        env = shell_quote(&paths.env_file.to_string_lossy()),
        bin = shell_quote(&paths.binary.to_string_lossy()),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>{exec}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exec = xml_escape(&exec),
        log = xml_escape(&paths.log_file.to_string_lossy()),
    )
}

/// `KillMode=process` is load-bearing: the default (`control-group`) would
/// reap detached `bud term-hold` holders on every daemon restart.
pub fn systemd_unit(paths: &LifecyclePaths) -> String {
    format!(
        r#"[Unit]
Description=Bud daemon
After=network-online.target

[Service]
EnvironmentFile=-{env}
ExecStart={bin} --terminal-enabled
Restart=on-failure
RestartSec=2
KillMode=process
StandardOutput=append:{log}
StandardError=append:{log}

[Install]
WantedBy=default.target
"#,
        env = paths.env_file.display(),
        bin = paths.binary.display(),
        log = paths.log_file.display(),
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

// ---------------------------------------------------------------------------
// bud.env parsing (single-quoted KEY='value' lines, as the installer writes)
// ---------------------------------------------------------------------------

pub fn parse_env_file(content: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_start_matches("export ").trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let raw = raw.trim();
        let value = if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
            raw[1..raw.len() - 1].replace(r"'\''", "'")
        } else if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
            raw[1..raw.len() - 1].to_string()
        } else {
            raw.to_string()
        };
        vars.push((key.to_string(), value));
    }
    vars
}

/// Replace or append `KEY='value'` in the env file, preserving every other
/// line byte-for-byte (bud.env is the single config home; edits must be
/// surgical).
pub fn upsert_env_var(path: &std::path::Path, key: &str, value: &str) -> Result<()> {
    let quoted = format!("{key}={}", sh_single_quote(value));
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in content.lines() {
        let trimmed = line.trim_start().trim_start_matches("export ").trim_start();
        if trimmed.starts_with(&format!("{key}=")) && !replaced {
            lines.push(quoted.clone());
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        lines.push(quoted);
    }
    let mut output = lines.join("\n");
    output.push('\n');
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, output)?;
    Ok(())
}

/// Remove `KEY=...` lines; returns whether anything was removed.
pub fn remove_env_var(path: &std::path::Path, key: &str) -> Result<bool> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err.into()),
    };
    let mut removed = false;
    let lines: Vec<&str> = content
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start().trim_start_matches("export ").trim_start();
            if trimmed.starts_with(&format!("{key}=")) {
                removed = true;
                false
            } else {
                true
            }
        })
        .collect();
    if removed {
        let mut output = lines.join("\n");
        output.push('\n');
        std::fs::write(path, output)?;
    }
    Ok(removed)
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn load_env_file(paths: &LifecyclePaths) -> Vec<(String, String)> {
    std::fs::read_to_string(&paths.env_file)
        .map(|content| parse_env_file(&content))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

pub fn service_install(paths: &LifecyclePaths) -> Result<()> {
    let manager = ServiceManager::detect();
    std::fs::create_dir_all(&paths.log_dir)
        .with_context(|| format!("cannot create {}", paths.log_dir.display()))?;

    match manager {
        ServiceManager::Launchd => {
            let plist_path = paths.launchd_plist_path();
            if let Some(parent) = plist_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&plist_path, launchd_plist(paths))
                .with_context(|| format!("cannot write {}", plist_path.display()))?;
            // Re-installs: drop any loaded copy first (ignore "not loaded").
            let _ = run_quiet("launchctl", &["bootout", &gui_domain_target()]);
            run_checked(
                "launchctl",
                &["bootstrap", &gui_domain(), &plist_path.to_string_lossy()],
            )?;
            println!(
                "Installed launchd agent {plist_path}",
                plist_path = plist_path.display()
            );
        }
        ServiceManager::SystemdUser => {
            let unit_path = paths.systemd_unit_path();
            if let Some(parent) = unit_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&unit_path, systemd_unit(paths))
                .with_context(|| format!("cannot write {}", unit_path.display()))?;
            run_checked("systemctl", &["--user", "daemon-reload"])?;
            run_checked("systemctl", &["--user", "enable", SYSTEMD_UNIT_NAME])?;
            // restart, not `enable --now`: reinstalls/upgrades run over an
            // ALREADY-RUNNING unit, and `--now` only starts stopped units —
            // the old daemon kept running the old binary/env (seen live:
            // a freshly enabled local-LLM endpoint never reached the
            // picker because the pre-upgrade daemon never re-helloed).
            run_checked("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME])?;
            // Linger keeps the user manager (and Bud) alive without an open
            // session. Best-effort: polkit may refuse on hardened distros.
            if !run_quiet("loginctl", &["enable-linger"]) {
                println!(
                    "warning: could not enable lingering; Bud will stop when you log out.\n\
                     Run `loginctl enable-linger {}` manually (may need sudo).",
                    whoami()
                );
            }
            println!(
                "Installed systemd user service {unit}",
                unit = unit_path.display()
            );
        }
        ServiceManager::None => {
            bail!(
                "no supported service manager found (need launchd or systemd --user); \
                 run `bud start` for pidfile-managed background mode or `bud run` for foreground"
            );
        }
    }
    println!("Bud is running in the background. Try `bud status`.");
    Ok(())
}

pub fn service_uninstall(paths: &LifecyclePaths) -> Result<()> {
    match ServiceManager::detect() {
        ServiceManager::Launchd => {
            let plist_path = paths.launchd_plist_path();
            let _ = run_quiet("launchctl", &["bootout", &gui_domain_target()]);
            if plist_path.is_file() {
                std::fs::remove_file(&plist_path)?;
            }
            println!("Removed launchd agent (identity and terminal sessions untouched).");
        }
        ServiceManager::SystemdUser => {
            let unit_path = paths.systemd_unit_path();
            let _ = run_quiet(
                "systemctl",
                &["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
            );
            if unit_path.is_file() {
                std::fs::remove_file(&unit_path)?;
            }
            let _ = run_quiet("systemctl", &["--user", "daemon-reload"]);
            println!("Removed systemd user service (identity and terminal sessions untouched).");
        }
        ServiceManager::None => {
            println!("No service manager detected; nothing to uninstall.");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

pub fn start(paths: &LifecyclePaths) -> Result<()> {
    let manager = ServiceManager::detect();
    if paths.service_installed(manager) {
        match manager {
            ServiceManager::Launchd => {
                let plist = paths.launchd_plist_path();
                let _ = run_quiet("launchctl", &["bootout", &gui_domain_target()]);
                run_checked(
                    "launchctl",
                    &["bootstrap", &gui_domain(), &plist.to_string_lossy()],
                )?;
            }
            ServiceManager::SystemdUser => {
                run_checked("systemctl", &["--user", "start", SYSTEMD_UNIT_NAME])?;
            }
            ServiceManager::None => unreachable!(),
        }
        println!("Bud started. Try `bud status`.");
        return Ok(());
    }
    start_pidfile(paths)
}

pub fn stop(paths: &LifecyclePaths) -> Result<()> {
    let manager = ServiceManager::detect();
    if paths.service_installed(manager) {
        match manager {
            ServiceManager::Launchd => {
                run_checked("launchctl", &["bootout", &gui_domain_target()])?;
            }
            ServiceManager::SystemdUser => {
                run_checked("systemctl", &["--user", "stop", SYSTEMD_UNIT_NAME])?;
            }
            ServiceManager::None => unreachable!(),
        }
    } else {
        stop_pidfile(paths)?;
    }
    println!("Bud stopped. Terminal sessions keep running; they reattach on the next start.");
    Ok(())
}

pub fn restart(paths: &LifecyclePaths) -> Result<()> {
    let manager = ServiceManager::detect();
    if paths.service_installed(manager) {
        match manager {
            ServiceManager::Launchd => {
                run_checked(
                    "launchctl",
                    &[
                        "kickstart",
                        "-k",
                        &format!("{}/{}", gui_domain(), LAUNCHD_LABEL),
                    ],
                )?;
            }
            ServiceManager::SystemdUser => {
                run_checked("systemctl", &["--user", "restart", SYSTEMD_UNIT_NAME])?;
            }
            ServiceManager::None => unreachable!(),
        }
        println!("Bud restarted. Terminal sessions reattach automatically.");
        return Ok(());
    }
    let _ = stop_pidfile(paths);
    start_pidfile(paths)
}

pub async fn status(paths: &LifecyclePaths, args: &BudArgs) -> Result<()> {
    let manager = ServiceManager::detect();
    println!("Bud status");
    println!("==========");
    // Best-effort update check: short budget, silent on failure.
    let current = crate::upgrade::current_release_version();
    match crate::upgrade::fetch_manifest(crate::upgrade::STATUS_CHECK_TIMEOUT).await {
        Ok(manifest) if crate::upgrade::update_available(&current, &manifest.version) => {
            println!(
                "version: {current} (update available: {} — run `bud upgrade`)",
                crate::upgrade::normalize_version(&manifest.version)
            );
        }
        Ok(_) => println!("version: {current} (up to date)"),
        Err(_) => println!("version: {current}"),
    }
    println!("service manager: {}", manager.describe());

    let installed = paths.service_installed(manager);
    let state = if installed {
        match manager {
            ServiceManager::Launchd => launchd_state(),
            ServiceManager::SystemdUser => systemd_state(),
            ServiceManager::None => "unknown".to_string(),
        }
    } else {
        "not installed (run `bud service install`)".to_string()
    };
    println!("service: {state}");

    match read_live_pid(paths) {
        Some(pid) => println!("daemon pid: {pid}"),
        None => {
            if !installed {
                println!("daemon pid: not running");
            }
        }
    }

    match load_identity(&paths.identity_file).await? {
        Some(identity) => {
            println!("identity: `{}` ({})", identity.name, identity.bud_id);
        }
        None => {
            println!("identity: not claimed — run `bud claim` (the claim link prints there)");
        }
    }

    let env = load_env_file(paths);
    let server = env
        .iter()
        .find(|(k, _)| k == "BUD_SERVER_URL")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| args.server.clone());
    println!("server: {server}");
    match configured_llm_url(paths, args) {
        Some(url) => {
            let client = reqwest::Client::new();
            match crate::local_llm::probe_ds4_url(&client, &url).await {
                Ok((crate::local_llm::Ds4ModelMatch::Found(served), _)) => {
                    println!("llm: ds4 at {url} (serving `{served}`)");
                }
                Ok((_, models)) if !models.is_empty() => {
                    println!(
                        "llm: local server at {url} serving {} (experimental)",
                        models.join(", ")
                    );
                }
                _ => println!("llm: configured at {url} but no server responded"),
            }
        }
        None => println!("llm: not configured (enable with `bud llm enable <url>`)"),
    }
    println!("holders: {} terminal holder(s) running", holder_count());
    println!("logs: {} (tail with `bud logs`)", paths.log_file.display());
    Ok(())
}

pub fn logs(paths: &LifecyclePaths, lines: usize, follow: bool) -> Result<()> {
    let path = &paths.log_file;
    if !path.is_file() {
        bail!(
            "no log file at {} (the service writes it after the first managed start)",
            path.display()
        );
    }
    let mut file = std::fs::File::open(path)?;
    let content = {
        let mut buf = String::new();
        file.read_to_string(&mut buf)?;
        buf
    };
    let tail_start = content.lines().count().saturating_sub(lines);
    for line in content.lines().skip(tail_start) {
        println!("{line}");
    }
    if !follow {
        return Ok(());
    }
    let mut offset = file.seek(SeekFrom::End(0))?;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let len = std::fs::metadata(path)?.len();
        if len < offset {
            offset = 0; // rotated/truncated
        }
        if len > offset {
            let mut file = std::fs::File::open(path)?;
            file.seek(SeekFrom::Start(offset))?;
            let mut chunk = String::new();
            file.read_to_string(&mut chunk)?;
            print!("{chunk}");
            use std::io::Write as _;
            std::io::stdout().flush().ok();
            offset = len;
        }
    }
}

// ---------------------------------------------------------------------------
// Local LLM (`bud llm probe|enable|disable`)
// ---------------------------------------------------------------------------

pub const LLM_ENV_KEY: &str = "BUD_LOCAL_LLM_DS4_URL";
pub const LLM_GENERIC_ENV_KEY: &str = "BUD_LOCAL_LLM_URL";
const LLM_DEFAULT_CANDIDATES: &[&str] = &["http://127.0.0.1:8888/v1", "http://127.0.0.1:8000/v1"];

fn configured_llm_url(paths: &LifecyclePaths, args: &BudArgs) -> Option<String> {
    let env = load_env_file(paths);
    env.iter()
        .find(|(key, _)| key == LLM_ENV_KEY)
        .or_else(|| env.iter().find(|(key, _)| key == LLM_GENERIC_ENV_KEY))
        .map(|(_, value)| value.clone())
        .or_else(|| args.local_llm_ds4_url.clone())
        .or_else(|| args.local_llm_url.clone())
}

pub async fn llm_probe(
    paths: &LifecyclePaths,
    args: &BudArgs,
    url: Option<String>,
    require_validated: bool,
) -> Result<()> {
    let candidates: Vec<String> = match url {
        Some(url) => vec![url],
        None => {
            let mut candidates = Vec::new();
            if let Some(configured) = configured_llm_url(paths, args) {
                candidates.push(configured);
            }
            for default in LLM_DEFAULT_CANDIDATES {
                if !candidates.iter().any(|c| c == default) {
                    candidates.push((*default).to_string());
                }
            }
            candidates
        }
    };

    let client = reqwest::Client::new();
    for candidate in &candidates {
        match crate::local_llm::probe_ds4_url(&client, candidate).await {
            Ok((family, models)) if !models.is_empty() => {
                let validated = matches!(family, crate::local_llm::Ds4ModelMatch::Found(_));
                if require_validated && !validated {
                    println!(
                        "{candidate} serves {} model(s) ({}) but none from a validated family.",
                        models.len(),
                        models.join(", ")
                    );
                    continue;
                }
                if let crate::local_llm::Ds4ModelMatch::Found(served) = &family {
                    println!("Found a DeepSeek v4 server at {candidate} (serving `{served}`).");
                } else {
                    println!(
                        "Found a local LLM server at {candidate} serving {} model(s): {} (experimental - unvalidated for agentic tool use).",
                        models.len(),
                        models.join(", ")
                    );
                }
                println!("Enable it with: bud llm enable {candidate}");
                return Ok(());
            }
            Ok(_) => {
                println!("{candidate} answered but advertised no models.");
            }
            Err(_) => {}
        }
    }
    bail!(
        "no local LLM server found (tried {})",
        candidates.join(", ")
    );
}

pub async fn llm_enable(paths: &LifecyclePaths, url: String, force: bool) -> Result<()> {
    let client = reqwest::Client::new();
    match crate::local_llm::probe_ds4_url(&client, &url).await {
        Ok((crate::local_llm::Ds4ModelMatch::Found(served), _)) => {
            println!("Verified DeepSeek v4 at {url} (serving `{served}`).");
        }
        Ok((_, models)) if !models.is_empty() => {
            println!(
                "Verified a local LLM server at {url} serving {} model(s): {}.",
                models.len(),
                models.join(", ")
            );
            println!(
                "Note: these models are experimental for agentic use (unvalidated tool calling)."
            );
        }
        Ok(_) if !force => {
            bail!("{url} answered but advertised no models. Rerun with --force to persist anyway.");
        }
        Err(err) if !force => {
            bail!("could not reach {url}: {err}. Rerun with --force to persist anyway.");
        }
        _ => {
            println!("warning: persisting {url} without a successful probe (--force).");
        }
    }
    // Validation IS the daemon's own config parser (normalize_ds4_url
    // delegates to it), so what we persist here cannot be rejected at
    // startup. New installs write the generic key; the legacy ds4-named
    // key is removed so it can never shadow the generic one.
    crate::local_llm::normalize_ds4_url(&url)?;
    upsert_env_var(&paths.env_file, LLM_GENERIC_ENV_KEY, &url)?;
    let _ = remove_env_var(&paths.env_file, LLM_ENV_KEY)?;
    println!(
        "Saved {LLM_GENERIC_ENV_KEY} to {}.",
        paths.env_file.display()
    );
    println!("Apply it with: bud restart");
    Ok(())
}

pub fn llm_disable(paths: &LifecyclePaths) -> Result<()> {
    let removed_generic = remove_env_var(&paths.env_file, LLM_GENERIC_ENV_KEY)?;
    let removed_legacy = remove_env_var(&paths.env_file, LLM_ENV_KEY)?;
    if removed_generic || removed_legacy {
        println!(
            "Removed the local LLM endpoint from {}.",
            paths.env_file.display()
        );
        println!("Apply it with: bud restart");
    } else {
        println!("Local LLM endpoint was not configured; nothing to do.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pidfile fallback (no service manager, or service not installed)
// ---------------------------------------------------------------------------

fn start_pidfile(paths: &LifecyclePaths) -> Result<()> {
    if let Some(pid) = read_live_pid(paths) {
        println!("Bud is already running (pid {pid}).");
        return Ok(());
    }
    std::fs::create_dir_all(&paths.log_dir)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log_file)?;
    let log_err = log.try_clone()?;

    let mut command = Command::new(&paths.binary);
    command
        .arg("--terminal-enabled")
        .envs(load_env_file(paths))
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(log_err);
    // Detach from our session so closing this terminal does not kill it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid().map_err(std::io::Error::other)?;
                Ok(())
            });
        }
    }
    let child = command
        .spawn()
        .with_context(|| format!("failed to spawn {}", paths.binary.display()))?;
    std::fs::write(&paths.pid_file, child.id().to_string())?;
    println!(
        "Bud started in the background (pid {}, logs at {}).",
        child.id(),
        paths.log_file.display()
    );
    println!(
        "Note: without a service install it will not survive a reboot; run `bud service install`."
    );
    Ok(())
}

fn stop_pidfile(paths: &LifecyclePaths) -> Result<()> {
    let Some(pid) = read_live_pid(paths) else {
        println!("Bud is not running (no live pidfile).");
        return Ok(());
    };
    // SIGTERM to the daemon pid ONLY. Never a process group / pkill: holder
    // processes share the binary name and must survive.
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .with_context(|| format!("failed to signal pid {pid}"))?;
    let _ = std::fs::remove_file(&paths.pid_file);
    Ok(())
}

/// Whether a pidfile-managed daemon is currently alive (upgrade uses this
/// to decide between restart and a start hint).
pub(crate) fn daemon_running(paths: &LifecyclePaths) -> bool {
    read_live_pid(paths).is_some()
}

fn read_live_pid(paths: &LifecyclePaths) -> Option<u32> {
    let raw = std::fs::read_to_string(&paths.pid_file).ok()?;
    let pid: u32 = raw.trim().parse().ok()?;
    // Signal 0 = existence probe.
    let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok();
    if alive {
        Some(pid)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn gui_domain() -> String {
    format!("gui/{}", nix::unistd::getuid().as_raw())
}

fn gui_domain_target() -> String {
    format!("{}/{}", gui_domain(), LAUNCHD_LABEL)
}

fn whoami() -> String {
    std::env::var("USER").unwrap_or_else(|_| "<user>".to_string())
}

fn launchd_state() -> String {
    let target = gui_domain_target();
    match Command::new("launchctl").args(["print", &target]).output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("state = running") {
                "running".to_string()
            } else {
                "loaded (not running)".to_string()
            }
        }
        _ => "installed (not loaded — `bud start`)".to_string(),
    }
}

fn systemd_state() -> String {
    match Command::new("systemctl")
        .args(["--user", "is-active", SYSTEMD_UNIT_NAME])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    }
}

fn holder_count() -> usize {
    let Ok(out) = Command::new("ps").args(["ax", "-o", "command"]).output() else {
        return 0;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| line.contains("bud term-hold") && !line.contains("grep"))
        .count()
}

fn run_checked(program: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("failed to run {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn run_quiet(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths() -> LifecyclePaths {
        LifecyclePaths {
            base_dir: PathBuf::from("/home/user/.bud"),
            binary: PathBuf::from("/home/user/.bud/bin/bud"),
            env_file: PathBuf::from("/home/user/.bud/bud.env"),
            log_dir: PathBuf::from("/home/user/.bud/logs"),
            log_file: PathBuf::from("/home/user/.bud/logs/daemon.log"),
            pid_file: PathBuf::from("/home/user/.bud/bud.pid"),
            identity_file: PathBuf::from("/home/user/.bud/identity.json"),
        }
    }

    #[test]
    fn systemd_unit_carries_holder_safe_directives() {
        let unit = systemd_unit(&test_paths());
        assert!(
            unit.contains("KillMode=process"),
            "holders must survive restarts"
        );
        assert!(unit.contains("EnvironmentFile=-/home/user/.bud/bud.env"));
        assert!(unit.contains("ExecStart=/home/user/.bud/bin/bud --terminal-enabled"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("StandardOutput=append:/home/user/.bud/logs/daemon.log"));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn launchd_plist_sources_env_and_abandons_process_group() {
        let plist = launchd_plist(&test_paths());
        assert!(
            plist.contains("<key>AbandonProcessGroup</key>"),
            "holders must survive"
        );
        assert!(plist.contains("dev.bud.daemon"));
        // env sourced through the shell wrapper (launchd has no EnvironmentFile)
        assert!(
            plist.contains(". &apos;/home/user/.bud/bud.env&apos;")
                || plist.contains(". '/home/user/.bud/bud.env'")
        );
        assert!(plist.contains("exec '/home/user/.bud/bin/bud' --terminal-enabled"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("/home/user/.bud/logs/daemon.log"));
        // KeepAlive on failure only: `bud stop` must stick.
        assert!(plist.contains("<key>SuccessfulExit</key>"));
    }

    #[test]
    fn generated_files_pass_the_doctor_supervision_parsers() {
        // The doctor validates installed service files for holder-safe
        // directives; the generators must always satisfy it.
        let paths = test_paths();
        assert_eq!(
            crate::doctor::plist_abandon_process_group(&launchd_plist(&paths)),
            Some(true)
        );
        assert_eq!(
            crate::doctor::systemd_unit_kill_mode(&systemd_unit(&paths)).as_deref(),
            Some("process")
        );
    }

    #[test]
    fn env_upsert_replaces_appends_and_removes_surgically() {
        let dir = std::env::temp_dir().join(format!("bud-lifecycle-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bud.env");
        std::fs::write(
            &path,
            "BUD_SERVER_URL='wss://app.bud.dev/ws'\nBUD_TERMINAL_ENABLED=true\n",
        )
        .unwrap();

        upsert_env_var(&path, LLM_ENV_KEY, "http://127.0.0.1:8888/v1").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("BUD_LOCAL_LLM_DS4_URL='http://127.0.0.1:8888/v1'"));
        assert!(
            content.starts_with("BUD_SERVER_URL='wss://app.bud.dev/ws'"),
            "other lines preserved"
        );

        // Replace, not duplicate.
        upsert_env_var(&path, LLM_ENV_KEY, "http://127.0.0.1:8000/v1").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.matches(LLM_ENV_KEY).count(), 1);
        assert!(content.contains("8000"));

        assert!(remove_env_var(&path, LLM_ENV_KEY).unwrap());
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains(LLM_ENV_KEY));
        assert!(content.contains("BUD_TERMINAL_ENABLED=true"));
        assert!(!remove_env_var(&path, LLM_ENV_KEY).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn llm_enable_key_migration_prefers_generic_and_removes_legacy() {
        let dir = std::env::temp_dir().join(format!("bud-llm-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bud.env");
        std::fs::write(&path, "BUD_LOCAL_LLM_DS4_URL='http://127.0.0.1:8888/v1'\n").unwrap();

        // What llm_enable does post-migration: generic upsert + legacy removal.
        upsert_env_var(&path, LLM_GENERIC_ENV_KEY, "http://127.0.0.1:8888/v1").unwrap();
        remove_env_var(&path, LLM_ENV_KEY).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("BUD_LOCAL_LLM_URL='http://127.0.0.1:8888/v1'"));
        assert!(!content.contains("BUD_LOCAL_LLM_DS4_URL"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn env_file_parser_handles_installer_format() {
        let parsed = parse_env_file(
            "BUD_SERVER_URL='wss://app.bud.dev/ws'\nBUD_TERMINAL_ENABLED=true\n# comment\n\nexport BUD_BASE_DIR=\"/home/u/.bud\"\nBAD LINE\nWEIRD-KEY='x'\n",
        );
        assert_eq!(
            parsed,
            vec![
                (
                    "BUD_SERVER_URL".to_string(),
                    "wss://app.bud.dev/ws".to_string()
                ),
                ("BUD_TERMINAL_ENABLED".to_string(), "true".to_string()),
                ("BUD_BASE_DIR".to_string(), "/home/u/.bud".to_string()),
            ]
        );
    }

    #[test]
    fn env_file_parser_unescapes_single_quotes() {
        let parsed = parse_env_file(r"NAME='it'\''s bud'");
        assert_eq!(parsed, vec![("NAME".to_string(), "it's bud".to_string())]);
    }
}
