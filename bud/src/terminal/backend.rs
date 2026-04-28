use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use anyhow::Result;

use crate::transport::OutboundSender;

pub type BackendResultFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

pub trait TerminalBackend: Clone + Send + Sync + 'static {
    fn session_name(&self, session_id: &str) -> String;
    fn log_path(&self, session_id: &str) -> PathBuf;

    fn session_exists<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, bool>;
    fn create_session<'a>(
        &'a self,
        session_name: &'a str,
        cols: u16,
        rows: u16,
        cwd: &'a str,
        shell: &'a str,
        session_env: &'a [(String, String)],
    ) -> BackendResultFuture<'a, ()>;
    fn set_history_limit<'a>(
        &'a self,
        session_name: &'a str,
        limit: u32,
    ) -> BackendResultFuture<'a, ()>;
    fn reset_pipe<'a>(
        &'a self,
        session_name: &'a str,
        log_path: &'a Path,
    ) -> BackendResultFuture<'a, bool>;
    fn pane_pid<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, i32>;
    fn pane_cwd<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, String>;
    fn resize_window<'a>(
        &'a self,
        session_name: &'a str,
        cols: u16,
        rows: u16,
    ) -> BackendResultFuture<'a, ()>;
    fn kill_session<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, ()>;
    fn send_literal_text<'a>(
        &'a self,
        session_name: &'a str,
        text: &'a str,
    ) -> BackendResultFuture<'a, ()>;
    fn send_key<'a>(&'a self, session_name: &'a str, key: &'a str) -> BackendResultFuture<'a, ()>;
    fn capture_pane_with_lines<'a>(
        &'a self,
        session_name: &'a str,
        start_line: Option<i32>,
    ) -> BackendResultFuture<'a, String>;

    fn spawn_output_watcher(
        &self,
        session_id: String,
        session_name: String,
        log_path: PathBuf,
        sender: OutboundSender,
        seq: Arc<AtomicU64>,
        offset: Arc<AtomicU64>,
        last_output_at: Arc<AtomicU64>,
        last_output_seq: Arc<AtomicU64>,
    ) -> tokio::task::JoinHandle<()>;
}
