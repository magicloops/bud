use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::protocol::Envelope;
use crate::transport::{OutboundSender, TransportSender};
use crate::util::now_millis;

use super::backend::{BackendResultFuture, TerminalBackend};
use super::{TerminalConfig, TerminalHandle, TerminalManager};

#[derive(Clone, Default)]
pub(super) struct FakeBackend {
    inner: Arc<Mutex<FakeBackendState>>,
}

#[derive(Default)]
struct FakeBackendState {
    captures: HashMap<(String, Option<i32>), VecDeque<String>>,
    operations: Vec<String>,
}

impl FakeBackend {
    pub(super) fn push_capture(&self, session_name: &str, start_line: Option<i32>, capture: &str) {
        let mut inner = self.inner.lock().expect("fake backend lock");
        inner
            .captures
            .entry((session_name.to_string(), start_line))
            .or_default()
            .push_back(capture.to_string());
    }

    pub(super) fn operations(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("fake backend lock")
            .operations
            .clone()
    }

    fn record(&self, op: String) {
        self.inner
            .lock()
            .expect("fake backend lock")
            .operations
            .push(op);
    }

    fn next_capture(&self, session_name: &str, start_line: Option<i32>) -> Result<String> {
        let mut inner = self.inner.lock().expect("fake backend lock");
        inner
            .captures
            .get_mut(&(session_name.to_string(), start_line))
            .and_then(VecDeque::pop_front)
            .ok_or_else(|| anyhow!("no fake capture queued for {session_name:?} {start_line:?}"))
    }
}

impl TerminalBackend for FakeBackend {
    fn session_name(&self, session_id: &str) -> String {
        session_id.to_string()
    }

    fn log_path(&self, session_id: &str) -> PathBuf {
        PathBuf::from(format!("/tmp/{session_id}.log"))
    }

    fn session_exists<'a>(&'a self, _session_name: &'a str) -> BackendResultFuture<'a, bool> {
        Box::pin(async move { Ok(true) })
    }

    fn create_session<'a>(
        &'a self,
        _session_name: &'a str,
        _cols: u16,
        _rows: u16,
        _cwd: &'a str,
        _shell: &'a str,
        _session_env: &'a [(String, String)],
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn set_history_limit<'a>(
        &'a self,
        _session_name: &'a str,
        _limit: u32,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn reset_pipe<'a>(
        &'a self,
        _session_name: &'a str,
        _log_path: &'a Path,
    ) -> BackendResultFuture<'a, bool> {
        Box::pin(async move { Ok(true) })
    }

    fn pane_pid<'a>(&'a self, _session_name: &'a str) -> BackendResultFuture<'a, i32> {
        Box::pin(async move { Ok(42) })
    }

    fn pane_cwd<'a>(&'a self, _session_name: &'a str) -> BackendResultFuture<'a, String> {
        Box::pin(async move { Ok("/tmp".to_string()) })
    }

    fn resize_window<'a>(
        &'a self,
        _session_name: &'a str,
        _cols: u16,
        _rows: u16,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn kill_session<'a>(&'a self, _session_name: &'a str) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { Ok(()) })
    }

    fn send_literal_text<'a>(
        &'a self,
        session_name: &'a str,
        text: &'a str,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move {
            self.record(format!("text:{session_name}:{text}"));
            Ok(())
        })
    }

    fn send_key<'a>(&'a self, session_name: &'a str, key: &'a str) -> BackendResultFuture<'a, ()> {
        Box::pin(async move {
            self.record(format!("key:{session_name}:{key}"));
            Ok(())
        })
    }

    fn capture_pane_with_lines<'a>(
        &'a self,
        session_name: &'a str,
        start_line: Option<i32>,
    ) -> BackendResultFuture<'a, String> {
        Box::pin(async move { self.next_capture(session_name, start_line) })
    }

    fn spawn_output_watcher(
        &self,
        _session_id: String,
        _session_name: String,
        _log_path: PathBuf,
        _sender: OutboundSender,
        _seq: Arc<AtomicU64>,
        _offset: Arc<AtomicU64>,
        _last_output_at: Arc<AtomicU64>,
        _last_output_seq: Arc<AtomicU64>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async {})
    }
}

pub(super) async fn test_manager_with_sender() -> (
    TerminalManager<FakeBackend>,
    FakeBackend,
    mpsc::UnboundedReceiver<Message>,
) {
    let backend = FakeBackend::default();
    let manager = TerminalManager::with_backend(test_config(), backend.clone());
    let (tx, rx) = mpsc::unbounded_channel();
    manager
        .set_sender(TransportSender::websocket(tx, false))
        .await;
    (manager, backend, rx)
}

pub(super) async fn install_test_session(
    manager: &TerminalManager<FakeBackend>,
    backend: &FakeBackend,
    session_id: &str,
    session_name: &str,
) {
    let watcher = tokio::spawn(async {});
    let handle = Arc::new(TerminalHandle {
        session_id: session_id.to_string(),
        session_name: session_name.to_string(),
        log_path: backend.log_path(session_id),
        pid: Some(42),
        cwd: Some("/tmp".to_string()),
        watcher,
        seq: Arc::new(AtomicU64::new(0)),
        offset: Arc::new(AtomicU64::new(0)),
        last_output_at: Arc::new(AtomicU64::new(now_millis())),
        last_output_seq: Arc::new(AtomicU64::new(0)),
        cols: 200,
        rows: 50,
    });
    let mut inner = manager.inner.lock().await;
    inner.sessions.insert(session_id.to_string(), handle);
}

pub(super) async fn store_delivered_capture(
    manager: &TerminalManager<FakeBackend>,
    session_id: &str,
    capture: &str,
    start_line: Option<i32>,
) {
    manager
        .store_delivered_capture(session_id, capture, start_line)
        .await;
}

pub(super) async fn recv_json(rx: &mut mpsc::UnboundedReceiver<Message>) -> Value {
    let message = rx.recv().await.expect("ws message");
    match message {
        Message::Text(text) => serde_json::from_str(&text).expect("json frame"),
        other => panic!("expected text websocket frame, got {other:?}"),
    }
}

pub(super) fn decode_base64_field(payload: &Value, field: &str) -> Option<String> {
    let encoded = payload.get(field).and_then(Value::as_str)?;
    if encoded.is_empty() {
        return Some(String::new());
    }
    let bytes = BASE64_STANDARD.decode(encoded.as_bytes()).ok()?;
    String::from_utf8(bytes).ok()
}

pub(super) fn envelope(kind: &str) -> Envelope {
    Envelope {
        kind: kind.to_string(),
        proto: "0.2".to_string(),
        id: "msg_1".to_string(),
        ts: 0,
        ext: Value::Null,
    }
}

fn test_config() -> TerminalConfig {
    TerminalConfig {
        enabled: true,
        base_log_dir: PathBuf::from("/tmp"),
        default_cwd: "/tmp".to_string(),
        cols: 200,
        rows: 50,
        shell: "/bin/sh".to_string(),
        tmux_available: true,
        debug_enabled: false,
    }
}
