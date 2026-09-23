//! Killable workspace-local JavaScript. Browser calls are serviced by the manager,
//! outside the worker lock and only under the existing page/authority guards.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{future::Future, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub(super) struct Runtime {
    child: Child,
    _directory: tempfile::TempDir,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    pub generation: String,
    pub authority_fence: u64,
    interrupted: bool,
}

#[derive(Default)]
pub(super) struct Workspace {
    pub runtime: Option<Runtime>,
    pub reset_reason: Option<&'static str>,
}

impl Workspace {
    pub async fn reset(&mut self, reason: &'static str) -> Result<()> {
        if let Some(runtime) = self.runtime.as_mut() {
            self.reset_reason = Some(reason);
            runtime.interrupted = true;
            runtime.child.start_kill()?;
            tokio::time::timeout(std::time::Duration::from_millis(500), runtime.child.wait())
                .await
                .context("browser_repl_stop_unconfirmed")??;
            self.runtime = None;
        }
        Ok(())
    }
}

pub(super) fn prepared(runtime: &super::addon::Runtime) -> bool {
    ["repl-worker.mjs", "repl-api.mjs", "repl-artifacts.mjs"]
        .iter()
        .all(|name| runtime.helper.with_file_name(name).is_file())
}

impl Runtime {
    pub fn spawn(runtime: &super::addon::Runtime) -> Result<Self> {
        let worker = runtime.helper.with_file_name("repl-worker.mjs");
        if !prepared(runtime) {
            bail!("browser_repl_not_prepared");
        }
        let directory = tempfile::Builder::new().prefix("bud-repl-").tempdir()?;
        let mut child = Command::new(&runtime.node)
            .arg("--max-old-space-size=128")
            .arg(worker)
            .arg(directory.path())
            .current_dir(directory.path())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("browser_repl_unavailable")?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            _directory: directory,
            generation: ulid::Ulid::new().to_string(),
            authority_fence: 0,
            interrupted: false,
        })
    }

    pub fn interrupted(&mut self) -> bool {
        self.interrupted || !matches!(self.child.try_wait(), Ok(None))
    }

    /// Cancellation leaves this process unusable. Its owner drops it before
    /// admitting another cell; the generation changes on the next spawn.
    pub async fn execute<F, Fut>(&mut self, id: &str, code: &str, mut operation: F) -> Result<Value>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        if self.interrupted() {
            bail!("browser_repl_reset");
        }
        self.interrupted = true;
        self.send(json!({"type":"execute","cell_id":id,"code":code}))
            .await?;
        loop {
            let mut bytes = Vec::new();
            (&mut self.output)
                .take(3 * 1024 * 1024)
                .read_until(b'\n', &mut bytes)
                .await?;
            if bytes.last() != Some(&b'\n') {
                bail!("browser_repl_channel_lost");
            }
            let message: Value = serde_json::from_slice(&bytes)?;
            if message["cell_id"] != id {
                bail!("browser_repl_protocol_error");
            }
            match message["type"].as_str() {
                Some("result") => {
                    if !message["ok"].is_boolean()
                        || message["text"].as_str().is_none_or(|s| s.len() > 32 * 1024)
                        || !message["truncated"].is_boolean()
                        || message
                            .get("error")
                            .is_some_and(|e| e.as_str().is_none_or(|s| s.len() > 2048))
                    {
                        bail!("browser_repl_protocol_error");
                    }
                    self.interrupted = false;
                    return Ok(json!({"ok":message["ok"], "text":message["text"],
                        "truncated":message["truncated"], "error":message["error"],
                        "runtime_generation":self.generation,"images":message["images"],"output_artifact":message["output_artifact"]}));
                }
                Some("operation") => {
                    let result = operation(message["command"].clone()).await;
                    // Never forward page-bearing adapter exceptions to the worker.
                    let reply = match result {
                        Ok(data) => json!({"ok":true,"data":data}),
                        Err(error) => {
                            let code = error.to_string();
                            let safe = code.starts_with("browser_")
                                && code.len() <= 80
                                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
                            json!({"ok":false,"error":if safe {code.as_str()} else {"browser_outcome_unknown"}})
                        }
                    };
                    self.send(json!({"type":"operation_result","cell_id":id,
                        "operation_id":message["operation_id"],"ok":reply["ok"],
                        "data":reply["data"],"error":reply["error"]}))
                        .await?;
                }
                _ => bail!("browser_repl_protocol_error"),
            }
        }
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await?;
        self.input.flush().await?;
        Ok(())
    }
}
