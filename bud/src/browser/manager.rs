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

#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Open {
        url: Option<String>,
    },
    Observe {
        target_id: Option<String>,
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
    Close,
    Cancel,
}

impl Action {
    // Static labels only: never serialize action arguments into diagnostics.
    fn diagnostic_name(&self) -> &'static str {
        match self {
            Self::Open { .. } => "open",
            Self::Observe { .. } => "observe",
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

/// Authority is supplied by the service, never by model arguments.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub device_session_id: String,
    pub session_id: String,
    pub generation: String,
    pub thread_id: String,
    pub owner_user_id: String,
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
    owner: String,
    thread: String,
    generation: String,
    cancel: watch::Sender<Option<String>>,
    pub(super) state: AsyncMutex<Entry>,
    pub(super) authority: Mutex<Authority>,
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
    executable: Option<PathBuf>,
    boot_id: String,
    entries: Arc<Mutex<HashMap<String, Arc<Slot>>>>,
    connection: watch::Sender<Option<String>>,
}

impl BrowserManager {
    pub fn new(executable: Option<PathBuf>) -> Self {
        Self {
            executable,
            boot_id: ulid::Ulid::new().to_string(),
            entries: Arc::default(),
            connection: watch::channel(None).0,
        }
    }

    pub async fn configured() -> Self {
        let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").map(PathBuf::from);
        if let Some(path) = &executable {
            match Browser::launch(path).await {
                Ok(mut browser) => {
                    let ready = browser.version().await.is_ok();
                    let closed = browser.close().await.is_ok();
                    if ready && closed {
                        return Self::new(executable);
                    }
                }
                Err(_) => {}
            }
            tracing::warn!("Browser unavailable: verify BUD_BROWSER_EXECUTABLE points to a supported Chrome for Testing executable");
        }
        Self::new(None)
    }

    pub fn capability(&self) -> Value {
        json!({"version":1, "available":self.executable.is_some(), "boot_id":self.boot_id,
            "managed":true, "profile_mode":"ephemeral", "handoff":true, "viewport_resize":true, "agent_viewport_resize":true, "independent_renewal":true, "hidpi_capture":true, "history_navigation":true,
            "semantic_observations":true, "compact_observations":true, "agent_capture":true, "operation_driven_media":true, "max_sessions":2})
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
        let now = crate::util::now_millis() as u64;
        if (request.expires_at_ms <= now && !matches!(request.command, Action::Cancel))
            || request.expires_at_ms > now + 45_000
            || request.control_epoch == 0
            || request.sequence == 0
            || request.invocation_fence == 0
            || !valid_action(&request.command)
            || [
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
        let Some(executable) = &self.executable else {
            return Reply::error(&request, "browser_not_configured", false);
        };
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
                if !matches!(request.command, Action::Open { .. }) {
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
                if active >= 2 || entries.len() >= 128 {
                    return Reply::error(&request, "browser_session_limit", false);
                }
                if entries.values().any(|entry| {
                    entry.thread == request.thread_id
                        && entry
                            .state
                            .try_lock()
                            .map(|e| e.closed_at.is_none())
                            .unwrap_or(true)
                }) {
                    return Reply::error(&request, "browser_thread_already_open", false);
                }
                let entry = Arc::new(Slot {
                    owner: request.owner_user_id.clone(),
                    thread: request.thread_id.clone(),
                    generation: request.generation.clone(),
                    cancel: watch::channel(None).0,
                    refresh: watch::channel(0).0,
                    authority: Mutex::new(Authority::default()),
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
                .transition(request.control_epoch, command)
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
            if !entry
                .authority
                .lock()
                .unwrap()
                .viewer_allowed(request.control_epoch, controller_id.as_deref())
            {
                return Reply::error(&request, "browser_private_or_paused", false);
            }
            if entry.media.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Reply::error(&request, "browser_media_busy", false);
            }
            super::media::start(
                request.session_id.clone(),
                entry,
                connection,
                request.device_session_id.clone(),
                request.control_epoch,
                controller_id.clone(),
                endpoint.clone(),
                ticket.clone(),
                operation_driven == &Some(true) && controller_id.is_none(),
            );
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
            if let Err(code) = authority.transition(request.control_epoch, control.unwrap()) {
                return Reply::error(&request, code, false);
            }
        } else if let Action::HumanInput { controller_id, .. }
        | Action::ResizeViewport { controller_id, .. } = &request.command
        {
            if !entry
                .authority
                .lock()
                .unwrap()
                .human_allowed(request.control_epoch, controller_id)
            {
                return Reply::error(&request, "browser_control_expired", false);
            }
        } else if control.is_none() && !matches!(request.command, Action::Close) {
            if !entry
                .authority
                .lock()
                .unwrap()
                .agent_allowed(request.control_epoch)
            {
                return Reply::error(&request, "browser_private_or_paused", false);
            }
        }
        let slot = entry.clone();
        let mut cancellation = entry.cancel.subscribe();
        if cancellation.borrow_and_update().as_deref() == Some(&request.request_id) {
            return Reply::error(&request, "browser_canceled", false);
        }
        // Bound the FIFO wait for page operations, captures and fitting. This
        // avoids rejecting agent work merely because a viewer resize won the lock.
        let wait_started = Instant::now();
        let acquired = tokio::time::timeout(Duration::from_secs(4), entry.state.lock()).await;
        let wait_ms = wait_started.elapsed().as_millis() as u64;
        if wait_ms >= 250 || acquired.is_err() {
            tracing::info!(component = "browser_timing", event = "page_lock_wait",
                session_id = %request.session_id, request_id = %request.request_id,
                epoch = request.control_epoch, action = request.command.diagnostic_name(),
                wait_ms, timed_out = acquired.is_err(), "Browser page lock wait");
        }
        let mut entry = match acquired {
            Ok(guard) => guard,
            Err(_) => return Reply::error(&request, "browser_busy", false),
        };
        if connection.borrow().as_deref() != Some(&request.device_session_id) {
            return Reply::error(&request, "browser_stale_connection", false);
        }
        if request.expires_at_ms <= crate::util::now_millis() as u64 {
            return Reply::error(&request, "browser_deadline", false);
        }
        if passive_fit {
            // Viewer sizing is not an invocation and must never replace its fence.
            if request.control_epoch != entry.epoch
                || !slot
                    .authority
                    .lock()
                    .unwrap()
                    .viewer_allowed(request.control_epoch, None)
            {
                return Reply::error(&request, "browser_stale_request", false);
            }
            if let Action::FitViewport { target_id, .. } = &request.command {
                if entry.target.as_ref() != Some(target_id) {
                    return Reply::error(&request, "browser_target_not_found", false);
                }
            }
        } else if request.control_epoch < entry.epoch
            || request.sequence <= entry.sequence
            || (request.control_epoch == entry.epoch
                && entry.invocation.as_ref()
                    != Some(&(request.invocation_id.clone(), request.invocation_fence)))
        {
            return Reply::error(&request, "browser_stale_request", false);
        }
        if entry.closed_at.is_some() {
            return Reply::error(&request, "browser_closed", false);
        }
        if entry.connection != request.device_session_id || request.control_epoch != entry.epoch {
            if let Some(browser) = &mut entry.browser {
                browser.invalidate_references();
            }
            entry.connection = request.device_session_id.clone();
        }
        if let Some(command) = control {
            if !matches!(command, ControlCommand::Pause) {
                if let Err(code) = slot
                    .authority
                    .lock()
                    .unwrap()
                    .transition(request.control_epoch, command)
                {
                    return Reply::error(&request, code, false);
                }
            }
        } else if let Action::HumanInput { controller_id, .. }
        | Action::ResizeViewport { controller_id, .. } = &request.command
        {
            if !slot
                .authority
                .lock()
                .unwrap()
                .human_allowed(request.control_epoch, controller_id)
            {
                return Reply::error(&request, "browser_control_expired", false);
            }
        } else if !matches!(request.command, Action::Close) {
            let mut authority = slot.authority.lock().unwrap();
            if !authority.agent_allowed(request.control_epoch) {
                return Reply::error(&request, "browser_private_or_paused", false);
            }
            authority.epoch = request.control_epoch;
        }
        if matches!(request.command, Action::Close) {
            let mut authority = slot.authority.lock().unwrap();
            if request.control_epoch < authority.epoch {
                return Reply::error(&request, "browser_stale_control", false);
            }
            authority.pause();
        }
        if !passive_fit {
            entry.invocation = Some((request.invocation_id.clone(), request.invocation_fence));
            entry.epoch = request.control_epoch;
            entry.sequence = request.sequence;
        }
        // Connection change wins over a simultaneously completed read. Dropping
        // a CDP call poisons it; a later operation cannot reuse uncertain state.
        let viewport_before = entry.browser.as_ref().and_then(|b| b.viewport_revision());
        let operation_started = Instant::now();
        let result = tokio::select! {
            biased;
            _ = connection.changed() => Err(anyhow::anyhow!("browser_connection_lost")),
            _ = async { loop { if cancellation.changed().await.is_err() || cancellation.borrow_and_update().as_deref() == Some(&request.request_id) { break; } } } => Err(anyhow::anyhow!("browser_canceled")),
            result = tokio::time::timeout(Duration::from_millis(request.expires_at_ms.saturating_sub(crate::util::now_millis() as u64)),
                perform(&mut entry, executable, &request.command)) => {
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
        if control.is_none()
            && !matches!(
                request.command,
                Action::Close | Action::HumanInput { .. } | Action::ResizeViewport { .. }
            )
            && !slot
                .authority
                .lock()
                .unwrap()
                .agent_allowed(request.control_epoch)
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
            if request.expires_at_ms <= crate::util::now_millis() as u64
                || cancellation.borrow().as_deref() == Some(&request.request_id)
            {
                return Reply::error(&request, "browser_canceled", true);
            }
            let uploaded = super::capture::upload(endpoint, ticket, data).await;
            if request.expires_at_ms <= crate::util::now_millis() as u64
                || cancellation.borrow().as_deref() == Some(&request.request_id)
                || connection.borrow().as_deref() != Some(&request.device_session_id)
                || !slot
                    .authority
                    .lock()
                    .unwrap()
                    .agent_allowed(request.control_epoch)
            {
                return Reply::error(&request, "browser_private_or_paused", true);
            }
            uploaded
        } else {
            result
        };
        let refresh = match &request.command {
            Action::Open { .. }
            | Action::Observe { .. }
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
                    "browser_locator_ambiguous",
                    "browser_locator_not_found",
                    "browser_observation_limit",
                    "browser_invalid_arguments",
                    "browser_no_previous_page",
                    "browser_stale_reference",
                    "browser_stale_focus",
                    "browser_stale_viewport",
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
                if entry.browser.is_none() {
                    entry.closed_at = Some(Instant::now());
                }
                Reply::error(&request, "browser_outcome_unknown", true)
            }
        }
    }
}

async fn perform(
    entry: &mut Entry,
    executable: &std::path::Path,
    action: &Action,
) -> anyhow::Result<Value> {
    if let Action::Control { control } = action {
        let browser = entry
            .browser
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_interrupted"))?;
        // A lease acknowledgement must not imply that a permanently interrupted
        // Chrome channel can produce frames. Pause/close remain available.
        if matches!(control, ControlCommand::Acquire { .. }) && browser.interrupted() {
            anyhow::bail!("browser_interrupted");
        }
        if !matches!(control, ControlCommand::Renew { .. }) {
            browser.invalidate_references();
        }
        if matches!(control, ControlCommand::PrepareReturn { .. }) {
            let targets = browser.targets().await?;
            let target = entry
                .target
                .as_ref()
                .filter(|id| targets.iter().any(|t| &t.target_id == *id))
                .or_else(|| targets.first().map(|t| &t.target_id))
                .ok_or_else(|| anyhow::anyhow!("browser_target_not_found"))?;
            // Validate that a fresh nonprivate observation can be obtained;
            // its contents are not a control acknowledgement or audit payload.
            browser.observe(target).await?;
        }
        return Ok(json!({"control_acknowledged":true}));
    }
    if matches!(action, Action::Close) {
        if let Some(browser) = entry.browser.take() {
            browser.close().await?;
        }
        entry.closed_at = Some(Instant::now());
        return Ok(json!({"state":"closed", "profile_mode":"ephemeral"}));
    }
    if entry.browser.is_none() {
        if !matches!(action, Action::Open { .. }) {
            anyhow::bail!("browser_interrupted");
        }
        entry.browser = Some(Browser::launch(executable).await?);
    }
    let browser = entry.browser.as_mut().unwrap();
    if browser.interrupted() {
        anyhow::bail!("browser_interrupted");
    }
    let targets = browser.targets().await?;
    let requested = match action {
        Action::Navigate { target_id, .. }
        | Action::Observe { target_id }
        | Action::Inspect { target_id, .. }
        | Action::Capture { target_id, .. } => target_id.as_ref(),
        Action::ResizeViewport { target_id, .. } | Action::FitViewport { target_id, .. } => {
            Some(target_id)
        }
        _ => None,
    };
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
    entry.target = Some(target.clone());
    match action {
        Action::Open { url } => {
            if let Some(url) = url {
                browser.navigate(&target, url).await?;
            }
            Ok(
                json!({"state":"ready", "profile_mode":"ephemeral", "target_id":target,
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
            ..
        } => {
            let data = browser.inspect(&target, json!({"compact":compact,"operation":operation,"continuation":continuation,
                "scope":scope,"observation_id":observation_id,"reference":reference,"locator":locator,
                "text":text,"delta_y":delta_y})).await?;
            Ok(json!({"observation":data}))
        }
        Action::Observe { .. } => {
            Ok(json!({"targets":targets, "observation":browser.observe(&target).await?}))
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
        Action::Close | Action::Cancel | Action::Control { .. } | Action::MediaAttach { .. } => {
            unreachable!()
        }
    }
}

fn valid_action(action: &Action) -> bool {
    let id = |value: &String| !value.is_empty() && value.len() <= 128;
    let target = |value: &Option<String>| value.as_ref().is_none_or(id);
    let url = |value: &String| {
        value.len() <= 2048
            && url::Url::parse(value).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.username().is_empty()
                    && u.password().is_none()
            })
    };
    match action {
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
                        | "focus"
                        | "fill"
                        | "scroll"
                )
                && locator.as_ref().is_none_or(|l| {
                    !l.role.is_empty() && l.role.len() <= 64 && l.name.len() <= 2048
                })
                && text.as_ref().is_none_or(|t| t.len() <= 8192)
                && delta_y.is_none_or(|d| (-10000..=10000).contains(&d))
        }
        Action::Observe { target_id } => target(target_id),
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
        Action::Close | Action::Cancel | Action::Control { .. } => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn request(sequence: u64, command: Action) -> Request {
        Request {
            request_id: format!("request-{sequence}"),
            device_session_id: "device".into(),
            session_id: "browser".into(),
            generation: "generation".into(),
            thread_id: "thread".into(),
            owner_user_id: "alice".into(),
            control_epoch: 1,
            sequence,
            expires_at_ms: crate::util::now_millis() as u64 + 30_000,
            invocation_id: "invocation".into(),
            invocation_fence: 1,
            command,
        }
    }

    #[tokio::test]
    async fn live_operation_media_idles_and_refreshes_without_chrome_heartbeat_work() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(executable.into()));
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
        let observed = manager
            .execute(request(2, Action::Observe { target_id: None }))
            .await;
        assert!(observed.ok);
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
        let manager = BrowserManager::new(Some(executable.into()));
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
        let mut observe = request(2, Action::Observe { target_id: None });
        observe.device_session_id = "reconnected".into();
        assert!(manager.execute(observe.clone()).await.ok);
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
        let manager = BrowserManager::new(Some(executable.into()));
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
        let blocked = manager
            .execute(request(4, Action::Observe { target_id: None }))
            .await;
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
        let mut observe = request(10, Action::Observe { target_id: None });
        observe.control_epoch = 5;
        assert!(manager.execute(observe).await.ok);
        let mut close = request(11, Action::Close);
        close.control_epoch = 5;
        assert!(manager.execute(close).await.ok);
    }

    #[tokio::test]
    async fn live_passive_fit_preserves_invocation_and_rejects_private_authority() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(executable.into()));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .ok
        );
        let observed = manager
            .execute(request(2, Action::Observe { target_id: None }))
            .await;
        let observation = &observed.data["observation"];
        let reference = observation["elements"][0]["reference"]
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
        let fresh = manager
            .execute(request(4, Action::Observe { target_id: None }))
            .await;
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
        assert!(manager.execute(pause).await.ok);
        fit.control_epoch = 2;
        assert_eq!(
            manager.execute(fit).await.error,
            Some("browser_private_or_paused")
        );
        let mut close = request(6, Action::Close);
        close.control_epoch = 2;
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
        let manager = BrowserManager::new(Some(executable.into()));
        manager.connect("device".into());
        assert!(
            manager
                .execute(request(1, Action::Open { url: None }))
                .await
                .ok
        );
        let first = manager
            .execute(request(2, Action::Observe { target_id: None }))
            .await;
        assert!(first.ok);
        let reference = first.data["observation"]["elements"][0]["reference"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            manager
                .execute(request(3, Action::Observe { target_id: None }))
                .await
                .ok
        );
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
            manager
                .execute(request(6, Action::Observe { target_id: None }))
                .await
                .error,
            Some("browser_interrupted")
        );
        let mut pause = request(
            7,
            Action::Control {
                control: ControlCommand::Pause,
            },
        );
        pause.control_epoch = 2;
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
        assert_eq!(
            manager.execute(acquire).await.error,
            Some("browser_interrupted")
        );
        let mut close = request(9, Action::Close);
        close.control_epoch = 3;
        assert!(manager.execute(close).await.ok);
        let mut reopen = request(1, Action::Open { url: None });
        reopen.session_id = "replacement".into();
        reopen.generation = "replacement-generation".into();
        assert!(manager.execute(reopen.clone()).await.ok);
        reopen.sequence = 2;
        reopen.command = Action::Close;
        assert!(manager.execute(reopen).await.ok);
    }

    #[tokio::test]
    async fn live_session_isolation_reconnect_and_duplicate_admission() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        let manager = BrowserManager::new(Some(executable.into()));
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
        let mut foreign = request(2, Action::Observe { target_id: None });
        foreign.owner_user_id = "bob".into();
        assert_eq!(
            manager.execute(foreign).await.error,
            Some("browser_scope_mismatch")
        );
        let mut second = request(1, Action::Open { url: None });
        second.session_id = "second".into();
        second.thread_id = "second-thread".into();
        let other = manager.execute(second.clone()).await;
        assert!(other.ok, "{other:?}");
        assert_ne!(first.data["target_id"], other.data["target_id"]);
        let mut third = second.clone();
        third.session_id = "third".into();
        third.thread_id = "third".into();
        assert_eq!(
            manager.execute(third).await.error,
            Some("browser_session_limit")
        );
        manager.disconnect();
        manager.connect("reconnected".into());
        assert_eq!(
            manager
                .execute(request(2, Action::Observe { target_id: None }))
                .await
                .error,
            Some("browser_stale_connection")
        );
        let mut observe = request(2, Action::Observe { target_id: None });
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
    }
}
