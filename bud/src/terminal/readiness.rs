use std::io::SeekFrom;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde_json::{json, Map, Number, Value};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::time;
use tracing::{info, warn};

use crate::protocol::{AwaitReady, TERMINAL_PROTO_VERSION};
use crate::util::{new_message_id, now_millis, send_ws_frame, OutboundSender};

use super::backend::TerminalBackend;
use super::delta::{simple_hash, summarize_capture_for_log};
use super::{
    OutputQuiescenceWaitResult, ScreenCaptureState, ScreenWaitMode, ScreenWaitResult,
    TerminalHandle, TerminalManager, ACTIVITY_DEFAULT_INITIAL_DELAY_MS,
    ACTIVITY_DEFAULT_INTERVAL_MS, ACTIVITY_DEFAULT_MAX_WAIT_MS, ACTIVITY_DEFAULT_STABLE_COUNT,
    OUTPUT_QUIESCENCE_POLL_INTERVAL_MS, OUTPUT_QUIESCENCE_QUIET_MS,
    OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES, SCREEN_WAIT_POLL_INTERVAL_MS,
    SCREEN_WAIT_SETTLED_QUIET_MS,
};

pub(super) struct ReadinessDetector {
    session_id: String,
    handle: std::sync::Arc<TerminalHandle>,
    sender: OutboundSender,
    start_offset: u64,
    await_ready: Option<AwaitReady>,
}

pub(super) struct ActivityDetector<B>
where
    B: TerminalBackend,
{
    session_id: String,
    handle: std::sync::Arc<TerminalHandle>,
    sender: OutboundSender,
    backend: B,
    initial_delay_ms: u64,
    interval_ms: u64,
    stable_count_required: u32,
    max_wait_ms: u64,
}

impl<B> TerminalManager<B>
where
    B: TerminalBackend,
{
    pub(super) async fn resolve_readiness_after_interaction(
        &self,
        handle: &std::sync::Arc<TerminalHandle>,
        request_id: &str,
        wait_for: &str,
        timeout_ms: u64,
        start_offset: u64,
    ) -> Result<Value> {
        info!(
            request_id = request_id,
            session_id = %handle.session_id,
            session = %handle.session_name,
            wait_for = wait_for,
            timeout_ms = timeout_ms,
            start_offset = start_offset,
            "resolving readiness after interaction"
        );

        let wait_start = Instant::now();
        let assessment = match wait_for {
            "shell_ready" => {
                let (assessment, _, _, _) = self
                    .wait_quiescence_and_read(handle, start_offset, timeout_ms)
                    .await?;
                assessment
            }
            "changed" => {
                self.wait_for_screen_state(handle, request_id, wait_for, timeout_ms, None, None)
                    .await?
                    .assessment
            }
            "settled" | "screen_stable" => {
                let (assessment, _, _, _) = self
                    .wait_activity_and_capture(handle, request_id, timeout_ms)
                    .await?;
                assessment
            }
            "none" => {
                let capture = self.capture(&handle.session_name).await?;
                assess_capture_readiness(&capture)
            }
            _ => bail!("unsupported wait_for mode: {wait_for}"),
        };

        info!(
            request_id = request_id,
            session_id = %handle.session_id,
            session = %handle.session_name,
            wait_for = wait_for,
            elapsed_ms = wait_start.elapsed().as_millis() as u64,
            readiness_trigger = assessment
                .get("trigger")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown"),
            readiness_confidence = assessment
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0),
            "readiness resolution complete"
        );

        Ok(assessment)
    }

    pub(super) async fn wait_quiescence_and_read(
        &self,
        handle: &std::sync::Arc<TerminalHandle>,
        start_offset: u64,
        timeout_ms: u64,
    ) -> Result<(Value, Vec<u8>, usize, bool)> {
        const MAX_OUTPUT: usize = 64 * 1024;
        let quiescence_ms = 1500;
        let start = Instant::now();
        let mut last_change = Instant::now();
        let mut last_size = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        let log_path = handle.log_path.clone();

        loop {
            let size = match fs::metadata(&log_path).await {
                Ok(meta) => meta.len(),
                Err(_) => {
                    time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if size != last_size {
                last_change = Instant::now();
                last_size = size;
            }
            if last_change.elapsed() >= Duration::from_millis(quiescence_ms)
                || start.elapsed() >= Duration::from_millis(timeout_ms)
            {
                break;
            }
            time::sleep(Duration::from_millis(50)).await;
        }

        let end_size = fs::metadata(&log_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(last_size);

        let (output, truncated) =
            read_log_range(&log_path, start_offset, end_size, MAX_OUTPUT).await;
        let output_bytes = output.len();
        let text = String::from_utf8_lossy(&output).to_string();
        let last_line = text.lines().last().unwrap_or("").to_string();
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let elapsed_ms = start.elapsed().as_millis() as u64;

        let assessment = ReadinessDetector::assess(&text, &last_line, quiet_for_ms, elapsed_ms);

        Ok((assessment, output, output_bytes, truncated))
    }

    pub(super) async fn wait_activity_and_capture(
        &self,
        handle: &std::sync::Arc<TerminalHandle>,
        request_id: &str,
        timeout_ms: u64,
    ) -> Result<(Value, Vec<u8>, usize, bool)> {
        let wait_result = self
            .wait_for_screen_state(handle, request_id, "settled", timeout_ms, None, None)
            .await?;
        let output = wait_result.capture.into_bytes();
        let output_bytes = output.len();
        Ok((wait_result.assessment, output, output_bytes, false))
    }

    pub(super) async fn wait_for_output_quiescence(
        &self,
        handle: &std::sync::Arc<TerminalHandle>,
        request_id: &str,
        timeout_ms: u64,
        started_at_ms: u64,
        start_offset: u64,
    ) -> Result<OutputQuiescenceWaitResult> {
        let started_at = Instant::now();
        let mut previous_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        let mut check_count: u32 = 0;
        let mut stable_checks: u32 = 0;

        if self.config.debug_enabled {
            info!(
                request_id = request_id,
                session_id = %handle.session_id,
                session = %handle.session_name,
                timeout_ms = timeout_ms,
                poll_interval_ms = OUTPUT_QUIESCENCE_POLL_INTERVAL_MS,
                required_stable_samples = OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES,
                quiet_ms = OUTPUT_QUIESCENCE_QUIET_MS,
                start_offset = start_offset,
                "output quiescence wait started"
            );
        }

        loop {
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            let current_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
            let output_seen = current_offset > start_offset;
            let last_output_at = handle
                .last_output_at
                .load(std::sync::atomic::Ordering::SeqCst);
            let quiet_reference_ms = if output_seen || last_output_at > started_at_ms {
                last_output_at.max(started_at_ms)
            } else {
                started_at_ms
            };
            let quiet_for_ms = now_millis().saturating_sub(quiet_reference_ms);
            let last_output_seq = handle
                .last_output_seq
                .load(std::sync::atomic::Ordering::SeqCst);

            if elapsed_ms >= timeout_ms {
                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        output_seen = output_seen,
                        latest_offset = current_offset,
                        last_output_seq = last_output_seq,
                        "output quiescence wait timed out"
                    );
                }

                return Ok(OutputQuiescenceWaitResult {
                    trigger: "timeout",
                    quiet_for_ms,
                    elapsed_ms,
                    check_count,
                    stable_checks,
                    output_seen,
                    latest_offset: current_offset,
                    last_output_seq,
                });
            }

            let sleep_ms =
                OUTPUT_QUIESCENCE_POLL_INTERVAL_MS.min(timeout_ms.saturating_sub(elapsed_ms));
            if sleep_ms > 0 {
                time::sleep(Duration::from_millis(sleep_ms)).await;
            }

            let current_offset = handle.offset.load(std::sync::atomic::Ordering::SeqCst);
            check_count += 1;
            if current_offset == previous_offset {
                stable_checks += 1;
            } else {
                stable_checks = 0;
                previous_offset = current_offset;
            }

            let output_seen = current_offset > start_offset;
            let last_output_at = handle
                .last_output_at
                .load(std::sync::atomic::Ordering::SeqCst);
            let quiet_reference_ms = if output_seen || last_output_at > started_at_ms {
                last_output_at.max(started_at_ms)
            } else {
                started_at_ms
            };
            let quiet_for_ms = now_millis().saturating_sub(quiet_reference_ms);
            let last_output_seq = handle
                .last_output_seq
                .load(std::sync::atomic::Ordering::SeqCst);
            let elapsed_ms = started_at.elapsed().as_millis() as u64;

            if self.config.debug_enabled {
                info!(
                    request_id = request_id,
                    session_id = %handle.session_id,
                    session = %handle.session_name,
                    check_count = check_count,
                    stable_checks = stable_checks,
                    quiet_for_ms = quiet_for_ms,
                    output_seen = output_seen,
                    latest_offset = current_offset,
                    last_output_seq = last_output_seq,
                    "output quiescence wait check"
                );
            }

            if stable_checks >= OUTPUT_QUIESCENCE_REQUIRED_STABLE_SAMPLES
                && quiet_for_ms >= OUTPUT_QUIESCENCE_QUIET_MS
            {
                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        output_seen = output_seen,
                        latest_offset = current_offset,
                        last_output_seq = last_output_seq,
                        "output quiescence wait settled"
                    );
                }

                return Ok(OutputQuiescenceWaitResult {
                    trigger: "settled",
                    quiet_for_ms,
                    elapsed_ms,
                    check_count,
                    stable_checks,
                    output_seen,
                    latest_offset: current_offset,
                    last_output_seq,
                });
            }
        }
    }

    pub(super) fn build_quiescence_assessment(
        &self,
        capture: &str,
        quiescence: &OutputQuiescenceWaitResult,
    ) -> Value {
        match quiescence.trigger {
            "settled" => build_screen_wait_assessment(
                capture,
                "settled",
                quiescence.quiet_for_ms,
                quiescence.check_count,
                quiescence.stable_checks,
                Some(false),
                None,
                Some(0.85),
                Some(true),
            ),
            "timeout" => build_screen_wait_assessment(
                capture,
                "timeout",
                quiescence.quiet_for_ms,
                quiescence.check_count,
                quiescence.stable_checks,
                Some(true),
                Some(0.4),
                None,
                Some(false),
            ),
            _ => assess_capture_readiness(capture),
        }
    }

    pub(super) async fn capture(&self, session_name: &str) -> Result<String> {
        self.capture_with_lines(session_name, None).await
    }

    pub(super) async fn capture_with_lines(
        &self,
        session_name: &str,
        start_line: Option<i32>,
    ) -> Result<String> {
        self.backend
            .capture_pane_with_lines(session_name, start_line)
            .await
    }

    pub(super) async fn capture_screen_state(
        &self,
        session_name: &str,
        start_line: Option<i32>,
        captured_after_ms: u64,
    ) -> Result<ScreenCaptureState> {
        let capture = self.capture_with_lines(session_name, start_line).await?;
        let summary = summarize_capture_for_log(&capture, self.config.debug_enabled);
        Ok(ScreenCaptureState {
            capture,
            summary,
            captured_after_ms,
        })
    }

    pub(super) async fn wait_for_screen_state(
        &self,
        handle: &std::sync::Arc<TerminalHandle>,
        request_id: &str,
        wait_for: &str,
        timeout_ms: u64,
        baseline_capture: Option<&str>,
        start_line: Option<i32>,
    ) -> Result<ScreenWaitResult> {
        let mode = parse_screen_wait_mode(wait_for)?;
        if mode == ScreenWaitMode::None {
            let current = self
                .capture_screen_state(&handle.session_name, start_line, 0)
                .await?;
            return Ok(ScreenWaitResult {
                assessment: assess_capture_readiness(&current.capture),
                capture: current.capture,
                summary: current.summary,
                captured_after_ms: current.captured_after_ms,
            });
        }

        let baseline = match baseline_capture {
            Some(existing) => ScreenCaptureState {
                capture: existing.to_string(),
                summary: summarize_capture_for_log(existing, self.config.debug_enabled),
                captured_after_ms: 0,
            },
            None => {
                self.capture_screen_state(&handle.session_name, start_line, 0)
                    .await?
            }
        };

        let started_at = Instant::now();
        let baseline_hash = baseline.summary.hash;
        let mut last_summary = baseline.summary.clone();
        let mut final_state = baseline;
        let mut last_change_at = started_at;
        let mut changed_since_baseline = false;
        let mut check_count = 0;
        let mut stable_checks = 0;

        if self.config.debug_enabled {
            info!(
                request_id = request_id,
                session_id = %handle.session_id,
                session = %handle.session_name,
                wait_for = wait_for,
                timeout_ms = timeout_ms,
                interval_ms = SCREEN_WAIT_POLL_INTERVAL_MS,
                quiet_ms = SCREEN_WAIT_SETTLED_QUIET_MS,
                baseline_hash = format!("{:016x}", final_state.summary.hash),
                baseline_line_count = final_state.summary.line_count,
                baseline_last_non_empty_line = %final_state.summary.last_non_empty_line,
                preview_head = ?final_state.summary.preview_head.as_deref(),
                preview_tail = ?final_state.summary.preview_tail.as_deref(),
                "screen wait started"
            );
        }

        loop {
            let elapsed_ms = started_at.elapsed().as_millis() as u64;
            if elapsed_ms >= timeout_ms {
                let quiet_for_ms = last_change_at.elapsed().as_millis() as u64;
                let (may_still_be_processing, confidence_override, ready_override) = match mode {
                    ScreenWaitMode::Changed => (Some(false), Some(0.35), Some(false)),
                    ScreenWaitMode::Settled => (Some(true), Some(0.4), Some(false)),
                    ScreenWaitMode::None => (None, None, None),
                };
                let assessment = build_screen_wait_assessment(
                    &final_state.capture,
                    "timeout",
                    quiet_for_ms,
                    check_count,
                    stable_checks,
                    may_still_be_processing,
                    confidence_override,
                    None,
                    ready_override,
                );

                if self.config.debug_enabled {
                    info!(
                        request_id = request_id,
                        session_id = %handle.session_id,
                        session = %handle.session_name,
                        wait_for = wait_for,
                        timeout_ms = timeout_ms,
                        elapsed_ms = elapsed_ms,
                        quiet_for_ms = quiet_for_ms,
                        check_count = check_count,
                        stable_checks = stable_checks,
                        changed_since_baseline = changed_since_baseline,
                        final_hash = format!("{:016x}", final_state.summary.hash),
                        final_last_non_empty_line = %final_state.summary.last_non_empty_line,
                        "screen wait timed out"
                    );
                }

                return Ok(ScreenWaitResult {
                    assessment,
                    capture: final_state.capture,
                    summary: final_state.summary,
                    captured_after_ms: final_state.captured_after_ms,
                });
            }

            let sleep_ms = SCREEN_WAIT_POLL_INTERVAL_MS.min(timeout_ms.saturating_sub(elapsed_ms));
            if sleep_ms > 0 {
                time::sleep(Duration::from_millis(sleep_ms)).await;
            }

            let current = self
                .capture_screen_state(
                    &handle.session_name,
                    start_line,
                    started_at.elapsed().as_millis() as u64,
                )
                .await?;
            check_count += 1;

            let changed_from_previous = current.summary.hash != last_summary.hash;
            let changed_from_baseline = current.summary.hash != baseline_hash;

            if changed_from_baseline {
                changed_since_baseline = true;
            }

            if changed_from_previous {
                last_change_at = Instant::now();
                stable_checks = 0;
            } else {
                stable_checks += 1;
            }

            let quiet_for_ms = last_change_at.elapsed().as_millis() as u64;

            if self.config.debug_enabled {
                info!(
                    request_id = request_id,
                    session_id = %handle.session_id,
                    session = %handle.session_name,
                    wait_for = wait_for,
                    check_count = check_count,
                    stable_checks = stable_checks,
                    changed_from_previous = changed_from_previous,
                    changed_from_baseline = changed_from_baseline,
                    changed_since_baseline = changed_since_baseline,
                    captured_after_ms = current.captured_after_ms,
                    quiet_for_ms = quiet_for_ms,
                    screen_hash = format!("{:016x}", current.summary.hash),
                    line_count = current.summary.line_count,
                    last_non_empty_line = %current.summary.last_non_empty_line,
                    preview_head = ?current.summary.preview_head.as_deref(),
                    preview_tail = ?current.summary.preview_tail.as_deref(),
                    "screen wait capture check"
                );
            }

            match mode {
                ScreenWaitMode::Changed if changed_from_baseline => {
                    let assessment = build_screen_wait_assessment(
                        &current.capture,
                        "changed",
                        quiet_for_ms,
                        check_count,
                        stable_checks,
                        Some(true),
                        None,
                        Some(0.6),
                        Some(true),
                    );

                    return Ok(ScreenWaitResult {
                        assessment,
                        capture: current.capture,
                        summary: current.summary,
                        captured_after_ms: current.captured_after_ms,
                    });
                }
                ScreenWaitMode::Settled if quiet_for_ms >= SCREEN_WAIT_SETTLED_QUIET_MS => {
                    let assessment = build_screen_wait_assessment(
                        &current.capture,
                        "settled",
                        quiet_for_ms,
                        check_count,
                        stable_checks,
                        Some(false),
                        None,
                        Some(0.85),
                        Some(true),
                    );

                    return Ok(ScreenWaitResult {
                        assessment,
                        capture: current.capture,
                        summary: current.summary,
                        captured_after_ms: current.captured_after_ms,
                    });
                }
                _ => {
                    last_summary = current.summary.clone();
                    final_state = current;
                }
            }
        }
    }
}

impl ReadinessDetector {
    pub(super) fn new(
        session_id: String,
        handle: std::sync::Arc<TerminalHandle>,
        sender: OutboundSender,
        start_offset: u64,
        await_ready: Option<AwaitReady>,
    ) -> Self {
        Self {
            session_id,
            handle,
            sender,
            start_offset,
            await_ready,
        }
    }

    pub(super) async fn run(self) -> Result<()> {
        let quiescence_ms = self
            .await_ready
            .as_ref()
            .and_then(|await_ready| await_ready.quiescence_ms)
            .unwrap_or(1500);
        let max_wait_ms = self
            .await_ready
            .as_ref()
            .and_then(|await_ready| await_ready.max_wait_ms)
            .unwrap_or(30_000);
        let start = Instant::now();
        let mut last_change = Instant::now();
        let mut last_size = self.handle.offset.load(std::sync::atomic::Ordering::SeqCst);
        let log_path = self.handle.log_path.clone();
        loop {
            let size = match fs::metadata(&log_path).await {
                Ok(meta) => meta.len(),
                Err(_) => {
                    time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            if size != last_size {
                last_change = Instant::now();
                last_size = size;
            }
            if last_change.elapsed() >= Duration::from_millis(quiescence_ms)
                || start.elapsed() >= Duration::from_millis(max_wait_ms)
            {
                break;
            }
            time::sleep(Duration::from_millis(50)).await;
        }

        let end_size = match fs::metadata(&log_path).await {
            Ok(meta) => meta.len(),
            Err(_) => last_size,
        };
        let (output, last_line) = self.read_tail(end_size).await;
        let quiet_for_ms = last_change.elapsed().as_millis() as u64;
        let assessment = Self::assess(
            &output,
            &last_line,
            quiet_for_ms,
            start.elapsed().as_millis() as u64,
        );
        self.send_ready(&assessment)?;
        Ok(())
    }

    async fn read_tail(&self, end_size: u64) -> (String, String) {
        read_log_tail(&self.handle.log_path, self.start_offset, end_size).await
    }

    pub(super) fn assess(
        output: &str,
        last_line: &str,
        quiet_for_ms: u64,
        elapsed_ms: u64,
    ) -> Value {
        let (prompt_type, prompt_conf, prompt_hints) = Self::detect_prompt(last_line);
        if let Some((prompt_type, confidence)) = prompt_type.zip(prompt_conf) {
            return json!({
                "ready": true,
                "confidence": confidence,
                "trigger": "prompt_detected",
                "prompt_type": prompt_type,
                "hints": prompt_hints,
                "quiet_for_ms": quiet_for_ms,
            });
        }

        let mut confidence: f32 = 0.5;
        let trimmed = last_line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.ends_with('$')
            || trimmed.ends_with('#')
            || trimmed.ends_with('>')
            || trimmed.ends_with('%')
        {
            confidence += 0.25;
        }
        if trimmed.len() < 60 {
            confidence += 0.1;
        }
        if !trimmed.contains(' ') {
            confidence += 0.1;
        }
        if !trimmed.is_empty() && !trimmed.ends_with('\n') {
            confidence += 0.05;
        }
        if trimmed.len() > 150 {
            confidence -= 0.2;
        }
        if output.contains("%") && output.to_lowercase().contains("eta") {
            confidence -= 0.15;
        }
        if Self::looks_like_progress(output) {
            confidence -= 0.1;
        }
        if quiet_for_ms < 500 {
            confidence -= 0.1;
        }
        let ready = confidence >= 0.55;
        let trigger = if elapsed_ms >= 30_000 {
            "timeout"
        } else {
            "quiescence"
        };
        json!({
            "ready": ready,
            "confidence": confidence.clamp(0.0, 1.0),
            "trigger": trigger,
            "hints": {
                "looks_like_prompt": false,
                "looks_like_confirmation": false,
                "looks_like_password": false,
                "looks_like_pager": false,
                "looks_like_error": output.to_lowercase().contains("error"),
                "may_still_be_processing": !ready
            },
            "quiet_for_ms": quiet_for_ms,
        })
    }

    fn detect_prompt(last_line: &str) -> (Option<&'static str>, Option<f64>, Value) {
        let line = last_line.trim();
        if line.is_empty() {
            return (None, None, Self::hints_none());
        }
        let lower = line.to_lowercase();
        if line.ends_with('$') || line.ends_with('#') || line.ends_with('%') || line.contains(":~$")
        {
            return (Some("shell"), Some(0.95), Self::hints_prompt());
        }
        if line.starts_with(">>>") || line.starts_with("...") || line.starts_with("In [") {
            return (Some("python"), Some(0.95), Self::hints_prompt());
        }
        if line == ">" {
            return (Some("node"), Some(0.85), Self::hints_prompt());
        }
        if line.contains("[y/n]")
            || line.contains("[Y/n]")
            || lower.contains("yes/no")
            || lower.contains("continue?")
            || lower.contains("(yes/no)")
        {
            return (
                Some("confirmation"),
                Some(0.95),
                json!({
                    "looks_like_prompt": true,
                    "looks_like_confirmation": true,
                    "looks_like_password": false,
                    "looks_like_pager": false,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if lower.ends_with("password:") || lower.contains("passphrase") {
            return (
                Some("password"),
                Some(0.95),
                json!({
                    "looks_like_prompt": false,
                    "looks_like_confirmation": false,
                    "looks_like_password": true,
                    "looks_like_pager": false,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if line == ":" || line == "(END)" || line.starts_with("--More--") {
            return (
                Some("pager"),
                Some(0.9),
                json!({
                    "looks_like_prompt": false,
                    "looks_like_confirmation": false,
                    "looks_like_password": false,
                    "looks_like_pager": true,
                    "looks_like_error": false,
                    "may_still_be_processing": false
                }),
            );
        }
        if lower.ends_with("mysql>")
            || lower.ends_with("postgres=#")
            || lower.ends_with("postgres=>")
            || lower.ends_with("sqlite>")
        {
            return (Some("database"), Some(0.95), Self::hints_prompt());
        }
        (None, None, Self::hints_none())
    }

    fn hints_prompt() -> Value {
        json!({
            "looks_like_prompt": true,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": false
        })
    }

    fn hints_none() -> Value {
        json!({
            "looks_like_prompt": false,
            "looks_like_confirmation": false,
            "looks_like_password": false,
            "looks_like_pager": false,
            "looks_like_error": false,
            "may_still_be_processing": true
        })
    }

    fn looks_like_progress(output: &str) -> bool {
        let lower = output.to_lowercase();
        lower.contains("eta")
            || lower.contains('%')
            || lower.contains("download")
            || lower.contains("fetching")
            || lower.contains("progress")
            || lower.contains("completed")
    }

    fn send_ready(&self, assessment: &Value) -> Result<()> {
        let frame = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": &self.session_id,
            "assessment": assessment,
        });
        send_ws_frame(&self.sender, frame)?;
        Ok(())
    }
}

impl<B> ActivityDetector<B>
where
    B: TerminalBackend,
{
    pub(super) fn new(
        session_id: String,
        handle: std::sync::Arc<TerminalHandle>,
        sender: OutboundSender,
        backend: B,
        await_ready: &AwaitReady,
    ) -> Self {
        Self {
            session_id,
            handle,
            sender,
            backend,
            initial_delay_ms: await_ready
                .activity_initial_delay_ms
                .unwrap_or(ACTIVITY_DEFAULT_INITIAL_DELAY_MS),
            interval_ms: await_ready
                .activity_interval_ms
                .unwrap_or(ACTIVITY_DEFAULT_INTERVAL_MS),
            stable_count_required: await_ready
                .activity_stable_count
                .unwrap_or(ACTIVITY_DEFAULT_STABLE_COUNT),
            max_wait_ms: await_ready
                .max_wait_ms
                .unwrap_or(ACTIVITY_DEFAULT_MAX_WAIT_MS),
        }
    }

    pub(super) async fn run(self) -> Result<()> {
        let start = Instant::now();
        let mut last_hash: Option<u64> = None;
        let mut stable_count: u32 = 0;
        let mut check_count: u32 = 0;

        info!(
            session_id = %self.session_id,
            session = %self.handle.session_name,
            initial_delay_ms = self.initial_delay_ms,
            interval_ms = self.interval_ms,
            stable_count_required = self.stable_count_required,
            max_wait_ms = self.max_wait_ms,
            "activity detection started"
        );

        time::sleep(Duration::from_millis(self.initial_delay_ms)).await;

        loop {
            if start.elapsed() >= Duration::from_millis(self.max_wait_ms) {
                info!(
                    session_id = %self.session_id,
                    session = %self.handle.session_name,
                    check_count,
                    stable_count,
                    elapsed_ms = start.elapsed().as_millis(),
                    "activity detection timeout"
                );
                self.send_ready(0.5, "timeout", stable_count, check_count)
                    .await?;
                return Ok(());
            }

            let output = match self
                .backend
                .capture_pane_with_lines(&self.handle.session_name, None)
                .await
            {
                Ok(output) => output,
                Err(err) => {
                    warn!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        error = %err,
                        "capture-pane failed, retrying"
                    );
                    time::sleep(Duration::from_millis(self.interval_ms)).await;
                    continue;
                }
            };
            let current_hash = simple_hash(output.as_bytes());
            check_count += 1;

            match last_hash {
                Some(previous) if previous == current_hash => {
                    stable_count += 1;
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        stable_count,
                        required = self.stable_count_required,
                        "activity check: stable"
                    );

                    if stable_count >= self.stable_count_required {
                        info!(
                            session_id = %self.session_id,
                            session = %self.handle.session_name,
                            check_count,
                            stable_count,
                            elapsed_ms = start.elapsed().as_millis(),
                            "activity detection: ready (screen stable)"
                        );
                        self.send_ready(0.9, "activity_stable", stable_count, check_count)
                            .await?;
                        return Ok(());
                    }
                }
                Some(_) => {
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        prev_stable_count = stable_count,
                        "activity check: content changed"
                    );
                    stable_count = 0;
                }
                None => {
                    info!(
                        session_id = %self.session_id,
                        session = %self.handle.session_name,
                        check_count,
                        "activity check: first capture"
                    );
                }
            }

            last_hash = Some(current_hash);

            time::sleep(Duration::from_millis(self.interval_ms)).await;
        }
    }

    async fn send_ready(
        &self,
        confidence: f64,
        trigger: &str,
        stable_count: u32,
        check_count: u32,
    ) -> Result<()> {
        let readiness = json!({
            "ready": confidence >= 0.5,
            "confidence": confidence,
            "trigger": trigger,
            "hints": {
                "looks_like_prompt": false,
                "looks_like_confirmation": false,
                "looks_like_password": false,
                "looks_like_pager": false,
                "looks_like_error": false,
                "may_still_be_processing": confidence < 0.7
            },
            "activity_checks": check_count,
            "stable_checks": stable_count
        });
        let payload = json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": "terminal_ready",
            "id": new_message_id(),
            "ts": now_millis(),
            "ext": {},
            "session_id": &self.session_id,
            "assessment": &readiness,
        });
        send_ws_frame(&self.sender, payload)?;
        Ok(())
    }
}

pub(super) fn assess_capture_readiness(capture: &str) -> Value {
    let last_line = capture
        .lines()
        .last()
        .unwrap_or_else(|| capture.trim_end_matches(&['\r', '\n'][..]));
    ReadinessDetector::assess(capture, last_line, 0, 0)
}

pub(super) fn parse_screen_wait_mode(wait_for: &str) -> Result<ScreenWaitMode> {
    match wait_for {
        "none" => Ok(ScreenWaitMode::None),
        "changed" => Ok(ScreenWaitMode::Changed),
        "settled" | "screen_stable" => Ok(ScreenWaitMode::Settled),
        _ => bail!("unsupported wait_for mode: {wait_for}"),
    }
}

fn set_json_number(map: &mut Map<String, Value>, key: &str, value: u64) {
    map.insert(key.to_string(), Value::Number(Number::from(value)));
}

pub(super) fn build_screen_wait_assessment(
    capture: &str,
    trigger: &str,
    quiet_for_ms: u64,
    check_count: u32,
    stable_checks: u32,
    may_still_be_processing: Option<bool>,
    confidence_override: Option<f64>,
    confidence_floor: Option<f64>,
    ready_override: Option<bool>,
) -> Value {
    let mut assessment = assess_capture_readiness(capture);

    if let Some(map) = assessment.as_object_mut() {
        map.insert("trigger".into(), Value::String(trigger.to_string()));
        set_json_number(map, "quiet_for_ms", quiet_for_ms);
        if check_count > 0 {
            set_json_number(map, "activity_checks", check_count as u64);
        }
        if stable_checks > 0 {
            set_json_number(map, "stable_checks", stable_checks as u64);
        }

        if let Some(next) = confidence_override {
            if let Some(number) = Number::from_f64(next) {
                map.insert("confidence".into(), Value::Number(number));
            }
        } else if let Some(floor) = confidence_floor {
            let current = map
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let next = current.max(floor);
            if let Some(number) = Number::from_f64(next) {
                map.insert("confidence".into(), Value::Number(number));
            }
        }

        if let Some(ready) = ready_override {
            map.insert("ready".into(), Value::Bool(ready));
        }

        if let Some(processing) = may_still_be_processing {
            if let Some(hints) = map.get_mut("hints").and_then(|value| value.as_object_mut()) {
                hints.insert("may_still_be_processing".into(), Value::Bool(processing));
            }
        }
    }

    assessment
}

fn last_line_from_text(text: &str) -> String {
    text.lines()
        .last()
        .unwrap_or_else(|| text.trim_end_matches(&['\r', '\n'][..]))
        .to_string()
}

async fn read_log_tail(log_path: &Path, start_offset: u64, end_size: u64) -> (String, String) {
    const MAX_READ: usize = 16 * 1024;
    if end_size <= start_offset {
        return (String::new(), String::new());
    }
    let available = (end_size - start_offset) as usize;
    let to_read = std::cmp::min(available, MAX_READ);
    let mut buf = vec![0u8; to_read];
    if let Ok(mut file) = fs::File::open(log_path).await {
        let _ = file.seek(SeekFrom::Start(end_size - to_read as u64)).await;
        let _ = file.read_exact(&mut buf).await;
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let last_line_owned = last_line_from_text(&text);
    (text, last_line_owned)
}

async fn read_log_range(
    log_path: &Path,
    start: u64,
    end: u64,
    max_bytes: usize,
) -> (Vec<u8>, bool) {
    if end <= start {
        return (Vec::new(), false);
    }

    let total_bytes = (end - start) as usize;
    let truncated = total_bytes > max_bytes;
    let to_read = total_bytes.min(max_bytes);

    let seek_pos = if truncated {
        end - to_read as u64
    } else {
        start
    };

    let mut buf = vec![0u8; to_read];
    if let Ok(mut file) = fs::File::open(log_path).await {
        let _ = file.seek(SeekFrom::Start(seek_pos)).await;
        let _ = file.read_exact(&mut buf).await;
    }

    (buf, truncated)
}

#[cfg(test)]
mod tests {
    use super::{build_screen_wait_assessment, parse_screen_wait_mode};
    use crate::terminal::ScreenWaitMode;

    #[test]
    fn parse_screen_wait_mode_supports_phase_seven_modes() {
        assert_eq!(
            parse_screen_wait_mode("none").unwrap(),
            ScreenWaitMode::None
        );
        assert_eq!(
            parse_screen_wait_mode("changed").unwrap(),
            ScreenWaitMode::Changed
        );
        assert_eq!(
            parse_screen_wait_mode("settled").unwrap(),
            ScreenWaitMode::Settled
        );
    }

    #[test]
    fn parse_screen_wait_mode_still_accepts_legacy_alias() {
        assert_eq!(
            parse_screen_wait_mode("screen_stable").unwrap(),
            ScreenWaitMode::Settled
        );
    }

    #[test]
    fn build_screen_wait_assessment_applies_phase_seven_overrides() {
        let assessment = build_screen_wait_assessment(
            "Claude is thinking...\n",
            "settled",
            350,
            3,
            2,
            Some(false),
            Some(0.85),
            None,
            Some(true),
        );

        assert_eq!(
            assessment.get("trigger").and_then(|value| value.as_str()),
            Some("settled")
        );
        assert_eq!(
            assessment.get("ready").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(
            assessment
                .get("confidence")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0)
                >= 0.85
        );
        assert_eq!(
            assessment
                .get("hints")
                .and_then(|value| value.get("may_still_be_processing"))
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            assessment
                .get("activity_checks")
                .and_then(|value| value.as_u64()),
            Some(3)
        );
        assert_eq!(
            assessment
                .get("stable_checks")
                .and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn build_screen_wait_assessment_marks_timeout_as_not_ready_when_requested() {
        let assessment = build_screen_wait_assessment(
            "still working",
            "timeout",
            50,
            1,
            0,
            Some(true),
            Some(0.4),
            None,
            Some(false),
        );

        assert_eq!(
            assessment.get("ready").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            assessment.get("trigger").and_then(|value| value.as_str()),
            Some("timeout")
        );
    }
}
