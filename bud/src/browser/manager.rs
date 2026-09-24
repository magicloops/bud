#[path = "repl_execution.rs"]
mod repl_execution;
use super::adapter::Browser;
use super::control::{Authority, ControlCommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Mutex as AsyncMutex};

const MAX_ACTIVE_WORKSPACES: usize = 10;

#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Exec {
        code: String,
    },
    Open {
        url: Option<String>,
    },
    NativeWindow {
        controller_id: String,
        target_id: Option<String>,
        show: bool,
    },
    Ensure {
        explicit_url: bool,
    },
    Capture {
        target_id: Option<String>,
        endpoint: String,
        ticket: String,
    },
    Inspect {
        compact: Option<bool>,
        target_id: Option<String>,
        operation: String,
        continuation: Option<String>,
        scope: Option<String>,
        observation_id: Option<String>,
        reference: Option<String>,
        locator: Option<Locator>,
        text: Option<String>,
        delta_y: Option<i32>,
        position: Option<ClickPosition>,
    },
    Navigate {
        url: String,
        target_id: Option<String>,
    },
    Focus {
        reference: String,
    },
    InsertText {
        text: String,
    },
    Click {
        reference: String,
    },
    HumanInput {
        controller_id: String,
        target_id: String,
        document_id: String,
        frame_token: String,
        input: super::viewer::HumanInput,
    },
    ResizeViewport {
        controller_id: String,
        target_id: String,
        document_id: String,
        width: u32,
        height: u32,
    },
    FitViewport {
        target_id: String,
        document_id: String,
        width: u32,
        height: u32,
    },
    MediaAttach {
        endpoint: String,
        ticket: String,
        controller_id: Option<String>,
        operation_driven: Option<bool>,
    },
    Control {
        control: ControlCommand,
    },
    Lifecycle {
        reset: bool,
    },
    Close,
    Cancel,
}

impl Action {
    // Static labels only: never serialize action arguments into diagnostics.
    fn diagnostic_name(&self) -> &'static str {
        match self {
            Self::Exec { .. } => "exec",
            Self::Open { .. } => "open",
            Self::NativeWindow { .. } => "native_window",
            Self::Ensure { .. } => "ensure",
            Self::Capture { .. } => "capture",
            Self::Inspect { .. } => "inspect",
            Self::Navigate { .. } => "navigate",
            Self::Focus { .. } => "focus",
            Self::InsertText { .. } => "insert_text",
            Self::Click { .. } => "click",
            Self::HumanInput { .. } => "human_input",
            Self::ResizeViewport { .. } => "resize_viewport",
            Self::FitViewport { .. } => "fit_viewport",
            Self::MediaAttach { .. } => "media_attach",
            Self::Control { .. } => "control",
            Self::Lifecycle { .. } => "lifecycle",
            Self::Close => "close",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Locator {
    pub role: String,
    pub name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClickPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplImageUpload {
    pub endpoint: String,
    pub ticket: String,
}

/// Authority is supplied by the service, never by model arguments.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub browser_color: Option<String>,
    pub repl_images: Option<Vec<ReplImageUpload>>,
    pub request_id: String,
    pub device_session_id: String,
    pub session_id: String,
    pub generation: String,
    pub thread_id: String,
    pub owner_user_id: String,
    pub browser_id: String,
    pub browser_epoch: u64,
    pub private_content: bool,
    pub browser_paused: bool,
    pub control_epoch: u64,
    pub sequence: u64,
    pub expires_at_ms: u64,
    pub invocation_id: String,
    pub invocation_fence: u64,
    pub command: Action,
}

#[derive(Debug, Serialize)]
pub struct Reply {
    pub request_id: String,
    pub session_id: String,
    pub generation: String,
    pub ok: bool,
    pub outcome: &'static str,
    pub error: Option<&'static str>,
    pub data: Value,
}

impl Reply {
    fn error(request: &Request, code: &'static str, unknown: bool) -> Self {
        Self {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            generation: request.generation.clone(),
            ok: false,
            outcome: if unknown { "unknown" } else { "rejected" },
            error: Some(code),
            data: json!({}),
        }
    }
}

pub(super) struct Slot {
    repl: Arc<AsyncMutex<super::repl::Workspace>>,
    repl_stop: watch::Sender<Option<&'static str>>,
    owner: String,
    thread: String,
    generation: String,
    cancel: watch::Sender<Option<String>>,
    pub(super) state: AsyncMutex<Entry>,
    pub(super) authority: Arc<Mutex<Authority>>,
    pub(super) page_lock: Arc<AsyncMutex<()>>,
    pub(super) media: std::sync::atomic::AtomicBool,
    pub(super) refresh: watch::Sender<u64>,
}

pub(super) struct Entry {
    epoch: u64,
    sequence: u64,
    invocation: Option<(String, u64)>,
    connection: String,
    pub(super) browser: Option<Browser>,
    pub(super) target: Option<String>,
    closed_at: Option<Instant>,
}

/// Process lifetime owner. Disconnection fences work but keeps live processes.
/// Page operations share a bounded FIFO lock with viewer sizing and capture.
#[derive(Clone)]
pub struct BrowserManager {
    runtime: Option<super::addon::Runtime>,
    runtime_info: Option<Value>,
    boot_id: String,
    entries: Arc<Mutex<HashMap<String, Arc<Slot>>>>,
    connection: watch::Sender<Option<String>>,
    root: Arc<AsyncMutex<Option<Browser>>>,
    authority: Arc<Mutex<Authority>>,
    page_lock: Arc<AsyncMutex<()>>,
    binding: Arc<Mutex<Option<(String, String)>>>,
    persistent: Option<(PathBuf, String)>,
    lifecycle_receipt: Arc<Mutex<Option<String>>>,
    recovery_epoch: Arc<Mutex<Option<u64>>>,
    checkpoint_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl BrowserManager {
    pub fn new(runtime: Option<super::addon::Runtime>) -> Self {
        Self {
            runtime,
            runtime_info: None,
            boot_id: ulid::Ulid::new().to_string(),
            entries: Arc::default(),
            connection: watch::channel(None).0,
            root: Arc::default(),
            authority: Arc::default(),
            page_lock: Arc::default(),
            binding: Arc::default(),
            persistent: None,
            lifecycle_receipt: Arc::default(),
            recovery_epoch: Arc::default(),
            checkpoint_task: Arc::default(),
        }
    }

    /// Resolve the prepared add-on (or a development override), prove it can
    /// launch, answer CDP and close, then require secure storage for the
    /// persistent profile. Any failure leaves the capability unavailable.
    pub async fn configured_for(base: PathBuf, environment: String) -> Self {
        let prepared = super::addon::startup(&base).await;
        let mut manager = match prepared {
            Ok((resolution, outcome)) => {
                let (runtime, kind, product) = match resolution {
                    super::addon::Resolution::EnvOverride(runtime) => {
                        tracing::warn!(
                            "Browser runtime taken from BUD_BROWSER_* environment overrides"
                        );
                        (runtime, "override".to_owned(), "custom".to_owned())
                    }
                    super::addon::Resolution::Manifest(runtime, manifest) => {
                        (runtime, manifest.browser.kind, manifest.browser.product)
                    }
                    super::addon::Resolution::Unavailable(_) => unreachable!(),
                };
                let mut manager = Self::new(Some(runtime));
                manager.runtime_info =
                    Some(json!({"kind":kind,"product":product,"version":outcome.version}));
                manager
            }
            Err(error) => {
                tracing::warn!(component="browser_addon", event="unavailable", reason=%format!("{error:#}"),
                    "Browser support unavailable; continuing daemon startup");
                Self::new(None)
            }
        };
        manager.persistent = Some((base, environment));
        if manager.runtime.is_some() {
            if let Err(error) = super::profile::secure_storage_ready() {
                tracing::warn!(reason = %error, "Persistent browser unavailable");
                manager.runtime = None;
            }
        }
        manager
    }

    /// Stop capture/admission before draining page work and flushing Chrome's profile.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.disconnect();
        self.stop_repl_cells().await?;
        let _page = self.page_lock.lock().await;
        // A private shutdown must never disclose current private addresses.
        let live: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for slot in live {
            let mut entry = slot.state.lock().await;
            let selected = entry.target.clone();
            if self.authority.lock().unwrap().private_content() {
                continue;
            }
            if let Some(browser) = &mut entry.browser {
                if browser.save_pages(selected.as_deref()).await.is_err() {
                    tracing::warn!("Browser page recovery checkpoint unavailable");
                }
            }
        }
        self.close_root().await?;
        let slots: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for slot in slots {
            slot.state.lock().await.browser = None;
        }
        self.entries.lock().unwrap().clear();
        *self.binding.lock().unwrap() = None;
        *self.authority.lock().unwrap() = Authority::default();
        Ok(())
    }

    // Keep ownership after an unconfirmed shutdown, so a retry cannot acknowledge
    // stop/reset merely because the previous attempt dropped the process handle.
    async fn close_root(&self) -> anyhow::Result<()> {
        if let Some(task) = self.checkpoint_task.lock().unwrap().take() {
            task.abort();
        }
        let mut root = self.root.lock().await;
        if let Some(browser) = root.as_mut() {
            browser.close().await?;
        }
        *root = None;
        Ok(())
    }

    pub fn capability(&self) -> Value {
        json!({"version":1, "available":self.runtime.is_some(), "boot_id":self.boot_id, "runtime":self.runtime_info,
            "native_window":cfg!(target_os = "macos") && std::env::var("BUD_BROWSER_HEADED").as_deref() == Ok("1"),
            "managed":true, "profile_mode":"persistent", "handoff":true, "viewport_resize":true, "agent_viewport_resize":true, "independent_renewal":true, "hidpi_capture":true, "history_navigation":true,
            "repl":self.runtime.as_ref().is_some_and(super::repl::prepared), "semantic_observations":true, "compact_observations":true, "agent_capture":true, "operation_driven_media":true, "max_sessions":MAX_ACTIVE_WORKSPACES})
    }

    pub fn connect(&self, device_session_id: String) {
        self.connection.send_replace(Some(device_session_id));
    }

    pub fn disconnect(&self) {
        for slot in self.entries.lock().unwrap().values() {
            let mut authority = slot.authority.lock().unwrap();
            if authority.mode != super::control::Mode::Agent {
                authority.pause();
            }
        }
        self.connection.send_replace(None);
    }

    pub async fn execute(&self, request: Request) -> Reply {
        let now = crate::util::now_millis();
        if (request.expires_at_ms <= now && !matches!(request.command, Action::Cancel))
            || request.expires_at_ms > now + 45_000
            || request.browser_epoch == 0
            || request.control_epoch == 0
            || request.sequence == 0
            || request.invocation_fence == 0
            || !valid_action(&request.command)
            || [
                &request.browser_id,
                &request.request_id,
                &request.device_session_id,
                &request.session_id,
                &request.generation,
                &request.thread_id,
                &request.owner_user_id,
                &request.invocation_id,
            ]
            .iter()
            .any(|value| value.is_empty() || value.len() > 128)
        {
            return Reply::error(&request, "browser_invalid_request", false);
        }
        let mut connection = self.connection.subscribe();
        if connection.borrow_and_update().as_deref() != Some(&request.device_session_id) {
            return Reply::error(&request, "browser_stale_connection", false);
        }
        let Some(runtime) = &self.runtime else {
            return Reply::error(&request, "browser_not_configured", false);
        };
        {
            let mut binding = self.binding.lock().unwrap();
            let identity = (request.browser_id.clone(), request.owner_user_id.clone());
            if let Some(current) = binding.as_ref() {
                if current != &identity {
                    return Reply::error(
                        &request,
                        "browser_resource_changed_restart_required",
                        false,
                    );
                }
            } else {
                *binding = Some(identity);
                self.authority
                    .lock()
                    .unwrap()
                    .restore(request.private_content, request.browser_paused);
            }
        }
        if let Action::Lifecycle { reset } = request.command {
            return match self.lifecycle(&request, reset).await {
                Ok(()) => Reply {
                    request_id: request.request_id,
                    session_id: request.session_id,
                    generation: request.generation,
                    ok: true,
                    outcome: "completed",
                    error: None,
                    data: json!({"lifecycle_acknowledged":true}),
                },
                Err(_) => Reply::error(&request, "browser_lifecycle_unconfirmed", true),
            };
        }
        // Only a newer explicit open after acknowledged stop can release its
        // nonprivate pause. Private intent always requires human control/return.
        if matches!(request.command, Action::Open { .. })
            && self.lifecycle_receipt.lock().unwrap().is_some()
            && !request.private_content
            && !request.browser_paused
        {
            let mut authority = self.authority.lock().unwrap();
            if request.browser_epoch > authority.epoch {
                authority.resume_after_stop(request.browser_epoch);
                *self.lifecycle_receipt.lock().unwrap() = None;
            }
        }
        if matches!(request.command, Action::Open { .. })
            && !self
                .authority
                .lock()
                .unwrap()
                .agent_allowed(request.browser_epoch)
        {
            return Reply::error(&request, "browser_private_or_paused", false);
        }
        let entry = {
            let mut entries = self.entries.lock().unwrap();
            // Closed tombstones outlive every admitted request's deadline.
            entries.retain(|_, entry| {
                entry
                    .state
                    .try_lock()
                    .map(|e| {
                        e.closed_at
                            .is_none_or(|closed| closed.elapsed() < Duration::from_secs(45))
                    })
                    .unwrap_or(true)
            });
            if let Some(entry) = entries.get(&request.session_id) {
                entry.clone()
            } else {
                if !matches!(
                    request.command,
                    Action::Open { .. }
                        | Action::Ensure { .. }
                        | Action::Close
                        | Action::Control {
                            control: ControlCommand::Pause
                        }
                ) {
                    return Reply::error(&request, "browser_interrupted", false);
                }
                let active = entries
                    .values()
                    .filter(|entry| {
                        entry
                            .state
                            .try_lock()
                            .map(|e| e.closed_at.is_none())
                            .unwrap_or(true)
                    })
                    .count();
                if (active >= MAX_ACTIVE_WORKSPACES && !matches!(request.command, Action::Close))
                    || entries.len() >= 128
                {
                    return Reply::error(&request, "browser_session_limit", false);
                }
                if !matches!(request.command, Action::Close)
                    && entries.values().any(|entry| {
                        entry.thread == request.thread_id
                            && entry
                                .state
                                .try_lock()
                                .map(|e| e.closed_at.is_none())
                                .unwrap_or(true)
                    })
                {
                    return Reply::error(&request, "browser_thread_already_open", false);
                }
                let entry = Arc::new(Slot {
                    repl: Arc::default(),
                    repl_stop: watch::channel(None).0,
                    owner: request.owner_user_id.clone(),
                    thread: request.thread_id.clone(),
                    generation: request.generation.clone(),
                    cancel: watch::channel(None).0,
                    refresh: watch::channel(0).0,
                    authority: self.authority.clone(),
                    page_lock: self.page_lock.clone(),
                    media: std::sync::atomic::AtomicBool::new(false),
                    state: AsyncMutex::new(Entry {
                        epoch: 0,
                        sequence: 0,
                        invocation: None,
                        connection: request.device_session_id.clone(),
                        browser: None,
                        target: None,
                        closed_at: None,
                    }),
                });
                entries.insert(request.session_id.clone(), entry.clone());
                entry
            }
        };
        if entry.owner != request.owner_user_id
            || entry.thread != request.thread_id
            || entry.generation != request.generation
        {
            return Reply::error(&request, "browser_scope_mismatch", false);
        }
        if !entry
            .authority
            .lock()
            .unwrap()
            .workspace_allowed(&request.session_id)
            && matches!(
                request.command,
                Action::NativeWindow { .. }
                    | Action::HumanInput { .. }
                    | Action::ResizeViewport { .. }
                    | Action::Control {
                        control: ControlCommand::Renew { .. }
                            | ControlCommand::PrepareReturn { .. }
                            | ControlCommand::Release { .. }
                            | ControlCommand::FinishReturn
                    }
            )
        {
            return Reply::error(&request, "browser_control_workspace_mismatch", false);
        }
        // Renewal authenticates only the existing controller/epoch. It must not
        // queue behind CDP or advance the page-operation sequence.
        if let Action::Control {
            control: command @ ControlCommand::Renew { .. },
        } = &request.command
        {
            if let Err(code) = entry
                .authority
                .lock()
                .unwrap()
                .transition(request.browser_epoch, command)
            {
                return Reply::error(&request, code, false);
            }
            return Reply {
                request_id: request.request_id,
                session_id: request.session_id,
                generation: request.generation,
                ok: true,
                outcome: "completed",
                error: None,
                data: json!({"control_acknowledged":true}),
            };
        }
        if matches!(request.command, Action::Cancel) {
            entry.cancel.send_replace(Some(request.request_id.clone()));
            return Reply::error(&request, "browser_outcome_unknown", true);
        }
        if let Action::MediaAttach {
            endpoint,
            ticket,
            controller_id,
            operation_driven,
        } = &request.command
        {
            let media_fence = {
                let mut authority = entry.authority.lock().unwrap();
                if !authority.viewer_allowed(request.browser_epoch, controller_id.as_deref())
                    || (controller_id.is_some()
                        && !authority.workspace_allowed(&request.session_id))
                {
                    return Reply::error(&request, "browser_private_or_paused", false);
                }
                controller_id.is_none().then(|| authority.media_fence())
            };
            if entry.media.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Reply::error(&request, "browser_media_busy", false);
            }
            super::media::start(super::media::MediaStart {
                session_id: request.session_id.clone(),
                slot: entry,
                connection,
                device: request.device_session_id.clone(),
                epoch: request.browser_epoch,
                controller: controller_id.clone(),
                endpoint: endpoint.clone(),
                ticket: ticket.clone(),
                operation_driven: operation_driven == &Some(true) && controller_id.is_none(),
                media_fence,
            });
            return Reply {
                request_id: request.request_id,
                session_id: request.session_id,
                generation: request.generation,
                ok: true,
                outcome: "completed",
                error: None,
                data: json!({"media_connecting":true}),
            };
        }
        let passive_fit = matches!(request.command, Action::FitViewport { .. });
        // Pause fences delivery and new agent admission even while a prior
        // CDP operation drains. Never hold this lock across browser I/O.
        let control = match &request.command {
            Action::Control { control } => Some(control),
            _ => None,
        };
        if let Some(ControlCommand::Pause) = control {
            let mut authority = entry.authority.lock().unwrap();
            if let Err(code) = authority.transition(request.browser_epoch, control.unwrap()) {
                return Reply::error(&request, code, false);
            }
            *self.recovery_epoch.lock().unwrap() = None;
        } else if let Action::HumanInput { controller_id, .. }
        | Action::NativeWindow { controller_id, .. }
        | Action::ResizeViewport { controller_id, .. } = &request.command
        {
            if !entry
                .authority
                .lock()
                .unwrap()
                .human_allowed(request.browser_epoch, controller_id)
            {
                return Reply::error(&request, "browser_control_expired", false);
            }
        } else if control.is_none()
            && !matches!(request.command, Action::Close | Action::Ensure { .. })
            && !entry
                .authority
                .lock()
                .unwrap()
                .agent_allowed(request.browser_epoch)
        {
            return Reply::error(&request, "browser_private_or_paused", false);
        }
        // Admission was fenced above. Drain all workspace cells before a
        // private acknowledgement; renewal does not enter this path.
        if matches!(
            control,
            Some(ControlCommand::Pause | ControlCommand::Acquire { .. })
        ) && self.drain_repl_cells().await.is_err()
        {
            return Reply::error(&request, "browser_repl_stop_unconfirmed", true);
        }
        let cell = if matches!(request.command, Action::Exec { .. }) {
            match entry.repl.clone().try_lock_owned() {
                Ok(guard) => Some(guard),
                Err(_) => return Reply::error(&request, "browser_busy", false),
            }
        } else {
            None
        };
        let slot = entry.clone();
        let mut cancellation = entry.cancel.subscribe();
        if cancellation.borrow_and_update().as_deref() == Some(&request.request_id) {
            return Reply::error(&request, "browser_canceled", false);
        }
        // Bound the FIFO wait for page operations, captures and fitting. This
        // avoids rejecting agent work merely because a viewer resize won the lock.
        let wait_started = Instant::now();
        let acquired = tokio::time::timeout(Duration::from_secs(4), async {
            let page = entry.page_lock.lock().await;
            let state = entry.state.lock().await;
            (page, state)
        })
        .await;
        let wait_ms = wait_started.elapsed().as_millis() as u64;
        if wait_ms >= 250 || acquired.is_err() {
            tracing::info!(component = "browser_timing", event = "page_lock_wait",
                session_id = %request.session_id, request_id = %request.request_id,
                epoch = request.control_epoch, action = request.command.diagnostic_name(),
                wait_ms, timed_out = acquired.is_err(), "Browser page lock wait");
        }
        let (_page, mut entry) = match acquired {
            Ok(guard) => guard,
            Err(_) => return Reply::error(&request, "browser_busy", false),
        };
        if connection.borrow().as_deref() != Some(&request.device_session_id) {
            return Reply::error(&request, "browser_stale_connection", false);
        }
        if request.expires_at_ms <= crate::util::now_millis() {
            return Reply::error(&request, "browser_deadline", false);
        }
        if matches!(request.command, Action::Ensure { .. }) {
            let authority = self.authority.lock().unwrap();
            let retry = *self.recovery_epoch.lock().unwrap() == Some(request.browser_epoch)
                && authority.epoch == request.browser_epoch + 1;
            if (self.lifecycle_receipt.lock().unwrap().is_some()
                && request.browser_epoch <= authority.epoch)
                || (request.browser_epoch < authority.epoch && !retry)
                || request.control_epoch < entry.epoch
            {
                return Reply::error(&request, "browser_stale_request", false);
            }
        }
        if passive_fit {
            // Viewer sizing is not an invocation and must never replace its fence.
            if request.control_epoch != entry.epoch
                || !slot
                    .authority
                    .lock()
                    .unwrap()
                    .viewer_allowed(request.browser_epoch, None)
            {
                return Reply::error(&request, "browser_stale_request", false);
            }
            if let Action::FitViewport { target_id, .. } = &request.command {
                if entry.target.as_ref() != Some(target_id) {
                    return Reply::error(&request, "browser_target_not_found", false);
                }
            }
        } else if !matches!(request.command, Action::Ensure { .. })
            && (request.control_epoch < entry.epoch
                || request.sequence <= entry.sequence
                || (request.control_epoch == entry.epoch
                    && entry.invocation.as_ref()
                        != Some(&(request.invocation_id.clone(), request.invocation_fence))))
        {
            return Reply::error(&request, "browser_stale_request", false);
        }
        if entry.closed_at.is_some() {
            return Reply::error(&request, "browser_closed", false);
        }
        if entry.connection != request.device_session_id
            || (request.control_epoch != entry.epoch
                && !matches!(request.command, Action::Ensure { .. }))
        {
            if let Some(browser) = &mut entry.browser {
                browser.invalidate_references();
            }
            entry.connection = request.device_session_id.clone();
        }
        if matches!(
            control,
            Some(ControlCommand::Acquire { .. } | ControlCommand::FinishReturn)
        ) {
            // Validate before reading or persisting private inventory. A rejected
            // FinishReturn is not a disclosure decision.
            let mut candidate = self.authority.lock().unwrap().clone();
            if let Err(code) = candidate.transition(request.browser_epoch, control.unwrap()) {
                return Reply::error(&request, code, false);
            }
            // Acquiring an already-private browser must not overwrite the frozen checkpoint.
            let disclose = matches!(control, Some(ControlCommand::FinishReturn))
                || !self.authority.lock().unwrap().private_content();
            if disclose
                && self
                    .flush_checkpoints(
                        &request.session_id,
                        &mut entry,
                        matches!(control, Some(ControlCommand::FinishReturn)),
                    )
                    .await
                    .is_err()
            {
                return Reply::error(&request, "browser_checkpoint_unavailable", false);
            }
        }
        if let Some(command) = control {
            if !matches!(command, ControlCommand::Pause) {
                if let Err(code) = slot
                    .authority
                    .lock()
                    .unwrap()
                    .transition(request.browser_epoch, command)
                {
                    return Reply::error(&request, code, false);
                }
            }
        } else if let Action::HumanInput { controller_id, .. }
        | Action::NativeWindow { controller_id, .. }
        | Action::ResizeViewport { controller_id, .. } = &request.command
        {
            if !slot
                .authority
                .lock()
                .unwrap()
                .human_allowed(request.browser_epoch, controller_id)
            {
                return Reply::error(&request, "browser_control_expired", false);
            }
        } else if !matches!(request.command, Action::Close | Action::Ensure { .. }) {
            let mut authority = slot.authority.lock().unwrap();
            if !authority.agent_allowed(request.browser_epoch) {
                return Reply::error(&request, "browser_private_or_paused", false);
            }
            authority.epoch = request.browser_epoch;
            *self.recovery_epoch.lock().unwrap() = None;
        }
        if matches!(control, Some(ControlCommand::Acquire { .. })) {
            slot.authority
                .lock()
                .unwrap()
                .set_workspace(request.session_id.clone());
        }
        if matches!(request.command, Action::Close) {
            slot.repl_stop.send_replace(Some("workspace_closed"));
            // A cell may be waiting for this page lock. Signal cancellation but
            // do not await its worker lock while holding the page lock.
        }
        if matches!(request.command, Action::Ensure { .. }) && entry.epoch == 0 {
            entry.epoch = request.control_epoch;
        }
        if !passive_fit && !matches!(request.command, Action::Ensure { .. }) {
            entry.invocation = Some((request.invocation_id.clone(), request.invocation_fence));
            entry.epoch = request.control_epoch;
            entry.sequence = request.sequence;
        }
        if let Some(mut cell) = cell {
            let fence = self.authority.lock().unwrap().media_fence();
            if let Some(worker) = cell.runtime.as_mut() {
                if worker.authority_fence != fence {
                    if let Some(browser) = entry.browser.as_mut() {
                        browser.invalidate_references();
                    }
                    worker.authority_fence = fence;
                }
            }
            drop(entry);
            drop(_page);
            return self.execute_cell(&request, slot, cell, fence).await;
        }
        // Connection change wins over a simultaneously completed read. Dropping
        // a CDP call poisons it; a later operation cannot reuse uncertain state.
        let authority_before = self.authority.lock().unwrap().media_fence();
        let viewport_before = entry.browser.as_ref().and_then(|b| b.viewport_revision());
        let operation_started = Instant::now();
        let result = tokio::select! {
            biased;
            _ = connection.changed() => Err(anyhow::anyhow!("browser_connection_lost")),
            _ = async { loop { if cancellation.changed().await.is_err() || cancellation.borrow_and_update().as_deref() == Some(&request.request_id) { break; } } } => Err(anyhow::anyhow!("browser_canceled")),
            result = tokio::time::timeout(Duration::from_millis(request.expires_at_ms.saturating_sub(crate::util::now_millis())),
                async {
                    let result = self.perform(&mut entry, runtime, &request).await;
                    if result.is_ok()
                        && !self.authority.lock().unwrap().private_content()
                        && matches!(
                            request.command,
                            Action::Open { .. }
                                | Action::Navigate { .. }
                                | Action::Inspect { .. }
                                | Action::Click { .. }
                        )
                    {
                        let selected = entry.target.clone();
                        if let Some(browser) = &mut entry.browser {
                            if browser.save_pages(selected.as_deref()).await.is_err() {
                                tracing::warn!("Browser page recovery checkpoint unavailable");
                            }
                        }
                    }
                    result
                }) => {
                result.unwrap_or_else(|_| Err(anyhow::anyhow!("browser_deadline")))
            }
        };
        let operation_ms = operation_started.elapsed().as_millis() as u64;
        if operation_ms >= 250 {
            tracing::info!(component = "browser_timing", event = "page_operation",
                session_id = %request.session_id, request_id = %request.request_id,
                epoch = request.control_epoch, action = request.command.diagnostic_name(),
                operation_ms, ok = result.is_ok(), "Slow browser page operation");
        }
        if matches!(request.command, Action::Ensure { .. }) {
            let authority = self.authority.lock().unwrap();
            let replaced = result
                .as_ref()
                .ok()
                .is_some_and(|data| data["runtime_replaced"] == true);
            if self.lifecycle_receipt.lock().unwrap().is_some()
                || (!replaced && authority.media_fence() != authority_before)
                || (replaced
                    && (authority.epoch != request.browser_epoch + 1
                        || authority.mode != super::control::Mode::Agent))
            {
                return Reply::error(&request, "browser_stale_control", true);
            }
        }
        if control.is_none()
            && !matches!(
                request.command,
                Action::Close
                    | Action::Ensure { .. }
                    | Action::NativeWindow { .. }
                    | Action::HumanInput { .. }
                    | Action::ResizeViewport { .. }
            )
            && !slot
                .authority
                .lock()
                .unwrap()
                .agent_allowed(request.browser_epoch)
        {
            return Reply::error(&request, "browser_private_or_paused", true);
        }
        // A failed return observation must never unlock ordinary agent reads.
        if result.is_err() && control.is_some() {
            slot.authority.lock().unwrap().pause();
        }
        let result = if let (
            Action::Capture {
                endpoint, ticket, ..
            },
            Ok(data),
        ) = (&request.command, &result)
        {
            // Image bytes never ride the shared control writer. Recheck the fence
            // before upload and after the service acknowledges the artifact.
            if request.expires_at_ms <= crate::util::now_millis()
                || cancellation.borrow().as_deref() == Some(&request.request_id)
            {
                return Reply::error(&request, "browser_canceled", true);
            }
            let uploaded = super::capture::upload(endpoint, ticket, data).await;
            if request.expires_at_ms <= crate::util::now_millis()
                || cancellation.borrow().as_deref() == Some(&request.request_id)
                || connection.borrow().as_deref() != Some(&request.device_session_id)
                || !slot
                    .authority
                    .lock()
                    .unwrap()
                    .agent_allowed(request.browser_epoch)
            {
                return Reply::error(&request, "browser_private_or_paused", true);
            }
            uploaded
        } else {
            result
        };
        let refresh = match &request.command {
            Action::Open { .. }
            | Action::Capture { .. }
            | Action::Navigate { .. }
            | Action::Focus { .. }
            | Action::Click { .. }
            | Action::InsertText { .. } => true,
            Action::Inspect { continuation, .. } => continuation.is_none(),
            Action::FitViewport { .. } => {
                viewport_before != entry.browser.as_ref().and_then(|b| b.viewport_revision())
            }
            _ => false,
        };
        if result.is_ok() && matches!(request.command, Action::Close) {
            if let Ok(mut worker) = slot.repl.try_lock() {
                if worker.reset("workspace_closed").await.is_err() {
                    return Reply::error(&request, "browser_repl_stop_unconfirmed", true);
                }
            }
        }
        if result.is_ok() && refresh {
            slot.refresh.send_modify(|revision| *revision += 1);
        }
        match result {
            Ok(data) => Reply {
                request_id: request.request_id,
                session_id: request.session_id,
                generation: request.generation,
                ok: true,
                outcome: "completed",
                error: None,
                data,
            },
            Err(error) => {
                const REJECTED: &[&str] = &[
                    "browser_window_unsupported",
                    "browser_window_unconfirmed",
                    "browser_recovery_unavailable",
                    "browser_profile_in_use",
                    "browser_profile_permissions",
                    "browser_profile_recovery_required",
                    "browser_secure_storage_unavailable",
                    "browser_secure_storage_locked",
                    "browser_secure_storage_unsupported",
                    "browser_locator_ambiguous",
                    "browser_locator_not_found",
                    "browser_observation_limit",
                    "browser_invalid_arguments",
                    "browser_no_previous_page",
                    "browser_stale_reference",
                    "browser_stale_focus",
                    "browser_stale_viewport",
                    "browser_checkpoint_unavailable",
                    "browser_recovery_uncertain",
                    "browser_recovery_required",
                    "browser_focus_required",
                    "browser_stale_or_unsupported_focus",
                    "browser_unsupported_field",
                    "browser_target_not_found",
                    "browser_interrupted",
                    "browser_document_changed",
                ];
                if let Some(code) = REJECTED.iter().find(|code| error.to_string() == **code) {
                    return Reply::error(&request, code, false);
                }
                // Detailed CDP errors can include page data. Keep them local to
                // the adapter; conservatively classify admitted failures unknown.
                Reply::error(&request, "browser_outcome_unknown", true)
            }
        }
    }

    async fn flush_checkpoints(
        &self,
        current: &str,
        entry: &mut Entry,
        disclose: bool,
    ) -> anyhow::Result<()> {
        let mut changes = Vec::new();
        let selected = entry.target.clone();
        if let Some(browser) = &mut entry.browser {
            if let Some(pages) = browser
                .checkpoint_pages(selected.as_deref(), disclose)
                .await?
            {
                changes.push((current.to_owned(), Some(pages)));
            }
        }
        let slots: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id.as_str() != current)
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect();
        for (id, slot) in &slots {
            let mut other = slot.state.lock().await;
            if other.closed_at.is_some() {
                continue;
            }
            let selected = other.target.clone();
            if let Some(browser) = &mut other.browser {
                if let Some(pages) = browser
                    .checkpoint_pages(selected.as_deref(), disclose)
                    .await?
                {
                    changes.push((id.clone(), Some(pages)));
                }
            }
        }
        // All inventory reads succeed before the single atomic manifest write.
        if let Some(root) = self.root.lock().await.as_mut() {
            root.save_checkpoint_batch(changes)?;
        }
        if disclose {
            if let Some(browser) = &mut entry.browser {
                browser.disclose_pages();
            }
            for (_, slot) in slots {
                if let Some(browser) = &mut slot.state.lock().await.browser {
                    browser.disclose_pages();
                }
            }
        }
        Ok(())
    }

    fn start_checkpoints(&self, endpoint: String) {
        if let Some(task) = self.checkpoint_task.lock().unwrap().take() {
            task.abort();
        }
        let entries = Arc::downgrade(&self.entries);
        let page_lock = self.page_lock.clone();
        let authority = self.authority.clone();
        let task = tokio::spawn(async move {
            let (dirty, mut changed) = watch::channel(false);
            let reader = async {
                let mut events = super::cdp::Cdp::connect(&endpoint).await?;
                events
                    .call(None, "Target.setDiscoverTargets", json!({"discover":true}))
                    .await?;
                loop {
                    events.next_checkpoint_change().await?;
                    dirty.send_replace(true);
                }
                #[allow(unreachable_code)]
                Ok::<(), anyhow::Error>(())
            };
            let writer = async {
                loop {
                    changed.changed().await?;
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _page = page_lock.lock().await;
                    changed.borrow_and_update();
                    // Queued signals carry no URLs: inventory is read only after
                    // acquiring the same lock used by private transitions.
                    if authority.lock().unwrap().private_content() {
                        continue;
                    }
                    let Some(entries) = entries.upgrade() else {
                        return Ok::<(), anyhow::Error>(());
                    };
                    let slots: Vec<_> = entries.lock().unwrap().values().cloned().collect();
                    for slot in slots {
                        let mut entry = slot.state.lock().await;
                        if entry.closed_at.is_some() {
                            continue;
                        }
                        let selected = entry.target.clone();
                        if let Some(browser) = &mut entry.browser {
                            if browser.save_pages(selected.as_deref()).await.is_err() {
                                tracing::warn!(
                                    component = "browser_recovery",
                                    "Browser checkpoint write unavailable"
                                );
                            }
                        }
                    }
                }
            };
            let run = tokio::select! { result = reader => result, result = writer => result };
            if run.is_err() {
                tracing::warn!(
                    component = "browser_recovery",
                    "Browser checkpoint event subscription ended"
                );
            }
        });
        *self.checkpoint_task.lock().unwrap() = Some(task);
    }

    async fn lifecycle(&self, request: &Request, reset: bool) -> anyhow::Result<()> {
        {
            let mut authority = self.authority.lock().unwrap();
            if request.browser_epoch < authority.epoch
                || (request.browser_epoch == authority.epoch
                    && self.lifecycle_receipt.lock().unwrap().as_deref()
                        != Some(&request.request_id))
            {
                anyhow::bail!("browser_stale_control");
            }
            authority.pause();
            authority.epoch = request.browser_epoch;
            *self.recovery_epoch.lock().unwrap() = None;
            *self.lifecycle_receipt.lock().unwrap() = Some(request.request_id.clone());
        }
        self.stop_repl_cells().await?;
        let _page = tokio::time::timeout(Duration::from_secs(20), self.page_lock.lock()).await?;
        if self.authority.lock().unwrap().epoch != request.browser_epoch {
            anyhow::bail!("browser_stale_control");
        }
        self.close_root().await?;
        let slots: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for slot in slots {
            let mut entry = slot.state.lock().await;
            entry.browser = None;
            entry.closed_at = Some(Instant::now());
        }
        // Workspace handles share the profile lock. Drop them before opening
        // the profile exclusively to reset; never remove Chrome singleton locks.
        if reset {
            if let Some((base, environment)) = &self.persistent {
                super::profile::Profile::acquire(
                    base,
                    environment,
                    &request.browser_id,
                    &request.owner_user_id,
                )?
                .reset()?;
            }
        }
        Ok(())
    }

    async fn perform(
        &self,
        entry: &mut Entry,
        runtime: &super::addon::Runtime,
        request: &Request,
    ) -> anyhow::Result<Value> {
        let action = &request.command;
        let ensure = matches!(
            action,
            Action::Open { .. }
                | Action::Ensure { .. }
                | Action::Control {
                    control: ControlCommand::Pause
                }
        );
        if ensure {
            let mut root = self.root.lock().await;
            if matches!(action, Action::Control { .. })
                && root
                    .as_ref()
                    .map(|b| b.process_exited())
                    .transpose()?
                    .unwrap_or(true)
            {
                anyhow::bail!("browser_recovery_required");
            }
            if root
                .as_ref()
                .map(|b| b.process_exited())
                .transpose()?
                .unwrap_or(false)
            {
                tracing::info!(component="browser_lifecycle", event="process_exited",
                    session_id=%request.session_id, request_id=%request.request_id,
                    "Replacing exited owned browser on explicit request");
                // The global page lock is held. Drop every handle before releasing
                // the persistent profile lock; do not close logical workspaces.
                entry.browser = None;
                entry.target = None;
                let slots: Vec<_> = self
                    .entries
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(id, _)| *id != &request.session_id)
                    .map(|(_, s)| s.clone())
                    .collect();
                for slot in slots {
                    let mut other = slot.state.lock().await;
                    other.browser = None;
                    other.target = None;
                }
                *root = None;
            }
            if root.is_none() {
                *root = Some(if let Some((base, environment)) = &self.persistent {
                    let profile = super::profile::Profile::acquire(
                        base,
                        environment,
                        &request.browser_id,
                        &request.owner_user_id,
                    )?;
                    Browser::launch_persistent(runtime, profile, request.browser_color.as_deref())
                        .await?
                } else {
                    Browser::launch(runtime).await?
                });
                if matches!(action, Action::Ensure { .. }) {
                    let mut authority = self.authority.lock().unwrap();
                    // Pause/Stop fence before waiting for the page lock. A launch
                    // completing late must not override their newer intent.
                    if authority.epoch > request.browser_epoch {
                        anyhow::bail!("browser_stale_control");
                    }
                    authority.resume_after_stop(request.browser_epoch + 1);
                    *self.lifecycle_receipt.lock().unwrap() = None;
                    *self.recovery_epoch.lock().unwrap() = Some(request.browser_epoch);
                }
                self.start_checkpoints(root.as_ref().unwrap().checkpoint_endpoint().to_owned());
                // A system browser may have updated since prepare; keep the
                // manifest's recorded version honest without any other change.
                if let (Some((base, _)), Some(browser)) = (&self.persistent, root.as_mut()) {
                    if let Ok(version) = browser.version().await {
                        super::addon::record_observed_version(base, runtime, &version);
                    }
                }
            }
            if entry.browser.is_none() {
                entry.browser = Some(
                    root.as_mut()
                        .unwrap()
                        .workspace(&request.session_id)
                        .await?,
                );
            }
            entry.browser.as_mut().unwrap().recover_channel().await?;
            let restart_watch = self
                .checkpoint_task
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|task| task.is_finished());
            if restart_watch {
                self.start_checkpoints(root.as_ref().unwrap().checkpoint_endpoint().to_owned());
            }
        }
        if let Action::Control { control } = action {
            let browser = entry
                .browser
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("browser_interrupted"))?;
            // A lease acknowledgement must not imply that a permanently interrupted
            // Chrome channel can produce frames. Pause/close remain available.
            if matches!(control, ControlCommand::Acquire { .. }) {
                if browser.interrupted() {
                    anyhow::bail!("browser_interrupted");
                }
                entry.target = Some(browser.ensure_page(entry.target.as_deref()).await?);
                browser.selected_explicitly();
            }
            if !matches!(control, ControlCommand::Renew { .. }) {
                browser.invalidate_references();
            }
            if matches!(control, ControlCommand::PrepareReturn { .. }) {
                browser.hide_before_return().await?;
                let targets = browser.targets().await?;
                let target = entry
                    .target
                    .as_ref()
                    .filter(|id| targets.iter().any(|t| &t.target_id == *id))
                    .or_else(|| targets.first().map(|t| &t.target_id));
                // Empty inventory can be returned too; no DOM is required to
                // release private authority. Contents never enter the ack.
                if let Some(target) = target {
                    // Refresh the structured snapshot before authority returns.
                    browser
                        .inspect(target, json!({"operation":"snapshot","compact":true}))
                        .await?;
                } else {
                    entry.target = None;
                }
            }
            return Ok(json!({"control_acknowledged":true}));
        }
        if matches!(action, Action::Close) {
            if let Some(browser) = entry.browser.as_mut() {
                browser.close().await?;
            } else if let Some(root) = self.root.lock().await.as_mut() {
                root.forget_workspace(&request.session_id)?;
            } else if let Some((base, environment)) = &self.persistent {
                let profile = super::profile::Profile::acquire(
                    base,
                    environment,
                    &request.browser_id,
                    &request.owner_user_id,
                )?;
                super::recovery::Recovery::load(Some(&profile.path))
                    .save(&request.session_id, None)?;
            }
            entry.browser = None;
            entry.closed_at = Some(Instant::now());
            return Ok(json!({"state":"closed", "profile_mode":"persistent"}));
        }
        let browser = entry
            .browser
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_interrupted"))?;
        if browser.interrupted() {
            anyhow::bail!("browser_interrupted");
        }
        if let Action::NativeWindow {
            target_id, show, ..
        } = action
        {
            browser
                .native_window(target_id.as_deref().or(entry.target.as_deref()), *show)
                .await?;
            return Ok(json!({"window_acknowledged":true}));
        }
        if let Action::Ensure { explicit_url } = action {
            {
                let mut authority = self.authority.lock().unwrap();
                let mut pending = self.recovery_epoch.lock().unwrap();
                // A service restart can advance the epoch before receiving the
                // replacement ACK. Keep the proof until public authority is
                // confirmed, but never across a new live control transition.
                if pending.is_some() && request.browser_epoch >= authority.epoch {
                    if request.private_content || request.browser_paused {
                        authority.resume_after_stop(request.browser_epoch + 1);
                        *pending = Some(request.browser_epoch);
                    } else {
                        *pending = None;
                    }
                }
            }
            let replaced = *self.recovery_epoch.lock().unwrap() == Some(request.browser_epoch);
            if self.authority.lock().unwrap().private_content()
                || self.authority.lock().unwrap().mode != super::control::Mode::Agent
            {
                return Ok(
                    json!({"ensured":true,"runtime_replaced":false,"recovery_status":"private"}),
                );
            }
            let (target, count, status) = browser.restore_pages(*explicit_url).await?;
            if target.is_some() {
                entry.target = target;
            }
            return Ok(
                json!({"ensured":true,"runtime_replaced":replaced,"recovery_status":status,"restored_pages":count}),
            );
        }
        if let Action::Open { url } = action {
            if url.is_none() {
                browser.restore_closed_page().await?;
            }
            let (target, _, status) = browser.restore_pages(url.is_some()).await?;
            if target.is_some() {
                entry.target = target;
            }
            if status == "unavailable" {
                anyhow::bail!("browser_recovery_unavailable");
            }
            entry.target = Some(browser.ensure_page(entry.target.as_deref()).await?);
        }
        let targets = browser.targets().await?;
        if targets.is_empty()
            && matches!(action, Action::Inspect { operation, .. } if operation == "page_info")
        {
            return Ok(json!({"observation":{"targets":[],"empty":true}}));
        }
        let requested = match action {
            Action::Navigate { target_id, .. }
            | Action::Inspect { target_id, .. }
            | Action::Capture { target_id, .. } => target_id.as_ref(),
            Action::ResizeViewport { target_id, .. } | Action::FitViewport { target_id, .. } => {
                Some(target_id)
            }
            _ => None,
        };
        if requested.is_none() && browser.selection_unavailable() {
            anyhow::bail!("browser_recovery_unavailable");
        }
        let target = requested
            .or(entry.target.as_ref())
            .filter(|id| targets.iter().any(|target| &target.target_id == *id))
            .or_else(|| {
                if requested.is_none() {
                    targets.first().map(|target| &target.target_id)
                } else {
                    None
                }
            })
            .ok_or_else(|| anyhow::anyhow!("browser_target_not_found"))?
            .clone();
        if requested.is_some() {
            browser.selected_explicitly();
        }
        entry.target = Some(target.clone());
        match action {
            Action::Open { url } => {
                if let Some(url) = url {
                    browser.navigate(&target, url).await?;
                }
                Ok(
                    json!({"state":"ready", "profile_mode":"persistent", "target_id":target,
                "navigation_requested":url.is_some(), "targets":browser.targets().await?}),
                )
            }
            Action::Capture { .. } => browser.capture_scaled(&target, Some(1.0)).await,
            Action::Inspect {
                compact,
                operation,
                continuation,
                scope,
                observation_id,
                reference,
                locator,
                text,
                delta_y,
                position,
                ..
            } => {
                let data = browser.inspect(&target, json!({"compact":compact,"operation":operation,"continuation":continuation,
                "scope":scope,"observation_id":observation_id,"reference":reference,"locator":locator,
                "text":text,"delta_y":delta_y,"position":position})).await?;
                Ok(json!({"observation":data}))
            }
            Action::Navigate { url, .. } => {
                browser.navigate(&target, url).await?;
                Ok(json!({"navigation_requested":true}))
            }
            Action::Focus { reference } => {
                browser.focus(reference).await?;
                Ok(json!({}))
            }
            Action::Click { reference } => {
                browser.click(reference).await?;
                Ok(json!({}))
            }
            Action::HumanInput {
                target_id,
                document_id,
                frame_token,
                input,
                ..
            } => {
                browser
                    .human_input(target_id, document_id, frame_token, input)
                    .await
            }
            Action::ResizeViewport {
                document_id,
                width,
                height,
                ..
            }
            | Action::FitViewport {
                document_id,
                width,
                height,
                ..
            } => {
                browser
                    .resize_viewport(&target, document_id, *width, *height)
                    .await
            }
            Action::InsertText { text } => {
                browser.insert_text(text).await?;
                Ok(json!({}))
            }
            Action::Exec { .. }
            | Action::Lifecycle { .. }
            | Action::Ensure { .. }
            | Action::NativeWindow { .. }
            | Action::Close
            | Action::Cancel
            | Action::Control { .. }
            | Action::MediaAttach { .. } => {
                unreachable!()
            }
        }
    }
}

fn valid_action(action: &Action) -> bool {
    let id = |value: &String| !value.is_empty() && value.len() <= 128;
    let target = |value: &Option<String>| value.as_ref().is_none_or(id);
    let url = |value: &String| {
        value.len() <= 8192
            && url::Url::parse(value).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.username().is_empty()
                    && u.password().is_none()
            })
    };
    match action {
        Action::Exec { code } => !code.is_empty() && code.len() <= 64 * 1024,
        Action::Open { url: value } => value.as_ref().is_none_or(url),
        Action::Navigate {
            url: value,
            target_id,
        } => url(value) && target(target_id),
        Action::Capture {
            target_id,
            endpoint,
            ticket,
        } => {
            target(target_id)
                && ticket.len() >= 32
                && ticket.len() <= 128
                && endpoint.len() <= 2048
                && url::Url::parse(endpoint).is_ok_and(|u| {
                    u.username().is_empty()
                        && u.password().is_none()
                        && u.query().is_none()
                        && u.fragment().is_none()
                        && (u.scheme() == "https"
                            || (u.scheme() == "http"
                                && matches!(u.host_str(), Some("127.0.0.1" | "localhost"))))
                })
        }
        Action::Inspect {
            target_id,
            operation,
            continuation,
            scope,
            observation_id,
            reference,
            locator,
            text,
            delta_y,
            position,
            ..
        } => {
            target(target_id)
                && target(continuation)
                && target(scope)
                && target(observation_id)
                && target(reference)
                && matches!(
                    operation.as_str(),
                    "snapshot"
                        | "visible_dom"
                        | "page_info"
                        | "click"
                        | "geometry"
                        | "focus"
                        | "fill"
                        | "scroll"
                )
                && locator.as_ref().is_none_or(|l| {
                    !l.role.is_empty() && l.role.len() <= 64 && l.name.len() <= 2048
                })
                && text.as_ref().is_none_or(|t| t.len() <= 8192)
                && position.as_ref().is_none_or(|p| {
                    operation == "click"
                        && p.x.is_finite()
                        && p.y.is_finite()
                        && p.x >= 0.0
                        && p.y >= 0.0
                })
                && delta_y.is_none_or(|d| (-10000..=10000).contains(&d))
        }
        Action::NativeWindow {
            controller_id,
            target_id,
            ..
        } => id(controller_id) && target(target_id),
        Action::Ensure { .. } => true,
        Action::Focus { reference } | Action::Click { reference } => id(reference),
        Action::HumanInput {
            controller_id,
            target_id,
            document_id,
            frame_token,
            input,
        } => {
            id(controller_id)
                && id(target_id)
                && id(document_id)
                && id(frame_token)
                && input.valid()
        }
        Action::ResizeViewport {
            controller_id,
            target_id,
            document_id,
            width,
            height,
        } => {
            id(controller_id)
                && id(target_id)
                && id(document_id)
                && (240..=2560).contains(width)
                && (160..=2560).contains(height)
        }
        Action::FitViewport {
            target_id,
            document_id,
            width,
            height,
        } => {
            id(target_id)
                && id(document_id)
                && (240..=2560).contains(width)
                && (160..=2560).contains(height)
        }
        Action::MediaAttach {
            endpoint,
            ticket,
            controller_id,
            ..
        } => {
            ticket.len() >= 32
                && ticket.len() <= 128
                && target(controller_id)
                && endpoint.len() <= 2048
                && url::Url::parse(endpoint).is_ok_and(|u| {
                    u.username().is_empty()
                        && u.password().is_none()
                        && u.query().is_none()
                        && u.fragment().is_none()
                        && (u.scheme() == "wss"
                            || (u.scheme() == "ws"
                                && matches!(
                                    u.host_str(),
                                    Some("localhost" | "127.0.0.1" | "[::1]")
                                )))
                })
        }
        Action::InsertText { text } => !text.is_empty() && text.len() <= 8192,
        Action::Lifecycle { .. } | Action::Close | Action::Cancel | Action::Control { .. } => true,
    }
}

#[cfg(test)]
mod tests {

    #[tokio::test]
    async fn startup_failure_returns_an_unavailable_manager_without_aborting_daemon_setup() {
        if super::super::addon::env_override().is_some() {
            return;
        }
        let base = tempfile::tempdir().unwrap();
        let dir = super::super::addon::addon_dir(base.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), "invalid manifest").unwrap();
        let manager = BrowserManager::configured_for(base.path().into(), "test".into()).await;
        assert_eq!(manager.capability()["available"], false);
        manager.connect("device".into());
        assert_eq!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .error,
            Some("browser_not_configured")
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("manifest.json")).unwrap(),
            "invalid manifest"
        );
    }

    fn inspect_snapshot() -> Action {
        serde_json::from_value(json!({"action":"inspect","operation":"snapshot"})).unwrap()
    }
    use super::*;

    #[test]
    fn semantic_click_position_validation() {
        let command = |operation: &str, position: Value| {
            json!({
                "action":"inspect", "operation":operation, "reference":"s:e1", "position":position
            })
        };
        for value in [
            command("click", json!({"x":0.0,"y":1.5})),
            json!({"action":"inspect","operation":"geometry","reference":"s:e1"}),
        ] {
            assert!(valid_action(&serde_json::from_value(value).unwrap()));
        }
        for value in [
            command("click", json!({"x":-1,"y":1})),
            command("geometry", json!({"x":1,"y":1})),
        ] {
            assert!(!valid_action(&serde_json::from_value(value).unwrap()));
        }
        for position in [
            json!({"x":1}),
            json!({"x":1,"y":1,"force":true}),
            json!({"x":"1","y":1}),
        ] {
            assert!(serde_json::from_value::<Action>(command("click", position)).is_err());
        }
    }

    #[test]
    fn control_wire_has_a_strict_typed_operation() {
        assert!(serde_json::from_value::<Action>(
            json!({"action":"control","control":{"operation":"pause"}})
        )
        .is_ok());
        assert!(serde_json::from_value::<Action>(
            json!({"action":"control","control":{"operation":"acquire","controller_id":"one"}})
        )
        .is_ok());
        assert!(serde_json::from_value::<Action>(json!({"action":"control","control":{"operation":"acquire","controller_id":"one","script":"bad"}})).is_err());
    }

    #[test]
    fn launch_color_is_envelope_metadata_not_an_action_argument() {
        let mut value = json!({
            "request_id":"request", "device_session_id":"device", "session_id":"session",
            "generation":"generation", "thread_id":"thread", "owner_user_id":"alice",
            "browser_id":"resource", "browser_epoch":1, "private_content":false,
            "browser_paused":false, "control_epoch":1, "sequence":1,
            "expires_at_ms":30000, "invocation_id":"invocation", "invocation_fence":1,
            "browser_color":"#EE50E6", "command":{"action":"open"}
        });
        assert_eq!(
            serde_json::from_value::<Request>(value.clone())
                .unwrap()
                .browser_color
                .as_deref(),
            Some("#EE50E6")
        );
        value.as_object_mut().unwrap().remove("browser_color");
        assert!(serde_json::from_value::<Request>(value)
            .unwrap()
            .browser_color
            .is_none());
        assert!(serde_json::from_value::<Action>(
            json!({"action":"open", "browser_color":"#FFFFFF"})
        )
        .is_err());
    }

    fn request(sequence: u64, command: Action) -> Request {
        Request {
            browser_color: None,
            repl_images: None,
            request_id: format!("request-{sequence}"),
            device_session_id: "device".into(),
            session_id: "browser".into(),
            generation: "generation".into(),
            thread_id: "thread".into(),
            owner_user_id: "alice".into(),
            browser_id: "resource".into(),
            browser_epoch: 1,
            private_content: false,
            browser_paused: false,
            control_epoch: 1,
            sequence,
            expires_at_ms: crate::util::now_millis() + 30_000,
            invocation_id: "invocation".into(),
            invocation_fence: 1,
            command,
        }
    }

    async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let body =
                        "<html><body><h1>Fixture</h1><button>Continue</button></body></html>";
                    let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(),body).as_bytes()).await;
                });
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn live_operation_media_idles_and_refreshes_without_chrome_heartbeat_work() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .ok
        );
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(
            manager
                .execute(request(
                    2,
                    Action::MediaAttach {
                        endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                        ticket: "operation-driven-media-test-ticket-0123456789".into(),
                        controller_id: None,
                        operation_driven: Some(true),
                    }
                ))
                .await
                .ok
        );
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        socket.next().await.unwrap().unwrap(); // ticket
        socket
            .send(Message::Text(json!({"target_id":null}).to_string()))
            .await
            .unwrap();
        let frame: Value =
            serde_json::from_str(&socket.next().await.unwrap().unwrap().into_text().unwrap())
                .unwrap();
        assert!(frame["image"].is_string());
        // Across the old ten-second idle timeout. Hold the CDP lock to prove
        // protocol heartbeats do not need page access or capture.
        let page = slot.state.lock().await;
        for _ in 0..4 {
            socket.send(Message::Ping(vec![1])).await.unwrap();
            let pong = tokio::time::timeout(Duration::from_secs(1), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(matches!(pong, Message::Pong(_)));
            assert!(
                tokio::time::timeout(Duration::from_secs(3), socket.next())
                    .await
                    .is_err(),
                "unsolicited idle capture"
            );
        }
        drop(page);
        // A new invocation advances command authority but retains this socket.
        let request = |sequence, command| {
            let mut next = request(sequence, command);
            next.control_epoch = 2;
            next
        };
        let observed = manager.execute(request(2, inspect_snapshot())).await;
        assert!(observed.ok);
        let mut stale = request(3, inspect_snapshot());
        stale.control_epoch = 1;
        assert!(!manager.execute(stale).await.ok);
        let refresh = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&refresh.into_text().unwrap()).unwrap(),
            json!({"refresh":true})
        );
        socket
            .send(Message::Text(json!({"target_id":null}).to_string()))
            .await
            .unwrap();
        let updated = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(serde_json::from_str::<Value>(&updated).unwrap()["image"].is_string());
        let fit = request(
            2,
            Action::FitViewport {
                target_id: frame["target_id"].as_str().unwrap().into(),
                document_id: frame["document_id"].as_str().unwrap().into(),
                width: 640,
                height: 480,
            },
        );
        assert!(manager.execute(fit.clone()).await.ok);
        let revision = *slot.refresh.borrow();
        assert!(manager.execute(fit).await.ok);
        assert_eq!(*slot.refresh.borrow(), revision, "identical fit refreshed");
        let rejected = manager
            .execute(request(
                3,
                Action::Click {
                    reference: "missing".into(),
                },
            ))
            .await;
        assert!(!rejected.ok);
        assert_eq!(*slot.refresh.borrow(), revision, "rejection refreshed");
        manager.disconnect();
        tokio::time::timeout(Duration::from_secs(2), async {
            while slot.media.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!slot
            .state
            .lock()
            .await
            .browser
            .as_mut()
            .unwrap()
            .interrupted());
        manager.connect("device".into());
        assert!(manager.execute(request(4, Action::Close)).await.ok);
    }

    #[tokio::test]
    async fn live_disconnect_during_capture_drains_cdp_without_delivering_frame() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .ok
        );
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        assert!(
            manager
                .execute(request(
                    2,
                    Action::MediaAttach {
                        endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                        ticket: "capture-disconnect-test-ticket-0123456789".into(),
                        controller_id: None,
                        operation_driven: None,
                    }
                ))
                .await
                .ok
        );
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        socket.next().await.unwrap().unwrap(); // ticket handshake
        socket
            .send(Message::Text(json!({"target_id":null}).to_string()))
            .await
            .unwrap();
        // This single-threaded test waits until capture owns the page lock and
        // has yielded in CDP I/O, rather than guessing a screenshot duration.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if slot.state.try_lock().is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("capture never acquired page lock");
        manager.disconnect();
        tokio::time::timeout(Duration::from_secs(15), async {
            while slot.media.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("capture did not drain");
        assert!(
            !slot
                .state
                .lock()
                .await
                .browser
                .as_mut()
                .unwrap()
                .interrupted(),
            "disconnect poisoned the shared Chrome channel"
        );
        assert!(
            !matches!(socket.next().await, Some(Ok(Message::Text(_)))),
            "revoked capture delivered pixels"
        );
        manager.connect("reconnected".into());
        let mut observe = request(2, inspect_snapshot());
        observe.device_session_id = "reconnected".into();
        let observed = manager.execute(observe.clone()).await;
        assert!(observed.ok, "{observed:?}");
        observe.sequence = 3;
        observe.command = Action::Close;
        assert!(manager.execute(observe).await.ok);
    }

    #[tokio::test]
    async fn live_handoff_media_and_explicit_return() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .ok
        );
        let command = |sequence, epoch, control| {
            let mut r = request(sequence, Action::Control { control });
            r.control_epoch = epoch;
            r.browser_epoch = epoch;
            r
        };
        assert!(
            manager
                .execute(command(2, 2, ControlCommand::Pause))
                .await
                .ok
        );
        assert!(
            manager
                .execute(command(
                    3,
                    3,
                    ControlCommand::Acquire {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        // Hold the serial page lock: renewal must still finish immediately.
        {
            let slot = manager
                .entries
                .lock()
                .unwrap()
                .get("browser")
                .unwrap()
                .clone();
            let _page = slot.state.lock().await;
            let renewed = tokio::time::timeout(
                Duration::from_millis(100),
                manager.execute(command(
                    3,
                    3,
                    ControlCommand::Renew {
                        controller_id: "viewer".into(),
                    },
                )),
            )
            .await
            .expect("renewal waited for page work");
            assert!(renewed.ok);
            let rejected = manager
                .execute(command(
                    3,
                    3,
                    ControlCommand::Renew {
                        controller_id: "other".into(),
                    },
                ))
                .await;
            assert_eq!(rejected.error, Some("browser_control_expired"));
        }
        let blocked = manager.execute(request(4, inspect_snapshot())).await;
        assert_eq!(blocked.error, Some("browser_private_or_paused"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ticket = "test-ticket-012345678901234567890123456789";
        let mut attach = request(
            4,
            Action::MediaAttach {
                endpoint: format!("ws://{}/", listener.local_addr().unwrap()),
                ticket: ticket.into(),
                controller_id: Some("viewer".into()),
                operation_driven: None,
            },
        );
        attach.control_epoch = 3;
        attach.browser_epoch = 3;
        assert!(manager.execute(attach).await.ok);
        let (socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let hello = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&hello).unwrap()["ticket"],
            ticket
        );
        socket
            .send(Message::Text(json!({"target_id":null}).to_string()))
            .await
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let frame: Value = serde_json::from_str(&frame).unwrap();
        assert!(frame["image"].as_str().unwrap().len() > 100);
        let resize = |controller: &str, epoch| {
            let mut r = request(
                5,
                Action::ResizeViewport {
                    controller_id: controller.into(),
                    target_id: frame["target_id"].as_str().unwrap().into(),
                    document_id: frame["document_id"].as_str().unwrap().into(),
                    width: 640,
                    height: 480,
                },
            );
            r.control_epoch = epoch;
            r.browser_epoch = epoch;
            r
        };
        assert_eq!(
            manager.execute(resize("other", 3)).await.error,
            Some("browser_control_expired")
        );
        assert_eq!(
            manager.execute(resize("viewer", 2)).await.error,
            Some("browser_control_expired")
        );
        let resized = manager.execute(resize("viewer", 3)).await;
        assert!(resized.ok, "resize failed: {:?}", resized.error);
        // Real viewer cadence: capture continuously across two five-second renewals.
        let started = Instant::now();
        let mut renewals = 0;
        while started.elapsed() < Duration::from_secs(11) {
            socket
                .send(Message::Text(json!({"target_id":null}).to_string()))
                .await
                .unwrap();
            let raw = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap();
            let data: Value = serde_json::from_str(&raw).unwrap();
            assert!(data["image"].is_string() || data["busy"] == true);
            if started.elapsed() >= Duration::from_secs((renewals + 1) * 5) && renewals < 2 {
                let reply = manager
                    .execute(command(
                        6 + renewals,
                        3,
                        ControlCommand::Renew {
                            controller_id: "viewer".into(),
                        },
                    ))
                    .await;
                assert!(reply.ok, "renewal failed: {:?}", reply.error);
                renewals += 1;
            }
        }
        assert_eq!(renewals, 2);
        socket.close(None).await.unwrap();
        drop(socket);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            manager
                .execute(command(
                    8,
                    4,
                    ControlCommand::PrepareReturn {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        assert!(
            manager
                .execute(command(9, 5, ControlCommand::FinishReturn))
                .await
                .ok
        );
        let mut observe = request(10, inspect_snapshot());
        observe.control_epoch = 5;
        observe.browser_epoch = 5;
        assert!(manager.execute(observe).await.ok);
        let mut close = request(11, Action::Close);
        close.control_epoch = 5;
        close.browser_epoch = 5;
        assert!(manager.execute(close).await.ok);
    }

    #[tokio::test]
    async fn live_passive_fit_preserves_invocation_and_rejects_private_authority() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: Some(url) }))
                .await
                .ok
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        server.abort();
        let observed = manager.execute(request(2, inspect_snapshot())).await;
        let observation = &observed.data["observation"];
        let reference = observation["nodes"][0]["reference"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut fit = request(
            2,
            Action::FitViewport {
                target_id: observation["target_id"].as_str().unwrap().into(),
                document_id: observation["document_id"].as_str().unwrap().into(),
                width: 640,
                height: 480,
            },
        );
        fit.invocation_id = "viewer_not_an_invocation".into();
        assert!(manager.execute(fit.clone()).await.ok);
        assert_eq!(
            manager
                .execute(request(3, Action::Click { reference }))
                .await
                .error,
            Some("browser_stale_reference")
        );
        let fresh = manager.execute(request(4, inspect_snapshot())).await;
        assert!(fresh.ok, "{fresh:?}");
        // Reapplying identical geometry doesn't invalidate the fresh observation.
        assert!(manager.execute(fit.clone()).await.ok);
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        let entry = slot.state.lock().await;
        assert_eq!(entry.sequence, 4);
        assert_eq!(entry.invocation.as_ref().unwrap().0, "invocation");
        drop(entry);
        let mut pause = request(
            5,
            Action::Control {
                control: ControlCommand::Pause,
            },
        );
        pause.control_epoch = 2;
        pause.browser_epoch = 2;
        assert!(manager.execute(pause).await.ok);
        fit.control_epoch = 2;
        fit.browser_epoch = 2;
        assert_eq!(
            manager.execute(fit).await.error,
            Some("browser_private_or_paused")
        );
        let mut close = request(6, Action::Close);
        close.control_epoch = 2;
        close.browser_epoch = 2;
        assert!(manager.execute(close).await.ok);
    }

    #[tokio::test]
    async fn unavailable_and_stale_connections_are_rejected_before_launch() {
        let manager = BrowserManager::new(None);
        assert_eq!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .error,
            Some("browser_stale_connection")
        );
        manager.connect("device".into());
        assert_eq!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .error,
            Some("browser_not_configured")
        );
    }

    #[tokio::test]
    async fn live_cancel_poison_and_explicit_recovery() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: Some(url) }))
                .await
                .ok
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        server.abort();
        let first = manager.execute(request(2, inspect_snapshot())).await;
        assert!(first.ok, "{first:?}");
        let reference = first.data["observation"]["nodes"][0]["reference"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(manager.execute(request(3, inspect_snapshot())).await.ok);
        assert_eq!(
            manager
                .execute(request(4, Action::Click { reference }))
                .await
                .error,
            Some("browser_stale_reference")
        );
        // A local server accepts navigation but deliberately never replies.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let navigation = request(
            5,
            Action::Navigate {
                url: format!("http://{}/", listener.local_addr().unwrap()),
                target_id: None,
            },
        );
        let mut cancel = navigation.clone();
        cancel.command = Action::Cancel;
        let (result, ()) = tokio::join!(manager.execute(navigation), async {
            let (_socket, _) = listener.accept().await.unwrap();
            manager.execute(cancel).await;
        });
        assert_eq!(result.outcome, "unknown");
        assert_eq!(
            manager.execute(request(6, inspect_snapshot())).await.error,
            Some("browser_interrupted")
        );
        let mut pause = request(
            7,
            Action::Control {
                control: ControlCommand::Pause,
            },
        );
        pause.control_epoch = 2;
        pause.browser_epoch = 2;
        assert!(manager.execute(pause).await.ok);
        let mut acquire = request(
            8,
            Action::Control {
                control: ControlCommand::Acquire {
                    controller_id: "viewer".into(),
                },
            },
        );
        acquire.control_epoch = 3;
        acquire.browser_epoch = 3;
        assert!(
            manager.execute(acquire).await.ok,
            "explicit takeover repairs the channel without replaying navigation"
        );
        let mut close = request(9, Action::Close);
        close.control_epoch = 3;
        close.browser_epoch = 3;
        assert!(manager.execute(close).await.ok);
        let mut reopen = request(1, Action::Open { url: None });
        reopen.session_id = "replacement".into();
        reopen.generation = "replacement-generation".into();
        assert_eq!(
            manager.execute(reopen).await.error,
            Some("browser_private_or_paused")
        );
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn live_empty_workspace_return_and_dead_process_replacement() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let first = manager
            .execute(request(1, Action::Open { url: None }))
            .await;
        assert!(first.ok, "{first:?}");
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        // Close pages without closing the logical workspace, as native tab close does.
        slot.state
            .lock()
            .await
            .browser
            .as_mut()
            .unwrap()
            .close()
            .await
            .unwrap();
        let reopen = request(2, Action::Open { url: None });
        assert!(manager.execute(reopen.clone()).await.ok);
        assert!(
            !manager.execute(reopen).await.ok,
            "duplicate receipt must not dispatch"
        );
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_mut()
                .unwrap()
                .targets()
                .await
                .unwrap()
                .len(),
            1
        );
        manager
            .root
            .lock()
            .await
            .as_mut()
            .unwrap()
            .close()
            .await
            .unwrap();
        assert!(
            manager
                .execute(request(3, Action::Open { url: None }))
                .await
                .ok
        );
        let control = |seq, epoch, control| {
            let mut r = request(seq, Action::Control { control });
            r.control_epoch = epoch;
            r.browser_epoch = epoch;
            r
        };
        assert!(
            manager
                .execute(control(4, 2, ControlCommand::Pause))
                .await
                .ok
        );
        assert!(
            manager
                .execute(control(
                    5,
                    3,
                    ControlCommand::Acquire {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        slot.state
            .lock()
            .await
            .browser
            .as_mut()
            .unwrap()
            .close()
            .await
            .unwrap();
        assert_eq!(
            manager
                .execute(request(6, Action::Open { url: None }))
                .await
                .error,
            Some("browser_private_or_paused")
        );
        assert!(
            manager
                .execute(control(
                    6,
                    4,
                    ControlCommand::PrepareReturn {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        assert!(
            manager
                .execute(control(7, 5, ControlCommand::FinishReturn))
                .await
                .ok
        );
        let mut open = request(8, Action::Open { url: None });
        open.control_epoch = 5;
        open.browser_epoch = 5;
        let mut concurrent = request(9, Action::Open { url: None });
        concurrent.control_epoch = 5;
        concurrent.browser_epoch = 5;
        let (first, second) = tokio::join!(manager.execute(open), manager.execute(concurrent));
        assert!(first.ok || second.ok, "{first:?} {second:?}");
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_mut()
                .unwrap()
                .targets()
                .await
                .unwrap()
                .len(),
            1,
            "concurrent opens must ensure only one owned page"
        );
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn live_automatic_recovery_freezes_private_checkpoints_and_fences_stale_work() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let opened = manager
            .execute(request(
                1,
                Action::Open {
                    url: Some(url.clone()),
                },
            ))
            .await;
        assert!(opened.ok, "{opened:?}");
        let target = opened.data["target_id"].as_str().unwrap().to_owned();
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        // No browser operation flush follows these SPA changes: the event-fed
        // checkpoint must notice both query and fragment commits itself.
        tokio::time::sleep(Duration::from_millis(300)).await;
        {
            let _page = manager.page_lock.lock().await;
            let mut state = slot.state.lock().await;
            state.browser.as_mut().unwrap().same_document_for_test(&target,
                "history.pushState({}, '', '?q=a%2Fb&q=c#route'); history.replaceState({}, '', '?q=a%2Fb&q=c#final')").await.unwrap();
        }
        let expected = format!("{url}?q=a%2Fb&q=c#final");
        for _ in 0..100 {
            let saved = slot
                .state
                .lock()
                .await
                .browser
                .as_ref()
                .unwrap()
                .checkpoint_for_test();
            if saved.as_ref().is_some_and(|p| p.urls.contains(&expected)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_ref()
                .unwrap()
                .checkpoint_for_test()
                .unwrap()
                .urls,
            vec![expected.clone()]
        );
        let control = |seq, epoch, command| {
            let mut r = request(seq, Action::Control { control: command });
            r.control_epoch = epoch;
            r.browser_epoch = epoch;
            r
        };
        assert!(
            manager
                .execute(control(2, 2, ControlCommand::Pause))
                .await
                .ok
        );
        assert!(
            manager
                .execute(control(
                    3,
                    3,
                    ControlCommand::Acquire {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        {
            let _page = manager.page_lock.lock().await;
            slot.state
                .lock()
                .await
                .browser
                .as_mut()
                .unwrap()
                .same_document_for_test(
                    &target,
                    "history.pushState({}, '', '?private=secret#hidden')",
                )
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_ref()
                .unwrap()
                .checkpoint_for_test()
                .unwrap()
                .urls,
            vec![expected.clone()]
        );
        let invalid_return = manager
            .execute(control(4, 4, ControlCommand::FinishReturn))
            .await;
        assert_eq!(invalid_return.error, Some("browser_control_conflict"));
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_ref()
                .unwrap()
                .checkpoint_for_test()
                .unwrap()
                .urls,
            vec![expected.clone()],
            "rejected Return must not disclose private navigation"
        );
        let mut ensure = request(
            3,
            Action::Ensure {
                explicit_url: false,
            },
        );
        ensure.control_epoch = 3;
        ensure.browser_epoch = 3;
        ensure.private_content = true;
        ensure.browser_paused = true;
        let live = manager.execute(ensure.clone()).await;
        assert!(live.ok, "{live:?}");
        assert_eq!(live.data["runtime_replaced"], false);
        assert!(manager.authority.lock().unwrap().private_content());
        // A lost media/CDP channel never proves process loss. An exited owned
        // child does; old input and actions remain fenced until the new epoch.
        manager
            .root
            .lock()
            .await
            .as_mut()
            .unwrap()
            .close()
            .await
            .unwrap();
        let replaced = manager.execute(ensure.clone()).await;
        assert!(replaced.ok, "{replaced:?}");
        assert_eq!(replaced.data["runtime_replaced"], true);
        let duplicate = manager.execute(ensure.clone()).await;
        assert!(duplicate.ok, "{duplicate:?}");
        assert_eq!(duplicate.data["runtime_replaced"], true);
        assert!(slot
            .state
            .lock()
            .await
            .browser
            .as_mut()
            .unwrap()
            .targets()
            .await
            .unwrap()
            .is_empty());
        // Lost recovery acknowledgement followed by service restart still proves
        // replacement, without creating another runtime or releasing live control.
        ensure.browser_epoch = 4;
        let rebased = manager.execute(ensure.clone()).await;
        assert!(rebased.ok, "{rebased:?}");
        assert_eq!(rebased.data["runtime_replaced"], true);
        assert!(!manager.authority.lock().unwrap().private_content());
        assert_eq!(
            manager.execute(request(4, inspect_snapshot())).await.error,
            Some("browser_private_or_paused")
        );
        let mut fresh = request(
            4,
            serde_json::from_value(json!({"action":"inspect","operation":"page_info"})).unwrap(),
        );
        fresh.browser_epoch = 5;
        fresh.control_epoch = 4;
        assert!(manager.execute(fresh).await.ok);
        let mut stop = request(5, Action::Lifecycle { reset: false });
        stop.browser_epoch = 6;
        stop.control_epoch = 5;
        assert!(manager.execute(stop).await.ok);
        assert!(!manager.execute(ensure).await.ok);
        assert!(manager.root.lock().await.is_none());
        // Only the service's later explicit open can supply a newer workspace
        // identity/epoch after Stop. Passive retry of the old identity stays closed.
        let mut reopened = request(
            1,
            Action::Ensure {
                explicit_url: false,
            },
        );
        reopened.session_id = "replacement".into();
        reopened.browser_epoch = 7;
        let result = manager.execute(reopened).await;
        assert!(result.ok, "{result:?}");
        assert_eq!(result.data["runtime_replaced"], true);
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn live_explicit_return_checkpoints_disclosed_navigation() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let opened = manager
            .execute(request(
                1,
                Action::Open {
                    url: Some(url.clone()),
                },
            ))
            .await;
        assert!(opened.ok, "{opened:?}");
        let target = opened.data["target_id"].as_str().unwrap();
        let control = |seq, command| {
            let mut r = request(seq, Action::Control { control: command });
            r.control_epoch = seq;
            r.browser_epoch = seq;
            r
        };
        assert!(manager.execute(control(2, ControlCommand::Pause)).await.ok);
        assert!(
            manager
                .execute(control(
                    3,
                    ControlCommand::Acquire {
                        controller_id: "viewer".into()
                    }
                ))
                .await
                .ok
        );
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        {
            let _page = manager.page_lock.lock().await;
            slot.state
                .lock()
                .await
                .browser
                .as_mut()
                .unwrap()
                .same_document_for_test(
                    target,
                    "history.replaceState({}, '', '?returned=yes#done')",
                )
                .await
                .unwrap();
        }
        let prepared = manager
            .execute(control(
                4,
                ControlCommand::PrepareReturn {
                    controller_id: "viewer".into(),
                },
            ))
            .await;
        assert!(prepared.ok, "{prepared:?}");
        let returned = manager
            .execute(control(5, ControlCommand::FinishReturn))
            .await;
        assert!(returned.ok, "{returned:?}");
        assert!(!manager.authority.lock().unwrap().private_content());
        assert_eq!(
            slot.state
                .lock()
                .await
                .browser
                .as_ref()
                .unwrap()
                .checkpoint_for_test()
                .unwrap()
                .urls,
            vec![format!("{url}?returned=yes#done")]
        );
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn live_global_privacy_and_lifecycle() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let workspace = |id: &str, sequence, epoch, command| {
            let mut r = request(sequence, command);
            r.session_id = id.into();
            r.thread_id = id.into();
            r.browser_epoch = epoch;
            r.control_epoch = sequence;
            r.request_id = format!("{id}-{sequence}-{epoch}");
            r
        };
        for id in ["a", "b"] {
            assert!(
                manager
                    .execute(workspace(id, 1, 1, Action::Open { url: None }))
                    .await
                    .ok
            );
        }
        assert!(
            manager
                .execute(workspace(
                    "a",
                    2,
                    2,
                    Action::Control {
                        control: ControlCommand::Pause
                    }
                ))
                .await
                .ok
        );
        assert!(
            manager
                .execute(workspace(
                    "a",
                    3,
                    3,
                    Action::Control {
                        control: ControlCommand::Acquire {
                            controller_id: "viewer".into()
                        }
                    }
                ))
                .await
                .ok
        );
        assert_eq!(
            manager
                .execute(workspace("b", 2, 3, inspect_snapshot()))
                .await
                .error,
            Some("browser_private_or_paused")
        );
        let ensured = manager
            .execute(workspace(
                "a",
                3,
                3,
                Action::Ensure {
                    explicit_url: false,
                },
            ))
            .await;
        assert!(ensured.ok, "{ensured:?}");
        assert_eq!(ensured.data["runtime_replaced"], false);
        assert!(manager.authority.lock().unwrap().private_content());
        for (workspace_id, controller, expected) in [
            ("a", "other", "browser_control_expired"),
            ("b", "viewer", "browser_control_workspace_mismatch"),
        ] {
            assert_eq!(
                manager
                    .execute(workspace(
                        workspace_id,
                        4,
                        3,
                        Action::NativeWindow {
                            controller_id: controller.into(),
                            target_id: None,
                            show: true
                        }
                    ))
                    .await
                    .error,
                Some(expected)
            );
        }
        // A queued reveal cannot use authority revoked while waiting for page work.
        let page = manager.page_lock.lock().await;
        let stale_show = manager.execute(workspace(
            "a",
            4,
            3,
            Action::NativeWindow {
                controller_id: "viewer".into(),
                target_id: None,
                show: true,
            },
        ));
        let (result, ()) = tokio::join!(stale_show, async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            manager.authority.lock().unwrap().pause();
            drop(page);
        });
        assert_eq!(result.error, Some("browser_control_expired"));
        assert!(!manager.authority.lock().unwrap().workspace_allowed("b"));
        assert!(!manager.authority.lock().unwrap().viewer_allowed(3, None));
        // Stop is globally fenced, acknowledged only after process exit, and
        // retrying its exact receipt is safe. It never clears private intent.
        let mut stop = workspace("resource", 4, 4, Action::Lifecycle { reset: false });
        stop.private_content = true;
        stop.browser_paused = true;
        assert!(manager.execute(stop.clone()).await.ok);
        assert!(manager.root.lock().await.is_none());
        assert!(manager.execute(stop).await.ok);
        let mut forbidden = workspace("c", 1, 5, Action::Open { url: None });
        forbidden.private_content = true;
        forbidden.browser_paused = true;
        assert_eq!(
            manager.execute(forbidden).await.error,
            Some("browser_private_or_paused")
        );
        let reset = workspace("resource", 5, 6, Action::Lifecycle { reset: true });
        assert!(manager.execute(reset).await.ok);
        // Service clears the durable private latch only on reset acknowledgement.
        assert!(
            manager
                .execute(workspace("d", 1, 7, Action::Open { url: None }))
                .await
                .ok
        );
        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn live_repl_position_and_geometry_use_the_guarded_bridge() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: Some(url) }))
                .await
                .ok
        );
        let run = |sequence, code: &str| request(sequence, Action::Exec { code: code.into() });
        let clicked = manager.execute(run(2, r#"
            var tab = await browser.tabs.current();
            await tab.evaluate(() => { window.clicks=0; document.querySelector('button').onclick=()=>window.clicks++; });
            var snap = await tab.snapshot();
            var handle = tab.getByRole('button', {name:'Continue', exact:true});
            var box = await handle.geometry();
            await handle.click({position:{x:1,y:1}});
            console.log(JSON.stringify({box,clicks:await tab.evaluate(()=>window.clicks)}));
        "#)).await;
        assert!(clicked.ok, "{clicked:?}");
        let output: Value =
            serde_json::from_str(clicked.data["text"].as_str().unwrap().trim()).unwrap();
        assert!(output["box"]["width"].as_f64().unwrap() > 1.0);
        assert_eq!(output["clicks"], 1);
        let invalid = manager
            .execute(run(3, "await handle.click({position:{x:box.width,y:1}})"))
            .await;
        assert!(!invalid.ok);
        assert_eq!(invalid.outcome, "unknown"); // A started cell is never safe to replay.
        let observed = manager
            .execute(run(4, "console.log(await tab.evaluate(()=>window.clicks))"))
            .await;
        assert!(observed.ok, "{observed:?}");
        assert_eq!(observed.data["text"].as_str().unwrap().trim(), "1");
        assert_eq!(
            observed.data["runtime_generation"],
            clicked.data["runtime_generation"]
        );
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn live_uncertain_click_preserves_session_and_allows_fresh_observation() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let (url, server) = fixture().await;
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let opened = manager
            .execute(request(1, Action::Open { url: Some(url) }))
            .await;
        assert!(opened.ok, "{opened:?}");
        let target = opened.data["target_id"].as_str().unwrap().to_owned();
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("browser")
            .unwrap()
            .clone();
        {
            let _page = manager.page_lock.lock().await;
            let mut state = slot.state.lock().await;
            state.browser.as_mut().unwrap().same_document_for_test(&target,
                "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;z-index:100\"></div>')").await.unwrap();
        }
        assert!(manager.execute(request(2, inspect_snapshot())).await.ok);
        let action = serde_json::from_value(json!({
            "action":"inspect", "operation":"click", "target_id":target,
            "locator":{"role":"button","name":"Continue"}
        }))
        .unwrap();
        let blocked = manager.execute(request(3, action)).await;
        assert!(!blocked.ok);
        assert_eq!(blocked.error, Some("browser_outcome_unknown"));
        assert_eq!(blocked.outcome, "unknown");
        let observed = manager.execute(request(4, inspect_snapshot())).await;
        assert!(observed.ok, "{observed:?}");
        assert_eq!(observed.data["observation"]["target_id"], target);
        assert!(manager.execute(request(5, Action::Close)).await.ok);
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn live_session_isolation_reconnect_and_duplicate_admission() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let open = request(1, Action::Open { url: None });
        let (first, duplicate) =
            tokio::join!(manager.execute(open.clone()), manager.execute(open.clone()));
        assert!(first.ok, "{first:?}");
        assert!(!duplicate.ok);
        assert_eq!(
            manager.execute(open.clone()).await.error,
            Some("browser_stale_request")
        );
        let mut foreign = request(2, inspect_snapshot());
        foreign.owner_user_id = "bob".into();
        assert_eq!(
            manager.execute(foreign).await.error,
            Some("browser_resource_changed_restart_required")
        );
        let mut second = request(1, Action::Open { url: None });
        second.session_id = "second".into();
        second.thread_id = "second-thread".into();
        let other = manager.execute(second.clone()).await;
        assert!(other.ok, "{other:?}");
        assert_ne!(first.data["target_id"], other.data["target_id"]);
        assert_eq!(manager.capability()["max_sessions"], 10);
        for index in 2..10 {
            let mut extra = request(1, Action::Open { url: None });
            extra.session_id = format!("extra-{index}");
            extra.thread_id = format!("extra-thread-{index}");
            let result = manager.execute(extra).await;
            assert!(result.ok, "workspace {index}: {result:?}");
        }
        let mut overflow = second.clone();
        overflow.session_id = "overflow".into();
        overflow.thread_id = "overflow".into();
        assert_eq!(
            manager.execute(overflow.clone()).await.error,
            Some("browser_session_limit")
        );
        manager.disconnect();
        manager.connect("reconnected".into());
        assert_eq!(
            manager.execute(request(2, inspect_snapshot())).await.error,
            Some("browser_stale_connection")
        );
        let mut observe = request(2, inspect_snapshot());
        observe.device_session_id = "reconnected".into();
        let observed = manager.execute(observe.clone()).await;
        assert!(observed.ok, "{observed:?}");
        assert_eq!(
            observed.data["observation"]["target_id"],
            first.data["target_id"]
        );
        observe.sequence = 3;
        observe.request_id = "close".into();
        observe.command = Action::Close;
        assert!(manager.execute(observe.clone()).await.ok);
        observe.sequence = 4;
        assert_eq!(manager.execute(observe).await.error, Some("browser_closed"));
        second.device_session_id = "reconnected".into();
        second.sequence = 2;
        second.command = Action::Close;
        assert!(manager.execute(second).await.ok);
        overflow.device_session_id = "reconnected".into();
        assert!(manager.execute(overflow).await.ok);
        manager.shutdown().await.unwrap();
    }
}
