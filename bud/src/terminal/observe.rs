use anyhow::Result;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::protocol::{TerminalObserveFrame, TERMINAL_PROTO_VERSION};
use crate::transport::send_transport_frame;
use crate::util::{new_message_id, now_millis};

use super::backend::TerminalBackend;
use super::delta::build_additive_delta_payload;
use super::{TerminalManager, DEFAULT_DELTA_CAPTURE_START_LINE};

impl<B> TerminalManager<B>
where
    B: TerminalBackend,
{
    pub async fn handle_observe(&self, frame: TerminalObserveFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_observe_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let view = frame.view.as_deref().unwrap_or("delta");
        let wait_for = frame.wait_for.as_deref().unwrap_or("none");
        let timeout_ms = frame.timeout_ms.unwrap_or(30_000);
        let lines = frame.lines.unwrap_or(DEFAULT_DELTA_CAPTURE_START_LINE);
        let view = match parse_observe_view(view) {
            Ok(parsed) => parsed,
            Err(_) => {
                return self.send_observe_error(&frame, "unsupported_view").await;
            }
        };
        let start_line = start_line_for_observe_view(view, lines);

        if view == "delta" && wait_for == "shell_ready" {
            return self
                .send_observe_error(&frame, "unsupported_wait_for")
                .await;
        }

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            return self.send_observe_error(&frame, "session_not_found").await;
        };

        let Some(sender) = self.sender().await else {
            warn!(
                request_id = request_id,
                session_id = session_id,
                "terminal_observe dropped; no sender"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        info!(
            request_id = request_id,
            session_id = session_id,
            session = %handle.session_name,
            view = view,
            wait_for = wait_for,
            lines = lines,
            start_line = ?start_line,
            timeout_ms = timeout_ms,
            start_offset = start_offset,
            "terminal_observe received"
        );

        let delivered_baseline = if view == "delta" {
            self.get_delivered_capture(session_id, start_line).await
        } else {
            None
        };
        let wait_baseline = if view == "delta"
            && delivered_baseline.is_none()
            && wait_for != "none"
            && wait_for != "shell_ready"
        {
            match self
                .capture_with_lines(&handle.session_name, start_line)
                .await
            {
                Ok(capture) => Some(capture),
                Err(err) => {
                    warn!(
                        request_id = request_id,
                        session_id = session_id,
                        error = %err,
                        "terminal_observe baseline capture failed"
                    );
                    None
                }
            }
        } else {
            None
        };

        let readiness_wait_start = std::time::Instant::now();
        let (readiness, current_capture, capture_ms, capture_summary, reused_wait_capture) =
            if wait_for == "shell_ready" {
                let readiness = self
                    .resolve_readiness_after_interaction(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        start_offset,
                    )
                    .await?;

                let capture_start = std::time::Instant::now();
                let output = self
                    .capture_with_lines(&handle.session_name, start_line)
                    .await?;
                let capture_ms = capture_start.elapsed().as_millis() as u64;
                let capture_summary =
                    super::delta::summarize_capture_for_log(&output, self.config.debug_enabled);
                (readiness, output, capture_ms, capture_summary, false)
            } else if matches!(wait_for, "settled" | "screen_stable") {
                let observe_started_at = now_millis();
                let quiescence = self
                    .wait_for_output_quiescence(
                        &handle,
                        request_id,
                        timeout_ms,
                        observe_started_at,
                        start_offset,
                    )
                    .await?;
                let current = self
                    .capture_screen_state(&handle.session_name, start_line, quiescence.elapsed_ms)
                    .await?;
                let readiness = self.build_quiescence_assessment(&current.capture, &quiescence);
                (
                    readiness,
                    current.capture,
                    current.captured_after_ms,
                    current.summary,
                    false,
                )
            } else {
                let wait_result = self
                    .wait_for_screen_state(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        wait_baseline.as_deref().or(delivered_baseline.as_deref()),
                        start_line,
                    )
                    .await?;
                (
                    wait_result.assessment,
                    wait_result.capture,
                    wait_result.captured_after_ms,
                    wait_result.summary,
                    true,
                )
            };
        let readiness_wait_ms = readiness_wait_start.elapsed().as_millis() as u64;
        let (output, output_bytes, lines_captured, changed, truncated, delta_strategy) = match view
        {
            "delta" => {
                let comparison_baseline =
                    delivered_baseline.as_deref().or(wait_baseline.as_deref());
                let delta = build_additive_delta_payload(comparison_baseline, &current_capture);
                let fallback_delta =
                    if delivered_baseline.is_none() && delta.text.is_empty() && !delta.changed {
                        Some(build_additive_delta_payload(None, &current_capture))
                    } else {
                        None
                    };
                let output = fallback_delta
                    .as_ref()
                    .map(|value| value.text.clone())
                    .unwrap_or_else(|| delta.text.clone());
                let output_bytes = output.as_bytes().len();
                let lines_captured = output.lines().count();
                (
                    output,
                    output_bytes,
                    lines_captured,
                    Some(delta.changed),
                    Some(
                        fallback_delta
                            .as_ref()
                            .map(|value| value.truncated)
                            .unwrap_or(delta.truncated),
                    ),
                    Some(
                        fallback_delta
                            .as_ref()
                            .map(|value| value.strategy)
                            .unwrap_or(delta.strategy),
                    ),
                )
            }
            "screen" | "history" => {
                let output_bytes = current_capture.as_bytes().len();
                let lines_captured = current_capture.lines().count();
                (
                    current_capture.clone(),
                    output_bytes,
                    lines_captured,
                    None,
                    None,
                    None,
                )
            }
            _ => unreachable!("unsupported observe view"),
        };

        let host_cwd = match self.backend.pane_cwd(&handle.session_name).await {
            Ok(cwd) => Some(cwd),
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_observe pane cwd query failed"
                );
                None
            }
        };

        let mut payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_observe_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": request_id,
            "view": view,
            "output": BASE64_STANDARD.encode(output.as_bytes()),
            "output_bytes": output_bytes,
            "lines_captured": lines_captured,
            "changed": changed,
            "truncated": truncated,
            "readiness": readiness,
            "error": Value::Null,
        });
        if let Some(cwd) = host_cwd {
            if let Some(object) = payload.as_object_mut() {
                object.insert("host_cwd".to_string(), Value::String(cwd));
            }
        }
        send_transport_frame(&sender, payload)?;

        if view == "delta" {
            self.store_delivered_capture(session_id, &current_capture, start_line)
                .await;
        }

        info!(
            request_id = request_id,
            session_id = session_id,
            view = view,
            wait_for = wait_for,
            lines = lines,
            start_line = ?start_line,
            readiness_wait_ms = readiness_wait_ms,
            capture_ms = capture_ms,
            reused_wait_capture = reused_wait_capture,
            output_bytes = output_bytes,
            lines_captured = lines_captured,
            delta_changed = changed,
            delta_truncated = truncated,
            delta_strategy = delta_strategy,
            capture_hash = format!("{:016x}", capture_summary.hash),
            capture_line_count = capture_summary.line_count,
            last_non_empty_line = %capture_summary.last_non_empty_line,
            preview_head = ?capture_summary.preview_head.as_deref(),
            preview_tail = ?capture_summary.preview_tail.as_deref(),
            "terminal_observe_result sent"
        );

        Ok(())
    }

    async fn send_observe_error(&self, frame: &TerminalObserveFrame, error: &str) -> Result<()> {
        let Some(sender) = self.sender().await else {
            warn!(
                request_id = %frame.request_id,
                error = error,
                "terminal_observe error but no sender"
            );
            return Ok(());
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_observe_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": frame.session_id,
            "request_id": frame.request_id,
            "view": frame.view.as_deref().unwrap_or("delta"),
            "output": "",
            "output_bytes": 0,
            "lines_captured": 0,
            "changed": Value::Null,
            "truncated": Value::Null,
            "readiness": json!({
                "ready": false,
                "confidence": 0.0,
                "trigger": "error",
                "hints": {
                    "looks_like_prompt": false,
                    "looks_like_confirmation": false,
                    "looks_like_password": false,
                    "looks_like_pager": false,
                    "looks_like_error": true,
                    "may_still_be_processing": false
                }
            }),
            "error": error,
        });
        send_transport_frame(&sender, payload)?;
        Ok(())
    }
}

fn start_line_for_observe_view(view: &str, lines: i32) -> Option<i32> {
    match view {
        "screen" => None,
        "delta" | "history" => Some(lines),
        _ => Some(lines),
    }
}

fn parse_observe_view(view: &str) -> Result<&str> {
    match view {
        "delta" | "screen" | "history" => Ok(view),
        _ => anyhow::bail!("unsupported_view"),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use crate::protocol::TerminalObserveFrame;
    use crate::terminal::test_support::{
        decode_base64_field, envelope, install_test_session, recv_json, store_delivered_capture,
        test_manager_with_sender,
    };

    #[tokio::test]
    async fn handle_observe_delta_uses_delivered_capture_baseline() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        store_delivered_capture(&manager, "sess_1", "before\nprompt$ ", Some(-50)).await;
        backend.push_capture("s_1", Some(-50), "before\nafter\nprompt$ ");

        let frame = TerminalObserveFrame {
            envelope: envelope("terminal_observe"),
            session_id: "sess_1".to_string(),
            request_id: "req_1".to_string(),
            view: None,
            lines: None,
            wait_for: Some("none".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_observe(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("type").and_then(Value::as_str),
            Some("terminal_observe_result")
        );
        assert_eq!(
            decode_base64_field(&payload, "output").as_deref(),
            Some("after")
        );
        assert_eq!(payload.get("changed").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("host_cwd").and_then(Value::as_str),
            Some("/tmp")
        );
    }

    #[tokio::test]
    async fn handle_observe_settled_weak_capture_does_not_force_ready() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "adam@mac bud % ");
        backend.push_capture("s_1", Some(-50), "adam@mac bud % codex \"What is latest?\"");

        let frame = TerminalObserveFrame {
            envelope: envelope("terminal_observe"),
            session_id: "sess_1".to_string(),
            request_id: "req_settled_observe".to_string(),
            view: Some("delta".to_string()),
            lines: Some(-50),
            wait_for: Some("settled".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_observe(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        let readiness = payload.get("readiness").expect("readiness");
        assert_eq!(
            readiness.get("trigger").and_then(Value::as_str),
            Some("settled")
        );
        assert_eq!(readiness.get("ready").and_then(Value::as_bool), Some(false));
        assert_eq!(
            readiness
                .get("hints")
                .and_then(|value| value.get("may_still_be_processing"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn handle_observe_delta_rejects_shell_ready_wait() {
        let (manager, _backend, mut rx) = test_manager_with_sender().await;

        let frame = TerminalObserveFrame {
            envelope: envelope("terminal_observe"),
            session_id: "sess_1".to_string(),
            request_id: "req_shell_ready_delta".to_string(),
            view: Some("delta".to_string()),
            lines: Some(-50),
            wait_for: Some("shell_ready".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_observe(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("type").and_then(Value::as_str),
            Some("terminal_observe_result")
        );
        assert_eq!(
            payload.get("error").and_then(Value::as_str),
            Some("unsupported_wait_for")
        );
    }
}
