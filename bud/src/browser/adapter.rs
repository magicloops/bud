//! Private managed Chromium adapter. Authority belongs to the session manager.

use super::cdp::Cdp;
use anyhow::{bail, Context, Result};
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
    token: String,
}
struct Viewport {
    target: String,
    document: String,
    token: String,
    metrics: serde_json::Value,
    captured: Instant,
    stable: bool,
}

/// One owner, one serial command boundary; callers cannot clone the CDP handle.
/// Fresh TempDir profiles avoid ever attaching to a user's personal Chrome.
pub struct Browser {
    cdp: Cdp,
    child: Child,
    _profile: TempDir,
    sessions: HashMap<String, String>,
    references: HashMap<String, Reference>,
    observation_id: u64,
    focus: Option<Focus>,
    viewport: Option<Viewport>,
    viewport_id: Option<String>,
    fitted_sizes: HashMap<String, (u32, u32)>,
    last_wheel: Option<Instant>,
}

impl Browser {
    pub async fn launch(executable: &Path) -> Result<Self> {
        let profile = tempfile::Builder::new().prefix("bud-browser-").tempdir()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(profile.path(), std::fs::Permissions::from_mode(0o700))
                .await?;
        }
        let mut child = Command::new(executable)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("HOME", profile.path())
            .arg("--headless=new")
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                // Explicitly ephemeral development profiles must not touch the user's OS
                // credential store. Do not copy this policy to persistent
                // profiles: their encryption policy is a separate gate.
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
            sessions: HashMap::new(),
            references: HashMap::new(),
            observation_id: 0,
            focus: None,
            viewport: None,
            viewport_id: None,
            fitted_sizes: HashMap::new(),
            last_wheel: None,
        })
    }

    pub async fn version(&mut self) -> Result<String> {
        Ok(
            self.cdp.call(None, "Browser.getVersion", json!({})).await?["product"]
                .as_str()
                .unwrap_or("unknown")
                .into(),
        )
    }

    pub async fn targets(&mut self) -> Result<Vec<Target>> {
        let result = self.cdp.call(None, "Target.getTargets", json!({})).await?;
        Ok(result["targetInfos"]
            .as_array()
            .context("browser_invalid_targets")?
            .iter()
            .filter(|target| target["type"] == "page")
            .take(16)
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

    pub async fn navigate(&mut self, target: &str, url: &str) -> Result<()> {
        let parsed = url::Url::parse(url).map_err(|_| anyhow::anyhow!("browser_invalid_url"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            bail!("browser_unsupported_url");
        }
        let session = self.session(target).await?;
        self.invalidate_references();
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
            if elements.len() == 100 {
                truncated = true;
                break;
            }
            let reference = format!("{}:{}", ulid::Ulid::new(), id);
            self.references.insert(
                reference.clone(),
                Reference {
                    target: target.into(),
                    document: document.clone(),
                    node: id,
                },
            );
            // Never serialize AX values/properties (including passwords). Page
            // labels/text remain untrusted content. Human handoff is not yet supported.
            let name = node["name"]["value"].as_str().unwrap_or_default();
            truncated |= role.len() > 64 || name.len() > 256;
            elements.push(Element {
                reference,
                role: bounded(role, 64),
                name: bounded(name, 256),
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

    pub async fn observe(&mut self, target: &str) -> Result<Observation> {
        let observation = self.snapshot(target).await?;
        Ok(observation)
    }

    pub async fn focus(&mut self, reference: &str) -> Result<()> {
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
        self.cdp
            .call(Some(&session), "Page.bringToFront", json!({}))
            .await?;
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
            token: ulid::Ulid::new().to_string(),
        });
        Ok(())
    }

    /// Guarded committed text for ordinary inputs. Check and write
    /// in one JS task so navigation/focus changes cannot redirect input.
    /// This is NOT yet the general mobile composition/selection implementation.
    pub async fn insert_text(&mut self, text: &str) -> Result<()> {
        if text.len() > 8192 {
            bail!("browser_input_too_large");
        }
        let focus = self.focus.as_ref().context("browser_focus_required")?;
        let (target, document, object) = (
            focus.target.clone(),
            focus.document.clone(),
            focus.object.clone(),
        );
        let session = self.session(&target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
            "objectId":object, "returnByValue":true, "arguments":[{"value":text}],
            "functionDeclaration":"function(text) { if (!this.isConnected || this.ownerDocument.activeElement !== this || this.disabled || this.readOnly || this.selectionStart === null) return false; this.setRangeText(text, this.selectionStart, this.selectionEnd, 'end'); this.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); return true; }"
        })).await?;
        if result["result"]["value"] != true {
            bail!("browser_stale_or_unsupported_focus");
        }
        Ok(())
    }

    pub async fn click(&mut self, reference: &str) -> Result<()> {
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

    /// Authorized viewport mutation. Never navigate/reload the page to fit it.
    pub async fn resize_viewport(
        &mut self,
        target: &str,
        document: &str,
        width: u32,
        height: u32,
    ) -> Result<serde_json::Value> {
        let session = self.session(target).await?;
        if self.document(&session).await? != document {
            bail!("browser_document_changed");
        }
        if self.fitted_sizes.get(target) == Some(&(width, height)) {
            return Ok(json!({"viewport_applied":true,"viewport_id":self.viewport_id}));
        }
        self.invalidate_references();
        self.cdp
            .call(
                Some(&session),
                "Emulation.setDeviceMetricsOverride",
                json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}),
            )
            .await?;
        if self.document(&session).await? != document {
            bail!("browser_document_changed");
        }
        let viewport_id = ulid::Ulid::new().to_string();
        self.viewport_id = Some(viewport_id.clone());
        self.fitted_sizes.insert(target.into(), (width, height));
        Ok(
            json!({"viewport_applied":true,"viewport_id":viewport_id,"target_id":target,"document_id":document,"width":width,"height":height}),
        )
    }

    /// Demand capture uses a bounded image on the dedicated media connection.
    #[cfg(test)]
    pub async fn capture(&mut self, target: &str) -> Result<serde_json::Value> {
        self.capture_scaled(target, None).await
    }

    pub async fn capture_scaled(
        &mut self,
        target: &str,
        pixel_ratio: Option<f64>,
    ) -> Result<serde_json::Value> {
        let session = self.session(target).await?;
        let document = self.document(&session).await?;
        let metrics = self
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        let width = metrics["cssLayoutViewport"]["clientWidth"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let height = metrics["cssLayoutViewport"]["clientHeight"]
            .as_f64()
            .context("browser_viewport_unavailable")?;
        let moving = self
            .last_wheel
            .is_some_and(|at| at.elapsed() < Duration::from_millis(250));
        let enhanced = pixel_ratio.is_some() && !moving;
        let mut scale = if let Some(ratio) = pixel_ratio.filter(|_| enhanced) {
            ratio
                .clamp(1.0, 2.0)
                .min(2560.0 / width.max(height))
                .min((4_000_000.0 / (width * height)).sqrt())
        } else {
            (1280.0 / width.max(height)).min(1.0)
        };
        let mut image = String::new();
        // Read-only recapture at lower resolution bounds high-entropy PNGs.
        for _ in 0..4 {
            let shot = self.cdp.call(Some(&session), "Page.captureScreenshot", json!({
                "format":if enhanced { "png" } else { "jpeg" }, "quality":65, "captureBeyondViewport":false,
                "clip":{"x":metrics["cssLayoutViewport"]["pageX"], "y":metrics["cssLayoutViewport"]["pageY"],
                    "width":width, "height":height, "scale":scale}
            })).await?;
            image = shot["data"]
                .as_str()
                .context("browser_capture_failed")?
                .to_owned();
            if image.len() <= 1_400_000 {
                break;
            }
            scale *= 0.5;
        }
        if image.len() > 1_400_000 || self.document(&session).await? != document {
            bail!("browser_frame_discarded");
        }
        let after = self
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        let before_viewport = &metrics["cssLayoutViewport"];
        let after_viewport = &after["cssLayoutViewport"];
        if before_viewport["clientWidth"] != after_viewport["clientWidth"]
            || before_viewport["clientHeight"] != after_viewport["clientHeight"]
            || self.document(&session).await? != document
        {
            bail!("browser_frame_discarded");
        }
        // Show motion immediately, but never treat uncertain pixel coordinates
        // as proof for a click or text input.
        let stable = before_viewport == after_viewport;
        // Tokens stay opaque on the wire. Their context survives motion and
        // image quality, while their suffix still binds pixel-sensitive input.
        let context = self
            .viewport
            .as_ref()
            .filter(|v| {
                v.target == target
                    && v.document == document
                    && v.metrics["clientWidth"] == before_viewport["clientWidth"]
                    && v.metrics["clientHeight"] == before_viewport["clientHeight"]
            })
            .and_then(|v| {
                v.token
                    .split_once(':')
                    .map(|(context, _)| context.to_owned())
            })
            .unwrap_or_else(|| ulid::Ulid::new().to_string());
        let token = self
            .viewport
            .as_ref()
            .filter(|v| {
                v.target == target
                    && v.document == document
                    && v.metrics == metrics["cssLayoutViewport"]
                    && v.stable == stable
            })
            .map(|v| v.token.clone())
            .unwrap_or_else(|| format!("{context}:{}", ulid::Ulid::new()));
        self.viewport = Some(Viewport {
            target: target.into(),
            document: document.clone(),
            token: token.clone(),
            metrics: metrics["cssLayoutViewport"].clone(),
            captured: Instant::now(),
            stable,
        });
        let mut frame = json!({"target_id":target,"document_id":document,"frame_token":token,"width":width,"height":height,"image":image});
        if enhanced {
            frame["image_format"] = json!("png");
        }
        if let Some(id) = &self.viewport_id {
            frame["viewport_id"] = json!(id);
        }
        Ok(frame)
    }

    async fn remember_human_focus(
        &mut self,
        target: &str,
        session: &str,
        document: &str,
    ) -> Result<Option<String>> {
        self.focus = None;
        self.cdp
            .call(
                Some(session),
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":"bud-human-focus"}),
            )
            .await?;
        let active = self
            .cdp
            .call(
                Some(session),
                "Runtime.evaluate",
                json!({
                    "expression":"document.activeElement", "objectGroup":"bud-human-focus"
                }),
            )
            .await?;
        let Some(object) = active["result"]["objectId"].as_str() else {
            return Ok(None);
        };
        if self.document(session).await? != document {
            return Ok(None);
        }
        let token = ulid::Ulid::new().to_string();
        self.focus = Some(Focus {
            target: target.into(),
            document: document.into(),
            object: object.into(),
            token: token.clone(),
        });
        Ok(Some(token))
    }

    pub async fn human_input(
        &mut self,
        target: &str,
        document: &str,
        frame_token: &str,
        input: &super::viewer::HumanInput,
    ) -> Result<serde_json::Value> {
        use super::viewer::HumanInput;
        let session = self.session(target).await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let scroll = matches!(input, HumanInput::Scroll { .. });
        let viewport = self
            .viewport
            .as_ref()
            .filter(|v| v.target == target && v.document == document)
            .context("browser_stale_viewport")?;
        let valid_token = if scroll {
            frame_token
                .split_once(':')
                .zip(viewport.token.split_once(':'))
                .is_some_and(|((context, suffix), (current, _))| {
                    context == current && !suffix.is_empty()
                })
        } else {
            viewport.token == frame_token && viewport.captured.elapsed() < Duration::from_secs(3)
        };
        if !valid_token {
            bail!("browser_stale_viewport");
        }
        if !viewport.stable && !matches!(input, HumanInput::Scroll { .. }) {
            bail!("browser_stale_viewport");
        }
        let expected_metrics = viewport.metrics.clone();
        // Capture can display a background tab, but native input needs its
        // renderer active. The user's selected frame identifies the target.
        self.cdp
            .call(Some(&session), "Page.bringToFront", json!({}))
            .await?;
        if self.document(&session).await? != document {
            bail!("browser_stale_focus");
        }
        let metrics = self
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        // Wheel movement intentionally advances scroll offsets before the next
        // capture. Keep page/context guards and reject any size change.
        let current_metrics = &metrics["cssLayoutViewport"];
        let matches_metrics = if scroll {
            current_metrics["clientWidth"] == expected_metrics["clientWidth"]
                && current_metrics["clientHeight"] == expected_metrics["clientHeight"]
        } else {
            *current_metrics == expected_metrics
        };
        if !matches_metrics {
            bail!("browser_stale_viewport");
        }
        match input {
            HumanInput::Back => {
                let history = self
                    .cdp
                    .call(Some(&session), "Page.getNavigationHistory", json!({}))
                    .await?;
                let index = history["currentIndex"].as_u64().unwrap_or(0);
                if index == 0 {
                    bail!("browser_no_previous_page");
                }
                let id = history["entries"][index as usize - 1]["id"]
                    .as_i64()
                    .context("browser_no_previous_page")?;
                self.invalidate_references();
                self.cdp
                    .call(
                        Some(&session),
                        "Page.navigateToHistoryEntry",
                        json!({"entryId":id}),
                    )
                    .await?;
                return Ok(json!({"focus_token":null}));
            }
            HumanInput::Click { x, y } | HumanInput::Scroll { x, y, .. } => {
                if *x
                    > metrics["cssLayoutViewport"]["clientWidth"]
                        .as_f64()
                        .unwrap_or(0.0)
                    || *y
                        > metrics["cssLayoutViewport"]["clientHeight"]
                            .as_f64()
                            .unwrap_or(0.0)
                {
                    bail!("browser_stale_viewport");
                }
                if let HumanInput::Scroll { delta_y, .. } = input {
                    self.cdp
                        .call(
                            Some(&session),
                            "Input.dispatchMouseEvent",
                            json!({"type":"mouseWheel","x":x,"y":y,"deltaX":0,"deltaY":delta_y}),
                        )
                        .await?;
                    self.last_wheel = Some(Instant::now());
                    // Scrolling does not deliberately change focus. Later text/key
                    // input still checks the actual focused node before editing.
                    let focus = self
                        .focus
                        .as_ref()
                        .filter(|focus| focus.target == target && focus.document == document);
                    return Ok(json!({"focus_token":focus.map(|focus| &focus.token)}));
                } else {
                    self.cdp.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mousePressed","x":x,"y":y,"button":"left","clickCount":1})).await?;
                    self.cdp.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mouseReleased","x":x,"y":y,"button":"left","clickCount":1})).await?;
                }
            }
            HumanInput::Text { focus_token, text } => {
                if self.focus.as_ref().is_none_or(|focus| {
                    &focus.token != focus_token
                        || focus.document != document
                        || focus.target != target
                }) {
                    bail!("browser_stale_focus");
                }
                self.insert_text(text).await?;
            }
            HumanInput::Key { focus_token, key } => {
                let focus = self
                    .focus
                    .as_ref()
                    .filter(|focus| {
                        &focus.token == focus_token
                            && focus.document == document
                            && focus.target == target
                    })
                    .context("browser_stale_focus")?;
                let result = self.cdp.call(Some(&session), "Runtime.callFunctionOn", json!({
                    "objectId":focus.object,"returnByValue":true,"arguments":[{"value":key}],"userGesture":true,
                    "functionDeclaration":"function(key) { if (!this.isConnected || this.ownerDocument.activeElement !== this) return false; if (key === 'Enter') { if (this instanceof HTMLInputElement && this.form) { this.form.requestSubmit(); return true; } if (this instanceof HTMLButtonElement || this instanceof HTMLAnchorElement) { this.click(); return true; } return false; } if (key === 'Tab') { const items=[...document.querySelectorAll('input,textarea,button,select,a[href],[tabindex]')].filter(e=>!e.disabled && e.tabIndex>=0 && e.getClientRects().length); const next=items[(items.indexOf(this)+1)%items.length]; if (!next) return false; next.focus(); return true; } if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) || this.disabled || this.readOnly || this.selectionStart === null) return false; let a=this.selectionStart,b=this.selectionEnd; if (key==='Backspace'||key==='Delete') { if(a===b) { if(key==='Backspace') a=Math.max(0,a-1); else b=Math.min(this.value.length,b+1); } this.setRangeText('',a,b,'end'); this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:key==='Backspace'?'deleteContentBackward':'deleteContentForward'})); } else { const p=key==='Home'?0:key==='End'?this.value.length:key==='ArrowLeft'?Math.max(0,a-1):Math.min(this.value.length,b+1); this.setSelectionRange(p,p); } return true; }"
                })).await?;
                if result["result"]["value"] != true {
                    bail!("browser_unsupported_field");
                }
            }
        }
        Ok(json!({"focus_token":self.remember_human_focus(target,&session,document).await?}))
    }

    pub fn invalidate_references(&mut self) {
        self.references.clear();
        self.focus = None;
        self.viewport = None;
        self.last_wheel = None;
    }

    pub fn interrupted(&mut self) -> bool {
        self.cdp.interrupted() || !matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn close(mut self) -> Result<()> {
        // Own only this child. Never kill processes found by name or port.
        if self.child.try_wait()?.is_none() {
            self.child.kill().await.context("browser_close_failed")?;
        }
        Ok(())
    }
}

fn bounded(value: &str, count: usize) -> String {
    let mut end = value.len().min(count);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
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

#[cfg(test)]
#[path = "viewer_tests.rs"]
mod viewer_tests;
