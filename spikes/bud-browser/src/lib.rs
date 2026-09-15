//! Phase-0 managed-browser adapter. Not registered as a production capability.
mod cdp;
pub mod control;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use cdp::Cdp;
use control::Control;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::process::{Child, Command};

#[derive(Debug, Serialize)]
pub struct Target {
    pub target_id: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct Element {
    pub reference: String,
    pub role: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct Observation {
    pub target_id: String,
    pub document_id: String,
    pub observation_id: u64,
    pub elements: Vec<Element>,
    pub truncated: bool,
}

struct Reference {
    target: String,
    document: String,
    node: u64,
}
struct Focus {
    target: String,
    document: String,
    object: String,
    epoch: u64,
}

/// One owner, one serial command boundary; callers cannot clone the CDP handle.
/// Fresh TempDir profiles avoid ever attaching to a user's personal Chrome.
pub struct Browser {
    cdp: Cdp,
    child: Child,
    _profile: TempDir,
    pub control: Control,
    sessions: HashMap<String, String>,
    references: HashMap<String, Reference>,
    observation_id: u64,
    focus: Option<Focus>,
}

impl Browser {
    pub async fn launch(executable: &Path) -> Result<Self> {
        let profile = tempfile::Builder::new()
            .prefix("bud-browser-spike-")
            .tempdir()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700))
                .await?;
        }
        let mut child = Command::new(executable)
            .env_remove("BUD_BROWSER_SPIKE_HOST_TICKET")
            .env_remove("BUD_BROWSER_SPIKE_MEDIA_TICKET")
            .arg("--headless=new")
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                // Disposable fixture profiles must not touch the user's OS
                // credential store. Do not copy this policy to persistent
                // product profiles: their encryption policy is a separate gate.
                "--use-mock-keychain",
                "--password-store=basic",
                "--window-size=1024,768",
                "about:blank",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("browser_launch_failed")?;
        let ready = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if child.try_wait()?.is_some() {
                    bail!("browser_exited_before_ready");
                }
                if let Ok(text) =
                    tokio::fs::read_to_string(profile.path().join("DevToolsActivePort")).await
                {
                    if let Some(endpoint) = discovery_endpoint(&text) {
                        let mut cdp = Cdp::connect(&endpoint).await?;
                        // The DevTools listener starts before the browser main
                        // thread is necessarily responsive. Prove readiness with
                        // the same read-only inventory operation consumers need.
                        let targets = cdp.call(None, "Target.getTargets", json!({})).await?;
                        if !targets["targetInfos"].is_array() {
                            bail!("browser_invalid_targets");
                        }
                        return Ok(cdp);
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;
        let cdp = match ready {
            Ok(Ok(cdp)) => cdp,
            Ok(Err(error)) => {
                let _ = child.kill().await;
                return Err(error.context("browser_not_ready"));
            }
            Err(error) => {
                let _ = child.kill().await;
                return Err(anyhow::Error::new(error).context("browser_startup_timeout"));
            }
        };
        Ok(Self {
            cdp,
            child,
            _profile: profile,
            control: Control::default(),
            sessions: HashMap::new(),
            references: HashMap::new(),
            observation_id: 0,
            focus: None,
        })
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn version(&mut self) -> Result<String> {
        Ok(
            self.cdp.call(None, "Browser.getVersion", json!({})).await?["product"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
        )
    }

    pub async fn targets(&mut self, epoch: u64, viewer: Option<&str>) -> Result<Vec<Target>> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let result = self.cdp.call(None, "Target.getTargets", json!({})).await?;
        self.control.admit(epoch, viewer, Instant::now())?;
        Ok(result["targetInfos"]
            .as_array()
            .context("browser_invalid_targets")?
            .iter()
            .filter(|target| target["type"] == "page")
            .take(32)
            .map(|target| Target {
                target_id: target["targetId"].as_str().unwrap_or_default().into(),
                title: bounded(target["title"].as_str().unwrap_or_default(), 256),
                url: bounded(target["url"].as_str().unwrap_or_default(), 2048),
            })
            .collect())
    }

    async fn session(&mut self, target: &str) -> Result<String> {
        if let Some(session) = self.sessions.get(target) {
            return Ok(session.clone());
        }
        if self.sessions.len() >= 32 {
            bail!("browser_target_limit");
        }
        let result = self
            .cdp
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId":target, "flatten":true}),
            )
            .await?;
        let session = result["sessionId"]
            .as_str()
            .context("browser_attach_failed")?
            .to_owned();
        self.cdp
            .call(Some(&session), "Page.enable", json!({}))
            .await?;
        self.sessions.insert(target.into(), session.clone());
        Ok(session)
    }

    async fn document(&mut self, session: &str) -> Result<String> {
        let tree = self
            .cdp
            .call(Some(session), "Page.getFrameTree", json!({}))
            .await?;
        tree["frameTree"]["frame"]["loaderId"]
            .as_str()
            .map(str::to_owned)
            .context("browser_document_unavailable")
    }

    pub async fn navigate(
        &mut self,
        epoch: u64,
        viewer: Option<&str>,
        target: &str,
        url: &str,
    ) -> Result<()> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let parsed = url::Url::parse(url).map_err(|_| anyhow::anyhow!("browser_invalid_url"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("browser_unsupported_url");
        }
        let session = self.session(target).await?;
        self.references.clear();
        self.focus = None;
        self.control.admit(epoch, viewer, Instant::now())?;
        let result = self
            .cdp
            .call(Some(&session), "Page.navigate", json!({"url":url}))
            .await?;
        if result.get("errorText").is_some() {
            bail!("browser_navigation_failed");
        }
        Ok(())
    }

    async fn snapshot(&mut self, target: &str) -> Result<Observation> {
        let session = self.session(target).await?;
        let document = self.document(&session).await?;
        let result = self
            .cdp
            .call(Some(&session), "Accessibility.getFullAXTree", json!({}))
            .await?;
        if self.document(&session).await? != document {
            bail!("browser_document_changed");
        }
        self.observation_id += 1;
        self.references.clear();
        let nodes = result["nodes"]
            .as_array()
            .context("browser_snapshot_failed")?;
        let mut elements = Vec::new();
        let mut truncated = false;
        for node in nodes {
            if node["ignored"] == true {
                continue;
            }
            let Some(id) = node["backendDOMNodeId"].as_u64() else {
                continue;
            };
            let role = node["role"]["value"].as_str().unwrap_or_default();
            if matches!(role, "none" | "generic" | "InlineTextBox") {
                continue;
            }
            if elements.len() == 200 {
                truncated = true;
                break;
            }
            let reference = format!("{}:{}", self.observation_id, id);
            self.references.insert(
                reference.clone(),
                Reference {
                    target: target.into(),
                    document: document.clone(),
                    node: id,
                },
            );
            // Never serialize AX values/properties (including passwords). Page
            // labels/text remain untrusted content, and private mode gates all
            // observation, not merely value fields.
            elements.push(Element {
                reference,
                role: bounded(role, 64),
                name: bounded(node["name"]["value"].as_str().unwrap_or_default(), 256),
            });
        }
        Ok(Observation {
            target_id: target.into(),
            document_id: document,
            observation_id: self.observation_id,
            elements,
            truncated,
        })
    }

    pub async fn observe(
        &mut self,
        epoch: u64,
        viewer: Option<&str>,
        target: &str,
    ) -> Result<Observation> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let observation = self.snapshot(target).await?;
        self.control.admit(epoch, viewer, Instant::now())?;
        Ok(observation)
    }

    pub fn takeover(&mut self, epoch: u64, viewer: &str) -> Result<u64> {
        let epoch = self.control.takeover(epoch, viewer, Instant::now())?;
        self.references.clear();
        self.focus = None;
        Ok(epoch)
    }

    pub async fn return_to_agent(
        &mut self,
        epoch: u64,
        viewer: &str,
        target: &str,
    ) -> Result<Observation> {
        self.control.begin_return(epoch, viewer, Instant::now())?;
        self.references.clear();
        self.focus = None;
        // Any failure keeps ResumePending fenced; never implicitly resume.
        let observation = self.snapshot(target).await?;
        self.control.complete_return()?;
        Ok(observation)
    }

    pub async fn focus(&mut self, epoch: u64, viewer: Option<&str>, reference: &str) -> Result<()> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let entry = self
            .references
            .get(reference)
            .context("browser_stale_reference")?;
        let (target, document, node) = (entry.target.clone(), entry.document.clone(), entry.node);
        let session = self.session(&target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_reference");
        }
        self.cdp
            .call(
                Some(&session),
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":"bud-input"}),
            )
            .await?;
        self.focus = None;
        let result = self
            .cdp
            .call(
                Some(&session),
                "DOM.resolveNode",
                json!({"backendNodeId":node,"objectGroup":"bud-input"}),
            )
            .await?;
        let object = result["object"]["objectId"]
            .as_str()
            .context("browser_stale_reference")?
            .to_owned();
        self.control.admit(epoch, viewer, Instant::now())?;
        self.cdp
            .call(Some(&session), "Page.bringToFront", json!({}))
            .await?;
        self.control.admit(epoch, viewer, Instant::now())?;
        let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
            "objectId":object, "returnByValue":true, "userGesture":true,
            "functionDeclaration":"function() { if (!this.isConnected || !(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement)) return false; this.focus(); return this.ownerDocument.activeElement === this; }"
        })).await?;
        if result["result"]["value"] != true {
            bail!("browser_unsupported_field");
        }
        self.focus = Some(Focus {
            target,
            document,
            object,
            epoch,
        });
        Ok(())
    }

    /// Experiment: guarded committed text for ordinary inputs. Check and write
    /// in one JS task so a navigation/focus change cannot redirect a password.
    /// This is NOT yet the general mobile composition/selection implementation.
    pub async fn insert_text(
        &mut self,
        epoch: u64,
        viewer: Option<&str>,
        text: &str,
    ) -> Result<()> {
        self.control.admit(epoch, viewer, Instant::now())?;
        if text.len() > 8192 {
            bail!("browser_input_too_large");
        }
        let focus = self.focus.as_ref().context("browser_focus_required")?;
        if focus.epoch != epoch {
            bail!("browser_stale_focus");
        }
        let (target, document, object) = (
            focus.target.clone(),
            focus.document.clone(),
            focus.object.clone(),
        );
        let session = self.session(&target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        self.control.admit(epoch, viewer, Instant::now())?;
        let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
            "objectId":object, "returnByValue":true, "arguments":[{"value":text}],
            "functionDeclaration":"function(text) { if (!this.isConnected || this.ownerDocument.activeElement !== this || this.disabled || this.readOnly || this.selectionStart === null) return false; this.setRangeText(text, this.selectionStart, this.selectionEnd, 'end'); this.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); return true; }"
        })).await?;
        if result["result"]["value"] != true {
            bail!("browser_stale_or_unsupported_focus");
        }
        Ok(())
    }

    pub async fn click(&mut self, epoch: u64, viewer: Option<&str>, reference: &str) -> Result<()> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let entry = self
            .references
            .get(reference)
            .context("browser_stale_reference")?;
        let (target, document, node) = (entry.target.clone(), entry.document.clone(), entry.node);
        let session = self.session(&target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_reference");
        }
        let result = self
            .cdp
            .call(
                Some(&session),
                "DOM.resolveNode",
                json!({"backendNodeId":node,"objectGroup":"bud-click"}),
            )
            .await?;
        let object = result["object"]["objectId"]
            .as_str()
            .context("browser_stale_reference")?;
        self.control.admit(epoch, viewer, Instant::now())?;
        let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
            "objectId":object,"returnByValue":true,"userGesture":true,
            "functionDeclaration":"function() { if (!this.isConnected || typeof this.click !== 'function') return false; this.click(); return true; }"
        })).await?;
        if result["result"]["value"] != true {
            bail!("browser_stale_reference");
        }
        self.focus = None;
        self.cdp
            .call(
                Some(&session),
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":"bud-click"}),
            )
            .await?;
        Ok(())
    }

    /// Demand capture: no frame events, no queue, no capture without a caller.
    pub async fn capture(
        &mut self,
        epoch: u64,
        viewer: Option<&str>,
        target: &str,
    ) -> Result<Vec<u8>> {
        self.control.admit(epoch, viewer, Instant::now())?;
        let session = self.session(target).await?;
        let result = self
            .cdp
            .call(
                Some(&session),
                "Page.captureScreenshot",
                json!({"format":"jpeg","quality":65,"captureBeyondViewport":false}),
            )
            .await?;
        self.control.admit(epoch, viewer, Instant::now())?;
        let bytes = STANDARD.decode(result["data"].as_str().context("browser_capture_failed")?)?;
        if bytes.len() > 1024 * 1024 {
            bail!("browser_frame_too_large");
        }
        Ok(bytes)
    }

    pub async fn close(mut self) -> Result<()> {
        // Own only this child. Never kill processes found by name or port.
        self.child.kill().await.context("browser_close_failed")?;
        Ok(())
    }
}

fn bounded(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

// Chrome creates this file before writing it. Incomplete discovery is not a
// failed launch. Its browser path ends in a canonical UUID; wait for all of it
// before connecting, including when a read catches only part of the write.
fn discovery_endpoint(text: &str) -> Option<String> {
    let mut lines = text.lines();
    let port: u16 = lines.next()?.parse().ok()?;
    let path = lines.next()?;
    let id = path.strip_prefix("/devtools/browser/")?;
    if port == 0
        || id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

#[cfg(test)]
mod launch_tests {
    use super::discovery_endpoint;

    #[test]
    fn discovery_waits_for_every_partial_write() {
        let text = "43210\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
        for end in 0..text.len() {
            assert!(discovery_endpoint(&text[..end]).is_none(), "prefix {end}");
        }
        assert_eq!(
            discovery_endpoint(text),
            Some(format!("ws://127.0.0.1:43210{}", &text[6..]))
        );
        assert!(discovery_endpoint(&text.replace("43210", "0")).is_none());
        assert!(discovery_endpoint(&text.replace("43210", "99999")).is_none());
        assert!(discovery_endpoint(&text.replace("/browser/", "/page/")).is_none());
    }
}
