use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use tokio::time;
use tracing::{info, warn};

use crate::protocol::{TerminalInputFrame, TerminalSendFrame, TERMINAL_PROTO_VERSION};
use crate::transport::send_transport_frame;
use crate::util::{new_message_id, now_millis};

use super::backend::TerminalBackend;
use super::delta::{build_additive_delta_payload, build_delta_payload_json};
use super::readiness::{assess_capture_readiness, ActivityDetector, ReadinessDetector};
use super::{
    TerminalManager, DEFAULT_DELTA_CAPTURE_START_LINE, TERMINAL_SEND_POST_DISPATCH_GUARD_MS,
    TMUX_TEXT_TO_ENTER_DELAY_MS,
};

impl<B> TerminalManager<B>
where
    B: TerminalBackend,
{
    pub async fn handle_input(&self, frame: TerminalInputFrame) -> Result<()> {
        if !self.config.enabled {
            return Ok(());
        }

        let session_id = &frame.session_id;
        let data = BASE64_STANDARD
            .decode(frame.data.as_bytes())
            .map_err(|err| anyhow!("invalid terminal input data: {}", err))?;

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            warn!(
                message_id = %frame.envelope.id,
                session_id = session_id,
                "terminal_input dropped; no session"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            bytes = data.len(),
            session = %handle.session_name,
            start_offset = start_offset,
            "terminal_input received"
        );
        let input = String::from_utf8_lossy(&data).to_string();
        let (trimmed_end, newline_count) = split_low_level_input(&input);

        if !trimmed_end.is_empty() {
            if let Err(err) = self
                .backend
                .send_literal_text(&handle.session_name, &trimmed_end)
                .await
            {
                warn!(message_id = %frame.envelope.id, error = %err, "tmux send-keys (text) failed");
            }
        }

        if !trimmed_end.is_empty() && newline_count > 0 {
            time::sleep(std::time::Duration::from_millis(
                TMUX_TEXT_TO_ENTER_DELAY_MS,
            ))
            .await;
        }
        for _ in 0..newline_count {
            if let Err(err) = self.backend.send_key(&handle.session_name, "Enter").await {
                warn!(message_id = %frame.envelope.id, error = %err, "tmux send-keys (Enter) failed");
            }
        }

        info!(
            message_id = %frame.envelope.id,
            session_id = session_id,
            bytes = input.len(),
            text_bytes = trimmed_end.len(),
            enter_count = newline_count,
            session = %handle.session_name,
            "tmux send-keys succeeded"
        );

        if frame
            .await_ready
            .as_ref()
            .map(|await_ready| await_ready.enabled)
            .unwrap_or(false)
        {
            if let Some(sender) = self.sender().await {
                let await_ready = frame.await_ready.clone().unwrap_or_default();
                let session_id_owned = session_id.clone();

                if await_ready.activity_based {
                    info!(
                        message_id = %frame.envelope.id,
                        session_id = session_id,
                        session = %handle.session_name,
                        "using activity-based readiness detection"
                    );
                    let detector = ActivityDetector::new(
                        session_id_owned,
                        handle.clone(),
                        sender,
                        self.backend.clone(),
                        &await_ready,
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "activity detection failed");
                        }
                    });
                } else {
                    let detector = ReadinessDetector::new(
                        session_id_owned,
                        handle.clone(),
                        sender,
                        start_offset,
                        frame.await_ready.clone(),
                    );
                    tokio::spawn(async move {
                        if let Err(err) = detector.run().await {
                            warn!(error = %err, "readiness detection failed");
                        }
                    });
                }
            }
        }
        Ok(())
    }

    pub async fn handle_send(&self, frame: TerminalSendFrame) -> Result<()> {
        if !self.config.enabled {
            return self.send_send_error(&frame, "terminal_disabled").await;
        }

        let session_id = &frame.session_id;
        let request_id = &frame.request_id;
        let wait_for = frame.wait_for.as_deref().unwrap_or("settled");
        let timeout_ms = frame.timeout_ms.unwrap_or(30_000);
        let observe_after_ms = frame.observe_after_ms.unwrap_or(1000);
        let submit = frame.submit.unwrap_or(false);
        let text = frame.text.as_deref();
        let legacy_keys = frame.keys.as_deref().unwrap_or(&[]);
        let key = if frame.key.is_some() && !legacy_keys.is_empty() {
            return self.send_send_error(&frame, "ambiguous_interaction").await;
        } else if let Some(key) = frame.key.as_deref() {
            (!key.trim().is_empty()).then_some(key)
        } else {
            match legacy_keys {
                [] => None,
                [key] => (!key.trim().is_empty()).then_some(key.as_str()),
                _ => {
                    return self
                        .send_send_error(&frame, "multiple_keys_unsupported")
                        .await
                }
            }
        };

        if submit && text.is_none() {
            return self.send_send_error(&frame, "submit_requires_text").await;
        }

        if key.is_some() && (text.is_some() || submit) {
            return self.send_send_error(&frame, "ambiguous_interaction").await;
        }

        let has_text = text.map(|value| !value.is_empty()).unwrap_or(false);
        if !has_text && !submit && key.is_none() {
            return self.send_send_error(&frame, "empty_interaction").await;
        }

        let handle = self.ensure_handle_for_session(session_id, None).await?;
        let Some(handle) = handle else {
            return self.send_send_error(&frame, "session_not_found").await;
        };

        let Some(sender) = self.sender().await else {
            warn!(
                request_id = request_id,
                session_id = session_id,
                "terminal_send dropped; no sender"
            );
            return Ok(());
        };

        let start_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        let delta_start_line = Some(DEFAULT_DELTA_CAPTURE_START_LINE);
        let baseline_capture = match self
            .capture_screen_state(&handle.session_name, delta_start_line, 0)
            .await
        {
            Ok(capture) => Some(capture),
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_send baseline capture failed"
                );
                None
            }
        };

        let submitted = match self
            .dispatch_interaction_to_backend(&handle, text, submit, key)
            .await
        {
            Ok(submitted) => submitted,
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_send dispatch failed"
                );
                return self.send_send_error(&frame, "send_keys_failed").await;
            }
        };
        let (
            delta,
            readiness,
            current_capture,
            current_summary,
            captured_after_ms,
            quiescence_wait,
        ) = match wait_for {
            "none" => {
                if observe_after_ms > 0 {
                    time::sleep(std::time::Duration::from_millis(observe_after_ms)).await;
                }

                match self
                    .capture_screen_state(&handle.session_name, delta_start_line, observe_after_ms)
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        let readiness = assess_capture_readiness(&current.capture);
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            None,
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send post-send capture failed"
                        );
                        (
                            None,
                            self.resolve_readiness_after_interaction(
                                &handle,
                                request_id,
                                wait_for,
                                timeout_ms,
                                start_offset,
                            )
                            .await?,
                            None,
                            None,
                            None,
                            None,
                        )
                    }
                }
            }
            "shell_ready" => {
                let shell_wait_start = std::time::Instant::now();
                let readiness = self
                    .resolve_readiness_after_interaction(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        start_offset,
                    )
                    .await?;
                let captured_after_ms = shell_wait_start.elapsed().as_millis() as u64;
                match self
                    .capture_screen_state(&handle.session_name, delta_start_line, captured_after_ms)
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            None,
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send final capture after shell_ready failed"
                        );
                        (None, readiness, None, None, None, None)
                    }
                }
            }
            "changed" => {
                let wait_result = self
                    .wait_for_screen_state(
                        &handle,
                        request_id,
                        wait_for,
                        timeout_ms,
                        baseline_capture
                            .as_ref()
                            .map(|state| state.capture.as_str()),
                        delta_start_line,
                    )
                    .await?;
                let delta = build_additive_delta_payload(
                    baseline_capture
                        .as_ref()
                        .map(|state| state.capture.as_str()),
                    &wait_result.capture,
                );

                (
                    Some(delta),
                    wait_result.assessment,
                    Some(wait_result.capture),
                    Some(wait_result.summary),
                    Some(wait_result.captured_after_ms),
                    None,
                )
            }
            "settled" | "screen_stable" => {
                if TERMINAL_SEND_POST_DISPATCH_GUARD_MS > 0 {
                    time::sleep(std::time::Duration::from_millis(
                        TERMINAL_SEND_POST_DISPATCH_GUARD_MS,
                    ))
                    .await;
                }
                let quiescence_started_at = now_millis();
                let quiescence_start_offset =
                    handle.offset.load(std::sync::atomic::Ordering::SeqCst);
                let quiescence = self
                    .wait_for_output_quiescence(
                        &handle,
                        request_id,
                        timeout_ms,
                        quiescence_started_at,
                        quiescence_start_offset,
                    )
                    .await?;

                match self
                    .capture_screen_state(
                        &handle.session_name,
                        delta_start_line,
                        quiescence.elapsed_ms,
                    )
                    .await
                {
                    Ok(current) => {
                        let delta = build_additive_delta_payload(
                            baseline_capture
                                .as_ref()
                                .map(|state| state.capture.as_str()),
                            &current.capture,
                        );
                        let readiness =
                            self.build_quiescence_assessment(&current.capture, &quiescence);
                        (
                            Some(delta),
                            readiness,
                            Some(current.capture),
                            Some(current.summary),
                            Some(current.captured_after_ms),
                            Some(quiescence),
                        )
                    }
                    Err(err) => {
                        warn!(
                            request_id = request_id,
                            session_id = session_id,
                            error = %err,
                            "terminal_send final capture after output quiescence failed"
                        );
                        let readiness = self.build_quiescence_assessment("", &quiescence);
                        (None, readiness, None, None, None, Some(quiescence))
                    }
                }
            }
            _ => return self.send_send_error(&frame, "unsupported_wait_for").await,
        };

        if let Some(current_capture) = current_capture.as_deref() {
            self.store_delivered_capture(session_id, current_capture, delta_start_line)
                .await;
        }

        let host_cwd = match self.backend.pane_cwd(&handle.session_name).await {
            Ok(cwd) => Some(cwd),
            Err(err) => {
                warn!(
                    request_id = request_id,
                    session_id = session_id,
                    error = %err,
                    "terminal_send pane cwd query failed"
                );
                None
            }
        };

        let mut payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_send_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": session_id,
            "request_id": request_id,
            "submitted": submitted,
            "delta": delta
                .as_ref()
                .map(build_delta_payload_json)
                .unwrap_or(Value::Null),
            "readiness": readiness,
            "error": Value::Null,
        });
        if let Some(cwd) = host_cwd {
            if let Some(object) = payload.as_object_mut() {
                object.insert("host_cwd".to_string(), Value::String(cwd));
            }
        }
        send_transport_frame(&sender, payload)?;

        info!(
            request_id = request_id,
            session_id = session_id,
            wait_for = wait_for,
            observe_after_ms = observe_after_ms,
            submitted = submitted,
            has_key = key.is_some(),
            has_text = text.is_some(),
            delta_changed = ?delta.as_ref().map(|value| value.changed),
            delta_truncated = ?delta.as_ref().map(|value| value.truncated),
            delta_strategy = ?delta.as_ref().map(|value| value.strategy),
            delta_text_bytes = ?delta.as_ref().map(|value| value.text.as_bytes().len()),
            captured_after_ms = ?captured_after_ms,
            quiescence_trigger = ?quiescence_wait.as_ref().map(|value| value.trigger),
            quiescence_output_seen = ?quiescence_wait.as_ref().map(|value| value.output_seen),
            quiescence_checks = ?quiescence_wait.as_ref().map(|value| value.check_count),
            quiescence_stable_checks = ?quiescence_wait.as_ref().map(|value| value.stable_checks),
            quiescence_quiet_for_ms = ?quiescence_wait.as_ref().map(|value| value.quiet_for_ms),
            quiescence_latest_offset = ?quiescence_wait.as_ref().map(|value| value.latest_offset),
            quiescence_last_output_seq = ?quiescence_wait.as_ref().map(|value| value.last_output_seq),
            post_dispatch_guard_ms = if matches!(wait_for, "settled" | "screen_stable") {
                Some(TERMINAL_SEND_POST_DISPATCH_GUARD_MS)
            } else {
                None
            },
            capture_hash = ?current_summary
                .as_ref()
                .map(|summary| format!("{:016x}", summary.hash)),
            capture_line_count = ?current_summary.as_ref().map(|summary| summary.line_count),
            last_non_empty_line = current_summary
                .as_ref()
                .map(|summary| summary.last_non_empty_line.as_str())
                .unwrap_or(""),
            preview_head = ?current_summary
                .as_ref()
                .and_then(|summary| summary.preview_head.as_deref()),
            preview_tail = ?current_summary
                .as_ref()
                .and_then(|summary| summary.preview_tail.as_deref()),
            "terminal_send_result sent"
        );

        Ok(())
    }

    async fn send_send_error(&self, frame: &TerminalSendFrame, error: &str) -> Result<()> {
        let Some(sender) = self.sender().await else {
            warn!(
                request_id = %frame.request_id,
                error = error,
                "terminal_send error but no sender"
            );
            return Ok(());
        };

        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_send_result",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": frame.session_id,
            "request_id": frame.request_id,
            "submitted": false,
            "delta": Value::Null,
            "readiness": Self::error_readiness(),
            "error": error,
        });
        send_transport_frame(&sender, payload)?;
        Ok(())
    }

    fn error_readiness() -> Value {
        json!({
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
        })
    }

    async fn dispatch_interaction_to_backend(
        &self,
        handle: &std::sync::Arc<super::TerminalHandle>,
        text: Option<&str>,
        submit: bool,
        key: Option<&str>,
    ) -> Result<bool> {
        let mut submitted = false;

        if let Some(text) = text {
            submitted |= self
                .send_text_payload_to_backend(&handle.session_name, text, submit)
                .await?;
        }

        if let Some(key) = key {
            submitted |= self.send_interaction_key(&handle.session_name, key).await?;
        }

        Ok(submitted)
    }

    async fn send_text_payload_to_backend(
        &self,
        session_name: &str,
        text: &str,
        submit: bool,
    ) -> Result<bool> {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let segments: Vec<&str> = normalized.split('\n').collect();
        let mut submitted = false;
        let mut sent_literal_text = false;

        for (index, segment) in segments.iter().enumerate() {
            if !segment.is_empty() {
                self.backend
                    .send_literal_text(session_name, segment)
                    .await?;
                submitted = true;
                sent_literal_text = true;
            }

            let should_press_enter =
                index + 1 < segments.len() || (submit && index + 1 == segments.len());
            if should_press_enter {
                if sent_literal_text {
                    time::sleep(std::time::Duration::from_millis(
                        TMUX_TEXT_TO_ENTER_DELAY_MS,
                    ))
                    .await;
                    sent_literal_text = false;
                }
                self.backend.send_key(session_name, "Enter").await?;
                submitted = true;
            }
        }

        if normalized.is_empty() && submit {
            self.backend.send_key(session_name, "Enter").await?;
            submitted = true;
        }

        Ok(submitted)
    }

    async fn send_interaction_key(&self, session_name: &str, key: &str) -> Result<bool> {
        if let Some(tmux_key) = normalize_tmux_key_notation(key) {
            self.backend.send_key(session_name, &tmux_key).await?;
            return Ok(true);
        }

        let normalized = key.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Ok(false);
        }

        match normalized.as_str() {
            "enter" | "return" => {
                self.backend.send_key(session_name, "Enter").await?;
                Ok(true)
            }
            "space" | "spacebar" => {
                self.backend.send_literal_text(session_name, " ").await?;
                Ok(true)
            }
            "tab" => {
                self.backend.send_key(session_name, "Tab").await?;
                Ok(true)
            }
            "escape" | "esc" => {
                self.backend.send_key(session_name, "Escape").await?;
                Ok(true)
            }
            "up" | "arrowup" => {
                self.backend.send_key(session_name, "Up").await?;
                Ok(true)
            }
            "down" | "arrowdown" => {
                self.backend.send_key(session_name, "Down").await?;
                Ok(true)
            }
            "left" | "arrowleft" => {
                self.backend.send_key(session_name, "Left").await?;
                Ok(true)
            }
            "right" | "arrowright" => {
                self.backend.send_key(session_name, "Right").await?;
                Ok(true)
            }
            "backspace" => {
                self.backend.send_key(session_name, "BSpace").await?;
                Ok(true)
            }
            "delete" => {
                self.backend.send_key(session_name, "DC").await?;
                Ok(true)
            }
            "home" => {
                self.backend.send_key(session_name, "Home").await?;
                Ok(true)
            }
            "end" => {
                self.backend.send_key(session_name, "End").await?;
                Ok(true)
            }
            "pageup" => {
                self.backend.send_key(session_name, "PageUp").await?;
                Ok(true)
            }
            "pagedown" => {
                self.backend.send_key(session_name, "PageDown").await?;
                Ok(true)
            }
            _ if key.chars().count() == 1 => {
                self.backend.send_literal_text(session_name, key).await?;
                Ok(true)
            }
            _ => bail!("unsupported interaction key: {key}"),
        }
    }
}

fn normalize_tmux_key_notation(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower
        .strip_prefix("ctrl+")
        .or_else(|| lower.strip_prefix("ctrl-"))
        .or_else(|| lower.strip_prefix("control+"))
        .or_else(|| lower.strip_prefix("control-"))
    {
        if !rest.is_empty() {
            return Some(format!("C-{}", rest));
        }
    }

    if let Some(rest) = trimmed
        .strip_prefix("C-")
        .or_else(|| trimmed.strip_prefix("c-"))
    {
        if !rest.is_empty() {
            return Some(format!("C-{}", rest.to_ascii_lowercase()));
        }
    }

    None
}

fn split_low_level_input(input: &str) -> (String, usize) {
    let mut end = input.len();
    let mut newline_count = 0;

    while end > 0 {
        if input[..end].ends_with("\r\n") {
            end -= 2;
            newline_count += 1;
        } else if input[..end].ends_with('\n') || input[..end].ends_with('\r') {
            end -= 1;
            newline_count += 1;
        } else {
            break;
        }
    }

    (input[..end].to_string(), newline_count)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{normalize_tmux_key_notation, split_low_level_input};
    use crate::protocol::TerminalSendFrame;
    use crate::terminal::test_support::{
        decode_base64_field, envelope, install_test_session, recv_json, test_manager_with_sender,
    };

    #[test]
    fn normalize_tmux_key_notation_prefers_tmux_style_ctrl_chords() {
        assert_eq!(normalize_tmux_key_notation("C-c").as_deref(), Some("C-c"));
        assert_eq!(normalize_tmux_key_notation("c-D").as_deref(), Some("C-d"));
    }

    #[test]
    fn normalize_tmux_key_notation_accepts_ctrl_aliases() {
        assert_eq!(
            normalize_tmux_key_notation("ctrl+c").as_deref(),
            Some("C-c")
        );
        assert_eq!(
            normalize_tmux_key_notation("control-d").as_deref(),
            Some("C-d")
        );
    }

    #[test]
    fn split_low_level_input_treats_crlf_as_single_enter() {
        let (text, enters) = split_low_level_input("hello\r\n");
        assert_eq!(text, "hello");
        assert_eq!(enters, 1);
    }

    #[test]
    fn split_low_level_input_counts_multiple_trailing_linebreak_sequences() {
        let (text, enters) = split_low_level_input("hello\r\n\n\r");
        assert_eq!(text, "hello");
        assert_eq!(enters, 3);
    }

    #[tokio::test]
    async fn handle_send_wait_none_uses_fake_backend_and_returns_delta() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "prompt$ ");
        backend.push_capture("s_1", Some(-50), "prompt$ echo hi\nhi\nprompt$ ");

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_1".to_string(),
            text: Some("echo hi".to_string()),
            submit: Some(true),
            key: None,
            keys: Some(Vec::new()),
            observe_after_ms: Some(0),
            wait_for: Some("none".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_send(frame).await.unwrap();

        assert_eq!(
            backend.operations(),
            vec!["text:s_1:echo hi", "key:s_1:Enter"]
        );

        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("type").and_then(Value::as_str),
            Some("terminal_send_result")
        );
        assert_eq!(
            payload.get("submitted").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            payload.get("host_cwd").and_then(Value::as_str),
            Some("/tmp")
        );
        let delta = payload
            .get("delta")
            .and_then(Value::as_object)
            .expect("delta");
        let text = delta
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(text.contains("hi"));
        assert_eq!(
            payload
                .get("readiness")
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str),
            None
        );
        assert_eq!(decode_base64_field(&payload, "output").as_deref(), None);
    }

    #[tokio::test]
    async fn handle_send_accepts_canonical_single_key() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "prompt$ ");
        backend.push_capture("s_1", Some(-50), "prompt$ ^C\nprompt$ ");

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_key".to_string(),
            text: None,
            submit: None,
            key: Some("ctrl+c".to_string()),
            keys: None,
            observe_after_ms: Some(0),
            wait_for: Some("none".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_send(frame).await.unwrap();

        assert_eq!(backend.operations(), vec!["key:s_1:C-c"]);
        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("submitted").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn handle_send_settled_preserves_echo_but_keeps_weak_capture_conservative() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "adam@mac bud % ");
        backend.push_capture("s_1", Some(-50), "adam@mac bud % codex \"What is latest?\"");

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_settled_weak".to_string(),
            text: Some("codex \"What is latest?\"".to_string()),
            submit: Some(true),
            key: None,
            keys: None,
            observe_after_ms: None,
            wait_for: Some("settled".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_send(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        let delta = payload
            .get("delta")
            .and_then(Value::as_object)
            .expect("delta");
        let text = delta
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(text.contains("codex \"What is latest?\""));

        let readiness = payload.get("readiness").expect("readiness");
        assert_eq!(
            readiness.get("trigger").and_then(Value::as_str),
            Some("settled")
        );
        assert_eq!(readiness.get("ready").and_then(Value::as_bool), Some(false));
        assert!(
            readiness
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                <= 0.55
        );
        assert_eq!(
            readiness
                .get("hints")
                .and_then(|value| value.get("may_still_be_processing"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[tokio::test]
    async fn handle_send_settled_preserves_prompt_readiness() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "adam@mac bud % ");
        backend.push_capture(
            "s_1",
            Some(-50),
            "adam@mac bud % pwd\n/Users/adam/bud\nadam@mac bud % ",
        );

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_settled_prompt".to_string(),
            text: Some("pwd".to_string()),
            submit: Some(true),
            key: None,
            keys: None,
            observe_after_ms: None,
            wait_for: Some("settled".to_string()),
            timeout_ms: Some(1_000),
        };

        manager.handle_send(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        let readiness = payload.get("readiness").expect("readiness");
        assert_eq!(
            readiness.get("trigger").and_then(Value::as_str),
            Some("settled")
        );
        assert_eq!(readiness.get("ready").and_then(Value::as_bool), Some(true));
        assert!(
            readiness
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                >= 0.8
        );
    }

    #[tokio::test]
    async fn handle_send_settled_timeout_returns_latest_delta_conservatively() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;
        install_test_session(&manager, &backend, "sess_1", "s_1").await;
        backend.push_capture("s_1", Some(-50), "adam@mac bud % ");
        backend.push_capture("s_1", Some(-50), "adam@mac bud % long-task\nstill working");

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_settled_timeout".to_string(),
            text: Some("long-task".to_string()),
            submit: Some(true),
            key: None,
            keys: None,
            observe_after_ms: None,
            wait_for: Some("settled".to_string()),
            timeout_ms: Some(1),
        };

        manager.handle_send(frame).await.unwrap();

        let payload = recv_json(&mut rx).await;
        let delta = payload
            .get("delta")
            .and_then(Value::as_object)
            .expect("delta");
        let text = delta
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(text.contains("still working"));

        let readiness = payload.get("readiness").expect("readiness");
        assert_eq!(
            readiness.get("trigger").and_then(Value::as_str),
            Some("timeout")
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
    async fn handle_send_rejects_mixed_text_and_key() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_invalid".to_string(),
            text: Some("echo hi".to_string()),
            submit: Some(true),
            key: Some("ctrl+c".to_string()),
            keys: None,
            observe_after_ms: None,
            wait_for: None,
            timeout_ms: None,
        };

        manager.handle_send(frame).await.unwrap();

        assert!(backend.operations().is_empty());
        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("error").and_then(Value::as_str),
            Some("ambiguous_interaction")
        );
        assert_eq!(
            payload.get("submitted").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[tokio::test]
    async fn handle_send_rejects_multiple_legacy_keys() {
        let (manager, backend, mut rx) = test_manager_with_sender().await;

        let frame = TerminalSendFrame {
            envelope: envelope("terminal_send"),
            session_id: "sess_1".to_string(),
            request_id: "req_multi".to_string(),
            text: None,
            submit: None,
            key: None,
            keys: Some(vec!["ctrl+c".to_string(), "enter".to_string()]),
            observe_after_ms: None,
            wait_for: None,
            timeout_ms: None,
        };

        manager.handle_send(frame).await.unwrap();

        assert!(backend.operations().is_empty());
        let payload = recv_json(&mut rx).await;
        assert_eq!(
            payload.get("error").and_then(Value::as_str),
            Some("multiple_keys_unsupported")
        );
    }
}
