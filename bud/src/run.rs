use std::collections::{HashMap, VecDeque};
use std::io;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use nix::unistd::{self, Pid};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::task;
use tracing::{info, warn};

use crate::protocol::PROTO_VERSION;
use crate::util::{
    default_shell, expand_path, new_message_id, now_millis, send_ws_frame, OutboundSender,
};

const MAX_QUEUE_DEPTH: usize = 10;

#[derive(Clone)]
pub struct RunCommand {
    pub run_id: String,
    pub cmd: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    #[allow(dead_code)]
    pub timeout_ms: u64,
}

#[derive(Clone)]
pub struct RunExecutor {
    inner: Arc<Mutex<ExecutorState>>,
}

struct ExecutorState {
    queue: VecDeque<RunCommand>,
    current_run: Option<String>,
    sender: Option<OutboundSender>,
    #[allow(dead_code)]
    active: HashMap<String, RunHandle>,
    current_dir: PathBuf,
}

struct RunHandle {
    #[allow(dead_code)]
    cancel_tx: mpsc::UnboundedSender<CancelCommand>,
}

enum CancelCommand {
    #[allow(dead_code)]
    Terminate,
}

impl RunExecutor {
    /// Legacy queued run path retained as reference functionality for future
    /// non-terminal device capabilities. This is intentionally isolated from
    /// the primary interactive terminal runtime.
    pub fn new(initial_cwd: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ExecutorState {
                queue: VecDeque::new(),
                current_run: None,
                sender: None,
                active: HashMap::new(),
                current_dir: initial_cwd,
            })),
        }
    }

    pub async fn set_sender(&self, sender: OutboundSender) {
        let mut inner = self.inner.lock().await;
        inner.sender = Some(sender);
    }

    pub async fn clear_sender(&self) {
        let mut inner = self.inner.lock().await;
        inner.sender = None;
    }

    pub async fn prepare_command(
        &self,
        run_id: String,
        cmd: String,
        requested_cwd: Option<String>,
        env: HashMap<String, String>,
        timeout_ms: u64,
    ) -> Result<RunCommand> {
        let mut inner = self.inner.lock().await;
        let resolved_cwd = if let Some(override_cwd) = requested_cwd {
            match expand_path(&override_cwd) {
                Some(path) => {
                    inner.current_dir = path.clone();
                    path
                }
                None => inner.current_dir.clone(),
            }
        } else {
            inner.current_dir.clone()
        };
        drop(inner);
        Ok(RunCommand {
            run_id,
            cmd,
            cwd: resolved_cwd,
            env,
            timeout_ms,
        })
    }

    pub async fn enqueue(&self, command: RunCommand) -> Result<()> {
        info!(
            run_id = %command.run_id,
            cmd = %command.cmd,
            cwd = %command.cwd.display(),
            "Queued run command"
        );
        let mut inner = self.inner.lock().await;
        if inner.queue.len() >= MAX_QUEUE_DEPTH {
            bail!("run queue is full");
        }
        inner.queue.push_back(command);
        if inner.current_run.is_none() {
            if let Some(next) = inner.queue.pop_front() {
                inner.current_run = Some(next.run_id.clone());
                let sender = inner.sender.clone();
                drop(inner);
                self.spawn_run(next, sender).await;
            }
        }
        Ok(())
    }

    async fn spawn_run(&self, cmd: RunCommand, sender: Option<OutboundSender>) {
        let executor = self.clone();
        task::spawn_local(async move {
            if let Err(err) = executor.execute_run(cmd.clone(), sender.clone()).await {
                warn!(error = %err, "run execution failed");
                if let Some(sender) = sender.clone() {
                    let _ = send_ws_frame(
                        &sender,
                        json!({
                            "proto": PROTO_VERSION,
                            "type": "run_finished",
                            "id": new_message_id(),
                            "ts": now_millis(),
                            "ext": {},
                            "run_id": cmd.run_id,
                            "exit_code": null,
                            "signal": null,
                            "canceled": false,
                            "cwd": cmd.cwd.to_string_lossy(),
                            "error": err.to_string()
                        }),
                    );
                }
            }
            executor.finish_and_start_next(cmd.run_id).await;
        });
    }

    async fn finish_and_start_next(&self, run_id: String) {
        let mut inner = self.inner.lock().await;
        if inner.current_run.as_deref() == Some(&run_id) {
            inner.current_run = None;
        }
        if inner.current_run.is_none() {
            if let Some(next) = inner.queue.pop_front() {
                inner.current_run = Some(next.run_id.clone());
                let sender = inner.sender.clone();
                drop(inner);
                self.spawn_run(next, sender).await;
            }
        }
    }

    async fn execute_run(&self, run: RunCommand, sender: Option<OutboundSender>) -> Result<()> {
        let sender = sender.ok_or_else(|| anyhow!("no websocket writer available"))?;
        info!(
            run_id = %run.run_id,
            cmd = %run.cmd,
            cwd = %run.cwd.display(),
            "Starting shell command"
        );
        if !run.cwd.exists() {
            warn!(
                run_id = %run.run_id,
                cwd = %run.cwd.display(),
                "Run cwd does not exist; command may fail"
            );
        }
        let shell = default_shell();
        let mut command = Command::new(shell);
        command.arg("-lc").arg(&run.cmd);
        command.envs(run.env.clone());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::null());
        command.current_dir(&run.cwd);
        unsafe {
            command.pre_exec(|| {
                unistd::setpgid(Pid::from_raw(0), Pid::from_raw(0))
                    .map_err(|err| io::Error::new(io::ErrorKind::Other, err))
            });
        }

        let cwd_clone = run.cwd.clone();
        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn shell in {}", cwd_clone.display()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("missing stderr pipe"))?;

        let seq = Arc::new(AtomicU64::new(0));
        let sender_stdout = sender.clone();
        let sender_stderr = sender.clone();
        let run_id_stdout = run.run_id.clone();
        let run_id_stderr = run.run_id.clone();
        let seq_stdout = seq.clone();

        let stdout_task = task::spawn_local(async move {
            if let Err(err) =
                stream_pipe(stdout, run_id_stdout, "stdout", sender_stdout, seq_stdout).await
            {
                warn!(error = %err, "stdout stream error");
            }
        });

        let stderr_task = task::spawn_local(async move {
            if let Err(err) = stream_pipe(stderr, run_id_stderr, "stderr", sender_stderr, seq).await
            {
                warn!(error = %err, "stderr stream error");
            }
        });

        let wait_status = child.wait().await;
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let (exit_code, signal) = match wait_status {
            Ok(status) => (status.code(), status.signal().map(|s| format!("SIG{}", s))),
            Err(err) => {
                warn!(run_id = %run.run_id, error = %err, "failed to wait for child");
                (Some(1), None)
            }
        };

        info!(
            run_id = %run.run_id,
            exit_code = exit_code,
            signal = signal.as_deref().unwrap_or(""),
            "Shell command finished"
        );

        send_ws_frame(
            &sender,
            json!({
                "proto": PROTO_VERSION,
                "type": "run_finished",
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "run_id": run.run_id,
                "exit_code": exit_code,
                "signal": signal,
                "canceled": false,
                "cwd": run.cwd.to_string_lossy(),
            }),
        )?;

        info!(run_id = %run.run_id, "Sent run_finished frame to backend");

        Ok(())
    }
}

async fn stream_pipe<R: AsyncRead + Unpin>(
    mut reader: R,
    run_id: String,
    stream: &str,
    sender: OutboundSender,
    seq: Arc<AtomicU64>,
) -> Result<()> {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let seq_no = seq.fetch_add(1, Ordering::SeqCst);
        send_ws_frame(
            &sender,
            json!({
                "proto": PROTO_VERSION,
                "type": stream,
                "id": new_message_id(),
                "ts": now_millis(),
                "ext": {},
                "run_id": run_id,
                "seq": seq_no,
                "data": BASE64_STANDARD.encode(chunk)
            }),
        )?;
    }
    Ok(())
}
