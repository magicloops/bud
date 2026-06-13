use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::json;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio::time;
use tracing::{info, warn};

use crate::protocol::TERMINAL_PROTO_VERSION;
use crate::transport::{send_transport_frame, OutboundSender};
use crate::util::{new_message_id, now_millis};

use super::backend::{BackendResultFuture, TerminalBackend};
use super::TerminalConfig;

const TERMINAL_OUTPUT_CHUNK_MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone)]
pub struct TmuxBackend {
    config: TerminalConfig,
}

impl TmuxBackend {
    pub(crate) fn new(config: TerminalConfig) -> Self {
        Self { config }
    }

    pub(crate) fn session_name(&self, session_id: &str) -> String {
        let suffix = session_id.strip_prefix("sess_").unwrap_or(session_id);
        let name = format!("s_{}", suffix);
        if name.len() > 32 {
            name[..32].to_string()
        } else {
            name
        }
    }

    pub(crate) fn log_path(&self, session_id: &str) -> PathBuf {
        self.config
            .base_log_dir
            .join("sessions")
            .join(session_id)
            .join("terminal.log")
    }

    pub(crate) async fn session_exists(&self, session_name: &str) -> bool {
        Command::new("tmux")
            .args(["has-session", "-t", session_name])
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false)
    }

    pub(crate) async fn create_session(
        &self,
        session_name: &str,
        cols: u16,
        rows: u16,
        cwd: &str,
        shell: &str,
        session_env: &[(String, String)],
    ) -> Result<()> {
        let mut command = Command::new("tmux");
        command
            .arg("new-session")
            .arg("-d")
            .arg("-s")
            .arg(session_name)
            .arg("-x")
            .arg(cols.to_string())
            .arg("-y")
            .arg(rows.to_string())
            .arg("-c")
            .arg(cwd);
        for (key, value) in session_env {
            command.arg("-e").arg(format!("{key}={value}"));
        }
        let status = command
            .arg(shell)
            .status()
            .await
            .with_context(|| "failed to create tmux session")?;

        if !status.success() {
            bail!("tmux new-session failed");
        }

        Ok(())
    }

    pub(crate) async fn set_history_limit(&self, session_name: &str, limit: u32) -> Result<()> {
        let status = Command::new("tmux")
            .args([
                "set-option",
                "-t",
                session_name,
                "history-limit",
                &limit.to_string(),
            ])
            .status()
            .await
            .with_context(|| "failed to set tmux history-limit")?;

        if !status.success() {
            bail!("tmux set-option history-limit failed");
        }

        Ok(())
    }

    pub(crate) async fn reset_pipe(&self, session_name: &str, log_path: &Path) -> Result<bool> {
        let _ = Command::new("tmux")
            .args(["pipe-pane", "-t", session_name])
            .status()
            .await;

        let pipe_cmd = build_pipe_command(log_path);
        let status = Command::new("tmux")
            .args(["pipe-pane", "-t", session_name, &pipe_cmd])
            .status()
            .await
            .with_context(|| "failed to configure tmux pipe-pane")?;

        Ok(status.success())
    }

    pub(crate) async fn pane_pid(&self, session_name: &str) -> Result<i32> {
        let output = Command::new("tmux")
            .args(["display-message", "-t", session_name, "-p", "#{pane_pid}"])
            .output()
            .await
            .with_context(|| "failed to get tmux pane pid")?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        text.parse::<i32>()
            .map_err(|err| anyhow::anyhow!("failed to parse pane pid: {}", err))
    }

    pub(crate) async fn pane_cwd(&self, session_name: &str) -> Result<String> {
        let output = Command::new("tmux")
            .args([
                "display-message",
                "-t",
                session_name,
                "-p",
                "#{pane_current_path}",
            ])
            .output()
            .await
            .with_context(|| "failed to get tmux pane cwd")?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub(crate) async fn resize_window(
        &self,
        session_name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let status = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                session_name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .status()
            .await
            .with_context(|| "failed to resize tmux window")?;

        if !status.success() {
            bail!("tmux resize-window failed");
        }

        Ok(())
    }

    pub(crate) async fn kill_session(&self, session_name: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["kill-session", "-t", session_name])
            .status()
            .await
            .with_context(|| "failed to kill tmux session")?;

        if !status.success() {
            bail!("tmux kill-session failed");
        }

        Ok(())
    }

    pub(crate) async fn send_literal_text(&self, session_name: &str, text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }

        let status = Command::new("tmux")
            .args(literal_send_keys_args(session_name, text))
            .status()
            .await
            .with_context(|| "failed to dispatch tmux send-keys (literal text)")?;

        if !status.success() {
            bail!("tmux send-keys literal text failed");
        }

        Ok(())
    }

    pub(crate) async fn send_key(&self, session_name: &str, key: &str) -> Result<()> {
        let status = Command::new("tmux")
            .args(["send-keys", "-t", session_name, key])
            .status()
            .await
            .with_context(|| format!("failed to dispatch tmux send-keys ({key})"))?;

        if !status.success() {
            bail!("tmux send-keys {key} failed");
        }

        Ok(())
    }

    pub(crate) async fn capture_pane_with_lines(
        &self,
        session_name: &str,
        start_line: Option<i32>,
    ) -> Result<String> {
        let mut args = vec!["capture-pane", "-p", "-J", "-t", session_name];
        let start_line_owned;
        if let Some(start) = start_line {
            start_line_owned = start.to_string();
            args.extend(["-S", &start_line_owned]);
        }

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .with_context(|| "failed to execute tmux capture-pane")?;

        if !output.status.success() {
            bail!(
                "tmux capture-pane failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    pub(crate) fn spawn_output_watcher(
        &self,
        session_id: String,
        session_name: String,
        log_path: PathBuf,
        sender: OutboundSender,
        seq: Arc<AtomicU64>,
        offset: Arc<AtomicU64>,
        last_output_at: Arc<AtomicU64>,
        last_output_seq: Arc<AtomicU64>,
    ) -> tokio::task::JoinHandle<()> {
        info!(session_id = %session_id, session = %session_name, log_path = %log_path.display(), "spawning terminal output watcher");
        tokio::spawn(async move {
            info!(session_id = %session_id, session = %session_name, "output watcher task started");
            'watch: loop {
                let size = match fs::metadata(&log_path).await {
                    Ok(meta) => meta.len(),
                    Err(err) => {
                        warn!(session_id = %session_id, session = %session_name, error = %err, "failed to stat log file");
                        time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let current_offset = offset.load(Ordering::SeqCst);
                if size > current_offset {
                    info!(session_id = %session_id, session = %session_name, size = size, current_offset = current_offset, "new output detected");
                    match fs::File::open(&log_path).await {
                        Ok(mut file) => {
                            for (chunk_offset, chunk_len) in output_chunk_plan(current_offset, size)
                            {
                                if file.seek(SeekFrom::Start(chunk_offset)).await.is_err() {
                                    warn!(session_id = %session_id, session = %session_name, offset = chunk_offset, "failed to seek log file");
                                    break;
                                }
                                let mut buf = vec![0u8; chunk_len];
                                if file.read_exact(&mut buf).await.is_ok() {
                                    let seq_no = seq.fetch_add(1, Ordering::SeqCst);
                                    let next_offset = chunk_offset + chunk_len as u64;
                                    offset.store(next_offset, Ordering::SeqCst);
                                    last_output_at.store(now_millis(), Ordering::SeqCst);
                                    last_output_seq.store(seq_no, Ordering::SeqCst);
                                    let payload = json!({
                                        "proto": TERMINAL_PROTO_VERSION,
                                        "type": "terminal_output",
                                        "id": new_message_id(),
                                        "ts": now_millis(),
                                        "ext": {},
                                        "session_id": &session_id,
                                        "seq": seq_no,
                                        "data": BASE64_STANDARD.encode(&buf),
                                        "byte_offset": chunk_offset,
                                    });
                                    info!(session_id = %session_id, session = %session_name, seq = seq_no, bytes = buf.len(), "sending terminal_output");
                                    if let Err(err) = send_transport_frame(&sender, payload) {
                                        warn!(session_id = %session_id, session = %session_name, error = %err, "failed to send terminal_output");
                                        break 'watch;
                                    }
                                } else {
                                    warn!(session_id = %session_id, session = %session_name, "failed to read log file");
                                    break;
                                }
                            }
                        }
                        Err(err) => {
                            warn!(session_id = %session_id, session = %session_name, error = %err, "failed to open log file");
                        }
                    }
                }
                time::sleep(Duration::from_millis(50)).await;
            }
            info!(session_id = %session_id, session = %session_name, "output watcher task exiting");
        })
    }
}

impl TerminalBackend for TmuxBackend {
    fn session_name(&self, session_id: &str) -> String {
        TmuxBackend::session_name(self, session_id)
    }

    fn log_path(&self, session_id: &str) -> PathBuf {
        TmuxBackend::log_path(self, session_id)
    }

    fn session_exists<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, bool> {
        Box::pin(async move { Ok(TmuxBackend::session_exists(self, session_name).await) })
    }

    fn create_session<'a>(
        &'a self,
        session_name: &'a str,
        cols: u16,
        rows: u16,
        cwd: &'a str,
        shell: &'a str,
        session_env: &'a [(String, String)],
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move {
            TmuxBackend::create_session(self, session_name, cols, rows, cwd, shell, session_env)
                .await
        })
    }

    fn set_history_limit<'a>(
        &'a self,
        session_name: &'a str,
        limit: u32,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { TmuxBackend::set_history_limit(self, session_name, limit).await })
    }

    fn reset_pipe<'a>(
        &'a self,
        session_name: &'a str,
        log_path: &'a Path,
    ) -> BackendResultFuture<'a, bool> {
        Box::pin(async move { TmuxBackend::reset_pipe(self, session_name, log_path).await })
    }

    fn pane_pid<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, i32> {
        Box::pin(async move { TmuxBackend::pane_pid(self, session_name).await })
    }

    fn pane_cwd<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, String> {
        Box::pin(async move { TmuxBackend::pane_cwd(self, session_name).await })
    }

    fn resize_window<'a>(
        &'a self,
        session_name: &'a str,
        cols: u16,
        rows: u16,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { TmuxBackend::resize_window(self, session_name, cols, rows).await })
    }

    fn kill_session<'a>(&'a self, session_name: &'a str) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { TmuxBackend::kill_session(self, session_name).await })
    }

    fn send_literal_text<'a>(
        &'a self,
        session_name: &'a str,
        text: &'a str,
    ) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { TmuxBackend::send_literal_text(self, session_name, text).await })
    }

    fn send_key<'a>(&'a self, session_name: &'a str, key: &'a str) -> BackendResultFuture<'a, ()> {
        Box::pin(async move { TmuxBackend::send_key(self, session_name, key).await })
    }

    fn capture_pane_with_lines<'a>(
        &'a self,
        session_name: &'a str,
        start_line: Option<i32>,
    ) -> BackendResultFuture<'a, String> {
        Box::pin(async move {
            TmuxBackend::capture_pane_with_lines(self, session_name, start_line).await
        })
    }

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
    ) -> tokio::task::JoinHandle<()> {
        TmuxBackend::spawn_output_watcher(
            self,
            session_id,
            session_name,
            log_path,
            sender,
            seq,
            offset,
            last_output_at,
            last_output_seq,
        )
    }
}

pub(crate) fn probe_tmux() -> bool {
    use std::process::Command as StdCommand;

    let output = StdCommand::new("tmux").arg("-V").output();
    match output {
        Ok(out) if out.status.success() => true,
        _ => false,
    }
}

fn build_pipe_command(log_path: &Path) -> String {
    format!("cat >> {}", shell_quote_path(log_path))
}

fn literal_send_keys_args<'a>(session_name: &'a str, text: &'a str) -> [&'a str; 6] {
    ["send-keys", "-t", session_name, "-l", "--", text]
}

fn output_chunk_plan(start_offset: u64, end_offset: u64) -> Vec<(u64, usize)> {
    let mut chunks = Vec::new();
    let mut next_offset = start_offset;
    while next_offset < end_offset {
        let chunk_len = (end_offset - next_offset).min(TERMINAL_OUTPUT_CHUNK_MAX_BYTES);
        chunks.push((next_offset, chunk_len as usize));
        next_offset += chunk_len;
    }
    chunks
}

fn shell_quote_path(path: &Path) -> String {
    let rendered = path.to_string_lossy();
    let escaped = rendered.replace('\'', "'\"'\"'");
    format!("'{}'", escaped)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        build_pipe_command, literal_send_keys_args, output_chunk_plan,
        TERMINAL_OUTPUT_CHUNK_MAX_BYTES,
    };

    #[test]
    fn build_pipe_command_quotes_paths_with_spaces() {
        let command = build_pipe_command(Path::new("/tmp/bud state/terminal.log"));
        assert_eq!(command, "cat >> '/tmp/bud state/terminal.log'");
    }

    #[test]
    fn build_pipe_command_escapes_single_quotes() {
        let command = build_pipe_command(Path::new("/tmp/bud's/terminal.log"));
        assert_eq!(command, "cat >> '/tmp/bud'\"'\"'s/terminal.log'");
    }

    #[test]
    fn literal_send_keys_args_terminates_options_before_text() {
        assert_eq!(
            literal_send_keys_args(
                "s_1",
                "- `npm run dev` starts the local development server."
            ),
            [
                "send-keys",
                "-t",
                "s_1",
                "-l",
                "--",
                "- `npm run dev` starts the local development server."
            ]
        );
    }

    #[test]
    fn literal_send_keys_args_preserves_option_shaped_text() {
        for text in ["hello", "- markdown bullet", "--flag-like", "-t"] {
            let args = literal_send_keys_args("s_1", text);
            assert_eq!(args[4], "--");
            assert_eq!(args[5], text);
        }
    }

    #[test]
    fn output_chunk_plan_caps_terminal_output_chunks() {
        let max = TERMINAL_OUTPUT_CHUNK_MAX_BYTES;
        assert_eq!(
            output_chunk_plan(5, 5 + max * 2 + 7),
            vec![(5, max as usize), (5 + max, max as usize), (5 + max * 2, 7)]
        );
    }
}
