use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::{json, Map, Number, Value};
use tokio::fs;
use tracing::{info, warn};

use crate::protocol::{
    TerminalCloseFrame, TerminalEnsureConfig, TerminalEnsureFrame, TerminalResizeFrame,
    TERMINAL_PROTO_VERSION,
};
use crate::util::{new_message_id, now_millis, send_ws_frame, OutboundSender};

use super::backend::TerminalBackend;
use super::{
    DeliveredCaptureState, TerminalHandle, TerminalManager, TerminalStatusSnapshot,
    DEFAULT_TERMINAL_COLORFGBG, DEFAULT_TERMINAL_COLORTERM,
};

impl<B> TerminalManager<B>
where
    B: TerminalBackend,
{
    pub async fn handle_ensure(&self, frame: TerminalEnsureFrame) -> Result<()> {
        if !self.config.enabled {
            info!("terminal support disabled; ignoring terminal_ensure");
            return Ok(());
        }

        let session_id = &frame.session_id;
        let inner = self.inner.lock().await;

        if inner.sessions.contains_key(session_id) {
            if let Some(sender) = inner.sender.clone() {
                drop(inner);
                self.send_status(&sender, session_id, "ready", None).await?;
            }
            return Ok(());
        }

        let sender = inner
            .sender
            .clone()
            .ok_or_else(|| anyhow!("no websocket writer available"))?;
        drop(inner);

        if !self.config.tmux_available {
            warn!("tmux not available; cannot create terminal");
            self.send_status(
                &sender,
                session_id,
                "none",
                Some(json!({ "error": "tmux_unavailable" })),
            )
            .await?;
            return Ok(());
        }

        let ensured = self
            .ensure_terminal_session(session_id, frame.config)
            .await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner.sessions.insert(session_id.clone(), handle);
        } else {
            self.send_status(
                &sender,
                session_id,
                "none",
                Some(json!({ "error": "terminal_create_failed" })),
            )
            .await?;
        }
        Ok(())
    }

    pub async fn handle_resize(&self, frame: TerminalResizeFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = session_id,
                "terminal_resize dropped; no session"
            );
            return Ok(());
        };

        if let Err(err) = self
            .backend
            .resize_window(&handle.session_name, frame.cols, frame.rows)
            .await
        {
            warn!(message_id = %frame.envelope.id, error = %err, "tmux resize-window failed");
        }

        Ok(())
    }

    pub async fn handle_close(&self, frame: TerminalCloseFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let sender = self.sender().await;

        let handle = {
            let mut inner = self.inner.lock().await;
            let handle = inner.sessions.remove(session_id);
            inner.delivered_captures.remove(session_id);
            handle
        };

        if let Some(handle) = handle {
            handle.watcher.abort();
            let _ = self.backend.kill_session(&handle.session_name).await;
            info!(
                session_id = session_id,
                session_name = %handle.session_name,
                "terminal session closed"
            );
        }

        if let Some(sender) = sender {
            self.send_status(&sender, session_id, "closed", None)
                .await?;
        }

        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            reason = %frame.reason.clone().unwrap_or_default(),
            "terminal_close handled"
        );
        Ok(())
    }

    pub(super) async fn sender(&self) -> Option<OutboundSender> {
        let inner = self.inner.lock().await;
        inner.sender.clone()
    }

    pub(super) async fn get_delivered_capture(
        &self,
        session_id: &str,
        start_line: Option<i32>,
    ) -> Option<String> {
        let inner = self.inner.lock().await;
        inner
            .delivered_captures
            .get(session_id)
            .filter(|state| state.start_line == start_line)
            .map(|state| state.capture.clone())
    }

    pub(super) async fn store_delivered_capture(
        &self,
        session_id: &str,
        capture: &str,
        start_line: Option<i32>,
    ) {
        let mut inner = self.inner.lock().await;
        inner.delivered_captures.insert(
            session_id.to_string(),
            DeliveredCaptureState {
                capture: capture.to_string(),
                start_line,
            },
        );
    }

    pub(super) async fn send_status(
        &self,
        sender: &OutboundSender,
        session_id: &str,
        state: &str,
        info: Option<Value>,
    ) -> Result<()> {
        let handle_snapshot = {
            let inner = self.inner.lock().await;
            inner
                .sessions
                .get(session_id)
                .map(|handle| TerminalStatusSnapshot {
                    cols: handle.cols,
                    rows: handle.rows,
                    output_log_bytes: handle.offset.load(Ordering::SeqCst),
                    pid: handle.pid,
                    cwd: handle.cwd.clone(),
                })
        };

        let payload = build_terminal_status_payload(session_id, state, info, handle_snapshot);
        send_ws_frame(sender, payload)
    }

    pub(super) async fn ensure_handle_for_session(
        &self,
        session_id: &str,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        {
            let inner = self.inner.lock().await;
            if let Some(handle) = inner.sessions.get(session_id) {
                return Ok(Some(handle.clone()));
            }
        }

        let ensured = self.ensure_terminal_session(session_id, cfg).await?;
        if let Some(handle) = ensured {
            let mut inner = self.inner.lock().await;
            inner
                .sessions
                .insert(session_id.to_string(), handle.clone());
            return Ok(Some(handle));
        }
        Ok(None)
    }

    pub(super) async fn ensure_terminal_session(
        &self,
        session_id: &str,
        cfg: Option<TerminalEnsureConfig>,
    ) -> Result<Option<Arc<TerminalHandle>>> {
        if !self.config.tmux_available {
            return Ok(None);
        }
        let cfg = cfg.unwrap_or_default();
        let session_name = self.backend.session_name(session_id);
        let log_path = self.backend.log_path(session_id);
        let session_env = build_terminal_session_env(cfg.env);
        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).await.ok();
        }
        let mut cols = cfg.cols.unwrap_or(self.config.cols);
        let mut rows = cfg.rows.unwrap_or(self.config.rows);
        if cols == 0 {
            cols = 200;
        }
        if rows == 0 {
            rows = 50;
        }
        let shell = cfg.shell.unwrap_or_else(|| self.config.shell.clone());
        let cwd = cfg.cwd.unwrap_or_else(|| "~".to_string());

        let session_exists = self
            .backend
            .session_exists(&session_name)
            .await
            .unwrap_or(false);
        if !session_exists {
            info!(
                session_id = session_id,
                session_name = %session_name,
                "creating new tmux session"
            );
            if self
                .backend
                .create_session(&session_name, cols, rows, &cwd, &shell, &session_env)
                .await
                .is_err()
            {
                warn!(session_id = session_id, session_name = %session_name, "tmux new-session failed");
                return Ok(None);
            }

            let _ = self.backend.set_history_limit(&session_name, 5000).await;
        } else {
            info!(
                session_id = session_id,
                session_name = %session_name,
                "reattaching to existing tmux session"
            );
        }

        match self.backend.reset_pipe(&session_name, &log_path).await {
            Ok(true) => {
                info!(session_id = session_id, session_name = %session_name, "tmux pipe-pane established");
            }
            Ok(false) => {
                warn!(session_id = session_id, session_name = %session_name, "tmux pipe-pane failed");
            }
            Err(err) => {
                warn!(session_id = session_id, session_name = %session_name, error = %err, "tmux pipe-pane command failed");
            }
        }

        let metadata = fs::metadata(&log_path).await.ok();
        let start_offset = metadata.map(|meta| meta.len()).unwrap_or(0);
        let pid = self.backend.pane_pid(&session_name).await.ok();
        let cwd_reported = self.backend.pane_cwd(&session_name).await.ok();
        let sender = match self.sender().await {
            Some(sender) => sender,
            None => return Ok(None),
        };
        let seq = Arc::new(AtomicU64::new(0));
        let offset = Arc::new(AtomicU64::new(start_offset));
        let last_output_at = Arc::new(AtomicU64::new(now_millis()));
        let last_output_seq = Arc::new(AtomicU64::new(0));
        let watcher = self.backend.spawn_output_watcher(
            session_id.to_string(),
            session_name.clone(),
            log_path.clone(),
            sender.clone(),
            seq.clone(),
            offset.clone(),
            last_output_at.clone(),
            last_output_seq.clone(),
        );
        let handle = Arc::new(TerminalHandle {
            session_id: session_id.to_string(),
            session_name,
            log_path,
            pid,
            cwd: cwd_reported.clone(),
            watcher,
            seq,
            offset,
            last_output_at,
            last_output_seq,
            cols,
            rows,
        });
        let info = json!({
            "pid": pid,
            "cwd": cwd_reported,
            "cols": handle.cols,
            "rows": handle.rows,
            "output_log_bytes": start_offset,
        });
        let _ = self
            .send_status(&sender, session_id, "ready", Some(info))
            .await;
        Ok(Some(handle))
    }
}

fn build_terminal_status_payload(
    session_id: &str,
    state: &str,
    info: Option<Value>,
    handle_snapshot: Option<TerminalStatusSnapshot>,
) -> Value {
    let mut payload = json!({
        "proto": TERMINAL_PROTO_VERSION,
        "type": "terminal_status",
        "id": new_message_id(),
        "ts": now_millis(),
        "ext": {},
        "session_id": session_id,
        "state": state,
    });

    let mut info_map = match info {
        Some(Value::Object(obj)) => obj,
        _ => Map::new(),
    };

    if let Some(snapshot) = handle_snapshot {
        info_map.insert("cols".into(), Value::Number(Number::from(snapshot.cols)));
        info_map.insert("rows".into(), Value::Number(Number::from(snapshot.rows)));
        info_map.insert(
            "output_log_bytes".into(),
            Value::Number(Number::from(snapshot.output_log_bytes)),
        );
        if let Some(pid) = snapshot.pid {
            info_map.insert("pid".into(), Value::Number(Number::from(pid)));
        }
        if let Some(cwd) = snapshot.cwd {
            info_map.insert("cwd".into(), Value::String(cwd));
        }
    }

    if !info_map.is_empty() {
        if let Some(map) = payload.as_object_mut() {
            map.insert("info".into(), Value::Object(info_map));
        }
    }

    payload
}

fn build_terminal_session_env(
    env_overrides: Option<HashMap<String, String>>,
) -> Vec<(String, String)> {
    let mut env = HashMap::from([
        (
            "COLORTERM".to_string(),
            DEFAULT_TERMINAL_COLORTERM.to_string(),
        ),
        (
            "COLORFGBG".to_string(),
            DEFAULT_TERMINAL_COLORFGBG.to_string(),
        ),
    ]);

    if let Some(overrides) = env_overrides {
        env.extend(overrides);
    }

    let mut entries = env.into_iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    entries
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::{build_terminal_session_env, build_terminal_status_payload};
    use crate::terminal::TerminalStatusSnapshot;

    #[test]
    fn build_terminal_session_env_includes_dark_terminal_defaults() {
        let env = build_terminal_session_env(None)
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("COLORFGBG").map(String::as_str), Some("15;0"));
    }

    #[test]
    fn build_terminal_session_env_allows_explicit_overrides() {
        let env = build_terminal_session_env(Some(HashMap::from([
            ("COLORTERM".to_string(), "24bit".to_string()),
            ("COLORFGBG".to_string(), "0;15".to_string()),
            ("TERM_PROGRAM".to_string(), "bud-test".to_string()),
        ])))
        .into_iter()
        .collect::<HashMap<_, _>>();

        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("24bit"));
        assert_eq!(env.get("COLORFGBG").map(String::as_str), Some("0;15"));
        assert_eq!(
            env.get("TERM_PROGRAM").map(String::as_str),
            Some("bud-test")
        );
    }

    #[test]
    fn terminal_status_payload_merges_existing_info_with_handle_snapshot() {
        let payload = build_terminal_status_payload(
            "sess_123",
            "ready",
            Some(json!({
                "cwd": "/tmp/work",
                "pid": 42,
                "output_log_bytes": 17,
                "existing": true,
            })),
            Some(TerminalStatusSnapshot {
                cols: 200,
                rows: 50,
                output_log_bytes: 17,
                pid: Some(42),
                cwd: Some("/tmp/work".to_string()),
            }),
        );

        let info = payload
            .get("info")
            .and_then(|value| value.as_object())
            .expect("terminal_status info");

        assert_eq!(info.get("cols").and_then(|value| value.as_u64()), Some(200));
        assert_eq!(info.get("rows").and_then(|value| value.as_u64()), Some(50));
        assert_eq!(info.get("pid").and_then(|value| value.as_i64()), Some(42));
        assert_eq!(
            info.get("cwd").and_then(|value| value.as_str()),
            Some("/tmp/work")
        );
        assert_eq!(
            info.get("output_log_bytes")
                .and_then(|value| value.as_u64()),
            Some(17)
        );
        assert_eq!(
            info.get("existing").and_then(|value| value.as_bool()),
            Some(true)
        );
    }
}
