pub mod backend;
mod delta;
mod interaction;
mod observe;
mod readiness;
mod registry;
#[cfg(test)]
mod test_support;
pub mod tmux;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use tokio::sync::Mutex;

pub use backend::TerminalBackend;

use crate::transport::OutboundSender;

use self::tmux::{probe_tmux as tmux_probe, TmuxBackend};

const DEFAULT_TERMINAL_COLORTERM: &str = "truecolor";
const DEFAULT_TERMINAL_COLORFGBG: &str = "15;0";

const ACTIVITY_DEFAULT_INITIAL_DELAY_MS: u64 = 2000;
const ACTIVITY_DEFAULT_INTERVAL_MS: u64 = 5000;
const ACTIVITY_DEFAULT_STABLE_COUNT: u32 = 2;
const ACTIVITY_DEFAULT_MAX_WAIT_MS: u64 = 60_000;
const OUTPUT_QUIESCENCE_POLL_INTERVAL_MS: u64 = 50;
const OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES: u32 = 3;
const OUTPUT_QUIESCENCE_QUIET_MS: u64 = 150;
const TERMINAL_SEND_POST_DISPATCH_GUARD_MS: u64 = 30;
const SCREEN_WAIT_POLL_INTERVAL_MS: u64 = 100;
const SCREEN_WAIT_SETTLED_QUIET_MS: u64 = 300;
const DEFAULT_DELTA_CAPTURE_START_LINE: i32 = -50;
const LOW_SIGNAL_SEPARATOR_MIN_RUN: usize = 4;
const MAX_VISIBLE_DELTA_LINES: usize = 20;
const MAX_CHANGED_WINDOW_LINES: usize = 20;
const MAX_VISIBLE_DELTA_BYTES: usize = 4096;
const TMUX_TEXT_TO_ENTER_DELAY_MS: u64 = 10;

#[derive(Clone)]
pub struct TerminalConfig {
    pub enabled: bool,
    pub base_log_dir: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
    pub tmux_available: bool,
    pub debug_enabled: bool,
}

#[derive(Clone)]
pub struct TerminalManager<B = TmuxBackend>
where
    B: TerminalBackend,
{
    inner: Arc<Mutex<TerminalState>>,
    pub config: TerminalConfig,
    backend: B,
}

struct TerminalState {
    sender: Option<OutboundSender>,
    sessions: HashMap<String, Arc<TerminalHandle>>,
    delivered_captures: HashMap<String, DeliveredCaptureState>,
}

#[derive(Clone, Debug)]
struct DeliveredCaptureState {
    capture: String,
    start_line: Option<i32>,
}

struct TerminalHandle {
    session_id: String,
    session_name: String,
    log_path: PathBuf,
    pid: Option<i32>,
    cwd: Option<String>,
    watcher: tokio::task::JoinHandle<()>,
    #[allow(dead_code)]
    seq: Arc<AtomicU64>,
    #[allow(dead_code)]
    offset: Arc<AtomicU64>,
    last_output_at: Arc<AtomicU64>,
    last_output_seq: Arc<AtomicU64>,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Debug)]
struct CaptureLogSummary {
    hash: u64,
    line_count: usize,
    last_non_empty_line: String,
    preview_head: Option<String>,
    preview_tail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScreenWaitMode {
    None,
    Changed,
    Settled,
}

#[derive(Debug)]
struct ScreenCaptureState {
    capture: String,
    summary: CaptureLogSummary,
    captured_after_ms: u64,
}

#[derive(Debug)]
struct ScreenWaitResult {
    capture: String,
    summary: CaptureLogSummary,
    assessment: serde_json::Value,
    captured_after_ms: u64,
}

#[derive(Debug)]
struct OutputQuiescenceWaitResult {
    trigger: &'static str,
    quiet_for_ms: u64,
    elapsed_ms: u64,
    check_count: u32,
    stable_checks: u32,
    output_seen: bool,
    latest_offset: u64,
    last_output_seq: u64,
}

#[derive(Debug, Clone)]
struct AdditiveDeltaPayload {
    changed: bool,
    text: String,
    truncated: bool,
    strategy: &'static str,
}

#[derive(Debug, Clone)]
struct TerminalStatusSnapshot {
    cols: u16,
    rows: u16,
    output_log_bytes: u64,
    pid: Option<i32>,
    cwd: Option<String>,
}

impl TerminalManager<TmuxBackend> {
    pub fn new(config: TerminalConfig) -> Self {
        let backend = TmuxBackend::new(config.clone());
        Self::with_backend(config, backend)
    }
}

impl<B> TerminalManager<B>
where
    B: TerminalBackend,
{
    fn with_backend(config: TerminalConfig, backend: B) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalState {
                sender: None,
                sessions: HashMap::new(),
                delivered_captures: HashMap::new(),
            })),
            config,
            backend,
        }
    }

    pub async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    pub async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        for (_, handle) in inner.sessions.drain() {
            handle.watcher.abort();
        }
        inner.delivered_captures.clear();
        inner.sender = None;
    }

    pub async fn fresh_pane_cwd_for_session(&self, session_id: &str) -> Option<String> {
        let session_name = self.backend.session_name(session_id);
        self.backend.pane_cwd(&session_name).await.ok()
    }
}

pub fn probe_tmux() -> bool {
    tmux_probe()
}
