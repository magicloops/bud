use std::collections::HashMap;

use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::Value;

pub const PROTO_VERSION: &str = "0.1";
pub const TERMINAL_PROTO_VERSION: &str = "0.2";
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
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalInputFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub data: String,
    pub await_ready: Option<AwaitReady>,
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

#[derive(Debug, Deserialize, Clone, Default)]
pub struct AwaitReady {
    pub enabled: bool,
    pub quiescence_ms: Option<u64>,
    pub max_wait_ms: Option<u64>,
    #[serde(default)]
    pub activity_based: bool,
    pub activity_interval_ms: Option<u64>,
    pub activity_stable_count: Option<u32>,
    pub activity_initial_delay_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalSendFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub request_id: String,
    pub text: Option<String>,
    pub submit: Option<bool>,
    pub keys: Option<Vec<String>>,
    pub observe_after_ms: Option<u64>,
    pub wait_for: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct TerminalObserveFrame {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub session_id: String,
    pub request_id: String,
    pub view: Option<String>,
    pub lines: Option<i32>,
    pub wait_for: Option<String>,
    pub timeout_ms: Option<u64>,
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
    }
}
