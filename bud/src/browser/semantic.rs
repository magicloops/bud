//! Private Playwright helper. The BrowserManager page lock serializes every call.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

struct KillOnCancel<'a> {
    child: &'a mut Child,
    armed: bool,
}
impl Drop for KillOnCancel<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.child.start_kill();
        }
    }
}

pub(super) struct Semantic {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    poisoned: bool,
}
impl Semantic {
    pub async fn connect(endpoint: &str) -> Result<Self> {
        let helper = std::env::var_os("BUD_BROWSER_HELPER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("browser-helper/main.mjs")
            });
        let node = std::env::var_os("BUD_BROWSER_NODE").unwrap_or_else(|| "node".into());
        let mut child = Command::new(node)
            .arg("--max-old-space-size=128")
            .arg(helper)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("browser_helper_unavailable")?;
        let mut result = Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            poisoned: false,
        };
        result.call(json!({"endpoint":endpoint})).await?;
        Ok(result)
    }
    pub fn interrupted(&mut self) -> bool {
        self.poisoned || !matches!(self.child.try_wait(), Ok(None))
    }
    pub async fn call(&mut self, command: Value) -> Result<Value> {
        if self.interrupted() {
            bail!("browser_interrupted");
        }
        let started = std::time::Instant::now();
        let operation = match command["operation"].as_str() {
            Some("click") => "click",
            Some("fill") => "fill",
            Some("focus") => "focus",
            Some("snapshot") => "snapshot",
            Some("visible_dom") => "visible_dom",
            _ => "other",
        };
        self.poisoned = true;
        let mut guard = KillOnCancel {
            child: &mut self.child,
            armed: true,
        };
        let result = tokio::time::timeout(Duration::from_secs(8), async {
            self.input
                .write_all(format!("{command}\n").as_bytes())
                .await?;
            self.input.flush().await?;
            let mut bytes = Vec::new();
            (&mut self.output)
                .take(128 * 1024)
                .read_until(b'\n', &mut bytes)
                .await?;
            if bytes.last() != Some(&b'\n') {
                bail!("browser_helper_output_limit");
            }
            Ok::<Value, anyhow::Error>(serde_json::from_slice(&bytes)?)
        })
        .await
        .context("browser_helper_timeout")??;
        guard.armed = false;
        self.poisoned = false;
        if result["ok"] != true {
            let d = &result["diagnostic"];
            // Read only bounded numeric/boolean fields, never the raw helper error.
            tracing::info!(
                component = "browser_timing",
                event = "semantic_failure",
                helper_pid = guard.child.id(),
                operation,
                elapsed_ms = started.elapsed().as_millis() as u64,
                stage = match d["stage"].as_u64() {
                    Some(0) => "resolve_page",
                    Some(1) => "validate_snapshot",
                    Some(2) => "snapshot",
                    Some(3) => "resolve_element",
                    Some(4) => "validate_action",
                    Some(5) => "click",
                    Some(6) => "fill",
                    Some(7) => "focus",
                    _ => "unknown",
                },
                timeout = d["timeout"].as_bool().unwrap_or(false),
                intercepted = d["intercepted"].as_bool().unwrap_or(false),
                invisible = d["invisible"].as_bool().unwrap_or(false),
                unstable = d["unstable"].as_bool().unwrap_or(false),
                disabled = d["disabled"].as_bool().unwrap_or(false),
                detached = d["detached"].as_bool().unwrap_or(false),
                navigation_wait = d["navigation_wait"].as_bool().unwrap_or(false),
                target_closed = d["target_closed"].as_bool().unwrap_or(false),
                "Browser semantic operation failed"
            );
            bail!(
                "{}",
                result["error"]
                    .as_str()
                    .unwrap_or("browser_outcome_unknown")
            );
        }
        Ok(result["data"].clone())
    }
}
