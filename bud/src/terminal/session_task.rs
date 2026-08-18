//! Per-session event pump: maps `stem::Event`s onto proto 0.3 wire frames
//! (`terminal_output` / `terminal_event` / `terminal_status`) and feeds the
//! internal broadcast channel that `terminal_send` awaits correlate against.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Number, Value};
use tokio::sync::{broadcast, mpsc};
use tracing::debug;
use ulid::Ulid;

use stem::events::{Event, Integration, Mode};

use crate::protocol::{terminal_event_frame, terminal_output_frame, terminal_status_frame};
use crate::transport::{send_transport_frame, OutboundSender};

/// Wire chunk ceiling for `terminal_output` payloads (bytes, pre-base64).
pub(crate) const OUTPUT_CHUNK_MAX_BYTES: usize = 16 * 1024;

/// Facts the pump keeps current for the manager (status frames, sentinel
/// decisions, grid-diff delta baselines).
#[derive(Debug)]
pub(crate) struct SessionFacts {
    pub mode: Mode,
    pub integration: Integration,
    /// Any real OSC 133 evidence observed (prompt/command markers or an
    /// Osc133 mode upgrade). Sentinel `D` trailers do not count.
    pub marker_seen: bool,
    /// A shell-integration shim was installed for this session, so genuine
    /// OSC 133 markers are expected once the shell finishes starting up.
    pub integration_expected: bool,
    /// Genuine OSC 133 `A`/`C` markers observed by THIS attachment
    /// (`prompt_ready` / `command_started`). A sentinel trailer can only
    /// produce bare `D` markers, and a reattach replay can mislabel those as
    /// `integration: osc133` — so the sentinel-wrap decision keys off this
    /// flag, never off the replay-derived integration fact.
    pub genuine_osc133: bool,
    pub ring_next_offset: u64,
    pub cols: u16,
    pub rows: u16,
    pub child_pid: i32,
    pub closed: bool,
    /// Grid snapshot from the last observe/send — the `delta` view baseline.
    pub last_observed_screen: Option<Vec<String>>,
}

pub(crate) struct SessionShared {
    pub session_id: String,
    pub facts: std::sync::Mutex<SessionFacts>,
}

/// Internal events used to resolve `terminal_send` awaits.
#[derive(Debug, Clone)]
pub(crate) enum PumpEvent {
    CommandStarted {
        command_id: String,
    },
    CommandFinished {
        command_id: String,
        /// No `command_started` was observed for this command (its start was
        /// synthesized at finish — e.g. sentinel-only integration).
        synthetic_start: bool,
        data: Value,
    },
    Settled {
        data: Value,
    },
    /// OSC 133 `A` observed (used by the fresh-session sentinel grace wait).
    PromptReady,
    /// The session's root process exited or the event stream ended.
    Closed,
}

pub(crate) fn mode_str(mode: Mode) -> &'static str {
    match mode {
        Mode::Shell => "shell",
        Mode::Tui => "tui",
        Mode::Repl => "repl",
        Mode::Unknown => "unknown",
    }
}

pub(crate) fn integration_str(integration: Integration) -> &'static str {
    match integration {
        Integration::Osc133 => "osc133",
        Integration::Sentinel => "sentinel",
        Integration::None => "none",
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        other => format!("SIG{other}"),
    }
}

pub(crate) fn new_command_id() -> String {
    format!("cmd_{}", Ulid::new())
}

/// Consume the session's event stream until it ends. Every wire emission goes
/// through `sender`; await-correlation facts go through `pump_tx` (best
/// effort — no receivers is normal).
pub(crate) async fn run_pump(
    mut events: mpsc::Receiver<Event>,
    sender: OutboundSender,
    shared: Arc<SessionShared>,
    pump_tx: broadcast::Sender<PumpEvent>,
) {
    // stem command_index -> (wire ULID, started-at) for open commands.
    let mut open_commands: HashMap<u64, (String, Instant)> = HashMap::new();
    let session_id = shared.session_id.clone();

    while let Some(event) = events.recv().await {
        let frames = match event {
            Event::Output { offset, bytes } => {
                {
                    let mut facts = shared.facts.lock().unwrap();
                    let end = offset + bytes.len() as u64;
                    if end > facts.ring_next_offset {
                        facts.ring_next_offset = end;
                    }
                }
                // Chunk to <=16 KiB, preserving absolute offsets per chunk.
                bytes
                    .chunks(OUTPUT_CHUNK_MAX_BYTES)
                    .enumerate()
                    .map(|(index, chunk)| {
                        let chunk_offset = offset + (index * OUTPUT_CHUNK_MAX_BYTES) as u64;
                        terminal_output_frame(
                            &session_id,
                            chunk_offset,
                            &BASE64_STANDARD.encode(chunk),
                        )
                    })
                    .collect()
            }
            Event::PromptReady { cwd } => {
                {
                    let mut facts = shared.facts.lock().unwrap();
                    facts.marker_seen = true;
                    facts.genuine_osc133 = true;
                }
                let _ = pump_tx.send(PumpEvent::PromptReady);
                let mut data = Map::new();
                if let Some(cwd) = cwd {
                    data.insert("cwd".into(), Value::String(cwd));
                }
                vec![terminal_event_frame(
                    &session_id,
                    "prompt_ready",
                    Value::Object(data),
                )]
            }
            Event::CommandStarted {
                command_index,
                output_byte_start,
            } => {
                let command_id = new_command_id();
                open_commands.insert(command_index, (command_id.clone(), Instant::now()));
                {
                    let mut facts = shared.facts.lock().unwrap();
                    facts.marker_seen = true;
                    facts.genuine_osc133 = true;
                }
                let _ = pump_tx.send(PumpEvent::CommandStarted {
                    command_id: command_id.clone(),
                });
                vec![terminal_event_frame(
                    &session_id,
                    "command_started",
                    json!({
                        "command_id": command_id,
                        "output_byte_start": output_byte_start,
                    }),
                )]
            }
            Event::CommandFinished {
                command_index,
                exit_code,
                output_byte_start,
                output_byte_end,
            } => {
                let (command_id, duration_ms, synthetic_start) =
                    match open_commands.remove(&command_index) {
                        Some((id, started_at)) => {
                            (id, Some(started_at.elapsed().as_millis() as u64), false)
                        }
                        // Finished without an observed start (sentinel-only):
                        // mint at finish; duration unknown -> omitted.
                        None => (new_command_id(), None, true),
                    };
                let mut data = Map::new();
                data.insert("command_id".into(), Value::String(command_id.clone()));
                if let Some(exit_code) = exit_code {
                    data.insert("exit_code".into(), Value::Number(Number::from(exit_code)));
                }
                if let Some(duration_ms) = duration_ms {
                    data.insert(
                        "duration_ms".into(),
                        Value::Number(Number::from(duration_ms)),
                    );
                }
                data.insert(
                    "output_byte_start".into(),
                    Value::Number(Number::from(output_byte_start)),
                );
                data.insert(
                    "output_byte_end".into(),
                    Value::Number(Number::from(output_byte_end)),
                );
                let data = Value::Object(data);
                let _ = pump_tx.send(PumpEvent::CommandFinished {
                    command_id,
                    synthetic_start,
                    data: data.clone(),
                });
                vec![terminal_event_frame(&session_id, "command_finished", data)]
            }
            Event::ModeChanged { mode, integration } => {
                {
                    let mut facts = shared.facts.lock().unwrap();
                    facts.mode = mode;
                    facts.integration = integration;
                    if integration == Integration::Osc133 {
                        facts.marker_seen = true;
                    }
                }
                vec![terminal_event_frame(
                    &session_id,
                    "mode_changed",
                    json!({
                        "mode": mode_str(mode),
                        "integration": integration_str(integration),
                    }),
                )]
            }
            Event::Settled { mode, quiet_ms } => {
                let data = json!({ "mode": mode_str(mode), "quiet_ms": quiet_ms });
                let _ = pump_tx.send(PumpEvent::Settled { data: data.clone() });
                vec![terminal_event_frame(&session_id, "settled", data)]
            }
            // Folded into prompt_ready.cwd and terminal_status info (§6.7.4:
            // host_cwd is retired in favor of OSC 7 via prompt_ready/status).
            Event::CwdChanged { .. } => Vec::new(),
            Event::OutputGap {
                from_offset,
                resume_offset,
            } => vec![terminal_event_frame(
                &session_id,
                "output_gap",
                json!({ "from_offset": from_offset, "resume_offset": resume_offset }),
            )],
            Event::ChildExited { exit_code, signal } => {
                shared.facts.lock().unwrap().closed = true;
                let _ = pump_tx.send(PumpEvent::Closed);
                let mut data = Map::new();
                if let Some(exit_code) = exit_code {
                    data.insert("exit_code".into(), Value::Number(Number::from(exit_code)));
                }
                if let Some(signal) = signal {
                    data.insert("signal".into(), Value::String(signal_name(signal)));
                }
                vec![
                    terminal_event_frame(&session_id, "child_exited", Value::Object(data)),
                    terminal_status_frame(&session_id, "closed", None),
                ]
            }
            Event::Resized { cols, rows } => {
                let mut facts = shared.facts.lock().unwrap();
                facts.cols = cols;
                facts.rows = rows;
                Vec::new()
            }
        };

        for frame in frames {
            if send_transport_frame(&sender, frame).is_err() {
                debug!(session_id = %session_id, "terminal pump stopping: transport gone");
                return;
            }
        }
    }

    // Event stream ended without a graceful ChildExited: the holder died
    // (e.g. SIGKILL) or its connection dropped. Announce the closure —
    // without this the service kept the session "ready" and every subsequent
    // gesture hit the dead socket with Broken pipe (found live, 2026-08-17 §A
    // holder-crash scenario).
    let announced = shared.facts.lock().unwrap().closed;
    if !announced {
        shared.facts.lock().unwrap().closed = true;
        let _ = send_transport_frame(
            &sender,
            terminal_status_frame(&session_id, "closed", None),
        );
        debug!(session_id = %session_id, "terminal pump ended without child_exited; session closed");
    }

    let _ = pump_tx.send(PumpEvent::Closed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::protocol::Message;

    use crate::transport::TransportSender;

    fn shared() -> Arc<SessionShared> {
        Arc::new(SessionShared {
            session_id: "sess_test".into(),
            facts: std::sync::Mutex::new(SessionFacts {
                mode: Mode::Unknown,
                integration: Integration::None,
                marker_seen: false,
                integration_expected: false,
                genuine_osc133: false,
                ring_next_offset: 0,
                cols: 80,
                rows: 24,
                child_pid: 42,
                closed: false,
                last_observed_screen: None,
            }),
        })
    }

    async fn run_events(events: Vec<Event>) -> (Vec<Value>, Arc<SessionShared>) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        let sender = TransportSender::websocket(tx, false);
        let (event_tx, event_rx) = mpsc::channel(64);
        let (pump_tx, _keep) = broadcast::channel(64);
        let shared = shared();

        for event in events {
            event_tx.send(event).await.unwrap();
        }
        drop(event_tx);
        // These tests end the stream by dropping the channel; pre-mark closed
        // so the pump's end-of-stream closure announcement (tested separately
        // in `stream_end_without_child_exit_announces_closed`) stays out of
        // the per-event frame assertions.
        shared.facts.lock().unwrap().closed = true;
        run_pump(event_rx, sender, Arc::clone(&shared), pump_tx).await;

        let mut frames = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let Message::Text(text) = message {
                frames.push(serde_json::from_str::<Value>(&text).unwrap());
            }
        }
        (frames, shared)
    }

    #[tokio::test]
    async fn stream_end_without_child_exit_announces_closed() {
        // Holder SIGKILL: the event channel just closes with no ChildExited.
        // The pump must announce the closure or the service keeps routing
        // gestures at a dead socket (live §A holder-crash finding).
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        let sender = TransportSender::websocket(tx, false);
        let (event_tx, event_rx) = mpsc::channel(64);
        let (pump_tx, _keep) = broadcast::channel(64);
        let shared = shared();
        drop(event_tx);
        run_pump(event_rx, sender, Arc::clone(&shared), pump_tx).await;

        let mut frames = Vec::new();
        while let Ok(message) = rx.try_recv() {
            if let Message::Text(text) = message {
                frames.push(serde_json::from_str::<Value>(&text).unwrap());
            }
        }
        assert_eq!(frames.len(), 1, "exactly one closure frame: {frames:?}");
        assert_eq!(frames[0]["type"], "terminal_status");
        assert_eq!(frames[0]["state"], "closed");
        assert!(shared.facts.lock().unwrap().closed);
    }

    #[tokio::test]
    async fn output_is_chunked_to_16k_with_preserved_offsets() {
        let bytes = vec![b'x'; OUTPUT_CHUNK_MAX_BYTES + 100];
        let (frames, shared) = run_events(vec![Event::Output {
            offset: 1000,
            bytes: bytes.clone(),
        }])
        .await;

        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0].get("type").and_then(Value::as_str),
            Some("terminal_output")
        );
        assert_eq!(
            frames[0].get("byte_offset").and_then(Value::as_u64),
            Some(1000)
        );
        assert!(frames[0].get("seq").is_none());
        assert_eq!(
            frames[1].get("byte_offset").and_then(Value::as_u64),
            Some(1000 + OUTPUT_CHUNK_MAX_BYTES as u64)
        );
        let first = BASE64_STANDARD
            .decode(frames[0].get("data").and_then(Value::as_str).unwrap())
            .unwrap();
        let second = BASE64_STANDARD
            .decode(frames[1].get("data").and_then(Value::as_str).unwrap())
            .unwrap();
        assert_eq!(first.len(), OUTPUT_CHUNK_MAX_BYTES);
        assert_eq!(second.len(), 100);
        assert_eq!([first, second].concat(), bytes);
        assert_eq!(
            shared.facts.lock().unwrap().ring_next_offset,
            1000 + bytes.len() as u64
        );
    }

    #[tokio::test]
    async fn command_lifecycle_mints_ulids_and_durations() {
        let (frames, _) = run_events(vec![
            Event::CommandStarted {
                command_index: 0,
                output_byte_start: 10,
            },
            Event::CommandFinished {
                command_index: 0,
                exit_code: Some(1),
                output_byte_start: 10,
                output_byte_end: 90,
            },
        ])
        .await;

        assert_eq!(frames.len(), 2);
        let started = &frames[0];
        assert_eq!(
            started.get("event").and_then(Value::as_str),
            Some("command_started")
        );
        let started_id = started
            .get("data")
            .and_then(|d| d.get("command_id"))
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        assert!(started_id.starts_with("cmd_"));

        let finished = &frames[1];
        assert_eq!(
            finished.get("event").and_then(Value::as_str),
            Some("command_finished")
        );
        let data = finished.get("data").unwrap();
        assert_eq!(
            data.get("command_id").and_then(Value::as_str),
            Some(started_id.as_str())
        );
        assert_eq!(data.get("exit_code").and_then(Value::as_i64), Some(1));
        assert!(data.get("duration_ms").and_then(Value::as_u64).is_some());
        assert_eq!(
            data.get("output_byte_start").and_then(Value::as_u64),
            Some(10)
        );
        assert_eq!(
            data.get("output_byte_end").and_then(Value::as_u64),
            Some(90)
        );
    }

    #[tokio::test]
    async fn finished_without_started_omits_duration() {
        let (frames, _) = run_events(vec![Event::CommandFinished {
            command_index: 7,
            exit_code: Some(0),
            output_byte_start: 0,
            output_byte_end: 12,
        }])
        .await;

        assert_eq!(frames.len(), 1);
        let data = frames[0].get("data").unwrap();
        assert!(data.get("duration_ms").is_none());
        assert!(data
            .get("command_id")
            .and_then(Value::as_str)
            .unwrap()
            .starts_with("cmd_"));
    }

    #[tokio::test]
    async fn child_exit_emits_event_then_closed_status() {
        let (frames, shared) = run_events(vec![Event::ChildExited {
            exit_code: None,
            signal: Some(15),
        }])
        .await;

        assert_eq!(frames.len(), 2);
        assert_eq!(
            frames[0].get("event").and_then(Value::as_str),
            Some("child_exited")
        );
        assert_eq!(
            frames[0]
                .get("data")
                .and_then(|d| d.get("signal"))
                .and_then(Value::as_str),
            Some("SIGTERM")
        );
        assert_eq!(
            frames[1].get("type").and_then(Value::as_str),
            Some("terminal_status")
        );
        assert_eq!(
            frames[1].get("state").and_then(Value::as_str),
            Some("closed")
        );
        assert!(shared.facts.lock().unwrap().closed);
    }

    #[tokio::test]
    async fn mode_and_settled_and_gap_events_map_to_wire_vocabulary() {
        let (frames, shared) = run_events(vec![
            Event::ModeChanged {
                mode: Mode::Shell,
                integration: Integration::Osc133,
            },
            Event::Settled {
                mode: Mode::Tui,
                quiet_ms: 300,
            },
            Event::OutputGap {
                from_offset: 5,
                resume_offset: 900,
            },
            Event::CwdChanged { cwd: "/tmp".into() },
        ])
        .await;

        // CwdChanged is folded (no frame of its own).
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames[0]
                .get("data")
                .and_then(|d| d.get("mode"))
                .and_then(Value::as_str),
            Some("shell")
        );
        assert_eq!(
            frames[0]
                .get("data")
                .and_then(|d| d.get("integration"))
                .and_then(Value::as_str),
            Some("osc133")
        );
        assert_eq!(
            frames[1].get("event").and_then(Value::as_str),
            Some("settled")
        );
        assert_eq!(
            frames[1]
                .get("data")
                .and_then(|d| d.get("quiet_ms"))
                .and_then(Value::as_u64),
            Some(300)
        );
        assert_eq!(
            frames[2].get("event").and_then(Value::as_str),
            Some("output_gap")
        );
        let facts = shared.facts.lock().unwrap();
        assert!(facts.marker_seen);
        assert_eq!(facts.integration, Integration::Osc133);
    }
}
