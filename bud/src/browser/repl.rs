//! Killable workspace-local JavaScript. Browser calls are serviced by the manager,
//! outside the worker lock and only under the existing page/authority guards.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{collections::VecDeque, future::Future, process::Stdio};
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
    trace: Option<CellTrace>,
    tracing: bool,
    trace_files: VecDeque<(std::path::PathBuf, usize)>,
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
    [
        "repl-worker.mjs",
        "repl-api.mjs",
        "repl-artifacts.mjs",
        "repl-snapshot.mjs",
    ]
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
            trace: None,
            tracing: trace_enabled(),
            trace_files: VecDeque::new(),
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
        self.trace = self.tracing.then(CellTrace::default);
        self.send(json!({"type":"execute","cell_id":id,"code":code,"trace":self.trace.is_some()}))
            .await?;
        loop {
            let mut bytes = Vec::new();
            (&mut self.output)
                .take(if self.trace.is_some() { 16 } else { 3 } * 1024 * 1024)
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
                    if let Some(trace) = self.trace.as_mut() {
                        trace.record(
                            json!({"stage":"formatted_output","value":message["_trace_output"]}),
                        );
                    }
                    self.interrupted = false;
                    return Ok(json!({"ok":message["ok"], "text":message["text"],
                        "truncated":message["truncated"], "error":message["error"],
                        "runtime_generation":self.generation,"images":message["images"],"output_artifact":message["output_artifact"]}));
                }
                Some("operation") => {
                    let started = std::time::Instant::now();
                    let result = operation(message["command"].clone()).await;
                    // Never forward page-bearing adapter exceptions to the worker.
                    let reply = match result {
                        Ok(mut data) => {
                            let operation = message["command"]["operation"].as_str().unwrap_or("");
                            if matches!(operation, "snapshot" | "visible_dom") {
                                let raw = data.as_object_mut().and_then(|o| o.remove("_bud_trace"));
                                if let (Some(trace), Some(raw)) = (self.trace.as_mut(), raw) {
                                    trace.record(json!({"stage":"upstream_snapshot", "operation_id":message["operation_id"],
                                        "value":raw}));
                                }
                            }
                            if let Some(trace) = self.trace.as_mut() {
                                let mut event = json!({"stage":"operation_result","operation_id":message["operation_id"],
                                    "operation":operation,"action":message["command"]["action"],
                                    "target_id":message["command"]["target_id"],"elapsed_ms":started.elapsed().as_millis(),"ok":true});
                                if matches!(operation, "snapshot" | "visible_dom" | "evaluate") {
                                    event["value"] = trace_value(&data);
                                    event["request"] = trace_value(&message["command"]);
                                }
                                trace.record(event);
                            }
                            json!({"ok":true,"data":data})
                        }
                        Err(error) => {
                            let code = error.to_string();
                            let safe = code.starts_with("browser_")
                                && code.len() <= 80
                                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
                            let code = if safe {
                                code.as_str()
                            } else {
                                "browser_outcome_unknown"
                            };
                            if let Some(trace) = self.trace.as_mut() {
                                trace.record(json!({"stage":"operation_result","operation_id":message["operation_id"],
                                    "operation":message["command"]["operation"],"elapsed_ms":started.elapsed().as_millis(),
                                    "ok":false,"error":code}));
                            }
                            json!({"ok":false,"error":code})
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
    #[cfg(test)]
    pub(super) fn enable_trace_for_test(&mut self) -> std::path::PathBuf {
        self.tracing = true;
        self._directory.path().to_owned()
    }

    pub fn discard_trace(&mut self) {
        self.trace = None;
    }

    /// Called only after the manager's final cell output authority check.
    pub async fn publish_trace(
        &mut self,
        correlation: Value,
        result: &Value,
    ) -> Option<std::path::PathBuf> {
        let trace = self.trace.take()?;
        // File names never incorporate caller-supplied IDs or page data.
        let path = self
            ._directory
            .path()
            .join(format!("trace-{}.json", ulid::Ulid::new()));
        let record = json!({"schema":"browser_observation_trace_v1","correlation":correlation,
            "runtime_generation":self.generation,"recorded_at_ms":crate::util::now_millis(),
            "stages":trace.stages,"omitted_stages":trace.omitted,
            "daemon_result":result});
        let encoded = record.to_string();
        let saved = async {
            while self.trace_files.len() >= 64
                || self
                    .trace_files
                    .iter()
                    .map(|(_, bytes)| bytes)
                    .sum::<usize>()
                    + encoded.len()
                    > 64 * 1024 * 1024
            {
                // Retain the entry if deletion fails: never grow beyond the cap.
                tokio::fs::remove_file(&self.trace_files.front().unwrap().0).await?;
                self.trace_files.pop_front();
            }
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&path).await?;
            file.write_all(encoded.as_bytes()).await?;
            file.flush().await?;
            Ok::<_, std::io::Error>(())
        }
        .await;
        if saved.is_ok() {
            tracing::info!(component="browser_trace", request_id=correlation["request_id"].as_str().unwrap_or(""),
                path=%path.display(), omitted_stages=trace.omitted, "Browser observation trace saved");
            self.trace_files.push_back((path.clone(), encoded.len()));
            Some(path)
        } else {
            let _ = tokio::fs::remove_file(&path).await;
            tracing::warn!(
                component = "browser_trace",
                "Browser observation trace unavailable"
            );
            None
        }
    }

    pub async fn retract_trace(&mut self, path: Option<std::path::PathBuf>) {
        if let Some(path) = path {
            if tokio::fs::remove_file(&path).await.is_ok() {
                self.trace_files.retain(|(saved, _)| *saved != path);
            } else {
                tracing::warn!(
                    component = "browser_trace",
                    "Withheld browser trace cleanup failed"
                );
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

/// Diagnostic opt-in only; not an agent-controlled request option.
pub(super) fn trace_enabled() -> bool {
    std::env::var("BUD_BROWSER_TRACE").as_deref() == Ok("1")
}

#[derive(Default)]
struct CellTrace {
    stages: Vec<Value>,
    bytes: usize,
    omitted: usize,
}
impl CellTrace {
    fn record(&mut self, mut event: Value) {
        event["recorded_at_ms"] = json!(crate::util::now_millis());
        let bytes = event.to_string().len();
        if self.stages.len() >= 128 || self.bytes + bytes > 4 * 1024 * 1024 {
            self.omitted += 1;
        } else {
            self.bytes += bytes;
            self.stages.push(event);
        }
    }
}
fn trace_value(value: &Value) -> Value {
    use sha2::{Digest, Sha256};
    let encoded = value.to_string();
    let mut end = encoded.len().min(1024 * 1024);
    while !encoded.is_char_boundary(end) {
        end -= 1;
    }
    json!({"content":&encoded[..end],"bytes":encoded.len(),"truncated":end < encoded.len(),
        "sha256":format!("{:x}",Sha256::digest(encoded.as_bytes()))})
}

#[cfg(test)]
mod trace_tests {
    use super::*;
    #[test]
    fn bounded_trace_marks_omissions_and_preserves_utf8() {
        let value = json!("🐱".repeat(300_000));
        let captured = trace_value(&value);
        assert_eq!(captured["bytes"], value.to_string().len());
        assert_eq!(captured["truncated"], true);
        assert!(!captured["content"].as_str().unwrap().contains('�'));
        let mut trace = CellTrace::default();
        for _ in 0..200 {
            trace.record(json!({"value":captured}));
        }
        assert!(trace.omitted > 0);
        assert!(trace.bytes <= 4 * 1024 * 1024);
        assert!(trace.stages.len() <= 128);
    }
    #[tokio::test]
    async fn trace_is_local_bounded_and_failure_does_not_change_cell_output() {
        let mut runtime = Runtime::spawn(&super::super::addon::test_runtime("unused")).unwrap();
        let normal = runtime
            .execute("off", "console.log('unchanged')", |_| async {
                Ok(json!({}))
            })
            .await
            .unwrap();
        assert!(runtime.trace.is_none());
        assert_eq!(normal["text"], "unchanged\n");
        let directory = runtime.enable_trace_for_test();
        let result = runtime.execute("on", "var t=browser.tabs.get('owned'); var s=await t.snapshot(); console.log(Object.keys(s).join(',')); console.log('x'.repeat(9000))", |_| async {
            Ok(json!({"nodes":[{"text":"retained evidence"}],"_bud_trace":{"content":"upstream","bytes":8,"truncated":false}}))
        }).await.unwrap();
        assert!(result["text"]
            .as_str()
            .unwrap()
            .starts_with("nodes\n[INCOMPLETE OUTPUT EXCERPT"));
        assert!(result.get("_trace_output").is_none());
        assert!(!result.to_string().contains("retained evidence"));
        runtime
            .publish_trace(json!({"request_id":"on","thread_id":"thread"}), &result)
            .await;
        let first = runtime.trace_files.front().unwrap().0.clone();
        let record: Value =
            serde_json::from_slice(&tokio::fs::read(&first).await.unwrap()).unwrap();
        assert!(record.to_string().contains("retained evidence"));
        assert!(record.to_string().contains("upstream"));
        assert_eq!(record["daemon_result"], result);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        runtime.retract_trace(Some(first.clone())).await;
        assert!(!first.exists());
        assert!(runtime.trace_files.is_empty());
        for i in 0..66 {
            runtime.trace = Some(CellTrace::default());
            runtime
                .publish_trace(json!({"request_id":i}), &normal)
                .await;
        }
        assert_eq!(runtime.trace_files.len(), 64);
        assert!(!first.exists());
        runtime.trace = Some(CellTrace::default());
        runtime.discard_trace();
        runtime.publish_trace(json!({}), &normal).await;
        assert_eq!(runtime.trace_files.len(), 64);
        // Fail retention I/O; do not fail/reexecute the completed browser cell.
        tokio::fs::remove_file(&runtime.trace_files.front().unwrap().0)
            .await
            .unwrap();
        runtime.trace = Some(CellTrace::default());
        runtime.publish_trace(json!({}), &normal).await;
        assert_eq!(runtime.trace_files.len(), 64);
        let after = runtime
            .execute("after", "console.log('alive')", |_| async { Ok(json!({})) })
            .await
            .unwrap();
        assert_eq!(after["text"], "alive\n");
        runtime.child.start_kill().unwrap();
        runtime.child.wait().await.unwrap();
        drop(runtime);
        assert!(!directory.exists());
    }
}
