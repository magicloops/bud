//! Private managed Chromium adapter. Authority belongs to the session manager.

use super::cdp::Cdp;
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
};

#[derive(Debug, Serialize)]
pub struct Target {
    pub target_id: String,
    pub title: String,
    pub url: String,
}

struct Focus {
    editable: bool,
    target: String,
    document: String,
    object: String,
    token: String,
}
struct Viewport {
    target: String,
    document: String,
    token: String,
    metrics: serde_json::Value,
    captured: Instant,
    stable: bool,
}

/// Local diagnostics only; never included in viewer frames.
#[derive(Debug, Default)]
pub(super) struct CaptureTiming {
    pub stage: &'static str,
    pub session_ms: u64,
    pub document_ms: u64,
    pub layout_ms: u64,
    pub focus_ms: u64,
    pub repair_ms: u64,
    pub repairs: u8,
    pub screenshot_ms: [u64; 4],
    pub attempts: usize,
    pub assembly_ms: u64,
    pub format: &'static str,
    pub scales: [f64; 4],
    pub image_chars: [usize; 4],
    pub image_dimensions: [(u32, u32); 4],
}

async fn timed<T>(elapsed: &mut u64, operation: impl std::future::Future<Output = T>) -> T {
    let started = Instant::now();
    let result = operation.await;
    *elapsed += started.elapsed().as_millis() as u64;
    result
}

struct Process {
    child: Child,
    background_windows: bool,
    native_shown: bool,
    windows: HashMap<String, i64>,
    idle_tab: Option<(String, i64)>,
    _temporary: Option<TempDir>,
    _persistent: Option<super::profile::Profile>,
}

/// Cleanup ownership independent of CDP, the page lock and workspace handles.
#[derive(Clone)]
pub(super) struct ProcessHandle(Arc<Mutex<Process>>);

impl ProcessHandle {
    #[cfg(test)]
    pub(super) fn fixture(child: Child) -> Self {
        Self(Arc::new(Mutex::new(Process {
            child,
            background_windows: false,
            native_shown: false,
            windows: HashMap::new(),
            idle_tab: None,
            _temporary: None,
            _persistent: None,
        })))
    }
    #[cfg(test)]
    pub(super) async fn terminate(&self) -> Result<()> {
        self.terminate_with_budgets(Duration::from_secs(5), Duration::from_secs(5))
            .await
    }

    pub(super) async fn terminate_until(&self, deadline: Instant) -> Result<()> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        self.terminate_with_budgets(
            remaining
                .saturating_sub(Duration::from_secs(5))
                .min(Duration::from_secs(5)),
            remaining.min(Duration::from_secs(5)),
        )
        .await
    }

    async fn terminate_with_budgets(&self, grace: Duration, reap: Duration) -> Result<()> {
        {
            let mut process = self.0.lock().unwrap();
            if process.child.try_wait()?.is_none() {
                // Hold the child mutex through signaling: another handle cannot
                // reap it and allow PID reuse between this check and SIGTERM.
                let pid = process.child.id().context("browser_close_unconfirmed")?;
                tracing::info!(
                    component = "browser_shutdown",
                    event = "terminate",
                    pid,
                    "Terminating owned browser process"
                );
                let result = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
                if result != Err(nix::errno::Errno::ESRCH) {
                    result?;
                }
            }
        }
        if !self.wait_for_exit(grace).await? {
            tracing::warn!(
                component = "browser_shutdown",
                event = "kill",
                "Owned browser did not exit gracefully; escalating"
            );
            self.0.lock().unwrap().child.start_kill()?;
            if !self.wait_for_exit(reap).await? {
                bail!("browser_close_unconfirmed");
            }
        }
        // An exited original child does not prove a relaunch left the profile
        // unused. This clears only proven stale singleton files, never live ones.
        let process = self.0.lock().unwrap();
        if let Some(profile) = &process._persistent {
            if profile.ensure_not_running().is_err() {
                tracing::warn!(
                    component = "browser_shutdown",
                    event = "profile_still_in_use",
                    "Browser child exited but profile ownership is unconfirmed"
                );
                bail!("browser_close_unconfirmed");
            }
        }
        tracing::info!(
            component = "browser_shutdown",
            event = "exited",
            "Owned browser exit confirmed"
        );
        Ok(())
    }

    async fn wait_for_exit(&self, budget: Duration) -> Result<bool> {
        let deadline = Instant::now() + budget;
        loop {
            if self.0.lock().unwrap().child.try_wait()?.is_some() {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// One serial CDP/observation handle per workspace. A lifecycle handle owns Chrome.
/// Workspaces share one persistent process/profile and global privacy authority.
pub struct Browser {
    cdp: Cdp,
    screenshot: Option<(Cdp, HashMap<String, String>)>,
    // Set before enabling focus, including when that acknowledgement is lost.
    // No replacement capture/private source starts before confirmed cleanup.
    capture_focus: Option<String>,
    capture_repair_failed: bool,
    semantic: super::semantic::Semantic,
    semantic_dirty: bool,
    process: Arc<Mutex<Process>>,
    endpoint: String,
    runtime: Arc<super::addon::Runtime>,
    workspace: String,
    ownership: Arc<Mutex<HashMap<String, String>>>,
    recovery: Arc<Mutex<super::recovery::Recovery>>,
    saved_pages: Option<super::recovery::Pages>,
    recovery_uncertain: bool,
    recovery_status: Option<&'static str>,
    sessions: HashMap<String, String>,
    focus: Option<Focus>,
    viewport: Option<Viewport>,
    stream_guard: Option<super::stream_guard::StreamGuard>,
    stream_cleanup: Option<Arc<std::sync::atomic::AtomicU8>>,
    viewport_id: Option<String>,
    fitted_sizes: HashMap<String, (u32, u32)>,
    preferred_size: Option<(u32, u32)>,
    sizing_invocation: Option<String>,
    last_wheel: Option<Instant>,
}

impl Browser {
    pub(super) fn process_handle(&self) -> ProcessHandle {
        ProcessHandle(self.process.clone())
    }

    pub(super) async fn shutdown_until(&mut self, deadline: Instant) -> Result<()> {
        tracing::info!(
            component = "browser_shutdown",
            event = "cdp_close",
            "Requesting owned browser close"
        );
        let closed = tokio::time::timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2)),
            self.cdp.call(None, "Browser.close", json!({})),
        )
        .await;
        // Allow an acknowledged close to flush the profile before OS signaling.
        if matches!(closed, Ok(Ok(_))) {
            self.process_handle()
                .wait_for_exit(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(1)),
                )
                .await?;
        }
        self.process_handle().terminate_until(deadline).await
    }
    /// Startup readiness must not open a window, even for headed browsing.
    pub(super) async fn launch_probe(runtime: &super::addon::Runtime) -> Result<Self> {
        Self::launch_mode(runtime, false).await
    }

    pub async fn launch(runtime: &super::addon::Runtime) -> Result<Self> {
        let headed = std::env::var("BUD_BROWSER_HEADED").as_deref() == Ok("1");
        Self::launch_mode(runtime, headed).await
    }

    async fn launch_mode(runtime: &super::addon::Runtime, headed: bool) -> Result<Self> {
        let profile = tempfile::Builder::new().prefix("bud-browser-").tempdir()?;
        Self::launch_profile(runtime, headed, Some(profile), None).await
    }

    pub(super) async fn launch_persistent(
        runtime: &super::addon::Runtime,
        profile: super::profile::Profile,
        color: Option<&str>,
    ) -> Result<Self> {
        super::profile::secure_storage_ready()?;
        // Cosmetic failure must never destroy preferences or prevent browsing.
        profile.ensure_not_running()?;
        if profile.apply_color(color).is_err() {
            tracing::warn!("Browser profile color update unavailable");
        }
        let headed = std::env::var("BUD_BROWSER_HEADED").as_deref() == Ok("1");
        Self::launch_profile(runtime, headed, None, Some(profile)).await
    }

    async fn launch_profile(
        runtime: &super::addon::Runtime,
        headed: bool,
        temporary: Option<TempDir>,
        persistent: Option<super::profile::Profile>,
    ) -> Result<Self> {
        let path = temporary
            .as_ref()
            .map(|p| p.path())
            .or_else(|| persistent.as_ref().map(|p| p.path.as_path()))
            .unwrap();
        let recovery = Arc::new(Mutex::new(super::recovery::Recovery::load(
            persistent.as_ref().map(|p| p.path.as_path()),
        )));
        let ephemeral = temporary.is_some();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
        }
        // Reserve an available port while building the command. Chrome must bind
        // it after release; a competing bind fails startup, never attaches by port.
        let owned_discovery = headed || !ephemeral;
        let reservation = owned_discovery
            .then(|| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)))
            .transpose()?;
        let port = reservation
            .as_ref()
            .map(|socket| socket.local_addr().map(|addr| addr.port()))
            .transpose()?
            .unwrap_or(0);
        let mut command = Command::new(&runtime.executable);
        if !headed {
            command.arg("--headless=new");
        }
        command.args(profile_flags(ephemeral));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env(
                "HOME",
                if ephemeral {
                    path.to_path_buf()
                } else {
                    std::env::var_os("HOME")
                        .map(std::path::PathBuf::from)
                        .context("browser_home_unavailable")?
                },
            )
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={}", path.display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--window-size=1024,768",
                "--no-startup-window",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(if owned_discovery {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .kill_on_drop(true);
        drop(reservation);
        let mut child = command.spawn().context("browser_launch_failed")?;
        let (endpoint_sender, mut endpoint_receiver) = tokio::sync::oneshot::channel();
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut prefix = BufReader::new(stderr).take(64 * 1024);
                let mut lines = (&mut prefix).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(endpoint) = line.strip_prefix("DevTools listening on ") {
                        let _ = endpoint_sender.send(endpoint.to_owned());
                        break;
                    }
                }
                // Chrome can continue writing diagnostics after readiness. Never
                // block its pipe or expose page/log content in daemon logs.
                drop(lines);
                let _ = tokio::io::copy(&mut prefix.into_inner(), &mut tokio::io::sink()).await;
            });
        }
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if child.try_wait()?.is_some() {
                    bail!("browser_exited_before_ready");
                }
                let endpoint = if owned_discovery {
                    match endpoint_receiver.try_recv() {
                        Ok(endpoint) => {
                            let parsed = url::Url::parse(&endpoint)?;
                            if parsed.scheme() != "ws"
                                || parsed.host_str() != Some("127.0.0.1")
                                || parsed.port() != Some(port)
                                || !parsed.path().starts_with("/devtools/browser/")
                            {
                                bail!("browser_invalid_endpoint");
                            }
                            Some(endpoint)
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                            bail!("browser_discovery_failed")
                        }
                        Err(tokio::sync::oneshot::error::TryRecvError::Empty) => None,
                    }
                } else {
                    tokio::fs::read_to_string(path.join("DevToolsActivePort"))
                        .await
                        .ok()
                        .and_then(|text| discovery_endpoint(&text))
                };
                if let Some(endpoint) = endpoint {
                    let mut cdp = Cdp::connect(&endpoint).await?;
                    // The DevTools listener starts before the browser main
                    // thread is necessarily responsive. Prove readiness with
                    // the same read-only inventory operation consumers need.
                    let targets = cdp.call(None, "Target.getTargets", json!({})).await?;
                    if !targets["targetInfos"].is_array() {
                        bail!("browser_invalid_targets");
                    }
                    let semantic = super::semantic::Semantic::connect(&endpoint, runtime).await?;
                    return Ok((cdp, semantic, endpoint));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
        let (cdp, semantic, endpoint) = match ready {
            Ok(Ok(cdp)) => cdp,
            Ok(Err(error)) => {
                let _ = child.kill().await;
                return Err(error.context("browser_not_ready"));
            }
            Err(error) => {
                let _ = child.kill().await;
                return Err(anyhow::Error::new(error).context("browser_startup_timeout"));
            }
        };
        let mut cdp = cdp;
        if ephemeral {
            cdp.call(None, "Target.createTarget", json!({"url":"about:blank"}))
                .await?;
        }
        Ok(Self {
            cdp,
            screenshot: None,
            capture_focus: None,
            capture_repair_failed: false,
            semantic,
            semantic_dirty: false,
            process: Arc::new(Mutex::new(Process {
                child,
                background_windows: cfg!(target_os = "macos") && headed,
                native_shown: false,
                windows: HashMap::new(),
                idle_tab: None,
                _temporary: temporary,
                _persistent: persistent,
            })),
            endpoint,
            runtime: Arc::new(runtime.clone()),
            workspace: String::new(),
            ownership: Arc::default(),
            recovery,
            saved_pages: None,
            recovery_uncertain: false,
            recovery_status: None,
            sessions: HashMap::new(),
            focus: None,
            viewport: None,
            stream_guard: None,
            stream_cleanup: None,
            viewport_id: None,
            fitted_sizes: HashMap::new(),
            preferred_size: None,
            sizing_invocation: None,
            last_wheel: None,
        })
    }

    pub async fn version(&mut self) -> Result<String> {
        Ok(
            self.cdp.call(None, "Browser.getVersion", json!({})).await?["product"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
        )
    }

    pub async fn targets(&mut self) -> Result<Vec<Target>> {
        let result = self.cdp.call(None, "Target.getTargets", json!({})).await?;
        let infos = result["targetInfos"]
            .as_array()
            .context("browser_invalid_targets")?;
        // Identity, not URL/title, distinguishes our presentation tab. It never
        // belongs to a workspace, including after a native user navigates it.
        let idle =
            {
                let mut process = self.process.lock().unwrap();
                if process.idle_tab.as_ref().is_some_and(|(id, _)| {
                    !infos.iter().any(|t| t["targetId"].as_str() == Some(id))
                }) {
                    process.idle_tab = None;
                }
                process.idle_tab.as_ref().map(|(id, _)| id.clone())
            };
        // Sessions attached to targets that no longer exist are detached and
        // dropped so a long-lived workspace never exhausts its session table.
        let live: std::collections::HashSet<String> = infos
            .iter()
            .filter_map(|t| t["targetId"].as_str().map(str::to_owned))
            .collect();
        for session in prune_sessions(&mut self.sessions, &live) {
            let _ = self
                .cdp
                .call(
                    None,
                    "Target.detachFromTarget",
                    json!({"sessionId":session}),
                )
                .await;
        }
        if let Some((cdp, sessions)) = self.screenshot.as_mut() {
            for session in prune_sessions(sessions, &live) {
                let _ = cdp
                    .call(
                        None,
                        "Target.detachFromTarget",
                        json!({"sessionId":session}),
                    )
                    .await;
            }
        }
        let owned_targets: Vec<String> = {
            let mut owners = self.ownership.lock().unwrap();
            owners.retain(|id, _| infos.iter().any(|t| t["targetId"].as_str() == Some(id)));
            for _ in 0..infos.len() {
                let mut changed = false;
                for target in infos.iter().filter(|t| t["type"] == "page") {
                    let Some(id) = target["targetId"].as_str() else {
                        continue;
                    };
                    if owners.contains_key(id) {
                        continue;
                    }
                    if let Some(owner) = target["openerId"]
                        .as_str()
                        .and_then(|id| owners.get(id))
                        .cloned()
                    {
                        owners.insert(id.to_owned(), owner);
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
            infos
                .iter()
                .filter(|t| t["type"] == "page")
                .filter_map(|t| t["targetId"].as_str())
                .filter(|id| idle.as_deref() != Some(*id))
                .filter(|id| self.workspace.is_empty() || owners.contains_key(*id))
                .map(str::to_owned)
                .collect()
        };
        self.background_new_windows(&owned_targets).await?;
        Ok(result["targetInfos"]
            .as_array()
            .context("browser_invalid_targets")?
            .iter()
            .filter(|target| {
                target["type"] == "page"
                    && target["targetId"].as_str() != idle.as_deref()
                    && (self.workspace.is_empty()
                        || target["targetId"].as_str().is_some_and(|id| {
                            self.ownership.lock().unwrap().get(id) == Some(&self.workspace)
                        }))
            })
            .take(16)
            .map(|target| Target {
                target_id: target["targetId"].as_str().unwrap_or_default().into(),
                title: bounded(target["title"].as_str().unwrap_or_default(), 256),
                url: target["url"].as_str().unwrap_or_default().to_owned(),
            })
            .collect())
    }

    // The owned CDP connection resolves window IDs; they never come from clients.
    async fn window_id(&mut self, target: &str) -> Result<i64> {
        self.cdp
            .call(
                None,
                "Browser.getWindowForTarget",
                json!({"targetId":target}),
            )
            .await?["windowId"]
            .as_i64()
            .context("browser_window_unconfirmed")
    }

    async fn window_state(&mut self, window: i64, state: &str) -> Result<()> {
        self.cdp
            .call(
                None,
                "Browser.setWindowBounds",
                json!({"windowId":window,"bounds":{"windowState":state}}),
            )
            .await?;
        // Window transitions are asynchronous on macOS. Bounded acknowledgement,
        // not a visibility monitor or a restore/minimize loop on each gesture.
        for _ in 0..20 {
            let bounds = self
                .cdp
                .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
                .await?;
            if bounds["bounds"]["windowState"] == state {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        bail!("browser_window_unconfirmed")
    }

    async fn background_new_windows(&mut self, targets: &[String]) -> Result<()> {
        if !self.process.lock().unwrap().background_windows {
            return Ok(());
        }
        if !targets.is_empty() && self.process.lock().unwrap().idle_tab.is_none() {
            self.create_idle_tab().await?;
            if !self.process.lock().unwrap().native_shown {
                self.select_idle_tab().await?;
                let window = self.process.lock().unwrap().idle_tab.as_ref().unwrap().1;
                self.window_state(window, "minimized").await?;
            }
        }
        self.process
            .lock()
            .unwrap()
            .windows
            .retain(|target, _| targets.contains(target));
        for target in targets {
            if self.process.lock().unwrap().windows.contains_key(target) {
                continue;
            }
            let window = self.window_id(target).await?;
            // Even background tab creation can restore an existing native window.
            // Apply presentation once per newly discovered target, not per frame.
            if !self.process.lock().unwrap().native_shown {
                self.window_state(window, "minimized").await?;
            }
            self.process
                .lock()
                .unwrap()
                .windows
                .insert(target.clone(), window);
        }
        Ok(())
    }

    // One process-owned presentation tab, never entered in the ownership map.
    // Existing inventory detects native closure; the next inventory recreates it.
    async fn create_idle_tab(&mut self) -> Result<()> {
        use base64::Engine;
        let html = include_str!("idle.html");
        let url = format!(
            "data:text/html;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(html)
        );
        let result = self
            .cdp
            .call(
                None,
                "Target.createTarget",
                json!({
                    "url":url,"background":true
                }),
            )
            .await?;
        let id = result["targetId"]
            .as_str()
            .context("browser_window_unconfirmed")?
            .to_owned();
        let window = self.window_id(&id).await?;
        self.process.lock().unwrap().idle_tab = Some((id, window));
        Ok(())
    }

    async fn select_idle_tab(&mut self) -> Result<()> {
        let idle = self.process.lock().unwrap().idle_tab.clone();
        if let Some((id, window)) = idle {
            // Finish any native restore before selecting/minimizing. Otherwise
            // Chrome can apply a delayed activation restore after our minimize.
            // This runs only for idle-tab creation/recovery and explicit Hide.
            self.window_state(window, "normal").await?;
            self.cdp
                .call(None, "Target.activateTarget", json!({"targetId":id}))
                .await?;
        }
        Ok(())
    }

    pub(super) async fn native_window(&mut self, target: Option<&str>, show: bool) -> Result<()> {
        if !self.process.lock().unwrap().background_windows {
            bail!("browser_window_unsupported");
        }
        let result = self.set_native_window(target, show).await;
        result.map_err(|_| anyhow::anyhow!("browser_window_unconfirmed"))
    }

    async fn set_native_window(&mut self, target: Option<&str>, show: bool) -> Result<()> {
        let targets = self.targets().await?;
        if show {
            let target = target
                .and_then(|id| targets.iter().find(|t| t.target_id == id))
                .or_else(|| {
                    if target.is_none() {
                        targets.first()
                    } else {
                        None
                    }
                })
                .context("browser_target_not_found")?;
            let window = self.window_id(&target.target_id).await?;
            self.window_state(window, "normal").await?;
            let session = self.session(&target.target_id).await?;
            self.cdp
                .call(Some(&session), "Page.bringToFront", json!({}))
                .await?;
            self.process.lock().unwrap().native_shown = true;
        } else {
            // Repeated return preparation must not restore an already parked window.
            let was_shown = self.process.lock().unwrap().native_shown;
            // All owned workspaces share native windows and private authority.
            let owned: Vec<String> = self.ownership.lock().unwrap().keys().cloned().collect();
            let mut windows = HashSet::new();
            for target in owned {
                windows.insert(self.window_id(&target).await?);
            }
            if was_shown {
                self.select_idle_tab().await?;
            }
            if let Some((_, window)) = self.process.lock().unwrap().idle_tab.clone() {
                windows.insert(window);
            }
            for window in windows {
                self.window_state(window, "minimized").await?;
            }
            self.process.lock().unwrap().native_shown = false;
        }
        Ok(())
    }

    pub(super) async fn hide_before_return(&mut self) -> Result<()> {
        self.retire_stream().await?;
        self.finish_capture_focus().await?;
        if self.process.lock().unwrap().background_windows {
            self.native_window(None, false).await?;
        }
        Ok(())
    }

    async fn session(&mut self, target: &str) -> Result<String> {
        if !self.workspace.is_empty()
            && !self.targets().await?.iter().any(|t| t.target_id == target)
        {
            bail!("browser_target_not_found");
        }
        if let Some(session) = self.sessions.get(target) {
            let session = session.clone();
            self.apply_preferred_size(target, &session).await?;
            return Ok(session);
        }
        if self.sessions.len() >= 32 {
            bail!("browser_target_limit");
        }
        let result = self
            .cdp
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId":target, "flatten":true}),
            )
            .await?;
        let session = result["sessionId"]
            .as_str()
            .context("browser_attach_failed")?
            .to_owned();
        self.cdp
            .call(Some(&session), "Page.enable", json!({}))
            .await?;
        self.sessions.insert(target.into(), session.clone());
        self.apply_preferred_size(target, &session).await?;
        Ok(session)
    }

    async fn document(&mut self, session: &str) -> Result<String> {
        let tree = self
            .cdp
            .call(Some(session), "Page.getFrameTree", json!({}))
            .await?;
        tree["frameTree"]["frame"]["loaderId"]
            .as_str()
            .map(str::to_owned)
            .context("browser_document_unavailable")
    }

    pub async fn navigate(&mut self, target: &str, url: &str) -> Result<()> {
        self.saved_pages = None;
        let parsed = url::Url::parse(url).map_err(|_| anyhow::anyhow!("browser_invalid_url"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            bail!("browser_unsupported_url");
        }
        let session = self.session(target).await?;
        self.invalidate_references();
        let result = self
            .cdp
            .call(Some(&session), "Page.navigate", json!({"url":url}))
            .await?;
        if result.get("errorText").is_some() {
            bail!("browser_navigation_failed");
        }
        Ok(())
    }

    pub async fn inspect(
        &mut self,
        target: &str,
        mut command: serde_json::Value,
    ) -> Result<serde_json::Value> {
        if !self.workspace.is_empty()
            && !self.targets().await?.iter().any(|t| t.target_id == target)
        {
            bail!("browser_target_not_found");
        }
        self.session(target).await?; // Apply request geometry before any semantic observation/action.
        if self.semantic_dirty {
            self.semantic
                .call(json!({"operation":"invalidate"}))
                .await?;
            self.semantic_dirty = false;
        }
        command["target_id"] = json!(target);
        let focus = command["operation"] == "focus";
        if matches!(
            command["operation"].as_str(),
            Some("click" | "fill" | "focus")
        ) {
            self.focus = None;
        }
        let result = self.semantic.call(command).await?;
        if focus {
            let session = self.session(target).await?;
            let document = self.document(&session).await?;
            self.remember_human_focus(target, &session, &document)
                .await?;
        }
        Ok(result)
    }

    /// Test-only: nodes of a fresh structured snapshot (`inspect` is the only
    /// observation path; the flat legacy `observe` result is gone).
    #[cfg(test)]
    pub(super) async fn snapshot_nodes(&mut self, target: &str) -> Result<Vec<serde_json::Value>> {
        let result = self
            .inspect(target, json!({"operation":"snapshot"}))
            .await?;
        Ok(result["nodes"].as_array().cloned().unwrap_or_default())
    }

    pub(super) async fn insert_text_in_tab(&mut self, target: &str, text: &str) -> Result<()> {
        if self
            .focus
            .as_ref()
            .is_none_or(|focus| focus.target != target)
        {
            bail!("browser_focus_required");
        }
        self.insert_text(text).await
    }

    /// Guarded committed text for ordinary inputs and contenteditable hosts, including open shadow roots. Check and write
    /// in one JS task so navigation/focus changes cannot redirect input.
    /// This is NOT yet the general mobile composition/selection implementation.
    pub async fn insert_text(&mut self, text: &str) -> Result<()> {
        if text.len() > 8192 {
            bail!("browser_input_too_large");
        }
        let focus = self.focus.as_ref().context("browser_focus_required")?;
        let (target, document, object) = (
            focus.target.clone(),
            focus.document.clone(),
            focus.object.clone(),
        );
        let session = self.session(&target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
            "objectId":object, "returnByValue":true, "arguments":[{"value":"text"},{"value":text}],
            "functionDeclaration":include_str!("human_edit.js")
        })).await?;
        if result["result"]["value"] != true {
            bail!("browser_stale_or_unsupported_focus");
        }
        Ok(())
    }

    pub(super) fn viewport_revision(&self) -> Option<String> {
        self.viewport_id.clone()
    }

    /// Admission has already checked the invocation and private-control fences.
    /// Only a new invocation changes the preference; explicit Fit survives later cells.
    pub(super) fn request_viewport(
        &mut self,
        invocation: &str,
        viewport: Option<super::manager::BrowserViewport>,
    ) {
        if self.sizing_invocation.as_deref() == Some(invocation) {
            return;
        }
        self.sizing_invocation = Some(invocation.to_owned());
        if let Some(viewport) = viewport {
            self.preferred_size = Some((viewport.width, viewport.height));
        }
    }

    async fn apply_preferred_size(&mut self, target: &str, session: &str) -> Result<()> {
        let Some((width, height)) = self.preferred_size else {
            return Ok(());
        };
        if self.fitted_sizes.get(target) == Some(&(width, height)) {
            return Ok(());
        }
        self.invalidate_references();
        self.cdp
            .call(
                Some(session),
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}),
            )
            .await?;
        self.fitted_sizes.insert(target.into(), (width, height));
        self.viewport_id = Some(ulid::Ulid::new().to_string());
        Ok(())
    }

    /// Authorized viewport mutation. Never navigate/reload the page to fit it.
    pub async fn resize_viewport(
        &mut self,
        target: &str,
        document: &str,
        width: u32,
        height: u32,
    ) -> Result<serde_json::Value> {
        let session = self.session(target).await?;
        if self.document(&session).await? != document {
            bail!("browser_document_changed");
        }
        if self.fitted_sizes.get(target) == Some(&(width, height)) {
            return Ok(json!({"viewport_applied":true,"viewport_id":self.viewport_id}));
        }
        self.invalidate_references();
        self.cdp
            .call(
                Some(&session),
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}),
            )
            .await?;
        if self.document(&session).await? != document {
            bail!("browser_document_changed");
        }
        let viewport_id = ulid::Ulid::new().to_string();
        self.viewport_id = Some(viewport_id.clone());
        self.fitted_sizes.insert(target.into(), (width, height));
        self.preferred_size = Some((width, height));
        Ok(
            json!({"viewport_applied":true,"viewport_id":viewport_id,"target_id":target,"document_id":document,"width":width,"height":height}),
        )
    }

    /// Demand capture uses a bounded image on the dedicated media connection.
    #[cfg(test)]
    pub async fn capture(&mut self, target: &str) -> Result<serde_json::Value> {
        self.capture_scaled(target, None).await
    }

    pub async fn capture_scaled(
        &mut self,
        target: &str,
        pixel_ratio: Option<f64>,
    ) -> Result<serde_json::Value> {
        self.capture_scaled_timed(target, pixel_ratio, &mut CaptureTiming::default())
            .await
    }

    // Only screenshots may recover on a new connection. Mutating commands retain
    // their fail-closed channel, and normal capture guards/serialization still apply.
    async fn screenshot_session(&mut self, target: &str) -> Result<String> {
        if self
            .screenshot
            .as_ref()
            .is_some_and(|(cdp, _)| cdp.interrupted())
        {
            self.screenshot = None;
        }
        if self.screenshot.is_none() {
            self.screenshot = Some((Cdp::connect(&self.endpoint).await?, HashMap::new()));
        }
        let (cdp, sessions) = self.screenshot.as_mut().unwrap();
        let session = if let Some(session) = sessions.get(target) {
            session.clone()
        } else {
            if sessions.len() >= 32 {
                bail!("browser_target_limit");
            }
            let attached = cdp
                .call(
                    None,
                    "Target.attachToTarget",
                    json!({"targetId":target,"flatten":true}),
                )
                .await?;
            let session = attached["sessionId"]
                .as_str()
                .context("browser_attach_failed")?
                .to_owned();
            sessions.insert(target.into(), session.clone());
            session
        };
        Ok(session)
    }

    async fn screenshot(
        &mut self,
        target: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let session = self.screenshot_session(target).await?;
        self.screenshot
            .as_mut()
            .unwrap()
            .0
            .call(Some(&session), "Page.captureScreenshot", params)
            .await
    }

    async fn finish_capture_focus(&mut self) -> Result<()> {
        let Some(target) = self.capture_focus.clone() else {
            return Ok(());
        };
        let result = async {
            // A timed-out capture cannot reuse its poisoned socket. A fresh
            // attachment may disable the target's emulation while we still hold
            // the page lock, before any replacement source can start.
            if self
                .screenshot
                .as_ref()
                .is_none_or(|(cdp, _)| cdp.interrupted())
            {
                self.screenshot = None;
                let mut cdp = Cdp::connect(&self.endpoint).await?;
                let inventory = cdp.call(None, "Target.getTargets", json!({})).await?;
                let targets = inventory["targetInfos"]
                    .as_array()
                    .context("browser_invalid_targets")?;
                if !targets.iter().any(|t| t["targetId"] == target) {
                    return Ok(()); // Target destruction also destroys its emulation.
                }
                self.screenshot = Some((cdp, HashMap::new()));
            }
            let session = self.screenshot_session(&target).await?;
            self.screenshot
                .as_mut()
                .unwrap()
                .0
                .call(
                    Some(&session),
                    "Emulation.setFocusEmulationEnabled",
                    json!({"enabled":false}),
                )
                .await?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            self.screenshot = None;
            // Retain pending cleanup. The next admitted preparation can retry
            // cleanup, but must not begin another focus lifetime first.
            bail!("browser_capture_cleanup_unconfirmed");
        }
        self.capture_focus = None;
        Ok(())
    }

    pub(super) async fn capture_scaled_timed(
        &mut self,
        target: &str,
        pixel_ratio: Option<f64>,
        timing: &mut CaptureTiming,
    ) -> Result<serde_json::Value> {
        self.capture_attempt(target, pixel_ratio, timing, Duration::from_secs(10))
            .await
    }

    /// Passive media supplies its live authority check; other capture callers
    /// retain ordinary errors without native window repair.
    pub(super) async fn capture_scaled_timed_with_repair(
        &mut self,
        target: &str,
        pixel_ratio: Option<f64>,
        timing: &mut CaptureTiming,
        authorized: impl Fn() -> bool,
    ) -> Result<serde_json::Value> {
        let first = self
            .capture_attempt(target, pixel_ratio, timing, Duration::from_secs(2))
            .await;
        if first.is_ok() {
            self.capture_repair_failed = false;
        }
        if !first
            .as_ref()
            .is_err_and(|error| error.is::<tokio::time::error::Elapsed>())
            || timing.stage != "screenshot"
            || !authorized()
            || self.capture_repair_failed
        {
            return first;
        }
        let started = Instant::now();
        timing.stage = "repair_window";
        let repaired = self.repair_minimized_capture(target, &authorized).await;
        timing.repair_ms = started.elapsed().as_millis() as u64;
        if repaired.is_err() {
            self.capture_repair_failed = true;
        }
        if !repaired? {
            timing.stage = "screenshot";
            return first;
        }
        timing.repairs = 1;
        tracing::info!(component="browser_media", event="capture_window_repaired",
            session_id=%self.workspace, repair_ms=timing.repair_ms,
            "Parked minimized browser window after capture timeout");
        if !authorized() {
            self.capture_repair_failed = true;
            bail!("browser_media_revoked");
        }
        let retry = self
            .capture_attempt(target, pixel_ratio, timing, Duration::from_secs(2))
            .await;
        // Reconnect cannot turn a persistent renderer failure into repeated
        // window flashes. Only a successful passive capture rearms repair.
        self.capture_repair_failed = retry.is_err();
        retry
    }

    async fn repair_minimized_capture(
        &mut self,
        target: &str,
        authorized: &impl Fn() -> bool,
    ) -> Result<bool> {
        if !self.process.lock().unwrap().background_windows {
            return Ok(false);
        }
        let Some((idle, _)) = self.process.lock().unwrap().idle_tab.clone() else {
            return Ok(false);
        };
        let window = self.window_id(target).await?;
        // Resolve both live window IDs; native tab moves can stale the cache.
        if self.window_id(&idle).await? != window {
            return Ok(false);
        }
        let bounds = self
            .cdp
            .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
            .await?;
        if bounds["bounds"]["windowState"] != "minimized" || !authorized() {
            return Ok(false);
        }
        // The user accepted a brief restoration here. Always attempt to park
        // the same window again, even if tab selection fails or authority changes.
        let selected = async {
            self.window_state(window, "normal").await?;
            if !authorized() {
                bail!("browser_media_revoked");
            }
            self.cdp
                .call(None, "Target.activateTarget", json!({"targetId":idle}))
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let minimized = self.window_state(window, "minimized").await;
        selected?;
        minimized?;
        self.process.lock().unwrap().native_shown = false;
        Ok(true)
    }

    async fn capture_attempt(
        &mut self,
        target: &str,
        pixel_ratio: Option<f64>,
        timing: &mut CaptureTiming,
        screenshot_timeout: Duration,
    ) -> Result<serde_json::Value> {
        self.retire_stream().await?;
        self.finish_capture_focus().await?;
        // Validate ownership before attaching the dedicated capture target.
        timing.stage = "session";
        let command_session = timed(&mut timing.session_ms, self.session(target)).await?;
        let session = self.screenshot_session(target).await?;
        self.capture_focus = Some(target.to_owned());
        timing.stage = "focus_enable";
        let enabled = timed(
            &mut timing.focus_ms,
            self.screenshot.as_mut().unwrap().0.call(
                Some(&session),
                "Emulation.setFocusEmulationEnabled",
                json!({"enabled":true}),
            ),
        )
        .await;
        let result = match enabled {
            Ok(_) => {
                self.capture_focused(
                    target,
                    command_session,
                    pixel_ratio,
                    timing,
                    screenshot_timeout,
                )
                .await
            }
            Err(error) => Err(error),
        };
        let stage = timing.stage;
        timing.stage = "focus_cleanup";
        timed(&mut timing.focus_ms, self.finish_capture_focus()).await?;
        timing.stage = stage;
        result
    }

    async fn capture_focused(
        &mut self,
        target: &str,
        session: String,
        pixel_ratio: Option<f64>,
        timing: &mut CaptureTiming,
        screenshot_timeout: Duration,
    ) -> Result<serde_json::Value> {
        timing.stage = "document_before";
        let document = timed(&mut timing.document_ms, self.document(&session)).await?;
        timing.stage = "layout_before";
        let metrics = timed(
            &mut timing.layout_ms,
            self.cdp
                .call(Some(&session), "Page.getLayoutMetrics", json!({})),
        )
        .await?;
        let width = metrics["cssLayoutViewport"]["clientWidth"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let height = metrics["cssLayoutViewport"]["clientHeight"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let moving = self
            .last_wheel
            .is_some_and(|at| at.elapsed() < Duration::from_millis(250));
        let enhanced = pixel_ratio.is_some() && !moving;
        let mut scale = if let Some(ratio) = pixel_ratio.filter(|_| enhanced) {
            ratio
                .clamp(1.0, 2.0)
                .min(2560.0 / width.max(height))
                .min((4_000_000.0 / (width * height)).sqrt())
        } else {
            (1280.0 / width.max(height)).min(1.0)
        };
        let mut image = String::new();
        let mut image_fits = false;
        // Chrome's actual bitmap can include device scaling beyond our CSS-based
        // prediction. Bound decoded dimensions as well as compressed byte length.
        timing.format = if enhanced { "png" } else { "jpeg" };
        for attempt in 0..4 {
            timing.stage = "screenshot";
            timing.attempts = attempt + 1;
            timing.scales[attempt] = scale;
            // Only the dedicated screenshot call is canceled at this deadline.
            // Focus cleanup retires its poisoned connection before any retry.
            let shot = timed(&mut timing.screenshot_ms[attempt], tokio::time::timeout(screenshot_timeout, self.screenshot(target, json!({
                "format":if enhanced { "png" } else { "jpeg" }, "quality":65, "captureBeyondViewport":false,
                "clip":{"x":metrics["cssLayoutViewport"]["pageX"], "y":metrics["cssLayoutViewport"]["pageY"],
                    "width":width, "height":height, "scale":scale}
            })))).await??;
            image = shot["data"]
                .as_str()
                .context("browser_capture_failed")?
                .to_owned();
            timing.image_chars[attempt] = image.len();
            timing.stage = "image_bounds";
            let dimensions = super::image_bounds::dimensions(&image, enhanced)?;
            timing.image_dimensions[attempt] = dimensions;
            image_fits = image.len() <= 1_400_000
                && super::image_bounds::within_bounds(dimensions, enhanced);
            if image_fits {
                break;
            }
            scale *= 0.5;
        }
        timing.stage = "document_after";
        if !image_fits || timed(&mut timing.document_ms, self.document(&session)).await? != document
        {
            bail!("browser_frame_discarded");
        }
        timing.stage = "layout_after";
        let after = timed(
            &mut timing.layout_ms,
            self.cdp
                .call(Some(&session), "Page.getLayoutMetrics", json!({})),
        )
        .await?;
        timing.stage = "validate";
        let before_viewport = &metrics["cssLayoutViewport"];
        let after_viewport = &after["cssLayoutViewport"];
        if before_viewport["clientWidth"] != after_viewport["clientWidth"]
            || before_viewport["clientHeight"] != after_viewport["clientHeight"]
            || timed(&mut timing.document_ms, self.document(&session)).await? != document
        {
            bail!("browser_frame_discarded");
        }
        timing.stage = "assembly";
        let assembly_started = Instant::now();
        // Show motion immediately, but never treat uncertain pixel coordinates
        // as proof for a click or text input.
        let stable = before_viewport == after_viewport;
        // Tokens stay opaque on the wire. Their context survives motion and
        // image quality, while their suffix still binds pixel-sensitive input.
        let context = self
            .viewport
            .as_ref()
            .filter(|v| {
                v.target == target
                    && v.document == document
                    && v.metrics["clientWidth"] == before_viewport["clientWidth"]
                    && v.metrics["clientHeight"] == before_viewport["clientHeight"]
            })
            .and_then(|v| {
                v.token
                    .split_once(':')
                    .map(|(context, _)| context.to_owned())
            })
            .unwrap_or_else(|| ulid::Ulid::new().to_string());
        let token = self
            .viewport
            .as_ref()
            .filter(|v| {
                v.target == target
                    && v.document == document
                    && v.metrics == metrics["cssLayoutViewport"]
                    && v.stable == stable
            })
            .map(|v| v.token.clone())
            .unwrap_or_else(|| format!("{context}:{}", ulid::Ulid::new()));
        self.viewport = Some(Viewport {
            target: target.into(),
            document: document.clone(),
            token: token.clone(),
            metrics: metrics["cssLayoutViewport"].clone(),
            captured: Instant::now(),
            stable,
        });
        let mut frame = json!({"target_id":target,"document_id":document,"frame_token":token,"width":width,"height":height,"image":image});
        if enhanced {
            frame["image_format"] = json!("png");
        }
        if let Some(id) = &self.viewport_id {
            frame["viewport_id"] = json!(id);
        }
        timing.assembly_ms = assembly_started.elapsed().as_millis() as u64;
        timing.stage = "complete";
        Ok(frame)
    }

    async fn remember_human_focus(
        &mut self,
        target: &str,
        session: &str,
        document: &str,
    ) -> Result<Option<String>> {
        self.focus = None;
        self.cdp
            .call(
                Some(session),
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":"bud-human-focus"}),
            )
            .await?;
        let active = self
            .cdp
            .call(
                Some(session),
                "Runtime.evaluate",
                json!({
                    "expression":"(() => { let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return active; })()", "objectGroup":"bud-human-focus"
                }),
            )
            .await?;
        let Some(object) = active["result"]["objectId"].as_str() else {
            return Ok(None);
        };
        if self.document(session).await? != document {
            return Ok(None);
        }
        let editable = self
            .cdp
            .call(
                Some(session),
                "Runtime.callFunctionOn",
                json!({
                    "objectId":object,"returnByValue":true,"arguments":[{"value":"probe"}],
                    "functionDeclaration":include_str!("human_edit.js")
                }),
            )
            .await?["result"]["value"]
            == true;
        if self.document(session).await? != document {
            return Ok(None);
        }
        let token = ulid::Ulid::new().to_string();
        self.focus = Some(Focus {
            editable,
            target: target.into(),
            document: document.into(),
            object: object.into(),
            token: token.clone(),
        });
        Ok(Some(token))
    }

    /// Called only under the page lock after private media admission.
    pub(super) async fn prepare_stream(
        &mut self,
        target: &str,
    ) -> Result<(super::screencast::SourceConfig, String)> {
        self.retire_stream().await?;
        self.finish_capture_focus().await?;
        let session = self.session(target).await?; // repeats workspace ownership
        self.invalidate_references();
        let document = self.document(&session).await?;
        let metrics = self
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        let metrics = super::screencast::viewport(&metrics)?;
        let width = metrics["clientWidth"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let height = metrics["clientHeight"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let guard =
            super::stream_guard::StreamGuard::new(target.into(), document.clone(), width, height);
        let generation = guard.generation.clone();
        let cleanup = Arc::new(std::sync::atomic::AtomicU8::new(1));
        self.stream_cleanup = Some(cleanup.clone());
        let config = super::screencast::SourceConfig {
            endpoint: self.endpoint.clone(),
            target: target.into(),
            document,
            width,
            height,
            live: guard.live.clone(),
            cleanup,
        };
        self.stream_guard = Some(guard);
        Ok((config, generation))
    }

    pub(super) fn stream_frame(
        &mut self,
        generation: &str,
        frame: &super::screencast::SourceFrame,
    ) -> Result<serde_json::Value> {
        let guard = self
            .stream_guard
            .as_mut()
            .filter(|g| g.generation == generation)
            .context("browser_frame_discarded")?;
        let token = guard
            .record(frame.metrics.clone(), frame.received)
            .context("browser_frame_discarded")?;
        Ok(
            json!({"target_id":guard.target,"document_id":guard.document,"frame_token":token,
            "viewport_id":self.viewport_id,"width":guard.width,"height":guard.height}),
        )
    }

    pub async fn human_input(
        &mut self,
        target: &str,
        document: &str,
        frame_token: &str,
        input: &super::viewer::HumanInput,
    ) -> Result<serde_json::Value> {
        use super::viewer::HumanInput;
        let session = self.session(target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let scroll = matches!(input, HumanInput::Scroll { .. });
        let action = match input {
            HumanInput::Click { .. } => "click",
            HumanInput::Scroll { .. } => "scroll",
            HumanInput::Text { .. } => "text",
            HumanInput::Key { .. } => "key",
            HumanInput::Back => "back",
        };
        let diagnostic_session = self.workspace.clone();
        let streaming = self.stream_guard.is_some();
        let reject = |reason: &'static str| {
            tracing::info!(component = "browser_input", event = "viewport_rejected",
                session_id = %diagnostic_session, action, reason,
                streaming, "Browser input viewport rejected");
            anyhow::anyhow!("browser_stale_viewport")
        };
        let expected_metrics = if let Some(guard) = &self.stream_guard {
            guard
                .resolve(target, document, frame_token, scroll)
                .ok_or_else(|| reject("stream_receipt"))?
                .metrics
                .clone()
        } else {
            let viewport = self
                .viewport
                .as_ref()
                .filter(|v| v.target == target && v.document == document)
                .ok_or_else(|| reject("passive_receipt_missing"))?;
            let valid_token = if scroll {
                frame_token
                    .split_once(':')
                    .zip(viewport.token.split_once(':'))
                    .is_some_and(|((context, suffix), (current, _))| {
                        context == current && !suffix.is_empty()
                    })
            } else {
                viewport.token == frame_token
                    && viewport.captured.elapsed() < Duration::from_secs(3)
            };
            if !valid_token {
                return Err(reject("passive_token_or_age"));
            }
            if !viewport.stable && !matches!(input, HumanInput::Scroll { .. }) {
                return Err(reject("passive_capture_unstable"));
            }
            viewport.metrics.clone()
        };
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let metrics = self
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        // Wheel movement intentionally advances scroll offsets before the next
        // capture. Keep page/context guards and reject any size change.
        let stream_metrics;
        let current_metrics = if self.stream_guard.is_some() {
            stream_metrics = super::screencast::viewport(&metrics)?;
            &stream_metrics
        } else {
            &metrics["cssLayoutViewport"]
        };
        let fields: &[&str] = if scroll {
            &["clientWidth", "clientHeight"]
        } else {
            &["clientWidth", "clientHeight", "pageX", "pageY"]
        };
        let matches_metrics = fields.iter().all(|key| {
            if streaming {
                super::stream_guard::metric_matches(
                    key,
                    &expected_metrics[*key],
                    &current_metrics[*key],
                )
            } else {
                current_metrics[*key].as_f64().is_some()
                    && current_metrics[*key].as_f64() == expected_metrics[*key].as_f64()
            }
        });
        if !matches_metrics {
            for key in fields {
                if current_metrics[*key].as_f64() != expected_metrics[*key].as_f64() {
                    tracing::info!(component = "browser_input", event = "geometry_mismatch",
                        session_id = %self.workspace, action, field = *key,
                        expected = expected_metrics[*key].as_f64(), current = current_metrics[*key].as_f64(),
                        "Browser input geometry mismatch");
                }
            }
            return Err(reject("geometry_changed"));
        }
        if self
            .stream_guard
            .as_ref()
            .is_some_and(|g| g.resolve(target, document, frame_token, scroll).is_none())
        {
            return Err(reject("stream_receipt_changed_during_validation"));
        }
        match input {
            HumanInput::Back => {
                let history = self
                    .cdp
                    .call(Some(&session), "Page.getNavigationHistory", json!({}))
                    .await?;
                let index = history["currentIndex"].as_u64().unwrap_or(0);
                if index == 0 {
                    bail!("browser_no_previous_page");
                }
                let id = history["entries"][index as usize - 1]["id"]
                    .as_i64()
                    .context("browser_no_previous_page")?;
                self.invalidate_references();
                self.cdp
                    .call(
                        Some(&session),
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":id}),
                    )
                    .await?;
                return Ok(json!({"focus_token":null}));
            }
            HumanInput::Click { x, y } | HumanInput::Scroll { x, y, .. } => {
                if *x > current_metrics["clientWidth"].as_f64().unwrap_or(0.0)
                    || *y > current_metrics["clientHeight"].as_f64().unwrap_or(0.0)
                {
                    return Err(reject("coordinates_outside_viewport"));
                }
                if let HumanInput::Scroll { delta_y, .. } = input {
                    self.cdp
                        .call(
                            Some(&session),
                            "Input.dispatchMouseEvent",
                            json!({"type":"mouseWheel","x":x,"y":y,"deltaX":0,"deltaY":delta_y}),
                        )
                        .await?;
                    self.last_wheel = Some(Instant::now());
                    // Scrolling does not deliberately change focus. Later text/key
                    // input still checks the actual focused node before editing.
                    let focus = self
                        .focus
                        .as_ref()
                        .filter(|focus| focus.target == target && focus.document == document);
                    return Ok(json!({"focus_token":focus.map(|focus| &focus.token)}));
                } else {
                    self.cdp.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})).await?;
                    self.cdp.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})).await?;
                }
            }
            HumanInput::Text { focus_token, text } => {
                if self.focus.as_ref().is_none_or(|focus| {
                    &focus.token != focus_token
                        || focus.document != document
                        || focus.target != target
                }) {
                    bail!("browser_stale_focus");
                }
                self.insert_text(text).await?;
            }
            HumanInput::Key { focus_token, key } => {
                let focus = self
                    .focus
                    .as_ref()
                    .filter(|focus| {
                        &focus.token == focus_token
                            && focus.document == document
                            && focus.target == target
                    })
                    .context("browser_stale_focus")?;
                let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
                    "objectId":focus.object,"returnByValue":true,"arguments":[{"value":"key"},{"value":key}],"userGesture":true,
                    "functionDeclaration":include_str!("human_edit.js")
                })).await?;
                if result["result"]["value"] != true {
                    bail!("browser_unsupported_field");
                }
            }
        }
        let token = self
            .remember_human_focus(target, &session, document)
            .await?;
        Ok(
            json!({"focus_token":token,"focus_editable":self.focus.as_ref().is_some_and(|f| f.editable)}),
        )
    }

    /// Close-time hint removal for a workspace without a live handle; best-effort
    /// like `close`, so corrupt hints never block closing (Phase 3s D1).
    pub(super) fn forget_workspace(&mut self, workspace: &str) -> Result<()> {
        self.recovery.lock().unwrap().forget(workspace)
    }

    /// The manager holds the page lock and disclosure fence for this entire write.
    pub(super) async fn save_pages(&mut self, selected: Option<&str>) -> Result<()> {
        if let Some(pages) = self.checkpoint_pages(selected, false).await? {
            self.recovery
                .lock()
                .unwrap()
                .save(&self.workspace, Some(pages))?;
        }
        Ok(())
    }

    pub(super) async fn checkpoint_pages(
        &mut self,
        selected: Option<&str>,
        disclose: bool,
    ) -> Result<Option<super::recovery::Pages>> {
        if self.workspace.is_empty()
            || (!disclose
                && (self.saved_pages.is_some()
                    || self.recovery_uncertain
                    || matches!(self.recovery_status, Some("unavailable" | "partial"))))
        {
            return Ok(None);
        }
        let mut targets = self.targets().await?;
        targets.sort_by(|a, b| a.target_id.cmp(&b.target_id));
        // Native closure retains fallback; logical close explicitly forgets it.
        if targets.is_empty() {
            return Ok(None);
        }
        Ok(Some(super::recovery::Pages {
            selected: targets
                .iter()
                .position(|t| Some(t.target_id.as_str()) == selected)
                .unwrap_or(0),
            urls: targets
                .into_iter()
                .map(|t| {
                    if super::recovery::storable(&t.url) {
                        t.url
                    } else {
                        String::new()
                    }
                })
                .collect(),
        }))
    }

    pub(super) fn save_checkpoint_batch(
        &mut self,
        changes: Vec<(String, Option<super::recovery::Pages>)>,
    ) -> Result<()> {
        self.recovery.lock().unwrap().save_batch(changes)
    }

    #[cfg(test)]
    pub(super) fn checkpoint_for_test(&self) -> Option<super::recovery::Pages> {
        self.recovery.lock().unwrap().get(&self.workspace)
    }

    #[cfg(test)]
    pub(super) async fn same_document_for_test(
        &mut self,
        target: &str,
        expression: &str,
    ) -> Result<()> {
        let session = self.session(target).await?;
        self.cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":expression}),
            )
            .await?;
        Ok(())
    }

    pub(super) fn checkpoint_endpoint(&self) -> &str {
        &self.endpoint
    }

    /// One reconstruction attempt per live workspace. Keep durable hints intact.
    /// A lost create/navigation acknowledgement is never automatically replayed.
    pub(super) async fn restore_pages(
        &mut self,
        explicit_url: bool,
    ) -> Result<(Option<String>, usize, &'static str)> {
        if explicit_url {
            self.saved_pages = None;
            self.recovery_uncertain = false;
            self.recovery_status = None;
            return Ok((None, 0, "empty"));
        }
        if self.recovery_uncertain {
            bail!("browser_recovery_uncertain");
        }
        if self.recovery_status == Some("unavailable") {
            return Ok((None, 0, "unavailable"));
        }
        let existing = self.targets().await?;
        if !existing.is_empty() {
            return Ok((None, 0, "ready"));
        }
        if !self.recovery.lock().unwrap().available() {
            return Ok((None, 0, "unavailable"));
        }
        let Some(pages) = self.saved_pages.take() else {
            return Ok((None, 0, "empty"));
        };
        self.recovery_uncertain = true;
        let mut selected = None;
        let mut restored = 0;
        for (index, url) in pages.urls.iter().enumerate() {
            if !super::recovery::eligible(url) {
                continue;
            }
            // Bind a blank page before navigation, so a navigation timeout leaves
            // a known owned target rather than creating another copy on retry.
            let result = self
                .cdp
                .call(
                    None,
                    "Target.createTarget",
                    json!({"url":"about:blank","background":true}),
                )
                .await?;
            let target = result["targetId"]
                .as_str()
                .context("browser_target_not_found")?
                .to_owned();
            self.ownership
                .lock()
                .unwrap()
                .insert(target.clone(), self.workspace.clone());
            self.navigate(&target, url).await?;
            if index == pages.selected {
                selected = Some(target);
            }
            restored += 1;
        }
        self.invalidate_references();
        self.targets().await?;
        self.recovery_uncertain = false;
        let status = if selected.is_none() {
            "unavailable"
        } else if restored < pages.urls.len() {
            "partial"
        } else {
            "restored"
        };
        self.recovery_status = Some(status);
        Ok((selected, restored, status))
    }

    pub(super) fn selection_unavailable(&self) -> bool {
        self.recovery_status == Some("unavailable")
    }

    pub(super) fn selected_explicitly(&mut self) {
        self.recovery_status = None;
    }

    pub(super) fn disclose_pages(&mut self) {
        self.saved_pages = None;
        self.recovery_status = None;
        self.recovery_uncertain = false;
    }

    /// A native final-tab close retains a public fallback, but only explicit open
    /// may recreate it. Viewer ensure and inventory never do so in a live runtime.
    pub(super) async fn restore_closed_page(&mut self) -> Result<()> {
        if self.saved_pages.is_none()
            && !self.recovery_uncertain
            && !self.selection_unavailable()
            && self.targets().await?.is_empty()
        {
            self.saved_pages = self.recovery.lock().unwrap().get(&self.workspace);
        }
        Ok(())
    }

    async fn retire_stream(&mut self) -> Result<()> {
        self.stream_guard = None;
        if let Some(cleanup) = &self.stream_cleanup {
            tokio::time::timeout(Duration::from_secs(8), async {
                while cleanup.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .context("browser_stream_cleanup_unconfirmed")?;
            if cleanup.load(std::sync::atomic::Ordering::SeqCst) != 1 {
                bail!("browser_stream_cleanup_unconfirmed");
            }
        }
        self.stream_cleanup = None;
        Ok(())
    }

    pub fn invalidate_references(&mut self) {
        self.semantic_dirty = true;
        self.focus = None;
        self.viewport = None;
        self.stream_guard = None;
        self.last_wheel = None;
    }

    pub(super) fn process_exited(&self) -> Result<bool> {
        Ok(self.process.lock().unwrap().child.try_wait()?.is_some())
    }

    /// Only explicit open/acquire preparation calls this. Reconnect reads inventory;
    /// it never retries the failed command or adopts a different process.
    pub(super) async fn recover_channel(&mut self) -> Result<()> {
        if self.process_exited()? {
            bail!("browser_process_exited");
        }
        if !self.cdp.interrupted() {
            if let Err(error) = self.targets().await {
                if !self.cdp.interrupted() {
                    return Err(error);
                }
            }
        }
        if self.cdp.interrupted() {
            tracing::info!(component="browser_lifecycle", event="channel_recovery",
                session_id=%self.workspace, stage="connect", process_exited=false,
                "Repairing owned browser command channel");
            self.cdp = Cdp::connect(&self.endpoint).await?;
            self.sessions.clear();
            self.screenshot = None;
            self.fitted_sizes.clear();
            self.viewport_id = None;
            self.invalidate_references();
            self.targets().await?;
        }
        if self.semantic.interrupted() {
            self.semantic =
                super::semantic::Semantic::connect(&self.endpoint, &self.runtime).await?;
            self.invalidate_references();
        }
        Ok(())
    }

    /// A missing tab is not an interrupted workspace. Only explicit open/acquire
    /// can create a replacement; observations and capture never call this.
    pub(super) async fn ensure_page(&mut self, selected: Option<&str>) -> Result<String> {
        let targets = self.targets().await?;
        if let Some(target) = targets
            .iter()
            .find(|t| Some(t.target_id.as_str()) == selected)
            .or_else(|| targets.first())
        {
            return Ok(target.target_id.clone());
        }
        self.create_page().await
    }

    /// Explicit creation, never an implicit side effect of observing a missing tab.
    pub(super) async fn create_page(&mut self) -> Result<String> {
        if self.targets().await?.len() >= 16 {
            bail!("browser_target_limit");
        }
        let result = self
            .cdp
            .call(
                None,
                "Target.createTarget",
                json!({"url":"about:blank", "background":true}),
            )
            .await?;
        let target = result["targetId"]
            .as_str()
            .context("browser_target_not_found")?
            .to_owned();
        self.ownership
            .lock()
            .unwrap()
            .insert(target.clone(), self.workspace.clone());
        self.invalidate_references();
        self.targets().await?; // Apply existing native presentation policy.
        self.session(&target).await?; // New targets inherit request/explicit Fit geometry.
        Ok(target)
    }

    /// Explicit tab close must remove its recovery hint, including the final tab.
    /// The workspace/REPL lifetime is independent of this individual tab.
    pub(super) async fn close_page(&mut self, target: &str, selected: Option<&str>) -> Result<()> {
        if !self.targets().await?.iter().any(|t| t.target_id == target) {
            bail!("browser_target_not_found");
        }
        let result = self
            .cdp
            .call(None, "Target.closeTarget", json!({"targetId":target}))
            .await?;
        if result["success"] != true {
            bail!("browser_close_unconfirmed");
        }
        self.ownership.lock().unwrap().remove(target);
        self.invalidate_references();
        self.disclose_pages();
        let pages = self.checkpoint_pages(selected, false).await?;
        self.recovery.lock().unwrap().save(&self.workspace, pages)?;
        Ok(())
    }

    pub fn interrupted(&mut self) -> bool {
        self.cdp.interrupted()
            || self.semantic.interrupted()
            || !matches!(self.process.lock().unwrap().child.try_wait(), Ok(None))
    }

    /// Idle disposal preserves the public checkpoint. Never call save_pages for
    /// private content: the previously disclosed checkpoint remains frozen.
    pub(super) async fn expire_idle(
        &mut self,
        selected: Option<&str>,
        private: bool,
    ) -> Result<()> {
        if !private && self.save_pages(selected).await.is_err() {
            // Recovery is best-effort; a corrupt/full hint store must not keep
            // unused browser processes alive indefinitely. Keep prior hints.
            tracing::warn!(
                component = "browser_recovery",
                event = "idle_checkpoint_unavailable",
                "Idle workspace checkpoint unavailable; retaining previous hints"
            );
        }
        // Freeze the checkpoint across partial close failure and checkpoint events.
        self.saved_pages = self.recovery.lock().unwrap().get(&self.workspace);
        self.close_owned(false).await
    }

    /// Only lifecycle ownership may stop Chrome; closing a workspace closes its pages.
    pub async fn close(&mut self) -> Result<()> {
        self.close_owned(true).await
    }

    async fn close_owned(&mut self, forget: bool) -> Result<()> {
        if self.workspace.is_empty() {
            return self
                .shutdown_until(Instant::now() + Duration::from_secs(13))
                .await;
        } else {
            if forget {
                // Best-effort: corrupt hints never block explicit close.
                if let Err(error) = self.recovery.lock().unwrap().forget(&self.workspace) {
                    tracing::warn!(reason = %error, "Recovery hint removal failed; closing anyway");
                }
                self.saved_pages = None;
            }
            if self.process_exited()? {
                return Ok(());
            }
            // Closing known owned tabs uses a fresh read/close channel after an
            // interrupted page call; no uncertain page mutation is replayed.
            if self.cdp.interrupted() {
                self.cdp = Cdp::connect(&self.endpoint).await?;
            }
            // Refresh popup ownership, then close every owned target, including
            // targets beyond the bounded inventory returned to the caller.
            self.targets().await?;
            let targets: Vec<String> = self
                .ownership
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, owner)| *owner == &self.workspace)
                .map(|(id, _)| id.clone())
                .collect();
            for target in targets {
                let result = self
                    .cdp
                    .call(None, "Target.closeTarget", json!({"targetId":target}))
                    .await?;
                if result["success"] != true {
                    bail!("browser_close_unconfirmed");
                }
                self.ownership.lock().unwrap().remove(&target);
            }
        }
        Ok(())
    }

    pub(super) async fn workspace(&mut self, id: &str) -> Result<Self> {
        if id.is_empty() || id.len() > 128 || !self.workspace.is_empty() {
            bail!("browser_invalid_workspace");
        }
        self.recover_channel().await?;
        let cdp = Cdp::connect(&self.endpoint).await?;
        let semantic = super::semantic::Semantic::connect(&self.endpoint, &self.runtime).await?;
        Ok(Self {
            cdp,
            screenshot: None,
            capture_focus: None,
            capture_repair_failed: false,
            semantic,
            semantic_dirty: false,
            process: self.process.clone(),
            endpoint: self.endpoint.clone(),
            runtime: self.runtime.clone(),
            workspace: id.to_owned(),
            ownership: self.ownership.clone(),
            recovery: self.recovery.clone(),
            saved_pages: self.recovery.lock().unwrap().get(id),
            recovery_uncertain: false,
            recovery_status: None,
            sessions: HashMap::new(),
            focus: None,
            viewport: None,
            stream_guard: None,
            stream_cleanup: None,
            viewport_id: None,
            fitted_sizes: HashMap::new(),
            preferred_size: None,
            sizing_invocation: None,
            last_wheel: None,
        })
    }
}

/// Drop cached CDP sessions whose target vanished; returns the session ids to
/// detach. The 32-entry caps in `session`/`screenshot` remain a backstop.
pub(super) fn prune_sessions(
    sessions: &mut HashMap<String, String>,
    live: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut stale = Vec::new();
    sessions.retain(|target, session| {
        if live.contains(target) {
            true
        } else {
            stale.push(session.clone());
            false
        }
    });
    stale
}

/// Disposable probe/fixture profiles use in-memory credential storage so a
/// throwaway launch never touches the keychain. A persistent profile must never
/// carry these flags: site sign-ins would be stored unprotected.
pub(super) fn profile_flags(ephemeral: bool) -> &'static [&'static str] {
    if ephemeral {
        &["--use-mock-keychain", "--password-store=basic"]
    } else {
        &[]
    }
}

fn bounded(value: &str, count: usize) -> String {
    let mut end = value.len().min(count);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

// Chrome creates this file before writing it. Incomplete discovery is not a
// failed launch. Its browser path ends in a canonical UUID; wait for all of it
// before connecting, including when a read catches only part of the write.
fn discovery_endpoint(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let port: u16 = lines.next()?.parse().ok()?;
    let path = lines.next()?;
    let id = path.strip_prefix("/devtools/browser/")?;
    if port == 0
        || id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

#[cfg(test)]
mod launch_tests {
    use super::discovery_endpoint;

    #[tokio::test]
    #[ignore = "requires local Chrome; disposable headed profile and fake capture peer"]
    async fn persistent_capture_failure_does_not_repeat_window_repair() {
        use super::*;
        use futures::{SinkExt, StreamExt};
        use std::sync::atomic::{AtomicBool, Ordering};
        let runtime = crate::browser::addon::test_runtime(
            std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
        );
        let mut root = Browser::launch_mode(&runtime, true).await.unwrap();
        let mut browser = root.workspace("persistent-timeout").await.unwrap();
        let target = browser.ensure_page(None).await.unwrap();
        let image = browser.capture(&target).await.unwrap()["image"]
            .as_str()
            .unwrap()
            .to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        browser.endpoint = format!("ws://{}", listener.local_addr().unwrap());
        browser.screenshot = None;
        let stalled = Arc::new(AtomicBool::new(true));
        let switch = stalled.clone();
        let peer = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (target, image, stalled) = (target.clone(), image.clone(), switch.clone());
                tokio::spawn(async move {
                    let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                    while let Some(Ok(message)) = socket.next().await {
                        if !message.is_text() {
                            continue;
                        }
                        let request: serde_json::Value =
                            serde_json::from_str(&message.into_text().unwrap()).unwrap();
                        let result = match request["method"].as_str().unwrap() {
                            "Target.attachToTarget" => json!({"sessionId":"capture"}),
                            "Target.getTargets" => json!({"targetInfos":[{"targetId":target}]}),
                            "Page.captureScreenshot" if stalled.load(Ordering::SeqCst) => continue,
                            "Page.captureScreenshot" => json!({"data":image}),
                            "Emulation.setFocusEmulationEnabled" => json!({}),
                            method => panic!("unexpected fixture method: {method}"),
                        };
                        if socket
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"id":request["id"],"result":result}).to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        // The original owned tab identity remains on the real command channel.
        let target = browser.targets().await.unwrap().remove(0).target_id;
        let result = async {
            for repairs in [1, 0] {
                let mut timing = CaptureTiming::default();
                assert!(browser
                    .capture_scaled_timed_with_repair(&target, None, &mut timing, || true)
                    .await
                    .is_err());
                assert_eq!(
                    timing.repairs, repairs,
                    "reconnect must not repeat failed window repair"
                );
                assert!(browser.capture_repair_failed);
                assert!(!browser.cdp.interrupted());
            }
            stalled.store(false, Ordering::SeqCst);
            browser
                .capture_scaled_timed_with_repair(
                    &target,
                    None,
                    &mut CaptureTiming::default(),
                    || true,
                )
                .await?;
            assert!(
                !browser.capture_repair_failed,
                "successful capture rearms future repair"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        root.close().await.unwrap();
        peer.abort();
        result.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires local Chrome; disposable headed profile only"]
    async fn timed_out_minimized_capture_parks_idle_and_retries_once() {
        use super::*;
        let runtime = crate::browser::addon::test_runtime(
            std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
        );
        let mut root = Browser::launch_mode(&runtime, true).await.unwrap();
        let result = async {
            let mut browser = root.workspace("timeout-repair").await?;
            let target = browser.ensure_page(None).await?;
            let session = browser.session(&target).await?;
            browser.cdp.call(Some(&session), "Page.navigate", json!({
                "url":"data:text/html,<input value='preserved'><h1>Timeout repair fixture</h1>"
            })).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let document = browser.document(&session).await?;
            let window = browser.window_id(&target).await?;
            let mut repaired = 0;
            for ratio in [None, Some(2.0), None] {
                browser.window_state(window, "normal").await?;
                browser
                    .cdp
                    .call(Some(&session), "Page.bringToFront", json!({}))
                    .await?;
                browser.window_state(window, "minimized").await?;
                let mut timing = CaptureTiming::default();
                let image = browser
                    .capture_scaled_timed_with_repair(&target, ratio, &mut timing, || true)
                    .await?;
                eprintln!("timeout repair capture: {timing:?}");
                repaired += timing.repairs;
                assert!(timing.repairs <= 1);
                assert!(image["image"].is_string());
                assert_eq!(image["document_id"], document);
                assert!(browser.capture_focus.is_none());
                assert!(!browser.cdp.interrupted());
                let bounds = browser
                    .cdp
                    .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
                    .await?;
                assert_eq!(bounds["bounds"]["windowState"], "minimized");
                let value = browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
                    "expression":"document.querySelector('input').value","returnByValue":true
                })).await?;
                assert_eq!(value["result"]["value"], "preserved");
            }
            assert!(repaired > 0, "fixture must exercise actual timeout repair");
            // Never restore a visible window, or a revoked capture's minimized window.
            browser.window_state(window, "normal").await?;
            assert!(!browser.repair_minimized_capture(&target, &|| true).await?);
            browser.window_state(window, "minimized").await?;
            assert!(!browser.repair_minimized_capture(&target, &|| false).await?);
            Ok::<_, anyhow::Error>(())
        }
        .await;
        root.close().await.unwrap();
        result.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires local Chrome; disposable headed profiles only"]
    async fn passive_focus_scope_captures_hidden_tab_and_cleans_interruption() {
        use super::*;
        let runtime = crate::browser::addon::test_runtime(
            std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
        );
        let mut root = Browser::launch_mode(&runtime, true).await.unwrap();
        let result = async {
            let mut browser = root.workspace("passive").await?;
            let mut other = root.workspace("other").await?;
            let target = browser.ensure_page(None).await?;
            let foreign = other.ensure_page(None).await?;
            let session = browser.session(&target).await?;
            browser.cdp.call(Some(&session), "Page.navigate", json!({
                "url":"data:text/html,<input value='preserved'><h1>Passive fixture</h1>"
            })).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
                "expression":"document.querySelector('input').focus();document.querySelector('input').setSelectionRange(1,3)"
            })).await?;
            // Use the existing idle-tab policy. Manual selection of a work tab
            // while minimized is a separately recorded Chrome limitation.
            let window = browser.window_id(&target).await?;
            browser.select_idle_tab().await?;
            browser.window_state(window, "minimized").await?;
            assert!(!browser.process.lock().unwrap().native_shown);
            let state = |expression| json!({"expression":expression,"returnByValue":true});
            for ratio in [None, Some(2.0), None] {
                let started = Instant::now();
                let mut timing = CaptureTiming::default();
                let image = browser.capture_scaled_timed(&target, ratio, &mut timing).await;
                eprintln!("passive capture {ratio:?}: {timing:?}");
                let image = image?;
                assert!(image["image"].is_string());
                assert!(started.elapsed() < Duration::from_secs(3), "warm capture stalled");
                assert!(browser.capture_focus.is_none());
                let after = browser.cdp.call(Some(&session), "Runtime.evaluate", state(
                    "[document.hasFocus(),document.activeElement.tagName,document.querySelector('input').value,document.querySelector('input').selectionStart,document.querySelector('input').selectionEnd]"
                )).await?;
                // Disabling emulation may emit blur/visibility changes. It must
                // stop synthetic focus without losing the selected field/caret.
                assert_eq!(after["result"]["value"], json!([false,"INPUT","preserved",1,3]));
                let bounds = browser.cdp.call(None, "Browser.getWindowBounds", json!({"windowId":window})).await?;
                assert_eq!(bounds["bounds"]["windowState"], "minimized");
            }
            assert!(browser.capture(&foreign).await.is_err());
            assert!(browser.capture_focus.is_none());
            assert_eq!(other.targets().await?[0].target_id, foreign);

            // Select the idle tab to make cleanup observable independently of
            // native Chrome focus behavior when its selected tab is minimized.
            let idle = browser.process.lock().unwrap().idle_tab.as_ref().unwrap().0.clone();
            browser.cdp.call(None, "Target.activateTarget", json!({"targetId":idle})).await?;

            // An ordinary rejected screenshot still permits confirmed cleanup.
            let capture_session = browser.screenshot_session(&target).await?;
            browser.capture_focus = Some(target.clone());
            browser.screenshot.as_mut().unwrap().0.call(Some(&capture_session),
                "Emulation.setFocusEmulationEnabled", json!({"enabled":true})).await?;
            assert!(browser.screenshot(&target, json!({"format":"jpeg", "clip":{
                "x":0,"y":0,"width":0,"height":10,"scale":1
            }})).await.is_err());
            assert!(!browser.screenshot.as_ref().unwrap().0.interrupted(), "ordinary rejection must remain definitive");
            browser.finish_capture_focus().await?;

            // Simulate an interrupted capture-channel read after enabling focus.
            browser.capture_focus = Some(target.clone());
            browser.screenshot.as_mut().unwrap().0.call(Some(&capture_session),
                "Emulation.setFocusEmulationEnabled", json!({"enabled":true})).await?;
            assert!(tokio::time::timeout(Duration::from_millis(50),
                browser.screenshot.as_mut().unwrap().0.call(Some(&capture_session),
                    "Runtime.evaluate", json!({"expression":"new Promise(()=>{})","awaitPromise":true}))
            ).await.is_err());
            assert!(browser.screenshot.as_ref().unwrap().0.interrupted());
            // Private preparation must finish old cleanup first.
            let (config, _) = browser.prepare_stream(&target).await?;
            assert!(browser.capture_focus.is_none());
            let after = browser.cdp.call(Some(&session), "Runtime.evaluate", state("document.hasFocus()")).await?;
            assert_eq!(after["result"]["value"], false);
            let mut source = super::super::screencast::Source::start(config).await?;
            source.stop().await?;
            browser.hide_before_return().await?;
            assert!(!browser.cdp.interrupted());
            browser.capture(&target).await?;
            let capture_session = browser.screenshot_session(&target).await?;
            browser.capture_focus = Some(target.clone());
            browser.screenshot.as_mut().unwrap().0.call(Some(&capture_session),
                "Emulation.setFocusEmulationEnabled", json!({"enabled":true})).await?;
            browser.cdp.call(None, "Target.closeTarget", json!({"targetId":target})).await?;
            // A vanished attachment may reject disable; retry only cleanup on a
            // fresh connection, confirming destruction before forgetting it.
            if browser.finish_capture_focus().await.is_err() {
                assert!(browser.capture_focus.is_some());
                browser.finish_capture_focus().await?;
            }
            assert!(browser.capture_focus.is_none());
            Ok::<_, anyhow::Error>(())
        }.await;
        root.close().await.unwrap();
        result.unwrap();
    }

    #[tokio::test]
    async fn owned_process_escalates_and_preserves_unrelated_process() {
        use super::*;
        let mut command = Command::new("/bin/sleep");
        command.arg("60").kill_on_drop(true);
        unsafe {
            command.pre_exec(|| {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
                Ok(())
            });
        }
        let handle = ProcessHandle::fixture(command.spawn().unwrap());
        let mut unrelated = Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        handle
            .terminate_with_budgets(Duration::from_millis(50), Duration::from_secs(2))
            .await
            .unwrap();
        let status = handle.0.lock().unwrap().child.try_wait().unwrap().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().await.unwrap();
    }

    #[tokio::test]
    async fn exited_child_cannot_clear_a_live_replacement_singleton() {
        use super::*;
        let base = tempfile::tempdir().unwrap();
        let profile =
            super::super::profile::Profile::acquire(base.path(), "test", "resource", "owner")
                .unwrap();
        let path = profile.path.clone();
        let mut replacement = Command::new("/bin/sh")
            .args(["-c", "while :; do sleep 1; done", "sh"])
            .arg(format!("--user-data-dir={}", path.display()))
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let owner = format!(
            "{}-{}",
            nix::unistd::gethostname().unwrap().to_string_lossy(),
            replacement.id().unwrap()
        );
        std::os::unix::fs::symlink(&owner, path.join("SingletonLock")).unwrap();
        let mut exited = Command::new("/usr/bin/true").spawn().unwrap();
        exited.wait().await.unwrap();
        let handle = ProcessHandle::fixture(exited);
        handle.0.lock().unwrap()._persistent = Some(profile);
        assert!(handle.terminate().await.is_err());
        assert_eq!(
            std::fs::read_link(path.join("SingletonLock")).unwrap(),
            std::path::PathBuf::from(owner)
        );
        assert!(replacement.try_wait().unwrap().is_none());
        replacement.kill().await.unwrap();
        handle.terminate().await.unwrap();
    }

    #[tokio::test]
    async fn live_poisoned_close_reopens_persistent_profile_without_reset() {
        use super::*;
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let runtime = crate::browser::addon::test_runtime(executable);
        let base = tempfile::tempdir().unwrap();
        let profile =
            super::super::profile::Profile::acquire(base.path(), "test", "resource", "owner")
                .unwrap();
        let path = profile.path.clone();
        std::fs::write(path.join("preserved"), "profile sentinel").unwrap();
        let mut browser = Browser::launch_profile(&runtime, false, None, Some(profile))
            .await
            .unwrap();
        {
            let call = browser.cdp.call(None, "Target.getTargets", json!({}));
            tokio::pin!(call);
            assert!(futures::poll!(call.as_mut()).is_pending());
        }
        assert!(browser.cdp.interrupted());
        let process = browser.process_handle();
        browser.close().await.unwrap();
        assert!(process
            .0
            .lock()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_some());
        drop(browser);
        drop(process);
        let profile =
            super::super::profile::Profile::acquire(base.path(), "test", "resource", "owner")
                .unwrap();
        assert_eq!(
            std::fs::read_to_string(path.join("preserved")).unwrap(),
            "profile sentinel"
        );
        let mut reopened = Browser::launch_profile(&runtime, false, None, Some(profile))
            .await
            .unwrap();
        reopened.close().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "launches a visible Chrome window; requires BUD_BROWSER_EXECUTABLE"]
    async fn visible_chrome_supports_semantics_and_capture_without_webdriver() {
        let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("browser executable");
        let mut browser =
            super::Browser::launch_mode(&crate::browser::addon::test_runtime(executable), true)
                .await
                .expect("visible browser launch");
        let target = browser.targets().await.unwrap().remove(0).target_id;
        let session = browser.session(&target).await.unwrap();
        browser.cdp.call(Some(&session), "Page.navigate", serde_json::json!({
            "url": "data:text/html,<title>Bud visible browser check</title><h1>Browser ready</h1><button>Continue</button>"
        })).await.unwrap();
        let mut snapshot = serde_json::Value::Null;
        for _ in 0..40 {
            snapshot = browser
                .inspect(
                    &target,
                    serde_json::json!({"operation":"snapshot", "compact":true}),
                )
                .await
                .unwrap();
            if snapshot.to_string().contains("Browser ready") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(snapshot.to_string().contains("Browser ready"));
        let observed = browser
            .cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                serde_json::json!({
                    "expression":"navigator.webdriver", "returnByValue":true
                }),
            )
            .await
            .unwrap();
        assert_eq!(observed["result"]["value"], false);
        let frame = browser.capture(&target).await.unwrap();
        assert!(!frame["image"].as_str().unwrap().is_empty());
        browser.close().await.unwrap();
    }

    #[test]
    fn discovery_waits_for_every_partial_write() {
        let text = "43210\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
        for end in 0..text.len() {
            assert!(discovery_endpoint(&text[..end]).is_none(), "prefix {end}");
        }
        assert_eq!(
            discovery_endpoint(text),
            Some(format!("ws://127.0.0.1:43210{}", &text[6..]))
        );
        assert!(discovery_endpoint(&text.replace("43210", "0")).is_none());
        assert!(discovery_endpoint(&text.replace("43210", "99999")).is_none());
        assert!(discovery_endpoint(&text.replace("/browser/", "/page/")).is_none());
    }
}

#[cfg(test)]
#[path = "viewer_tests.rs"]
mod viewer_tests;

#[cfg(test)]
#[path = "capture_bounds_tests.rs"]
mod capture_bounds_tests;

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod workspace_tests;

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn stale_sessions_are_pruned_and_reported_for_detach() {
        let mut sessions: HashMap<String, String> = [("t1", "s1"), ("t2", "s2"), ("t3", "s3")]
            .into_iter()
            .map(|(t, s)| (t.to_owned(), s.to_owned()))
            .collect();
        let live = ["t2".to_owned()].into_iter().collect();
        let mut stale = prune_sessions(&mut sessions, &live);
        stale.sort();
        assert_eq!(stale, vec!["s1".to_owned(), "s3".to_owned()]);
        assert_eq!(sessions.len(), 1);
        assert!(sessions.contains_key("t2"));
        assert!(prune_sessions(&mut sessions, &live).is_empty());
    }

    #[test]
    fn persistent_launches_never_carry_mock_keychain_flags() {
        assert!(profile_flags(false).is_empty());
        assert!(profile_flags(true).contains(&"--use-mock-keychain"));
    }
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod stream_tests;
