use std::collections::HashMap;

use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::Value;

pub const PROTO_VERSION: &str = "0.1";
pub const TERMINAL_PROTO_VERSION: &str = "0.3";
pub const DEFAULT_HEARTBEAT_SEC: u64 = 30;

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub proto: String,
    pub id: String,
    pub ts: u64,
    #[serde(default)]
    pub ext: Value,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct HelloAckFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub bud_id: String,
    pub heartbeat_sec: Option<u64>,
    pub device_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct HelloChallengeFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub nonce: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ErrorFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct RunFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub run_id: String,
    pub cmd: String,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub timeout_ms: Option<u64>,
    pub use_pty: Option<bool>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct TerminalEnsureConfig {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalEnsureFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub config: Option<TerminalEnsureConfig>,
    /// Highest end-offset the service has durably stored; the daemon backfills
    /// ring-buffered output from exactly this offset (proto 0.3, §6.7.2).
    pub resume_from_offset: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalInputFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub data: String,
    /// Grid-sync predictive echo (§6.8.3): client-minted monotonic sequence
    /// number. After this input is written to the PTY, grid frames carry
    /// `applied_input_seq >= input_seq`, letting the client retire its local
    /// prediction for these bytes.
    pub input_seq: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalResizeFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalCloseFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub reason: Option<String>,
}

/// Awaited terminating condition for `terminal_send` (proto 0.3, §6.7.4).
/// Absent = resolve on dispatch (transport ack only).
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSendAwait {
    /// Resolve when the dispatched command's `command_finished` (or sentinel
    /// equivalent) arrives; the service owns the timeout budget.
    Command,
    /// Resolve on the next `settled` event.
    Settled,
    /// The daemon picks: `command` when the text is submitted at a shell
    /// prompt (no open command), `settled` inside a running program. The
    /// unified `terminal.send` tool always sends this (§6.7.4).
    Auto,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalSendFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub request_id: String,
    pub text: Option<String>,
    pub submit: Option<bool>,
    pub key: Option<String>,
    pub r#await: Option<TerminalSendAwait>,
}

/// `terminal_grid_watch` (§6.8.1): viewer-driven grid-delta subscription.
/// Idempotent; watch state dies with the WS connection.
#[derive(Debug, Deserialize, Clone)]
pub struct TerminalGridWatchFrame {
    #[serde(flatten)]
    #[allow(dead_code)]
    pub envelope: Envelope,
    pub session_id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalObserveFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub request_id: String,
    pub view: Option<String>,
    /// History view: number of most-recent scrollback lines. Negative values
    /// (legacy tail notation) are treated as their magnitude; daemon-capped.
    pub lines: Option<i64>,
    /// Awaited observe (§6.1): block until the requested fact — `settled`
    /// (damage-quiet, or immediately when already quiet) or `command` (the
    /// open command's `command_finished`) — THEN snapshot. Absent = plain
    /// snapshot. The service owns the timeout budget (4h daemon safety cap).
    pub r#await: Option<TerminalSendAwait>,
    /// `await:"settled"` only: require this much quiet instead of the
    /// daemon default; the extra window is confirmed against output-stream
    /// progress so a program that merely paused does not wake the caller.
    pub quiet_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct StreamDataFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub stream_id: String,
    pub stream_type: String,
    pub offset: u64,
    pub data: String,
    #[serde(default)]
    pub end_stream: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct StreamCreditFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub stream_id: String,
    pub receive_offset: u64,
    pub credit_bytes: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct StreamResetFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub stream_id: String,
    pub reason: String,
    pub error: Option<Value>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct StreamCloseFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub stream_id: String,
    pub final_offset: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ProxyOpenFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub operation_id: String,
    pub stream_id: String,
    pub proxy_session_id: String,
    pub stream_type: String,
    pub target_host: String,
    pub target_port: u16,
    pub method: String,
    pub path: String,
    pub headers: Option<HashMap<String, String>>,
    pub request_body_bytes: Option<u64>,
    pub initial_credit_bytes: Option<u64>,
    pub max_chunk_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct LocalLlmOpenFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub operation_id: String,
    pub stream_id: String,
    pub stream_type: String,
    pub local_llm_server_id: String,
    pub method: String,
    pub path: String,
    pub headers: Option<HashMap<String, String>>,
    pub request_body_bytes: Option<u64>,
    pub initial_credit_bytes: Option<u64>,
    pub max_chunk_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ProxyWebSocketOpenFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub operation_id: String,
    pub ws_session_id: String,
    pub proxied_site_id: Option<String>,
    pub stream_type: String,
    pub target_host: String,
    pub target_port: u16,
    pub path: String,
    pub protocols: Option<Vec<String>>,
    pub max_message_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ProxyWebSocketMessageFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub ws_session_id: String,
    pub message_type: String,
    pub data: String,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ProxyWebSocketCloseFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub ws_session_id: String,
    pub code: Option<u16>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ProxyWebSocketErrorFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub ws_session_id: String,
    pub error: Value,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct FileOpenResolutionHint {
    pub kind: String,
    pub host_cwd: Option<String>,
    pub source_message_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct FileOpenFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub operation_id: String,
    pub stream_id: String,
    pub file_session_id: String,
    pub terminal_session_id: Option<String>,
    pub stream_type: String,
    pub root_key: String,
    pub relative_path: String,
    pub resolution_hint: Option<FileOpenResolutionHint>,
    pub mode: String,
    pub range_start: Option<u64>,
    pub range_end: Option<u64>,
    pub range_suffix_bytes: Option<u64>,
    pub expected_content_identity: Option<Value>,
    pub max_bytes: Option<u64>,
    pub initial_credit_bytes: Option<u64>,
    pub max_chunk_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
#[allow(dead_code)]
pub struct FileResolveFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub operation_id: String,
    pub root_key: String,
    pub requested_path: String,
    pub requested_path_kind: String,
    pub max_bytes: Option<u64>,
}

// ---------------------------------------------------------------------------
// Outbound proto 0.3 terminal frame builders (docs/proto.md §6.7).
// Wire fields are snake_case; optional contract fields are omitted when absent.
// ---------------------------------------------------------------------------

use serde_json::{json, Map, Number};

use crate::util::{new_message_id, now_millis};

fn terminal_envelope(kind: &str) -> Map<String, Value> {
    let mut frame = Map::new();
    frame.insert("proto".into(), Value::String(TERMINAL_PROTO_VERSION.into()));
    frame.insert("type".into(), Value::String(kind.into()));
    frame.insert("id".into(), Value::String(new_message_id()));
    frame.insert("ts".into(), Value::Number(Number::from(now_millis())));
    frame.insert("ext".into(), json!({}));
    frame
}

/// `terminal_output` (§6.7.1): offset-addressed, no `seq`.
pub fn terminal_output_frame(session_id: &str, byte_offset: u64, data_base64: &str) -> Value {
    let mut frame = terminal_envelope("terminal_output");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.insert(
        "byte_offset".into(),
        Value::Number(Number::from(byte_offset)),
    );
    frame.insert("data".into(), Value::String(data_base64.into()));
    Value::Object(frame)
}

/// `terminal_event` (§6.7.3): `data` must follow the per-event vocabulary.
pub fn terminal_event_frame(session_id: &str, event: &str, data: Value) -> Value {
    let mut frame = terminal_envelope("terminal_event");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.insert("event".into(), Value::String(event.into()));
    frame.insert("data".into(), data);
    Value::Object(frame)
}

/// `terminal_grid` (§6.8.2): grid-delta frame. `fields` carries the payload
/// (generation/full/cols/rows/alt_screen/cursor/dirty_rows/scrollback_push/
/// scrollback_dropped) serialized by `terminal::grid::grid_frame_fields`.
pub fn terminal_grid_frame(session_id: &str, fields: Map<String, Value>) -> Value {
    let mut frame = terminal_envelope("terminal_grid");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.extend(fields);
    Value::Object(frame)
}

/// `terminal_status` (§6.7.6): stem-backed `info` when available.
pub fn terminal_status_frame(session_id: &str, state: &str, info: Option<Value>) -> Value {
    let mut frame = terminal_envelope("terminal_status");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.insert("state".into(), Value::String(state.into()));
    if let Some(info) = info {
        frame.insert("info".into(), info);
    }
    Value::Object(frame)
}

/// `terminal_send_result` (§6.7.4): transport ack plus optional awaited
/// terminating event; `outcome` is `{event, data}` or null.
pub fn terminal_send_result_frame(
    session_id: &str,
    request_id: &str,
    dispatched: bool,
    outcome: Option<Value>,
    error: Option<&str>,
) -> Value {
    let mut frame = terminal_envelope("terminal_send_result");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.insert("request_id".into(), Value::String(request_id.into()));
    frame.insert("dispatched".into(), Value::Bool(dispatched));
    frame.insert("outcome".into(), outcome.unwrap_or(Value::Null));
    frame.insert(
        "error".into(),
        error
            .map(|e| Value::String(e.into()))
            .unwrap_or(Value::Null),
    );
    Value::Object(frame)
}

/// Grid-backed observation facts shared by every `terminal_observe_result`.
#[derive(Debug, Clone)]
pub struct TerminalObservation {
    pub view: String,
    pub output_base64: String,
    pub lines_captured: u64,
    pub changed: bool,
    pub mode: String,
    pub integration: String,
    pub alt_screen: bool,
    pub cursor_row: u16,
    pub cursor_col: u16,
    /// Output-stream offset the emulator state reflects (pump progress at
    /// observe time). Lets clients pair a grid snapshot with offset-exact
    /// stream resume: subscribe from this offset and nothing in the snapshot
    /// is replayed, nothing after it is missed.
    pub ring_next_offset: u64,
    /// Awaited observes only (§6.6): the terminating fact the wait resolved
    /// on, `{ "event", "data" }` — `settled` (with `data.immediate: true`
    /// when the session was already quiet), `command_finished`,
    /// `prompt_ready`, `idle` (command-await with nothing open), `closed`.
    pub outcome: Option<Value>,
    /// `view: "screen"` only: the grid serialized as ANSI (SGR runs + final
    /// cursor position), base64. Rendering this reproduces colors/styles/
    /// cursor faithfully — the plain `output` text loses presentation, which
    /// is glaring when a client bootstraps into a colorful TUI.
    pub output_ansi_base64: Option<String>,
}

/// `terminal_observe_result` (§6.7.5).
pub fn terminal_observe_result_frame(
    session_id: &str,
    request_id: &str,
    observation: Option<TerminalObservation>,
    error: Option<&str>,
) -> Value {
    let mut frame = terminal_envelope("terminal_observe_result");
    frame.insert("session_id".into(), Value::String(session_id.into()));
    frame.insert("request_id".into(), Value::String(request_id.into()));
    if let Some(observation) = observation {
        frame.insert("view".into(), Value::String(observation.view));
        frame.insert("output".into(), Value::String(observation.output_base64));
        frame.insert(
            "lines_captured".into(),
            Value::Number(Number::from(observation.lines_captured)),
        );
        frame.insert("changed".into(), Value::Bool(observation.changed));
        frame.insert("mode".into(), Value::String(observation.mode));
        frame.insert("integration".into(), Value::String(observation.integration));
        frame.insert("alt_screen".into(), Value::Bool(observation.alt_screen));
        frame.insert(
            "ring_next_offset".into(),
            Value::Number(Number::from(observation.ring_next_offset)),
        );
        if let Some(output_ansi) = observation.output_ansi_base64 {
            frame.insert("output_ansi".into(), Value::String(output_ansi));
        }
        if let Some(outcome) = observation.outcome {
            frame.insert("outcome".into(), outcome);
        }
        frame.insert(
            "cursor_row".into(),
            Value::Number(Number::from(observation.cursor_row)),
        );
        frame.insert(
            "cursor_col".into(),
            Value::Number(Number::from(observation.cursor_col)),
        );
    }
    frame.insert(
        "error".into(),
        error
            .map(|e| Value::String(e.into()))
            .unwrap_or(Value::Null),
    );
    Value::Object(frame)
}

pub fn validate_inbound_envelope_proto(envelope: &Envelope) -> Result<()> {
    let expected = if envelope.kind.starts_with("terminal_") {
        TERMINAL_PROTO_VERSION
    } else {
        PROTO_VERSION
    };

    if envelope.proto != expected {
        bail!(
            "unsupported inbound proto for {}: expected {}, got {}",
            envelope.kind,
            expected,
            envelope.proto
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(kind: &str, proto: &str) -> Envelope {
        Envelope {
            kind: kind.to_string(),
            proto: proto.to_string(),
            id: "id".to_string(),
            ts: 0,
            ext: Value::Null,
        }
    }

    #[test]
    fn validates_base_protocol_frames() {
        assert!(validate_inbound_envelope_proto(&envelope("run", PROTO_VERSION)).is_ok());
        assert!(validate_inbound_envelope_proto(&envelope("hello_ack", PROTO_VERSION)).is_ok());
    }

    #[test]
    fn validates_terminal_protocol_frames() {
        assert_eq!(TERMINAL_PROTO_VERSION, "0.3");
        assert!(validate_inbound_envelope_proto(&envelope(
            "terminal_send",
            TERMINAL_PROTO_VERSION
        ))
        .is_ok());
    }

    #[test]
    fn rejects_unexpected_proto_versions() {
        assert!(
            validate_inbound_envelope_proto(&envelope("terminal_send", PROTO_VERSION)).is_err()
        );
        assert!(validate_inbound_envelope_proto(&envelope("run", TERMINAL_PROTO_VERSION)).is_err());
        // Legacy 0.2 terminal frames are refused after the 0.3 cutover.
        assert!(validate_inbound_envelope_proto(&envelope("terminal_send", "0.2")).is_err());
    }

    fn base(kind: &str) -> Value {
        json!({
            "proto": TERMINAL_PROTO_VERSION,
            "type": kind,
            "id": "01TEST",
            "ts": 1731_u64,
            "ext": {},
        })
    }

    fn merged(kind: &str, extra: Value) -> String {
        let mut frame = base(kind);
        let map = frame.as_object_mut().unwrap();
        for (key, value) in extra.as_object().unwrap() {
            map.insert(key.clone(), value.clone());
        }
        serde_json::to_string(&frame).unwrap()
    }

    #[test]
    fn terminal_ensure_parses_resume_from_offset() {
        let text = merged(
            "terminal_ensure",
            json!({
                "session_id": "sess_01H",
                "config": { "shell": "/bin/zsh", "cwd": "/tmp", "cols": 120, "rows": 40 },
                "resume_from_offset": 16384_u64,
            }),
        );
        let frame: TerminalEnsureFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.session_id, "sess_01H");
        assert_eq!(frame.resume_from_offset, Some(16384));
        assert_eq!(frame.config.as_ref().unwrap().cols, Some(120));

        // First-ensure shape: both config and resume offset absent.
        let text = merged("terminal_ensure", json!({ "session_id": "sess_01H" }));
        let frame: TerminalEnsureFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.resume_from_offset, None);
        assert!(frame.config.is_none());
    }

    #[test]
    fn terminal_send_parses_gestures_and_await_modes() {
        let text = merged(
            "terminal_send",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "text": "git status",
                "submit": true,
                "await": "command",
            }),
        );
        let frame: TerminalSendFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.text.as_deref(), Some("git status"));
        assert_eq!(frame.submit, Some(true));
        assert_eq!(frame.r#await, Some(TerminalSendAwait::Command));
        assert!(frame.key.is_none());

        let text = merged(
            "terminal_send",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "key": "ctrl+c",
                "await": "settled",
            }),
        );
        let frame: TerminalSendFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.key.as_deref(), Some("ctrl+c"));
        assert_eq!(frame.r#await, Some(TerminalSendAwait::Settled));

        // Await absent = dispatch-ack only.
        let text = merged(
            "terminal_send",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "text": "y",
            }),
        );
        let frame: TerminalSendFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.r#await, None);

        // Retired 0.2 vocabulary must not deserialize as an await mode.
        let text = merged(
            "terminal_send",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "text": "x",
                "await": "shell_ready",
            }),
        );
        assert!(serde_json::from_str::<TerminalSendFrame>(&text).is_err());
    }

    #[test]
    fn terminal_send_rejects_legacy_keys_alias() {
        // The one-entry `keys` compatibility alias is removed in 0.3; the field
        // is simply ignored by serde, leaving no gesture.
        let text = merged(
            "terminal_send",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "keys": ["ctrl+c"],
            }),
        );
        let frame: TerminalSendFrame = serde_json::from_str(&text).unwrap();
        assert!(frame.key.is_none());
        assert!(frame.text.is_none());
    }

    #[test]
    fn terminal_observe_parses_views_without_wait_vocabulary() {
        let text = merged(
            "terminal_observe",
            json!({
                "session_id": "sess_01H",
                "request_id": "req_01H",
                "view": "history",
                "lines": 500,
            }),
        );
        let frame: TerminalObserveFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.view.as_deref(), Some("history"));
        assert_eq!(frame.lines, Some(500));
    }

    #[test]
    fn terminal_input_parses_without_await_ready() {
        let text = merged(
            "terminal_input",
            json!({ "session_id": "sess_01H", "data": "aGk=" }),
        );
        let frame: TerminalInputFrame = serde_json::from_str(&text).unwrap();
        assert_eq!(frame.data, "aGk=");
    }

    fn assert_envelope(frame: &Value, kind: &str) {
        assert_eq!(
            frame.get("proto").and_then(Value::as_str),
            Some(TERMINAL_PROTO_VERSION)
        );
        assert_eq!(frame.get("type").and_then(Value::as_str), Some(kind));
        assert!(frame.get("id").and_then(Value::as_str).is_some());
        assert!(frame.get("ts").and_then(Value::as_u64).is_some());
        assert!(frame.get("ext").is_some());
    }

    #[test]
    fn terminal_output_frame_is_offset_addressed_without_seq() {
        let frame = terminal_output_frame("sess_01H", 16384, "aGVsbG8=");
        assert_envelope(&frame, "terminal_output");
        assert_eq!(
            frame.get("byte_offset").and_then(Value::as_u64),
            Some(16384)
        );
        assert_eq!(frame.get("data").and_then(Value::as_str), Some("aGVsbG8="));
        assert!(frame.get("seq").is_none());

        // Round-trip through text stays identical.
        let text = serde_json::to_string(&frame).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), frame);
    }

    #[test]
    fn terminal_event_frame_carries_vocabulary_payloads() {
        let frame = terminal_event_frame(
            "sess_01H",
            "command_finished",
            json!({
                "command_id": "cmd_01H",
                "exit_code": 1,
                "duration_ms": 2311_u64,
                "output_byte_start": 16384_u64,
                "output_byte_end": 18101_u64,
            }),
        );
        assert_envelope(&frame, "terminal_event");
        assert_eq!(
            frame.get("event").and_then(Value::as_str),
            Some("command_finished")
        );
        let data = frame.get("data").unwrap();
        assert_eq!(data.get("exit_code").and_then(Value::as_i64), Some(1));
        assert_eq!(
            data.get("output_byte_end").and_then(Value::as_u64),
            Some(18101)
        );
    }

    #[test]
    fn terminal_status_frame_carries_stem_backed_info() {
        let frame = terminal_status_frame(
            "sess_01H",
            "ready",
            Some(json!({
                "pid": 12345,
                "cwd": "/Users/adam/bud",
                "cols": 120,
                "rows": 40,
                "ring_next_offset": 84213_u64,
                "mode": "shell",
                "integration": "osc133",
            })),
        );
        assert_envelope(&frame, "terminal_status");
        assert_eq!(frame.get("state").and_then(Value::as_str), Some("ready"));
        let info = frame.get("info").unwrap();
        assert_eq!(
            info.get("ring_next_offset").and_then(Value::as_u64),
            Some(84213)
        );
        assert!(info.get("output_log_bytes").is_none());
    }

    #[test]
    fn terminal_send_result_frame_shapes() {
        let outcome = json!({
            "event": "command_finished",
            "data": { "command_id": "cmd_01H", "exit_code": 0, "duration_ms": 412_u64,
                       "output_byte_start": 0_u64, "output_byte_end": 640_u64 }
        });
        let frame =
            terminal_send_result_frame("sess_01H", "req_01H", true, Some(outcome.clone()), None);
        assert_envelope(&frame, "terminal_send_result");
        assert_eq!(frame.get("dispatched").and_then(Value::as_bool), Some(true));
        assert_eq!(frame.get("outcome").unwrap(), &outcome);
        assert!(frame.get("error").unwrap().is_null());
        // Retired 0.2 fields never appear.
        for retired in ["submitted", "delta", "readiness", "host_cwd"] {
            assert!(frame.get(retired).is_none(), "retired field {retired}");
        }

        let frame = terminal_send_result_frame("sess_01H", "req_01H", true, None, Some("TIMEOUT"));
        assert!(frame.get("outcome").unwrap().is_null());
        assert_eq!(frame.get("error").and_then(Value::as_str), Some("TIMEOUT"));
    }

    #[test]
    fn terminal_observe_result_frame_shapes() {
        let frame = terminal_observe_result_frame(
            "sess_01H",
            "req_01H",
            Some(TerminalObservation {
                view: "screen".into(),
                output_base64: "aGk=".into(),
                lines_captured: 24,
                changed: true,
                mode: "tui".into(),
                integration: "osc133".into(),
                alt_screen: true,
                cursor_row: 3,
                cursor_col: 11,
                ring_next_offset: 84213,
                output_ansi_base64: Some("XGUxYlszMW0=".into()),
                outcome: None,
            }),
            None,
        );
        assert_envelope(&frame, "terminal_observe_result");
        assert_eq!(frame.get("view").and_then(Value::as_str), Some("screen"));
        assert_eq!(
            frame.get("lines_captured").and_then(Value::as_u64),
            Some(24)
        );
        assert_eq!(frame.get("changed").and_then(Value::as_bool), Some(true));
        assert_eq!(frame.get("mode").and_then(Value::as_str), Some("tui"));
        assert_eq!(
            frame.get("integration").and_then(Value::as_str),
            Some("osc133")
        );
        assert_eq!(frame.get("alt_screen").and_then(Value::as_bool), Some(true));
        assert_eq!(frame.get("cursor_row").and_then(Value::as_u64), Some(3));
        assert_eq!(frame.get("cursor_col").and_then(Value::as_u64), Some(11));
        assert!(frame.get("error").unwrap().is_null());
        for retired in ["readiness", "truncated", "output_bytes", "host_cwd"] {
            assert!(frame.get(retired).is_none(), "retired field {retired}");
        }

        let frame =
            terminal_observe_result_frame("sess_01H", "req_01H", None, Some("session_not_found"));
        assert_eq!(
            frame.get("error").and_then(Value::as_str),
            Some("session_not_found")
        );
        assert!(frame.get("output").is_none());
    }
}
