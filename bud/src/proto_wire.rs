use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::util::{new_message_id, now_millis};

const BUD_ENVELOPE_VERSION: u32 = 1;
const WIRE_VARINT: u8 = 0;
const WIRE_64_BIT: u8 = 1;
const WIRE_LENGTH_DELIMITED: u8 = 2;
const WIRE_32_BIT: u8 = 5;
const LEGACY_JSON_PAYLOAD_FIELD: u32 = 100;
const TYPED_FRAME_JSON_FIELD: u32 = 99;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrafficClass {
    Control = 1,
    Interactive = 2,
    ProxyActive = 3,
    Bulk = 4,
    Telemetry = 5,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvelopeTransportKind {
    WebSocket = 1,
    H2Grpc = 2,
    H2Data = 3,
    Quic = 4,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LegacyJsonPayload {
    pub json: Vec<u8>,
    pub frame_type: Option<String>,
    pub proto: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LegacyJsonEnvelope {
    pub envelope_version: u32,
    pub message_id: String,
    pub sent_at: String,
    pub traffic_class: TrafficClass,
    pub transport_kind: Option<EnvelopeTransportKind>,
    pub payload: LegacyJsonPayload,
}

pub fn encode_legacy_json_frame(frame: &Value) -> Result<Vec<u8>> {
    let frame_type = frame
        .get("type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let proto = frame
        .get("proto")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let message_id = frame
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(new_message_id);
    let sent_at = frame
        .get("ts")
        .and_then(Value::as_u64)
        .map(timestamp_millis_to_rfc3339)
        .unwrap_or_else(|| timestamp_millis_to_rfc3339(now_millis()));
    let traffic_class = traffic_class_for_frame(frame);
    let json = serde_json::to_vec(frame)?;

    encode_json_frame_envelope(
        &message_id,
        &sent_at,
        traffic_class,
        EnvelopeTransportKind::WebSocket,
        frame_type.as_deref(),
        proto.as_deref(),
        &json,
        PayloadEncoding::TypedFieldLevelWhenKnown,
    )
}

pub fn encode_bud_frame(frame: &Value) -> Result<Vec<u8>> {
    encode_legacy_json_frame(frame)
}

pub fn encode_legacy_json_envelope(
    message_id: &str,
    sent_at: &str,
    traffic_class: TrafficClass,
    transport_kind: EnvelopeTransportKind,
    frame_type: Option<&str>,
    proto: Option<&str>,
    legacy_json: &[u8],
) -> Result<Vec<u8>> {
    encode_json_frame_envelope(
        message_id,
        sent_at,
        traffic_class,
        transport_kind,
        frame_type,
        proto,
        legacy_json,
        PayloadEncoding::LegacyJson,
    )
}

pub fn encode_typed_json_envelope(
    message_id: &str,
    sent_at: &str,
    traffic_class: TrafficClass,
    transport_kind: EnvelopeTransportKind,
    frame_type: Option<&str>,
    proto: Option<&str>,
    legacy_json: &[u8],
) -> Result<Vec<u8>> {
    encode_json_frame_envelope(
        message_id,
        sent_at,
        traffic_class,
        transport_kind,
        frame_type,
        proto,
        legacy_json,
        PayloadEncoding::TypedFrameJsonWhenKnown,
    )
}

fn encode_json_frame_envelope(
    message_id: &str,
    sent_at: &str,
    traffic_class: TrafficClass,
    transport_kind: EnvelopeTransportKind,
    frame_type: Option<&str>,
    proto: Option<&str>,
    legacy_json: &[u8],
    payload_encoding: PayloadEncoding,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write_uint32(&mut out, 1, BUD_ENVELOPE_VERSION);
    write_string(&mut out, 2, message_id);
    write_string(&mut out, 10, sent_at);
    write_enum(&mut out, 11, traffic_class as u64);
    write_enum(&mut out, 12, transport_kind as u64);

    if matches!(
        payload_encoding,
        PayloadEncoding::TypedFrameJsonWhenKnown | PayloadEncoding::TypedFieldLevelWhenKnown
    ) {
        if let Some(field_number) = frame_type.and_then(payload_field_for_frame_type) {
            let mut payload = Vec::new();
            if payload_encoding == PayloadEncoding::TypedFieldLevelWhenKnown {
                let field_level_payload = match serde_json::from_slice::<Value>(legacy_json) {
                    Ok(frame) => {
                        encode_field_level_payload(frame_type.unwrap_or_default(), &frame)?
                    }
                    Err(_) => None,
                };
                if let Some(field_level_payload) = field_level_payload {
                    payload = field_level_payload;
                } else {
                    write_bytes(&mut payload, TYPED_FRAME_JSON_FIELD, legacy_json);
                }
            } else {
                write_bytes(&mut payload, TYPED_FRAME_JSON_FIELD, legacy_json);
            }
            write_bytes(&mut out, field_number, &payload);
            return Ok(out);
        }
    }

    let mut payload = Vec::new();
    write_bytes(&mut payload, 1, legacy_json);
    if let Some(frame_type) = frame_type {
        write_string(&mut payload, 2, frame_type);
    }
    if let Some(proto) = proto {
        write_string(&mut payload, 3, proto);
    }
    write_bytes(&mut out, LEGACY_JSON_PAYLOAD_FIELD, &payload);
    Ok(out)
}

pub fn decode_legacy_json_frame(bytes: &[u8]) -> Result<String> {
    let envelope = decode_legacy_json_envelope(bytes)?;
    String::from_utf8(envelope.payload.json).map_err(|err| err.into())
}

pub fn decode_bud_frame(bytes: &[u8]) -> Result<String> {
    decode_legacy_json_frame(bytes)
}

pub fn decode_legacy_json_envelope(bytes: &[u8]) -> Result<LegacyJsonEnvelope> {
    let mut reader = ProtoReader::new(bytes);
    let mut envelope_version: Option<u32> = None;
    let mut message_id: Option<String> = None;
    let mut sent_at: Option<String> = None;
    let mut traffic_class: Option<TrafficClass> = None;
    let mut transport_kind: Option<EnvelopeTransportKind> = None;
    let mut payload: Option<LegacyJsonPayload> = None;
    let mut typed_payload: Option<(&'static str, Vec<u8>)> = None;

    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => envelope_version = Some(reader.read_varint_for_wire_type(wire_type)? as u32),
            2 => message_id = Some(reader.read_string_for_wire_type(wire_type)?),
            10 => sent_at = Some(reader.read_string_for_wire_type(wire_type)?),
            11 => {
                traffic_class = Some(traffic_class_from_proto(
                    reader.read_varint_for_wire_type(wire_type)?,
                ))
            }
            12 => {
                transport_kind = Some(transport_kind_from_proto(
                    reader.read_varint_for_wire_type(wire_type)?,
                ))
            }
            LEGACY_JSON_PAYLOAD_FIELD => {
                payload = Some(decode_legacy_json_payload(
                    reader.read_bytes_for_wire_type(wire_type)?,
                )?)
            }
            field_number => {
                if let Some(frame_type) = frame_type_for_payload_field(field_number) {
                    typed_payload = Some((
                        frame_type,
                        reader.read_bytes_for_wire_type(wire_type)?.to_vec(),
                    ));
                } else {
                    reader.skip(wire_type)?;
                }
            }
        }
    }

    let envelope_version = envelope_version.ok_or_else(|| anyhow!("missing envelope_version"))?;
    if envelope_version != BUD_ENVELOPE_VERSION {
        bail!("unsupported envelope_version: {}", envelope_version);
    }
    let message_id = message_id.ok_or_else(|| anyhow!("missing message_id"))?;
    let sent_at = sent_at.ok_or_else(|| anyhow!("missing sent_at"))?;
    let payload = match (payload, typed_payload) {
        (Some(payload), _) => payload,
        (None, Some((frame_type, bytes))) => {
            decode_typed_json_payload(&bytes, frame_type, &message_id, &sent_at)?
        }
        (None, None) => bail!("missing legacy_json payload"),
    };

    Ok(LegacyJsonEnvelope {
        envelope_version,
        message_id,
        sent_at,
        traffic_class: traffic_class.ok_or_else(|| anyhow!("missing traffic_class"))?,
        transport_kind,
        payload,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PayloadEncoding {
    LegacyJson,
    TypedFrameJsonWhenKnown,
    TypedFieldLevelWhenKnown,
}

pub fn traffic_class_for_frame_type(frame_type: &str) -> TrafficClass {
    if frame_type == "stream_data" {
        TrafficClass::ProxyActive
    } else if frame_type == "stream_credit"
        || frame_type == "stream_reset"
        || frame_type == "stream_close"
    {
        TrafficClass::Control
    } else if frame_type == "terminal_output"
        || frame_type == "terminal_send"
        || frame_type == "terminal_input"
        || frame_type.starts_with("terminal_")
    {
        TrafficClass::Interactive
    } else {
        TrafficClass::Control
    }
}

pub fn traffic_class_for_frame(frame: &Value) -> TrafficClass {
    let frame_type = frame.get("type").and_then(Value::as_str).unwrap_or("");
    if frame_type == "stream_data" {
        return match frame.get("stream_type").and_then(Value::as_str) {
            Some("file_read") => TrafficClass::Bulk,
            _ => TrafficClass::ProxyActive,
        };
    }
    traffic_class_for_frame_type(frame_type)
}

fn decode_legacy_json_payload(bytes: &[u8]) -> Result<LegacyJsonPayload> {
    let mut reader = ProtoReader::new(bytes);
    let mut json: Option<Vec<u8>> = None;
    let mut frame_type: Option<String> = None;
    let mut proto: Option<String> = None;

    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => json = Some(reader.read_bytes_for_wire_type(wire_type)?.to_vec()),
            2 => frame_type = Some(reader.read_string_for_wire_type(wire_type)?),
            3 => proto = Some(reader.read_string_for_wire_type(wire_type)?),
            _ => reader.skip(wire_type)?,
        }
    }

    Ok(LegacyJsonPayload {
        json: json.ok_or_else(|| anyhow!("legacy_json payload missing json bytes"))?,
        frame_type,
        proto,
    })
}

fn decode_typed_json_payload(
    bytes: &[u8],
    frame_type: &str,
    message_id: &str,
    sent_at: &str,
) -> Result<LegacyJsonPayload> {
    if is_field_level_frame_type(frame_type) && !payload_contains_frame_json(bytes)? {
        let frame = decode_field_level_payload(bytes, frame_type, message_id, sent_at)?;
        return Ok(LegacyJsonPayload {
            json: serde_json::to_vec(&frame)?,
            frame_type: Some(frame_type.to_string()),
            proto: Some(proto_for_frame_type(frame_type).to_string()),
        });
    }

    let mut reader = ProtoReader::new(bytes);
    let mut json: Option<Vec<u8>> = None;

    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            TYPED_FRAME_JSON_FIELD => {
                json = Some(reader.read_bytes_for_wire_type(wire_type)?.to_vec())
            }
            _ => reader.skip(wire_type)?,
        }
    }

    Ok(LegacyJsonPayload {
        json: json.ok_or_else(|| anyhow!("typed protobuf payload missing frame_json bytes"))?,
        frame_type: Some(frame_type.to_string()),
        proto: Some(proto_for_frame_type(frame_type).to_string()),
    })
}

fn encode_field_level_payload(frame_type: &str, frame: &Value) -> Result<Option<Vec<u8>>> {
    if !is_field_level_frame_type(frame_type) {
        return Ok(None);
    }

    let mut out = Vec::new();
    match frame_type {
        "error" => {
            write_optional_string(&mut out, 1, string_value(frame, "code"));
            write_optional_string(&mut out, 2, string_value(frame, "message"));
            write_optional_bool(&mut out, 3, bool_value(frame, "retryable"));
            write_string_map(&mut out, 4, string_map_value(frame.get("details"))?);
        }
        "hello" => {
            write_optional_string(&mut out, 1, string_value(frame, "name"));
            write_optional_string(&mut out, 2, string_value(frame, "os"));
            write_optional_string(&mut out, 3, string_value(frame, "arch"));
            write_optional_string(&mut out, 4, string_value(frame, "version"));
            write_optional_string(&mut out, 5, string_value(frame, "installation_id"));
            write_optional_string(&mut out, 6, string_value(frame, "token"));
            write_optional_string(&mut out, 7, string_value(frame, "bud_id"));
            write_optional_json_bytes(&mut out, 8, frame.get("capabilities"))?;
        }
        "hello_ack" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "bud_id"));
            write_optional_u32(&mut out, 3, u64_value(frame, "heartbeat_sec"));
            write_optional_string(&mut out, 4, string_value(frame, "device_secret"));
        }
        "hello_challenge" => write_optional_string(&mut out, 1, string_value(frame, "nonce")),
        "hello_proof" => {
            write_optional_string(&mut out, 1, string_value(frame, "bud_id"));
            write_optional_string(&mut out, 2, string_value(frame, "hmac"));
        }
        "heartbeat" | "heartbeat_ack" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
        }
        "terminal_ensure" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_message(
                &mut out,
                2,
                encode_terminal_ensure_config(frame.get("config"))?,
            );
        }
        "terminal_status" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "state"));
            write_optional_json_bytes(&mut out, 3, frame.get("info"))?;
        }
        "terminal_input" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_base64_bytes(&mut out, 2, string_value(frame, "data"))?;
            write_optional_message(&mut out, 3, encode_await_ready(frame.get("await_ready"))?);
        }
        "terminal_resize" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_u32(&mut out, 2, u64_value(frame, "cols"));
            write_optional_u32(&mut out, 3, u64_value(frame, "rows"));
        }
        "terminal_close" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "reason"));
        }
        "terminal_send" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "request_id"));
            write_optional_string(&mut out, 3, string_value(frame, "text"));
            write_optional_bool(&mut out, 4, bool_value(frame, "submit"));
            write_optional_string(&mut out, 5, string_value(frame, "key"));
            write_optional_u64(&mut out, 6, u64_value(frame, "observe_after_ms"));
            write_optional_string(&mut out, 7, string_value(frame, "wait_for"));
            write_optional_u64(&mut out, 8, u64_value(frame, "timeout_ms"));
        }
        "terminal_send_result" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "request_id"));
            write_optional_bool(&mut out, 3, bool_value(frame, "submitted"));
            write_optional_json_bytes(&mut out, 4, frame.get("delta"))?;
            write_optional_json_bytes(&mut out, 5, frame.get("readiness"))?;
            write_optional_nullable_string(&mut out, 6, frame.get("error"));
        }
        "terminal_observe" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "request_id"));
            write_optional_string(&mut out, 3, string_value(frame, "view"));
            write_optional_i32(&mut out, 4, i64_value(frame, "lines"));
            write_optional_string(&mut out, 5, string_value(frame, "wait_for"));
            write_optional_u64(&mut out, 6, u64_value(frame, "timeout_ms"));
        }
        "terminal_observe_result" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_string(&mut out, 2, string_value(frame, "request_id"));
            write_optional_string(&mut out, 3, string_value(frame, "view"));
            write_optional_base64_bytes(&mut out, 4, string_value(frame, "output"))?;
            write_optional_u64(&mut out, 5, u64_value(frame, "output_bytes"));
            write_optional_u64(&mut out, 6, u64_value(frame, "lines_captured"));
            write_optional_bool(&mut out, 7, bool_value(frame, "changed"));
            write_optional_bool(&mut out, 8, bool_value(frame, "truncated"));
            write_optional_json_bytes(&mut out, 9, frame.get("readiness"))?;
            write_optional_nullable_string(&mut out, 10, frame.get("error"));
        }
        "terminal_output" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_u64(&mut out, 2, u64_value(frame, "seq"));
            write_optional_base64_bytes(&mut out, 3, string_value(frame, "data"))?;
            write_optional_u64(&mut out, 4, u64_value(frame, "byte_offset"));
        }
        "terminal_ready" => {
            write_optional_string(&mut out, 1, string_value(frame, "session_id"));
            write_optional_json_bytes(&mut out, 2, frame.get("assessment"))?;
        }
        "reconnect_report" => {
            write_optional_string(&mut out, 1, string_value(frame, "bud_id"));
            write_optional_string(&mut out, 2, string_value(frame, "device_session_id"));
            write_repeated_messages(
                &mut out,
                3,
                array_value(frame, "operations")
                    .iter()
                    .map(encode_operation_status)
                    .collect::<Result<Vec<_>>>()?,
            );
            write_repeated_messages(
                &mut out,
                4,
                array_value(frame, "streams")
                    .iter()
                    .map(encode_stream_status)
                    .collect::<Result<Vec<_>>>()?,
            );
            write_optional_string(&mut out, 5, string_value(frame, "local_policy_version"));
            write_repeated_strings(&mut out, 6, string_array_value(frame, "terminal_sessions"));
        }
        "reconciliation_decision" => {
            write_repeated_messages(
                &mut out,
                1,
                array_value(frame, "operations")
                    .iter()
                    .map(encode_operation_status)
                    .collect::<Result<Vec<_>>>()?,
            );
            write_repeated_messages(
                &mut out,
                2,
                array_value(frame, "streams")
                    .iter()
                    .map(encode_stream_status)
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        _ => return Ok(None),
    }

    Ok(Some(out))
}

fn decode_field_level_payload(
    bytes: &[u8],
    frame_type: &str,
    message_id: &str,
    sent_at: &str,
) -> Result<Value> {
    let mut frame = base_frame(frame_type, message_id, sent_at);
    let mut reader = ProtoReader::new(bytes);

    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match frame_type {
            "error" => read_bud_error_field(&mut frame, &mut reader, field_number, wire_type)?,
            "hello" => read_hello_field(&mut frame, &mut reader, field_number, wire_type)?,
            "hello_ack" => read_hello_ack_field(&mut frame, &mut reader, field_number, wire_type)?,
            "hello_challenge" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "nonce",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "hello_proof" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "bud_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_string(
                        &mut frame,
                        "hmac",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "heartbeat" | "heartbeat_ack" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_ensure" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    frame.insert(
                        "config".to_string(),
                        decode_terminal_ensure_config(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_status" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_string(
                        &mut frame,
                        "state",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 3 {
                    frame.insert(
                        "info".to_string(),
                        serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_input" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_string(
                        &mut frame,
                        "data",
                        BASE64_STANDARD.encode(reader.read_bytes_for_wire_type(wire_type)?),
                    );
                } else if field_number == 3 {
                    frame.insert(
                        "await_ready".to_string(),
                        decode_await_ready(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_resize" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_u64(
                        &mut frame,
                        "cols",
                        reader.read_varint_for_wire_type(wire_type)?,
                    );
                } else if field_number == 3 {
                    insert_u64(
                        &mut frame,
                        "rows",
                        reader.read_varint_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_close" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_string(
                        &mut frame,
                        "reason",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_send" => {
                read_terminal_send_field(&mut frame, &mut reader, field_number, wire_type)?
            }
            "terminal_send_result" => {
                read_terminal_send_result_field(&mut frame, &mut reader, field_number, wire_type)?
            }
            "terminal_observe" => {
                read_terminal_observe_field(&mut frame, &mut reader, field_number, wire_type)?
            }
            "terminal_observe_result" => read_terminal_observe_result_field(
                &mut frame,
                &mut reader,
                field_number,
                wire_type,
            )?,
            "terminal_output" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    insert_u64(
                        &mut frame,
                        "seq",
                        reader.read_varint_for_wire_type(wire_type)?,
                    );
                } else if field_number == 3 {
                    insert_string(
                        &mut frame,
                        "data",
                        BASE64_STANDARD.encode(reader.read_bytes_for_wire_type(wire_type)?),
                    );
                } else if field_number == 4 {
                    insert_u64(
                        &mut frame,
                        "byte_offset",
                        reader.read_varint_for_wire_type(wire_type)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "terminal_ready" => {
                if field_number == 1 {
                    insert_string(
                        &mut frame,
                        "session_id",
                        reader.read_string_for_wire_type(wire_type)?,
                    );
                } else if field_number == 2 {
                    frame.insert(
                        "assessment".to_string(),
                        serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            "reconnect_report" => {
                read_reconnect_report_field(&mut frame, &mut reader, field_number, wire_type)?
            }
            "reconciliation_decision" => {
                if field_number == 1 {
                    push_array_value(
                        &mut frame,
                        "operations",
                        decode_operation_status(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else if field_number == 2 {
                    push_array_value(
                        &mut frame,
                        "streams",
                        decode_stream_status(reader.read_bytes_for_wire_type(wire_type)?)?,
                    );
                } else {
                    reader.skip(wire_type)?;
                }
            }
            _ => reader.skip(wire_type)?,
        }
    }

    if (frame_type == "terminal_send_result" || frame_type == "terminal_observe_result")
        && !frame.contains_key("error")
    {
        frame.insert("error".to_string(), Value::Null);
    }

    Ok(Value::Object(frame))
}

fn encode_terminal_ensure_config(value: Option<&Value>) -> Result<Option<Vec<u8>>> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    write_optional_string(&mut out, 1, string_value(value, "shell"));
    write_optional_string(&mut out, 2, string_value(value, "cwd"));
    write_string_map(&mut out, 3, string_map_value(value.get("env"))?);
    write_optional_u32(&mut out, 4, u64_value(value, "cols"));
    write_optional_u32(&mut out, 5, u64_value(value, "rows"));
    Ok(Some(out))
}

fn decode_terminal_ensure_config(bytes: &[u8]) -> Result<Value> {
    let mut reader = ProtoReader::new(bytes);
    let mut config = Map::new();
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => insert_string(
                &mut config,
                "shell",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            2 => insert_string(
                &mut config,
                "cwd",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            3 => merge_string_map_entry(
                &mut config,
                "env",
                reader.read_bytes_for_wire_type(wire_type)?,
            )?,
            4 => insert_u64(
                &mut config,
                "cols",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            5 => insert_u64(
                &mut config,
                "rows",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(Value::Object(config))
}

fn encode_await_ready(value: Option<&Value>) -> Result<Option<Vec<u8>>> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    write_optional_bool(&mut out, 1, bool_value(value, "enabled"));
    write_optional_u64(&mut out, 2, u64_value(value, "quiescence_ms"));
    write_optional_u64(&mut out, 3, u64_value(value, "max_wait_ms"));
    write_optional_bool(&mut out, 4, bool_value(value, "activity_based"));
    write_optional_u64(&mut out, 5, u64_value(value, "activity_interval_ms"));
    write_optional_u32(&mut out, 6, u64_value(value, "activity_stable_count"));
    write_optional_u64(&mut out, 7, u64_value(value, "activity_initial_delay_ms"));
    Ok(Some(out))
}

fn decode_await_ready(bytes: &[u8]) -> Result<Value> {
    let mut reader = ProtoReader::new(bytes);
    let mut await_ready = Map::new();
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => insert_bool(
                &mut await_ready,
                "enabled",
                reader.read_varint_for_wire_type(wire_type)? != 0,
            ),
            2 => insert_u64(
                &mut await_ready,
                "quiescence_ms",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            3 => insert_u64(
                &mut await_ready,
                "max_wait_ms",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            4 => insert_bool(
                &mut await_ready,
                "activity_based",
                reader.read_varint_for_wire_type(wire_type)? != 0,
            ),
            5 => insert_u64(
                &mut await_ready,
                "activity_interval_ms",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            6 => insert_u64(
                &mut await_ready,
                "activity_stable_count",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            7 => insert_u64(
                &mut await_ready,
                "activity_initial_delay_ms",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(Value::Object(await_ready))
}

fn encode_operation_status(value: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write_optional_string(&mut out, 1, string_value(value, "operation_id"));
    write_optional_enum(
        &mut out,
        2,
        operation_state_proto(string_value(value, "state").unwrap_or_default()),
    );
    write_optional_message(&mut out, 3, encode_bud_error(value.get("error"))?);
    write_optional_string(&mut out, 4, string_value(value, "operation_type"));
    write_optional_string(&mut out, 5, string_value(value, "updated_at"));
    Ok(out)
}

fn decode_operation_status(bytes: &[u8]) -> Result<Value> {
    let mut reader = ProtoReader::new(bytes);
    let mut status = Map::new();
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => insert_string(
                &mut status,
                "operation_id",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            2 => insert_string(
                &mut status,
                "state",
                operation_state_json(reader.read_varint_for_wire_type(wire_type)?).to_string(),
            ),
            3 => {
                status.insert(
                    "error".to_string(),
                    decode_bud_error(reader.read_bytes_for_wire_type(wire_type)?)?,
                );
            }
            4 => insert_string(
                &mut status,
                "operation_type",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            5 => insert_string(
                &mut status,
                "updated_at",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(Value::Object(status))
}

fn encode_stream_status(value: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write_optional_string(&mut out, 1, string_value(value, "stream_id"));
    write_optional_string(&mut out, 2, string_value(value, "operation_id"));
    write_optional_enum(
        &mut out,
        3,
        stream_type_proto(string_value(value, "stream_type").unwrap_or_default()),
    );
    write_optional_enum(
        &mut out,
        4,
        stream_state_proto(string_value(value, "state").unwrap_or_default()),
    );
    write_optional_u64(&mut out, 5, u64_value(value, "send_offset"));
    write_optional_u64(&mut out, 6, u64_value(value, "receive_offset"));
    write_optional_enum(
        &mut out,
        7,
        stream_reset_reason_proto(string_value(value, "reset_reason").unwrap_or_default()),
    );
    write_optional_message(&mut out, 8, encode_bud_error(value.get("error"))?);
    write_optional_string(&mut out, 9, string_value(value, "updated_at"));
    Ok(out)
}

fn decode_stream_status(bytes: &[u8]) -> Result<Value> {
    let mut reader = ProtoReader::new(bytes);
    let mut status = Map::new();
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => insert_string(
                &mut status,
                "stream_id",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            2 => insert_string(
                &mut status,
                "operation_id",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            3 => insert_string(
                &mut status,
                "stream_type",
                stream_type_json(reader.read_varint_for_wire_type(wire_type)?).to_string(),
            ),
            4 => insert_string(
                &mut status,
                "state",
                stream_state_json(reader.read_varint_for_wire_type(wire_type)?).to_string(),
            ),
            5 => insert_u64(
                &mut status,
                "send_offset",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            6 => insert_u64(
                &mut status,
                "receive_offset",
                reader.read_varint_for_wire_type(wire_type)?,
            ),
            7 => insert_string(
                &mut status,
                "reset_reason",
                stream_reset_reason_json(reader.read_varint_for_wire_type(wire_type)?).to_string(),
            ),
            8 => {
                status.insert(
                    "error".to_string(),
                    decode_bud_error(reader.read_bytes_for_wire_type(wire_type)?)?,
                );
            }
            9 => insert_string(
                &mut status,
                "updated_at",
                reader.read_string_for_wire_type(wire_type)?,
            ),
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(Value::Object(status))
}

fn encode_bud_error(value: Option<&Value>) -> Result<Option<Vec<u8>>> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    write_optional_string(&mut out, 1, string_value(value, "code"));
    write_optional_string(&mut out, 2, string_value(value, "message"));
    write_optional_bool(&mut out, 3, bool_value(value, "retryable"));
    write_string_map(&mut out, 4, string_map_value(value.get("details"))?);
    Ok(Some(out))
}

fn decode_bud_error(bytes: &[u8]) -> Result<Value> {
    let mut reader = ProtoReader::new(bytes);
    let mut error = Map::new();
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        read_bud_error_field(&mut error, &mut reader, field_number, wire_type)?;
    }
    Ok(Value::Object(error))
}

fn read_bud_error_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(frame, "code", reader.read_string_for_wire_type(wire_type)?),
        2 => insert_string(
            frame,
            "message",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_bool(
            frame,
            "retryable",
            reader.read_varint_for_wire_type(wire_type)? != 0,
        ),
        4 => merge_string_map_entry(
            frame,
            "details",
            reader.read_bytes_for_wire_type(wire_type)?,
        )?,
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_hello_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(frame, "name", reader.read_string_for_wire_type(wire_type)?),
        2 => insert_string(frame, "os", reader.read_string_for_wire_type(wire_type)?),
        3 => insert_string(frame, "arch", reader.read_string_for_wire_type(wire_type)?),
        4 => insert_string(
            frame,
            "version",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        5 => insert_string(
            frame,
            "installation_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        6 => insert_string(frame, "token", reader.read_string_for_wire_type(wire_type)?),
        7 => insert_string(
            frame,
            "bud_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        8 => {
            frame.insert(
                "capabilities".to_string(),
                serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
            );
        }
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_hello_ack_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "bud_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_u64(
            frame,
            "heartbeat_sec",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        4 => insert_string(
            frame,
            "device_secret",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_terminal_send_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "request_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_string(frame, "text", reader.read_string_for_wire_type(wire_type)?),
        4 => insert_bool(
            frame,
            "submit",
            reader.read_varint_for_wire_type(wire_type)? != 0,
        ),
        5 => insert_string(frame, "key", reader.read_string_for_wire_type(wire_type)?),
        6 => insert_u64(
            frame,
            "observe_after_ms",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        7 => insert_string(
            frame,
            "wait_for",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        8 => insert_u64(
            frame,
            "timeout_ms",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_terminal_send_result_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "request_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_bool(
            frame,
            "submitted",
            reader.read_varint_for_wire_type(wire_type)? != 0,
        ),
        4 => {
            frame.insert(
                "delta".to_string(),
                serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
            );
        }
        5 => {
            frame.insert(
                "readiness".to_string(),
                serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
            );
        }
        6 => insert_string(frame, "error", reader.read_string_for_wire_type(wire_type)?),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_terminal_observe_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "request_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_string(frame, "view", reader.read_string_for_wire_type(wire_type)?),
        4 => insert_u64(frame, "lines", reader.read_varint_for_wire_type(wire_type)?),
        5 => insert_string(
            frame,
            "wait_for",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        6 => insert_u64(
            frame,
            "timeout_ms",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_terminal_observe_result_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "request_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => insert_string(frame, "view", reader.read_string_for_wire_type(wire_type)?),
        4 => insert_string(
            frame,
            "output",
            BASE64_STANDARD.encode(reader.read_bytes_for_wire_type(wire_type)?),
        ),
        5 => insert_u64(
            frame,
            "output_bytes",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        6 => insert_u64(
            frame,
            "lines_captured",
            reader.read_varint_for_wire_type(wire_type)?,
        ),
        7 => insert_bool(
            frame,
            "changed",
            reader.read_varint_for_wire_type(wire_type)? != 0,
        ),
        8 => insert_bool(
            frame,
            "truncated",
            reader.read_varint_for_wire_type(wire_type)? != 0,
        ),
        9 => {
            frame.insert(
                "readiness".to_string(),
                serde_json::from_slice(reader.read_bytes_for_wire_type(wire_type)?)?,
            );
        }
        10 => insert_string(frame, "error", reader.read_string_for_wire_type(wire_type)?),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn read_reconnect_report_field(
    frame: &mut Map<String, Value>,
    reader: &mut ProtoReader<'_>,
    field_number: u32,
    wire_type: u8,
) -> Result<()> {
    match field_number {
        1 => insert_string(
            frame,
            "bud_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        2 => insert_string(
            frame,
            "device_session_id",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        3 => push_array_value(
            frame,
            "operations",
            decode_operation_status(reader.read_bytes_for_wire_type(wire_type)?)?,
        ),
        4 => push_array_value(
            frame,
            "streams",
            decode_stream_status(reader.read_bytes_for_wire_type(wire_type)?)?,
        ),
        5 => insert_string(
            frame,
            "local_policy_version",
            reader.read_string_for_wire_type(wire_type)?,
        ),
        6 => push_array_value(
            frame,
            "terminal_sessions",
            Value::String(reader.read_string_for_wire_type(wire_type)?),
        ),
        _ => reader.skip(wire_type)?,
    }
    Ok(())
}

fn payload_contains_frame_json(bytes: &[u8]) -> Result<bool> {
    let mut reader = ProtoReader::new(bytes);
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        if field_number == TYPED_FRAME_JSON_FIELD {
            return Ok(true);
        }
        reader.skip(wire_type)?;
    }
    Ok(false)
}

fn is_field_level_frame_type(frame_type: &str) -> bool {
    matches!(
        frame_type,
        "error"
            | "hello"
            | "hello_ack"
            | "hello_challenge"
            | "hello_proof"
            | "heartbeat"
            | "heartbeat_ack"
            | "terminal_ensure"
            | "terminal_status"
            | "terminal_input"
            | "terminal_resize"
            | "terminal_close"
            | "terminal_send"
            | "terminal_send_result"
            | "terminal_observe"
            | "terminal_observe_result"
            | "terminal_output"
            | "terminal_ready"
            | "reconnect_report"
            | "reconciliation_decision"
    )
}

fn base_frame(frame_type: &str, message_id: &str, sent_at: &str) -> Map<String, Value> {
    let mut frame = Map::new();
    frame.insert(
        "proto".to_string(),
        Value::String(proto_for_frame_type(frame_type).to_string()),
    );
    frame.insert("type".to_string(), Value::String(frame_type.to_string()));
    frame.insert("id".to_string(), Value::String(message_id.to_string()));
    insert_u64(&mut frame, "ts", sent_at_to_millis(sent_at));
    frame.insert("ext".to_string(), Value::Object(Map::new()));
    frame
}

fn sent_at_to_millis(value: &str) -> u64 {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}

fn string_value<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn bool_value(value: &Value, field: &str) -> Option<bool> {
    value.get(field).and_then(Value::as_bool)
}

fn u64_value(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn i64_value(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

fn string_array_value<'a>(value: &'a Value, field: &str) -> Vec<&'a str> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn array_value<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_map_value(value: Option<&Value>) -> Result<Vec<(String, String)>> {
    let Some(Value::Object(map)) = value else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (key, nested) in map {
        let value = match nested {
            Value::String(value) => value.clone(),
            Value::Null => "null".to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            Value::Array(_) | Value::Object(_) => serde_json::to_string(nested)?,
        };
        out.push((key.clone(), value));
    }
    Ok(out)
}

fn insert_string(frame: &mut Map<String, Value>, field: &str, value: String) {
    frame.insert(field.to_string(), Value::String(value));
}

fn insert_bool(frame: &mut Map<String, Value>, field: &str, value: bool) {
    frame.insert(field.to_string(), Value::Bool(value));
}

fn insert_u64(frame: &mut Map<String, Value>, field: &str, value: u64) {
    frame.insert(field.to_string(), Value::Number(value.into()));
}

fn push_array_value(frame: &mut Map<String, Value>, field: &str, value: Value) {
    match frame.get_mut(field) {
        Some(Value::Array(values)) => values.push(value),
        _ => {
            frame.insert(field.to_string(), Value::Array(vec![value]));
        }
    }
}

fn merge_string_map_entry(frame: &mut Map<String, Value>, field: &str, bytes: &[u8]) -> Result<()> {
    let Some((key, value)) = decode_string_map_entry(bytes)? else {
        return Ok(());
    };
    let entry = frame
        .entry(field.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    if let Value::Object(map) = entry {
        map.insert(key, Value::String(value));
    }
    Ok(())
}

fn decode_string_map_entry(bytes: &[u8]) -> Result<Option<(String, String)>> {
    let mut reader = ProtoReader::new(bytes);
    let mut key: Option<String> = None;
    let mut value: Option<String> = None;
    while !reader.done() {
        let (field_number, wire_type) = reader.read_tag()?;
        match field_number {
            1 => key = Some(reader.read_string_for_wire_type(wire_type)?),
            2 => value = Some(reader.read_string_for_wire_type(wire_type)?),
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(key.map(|key| (key, value.unwrap_or_default())))
}

fn operation_state_proto(value: &str) -> u64 {
    match value {
        "offered" => 1,
        "accepted" => 2,
        "rejected" => 3,
        "running" => 4,
        "succeeded" => 5,
        "failed" => 6,
        "canceled" => 7,
        "unknown" => 8,
        "expired" => 9,
        _ => 0,
    }
}

fn operation_state_json(value: u64) -> &'static str {
    match value {
        1 => "offered",
        2 => "accepted",
        3 => "rejected",
        4 => "running",
        5 => "succeeded",
        6 => "failed",
        7 => "canceled",
        9 => "expired",
        _ => "unknown",
    }
}

fn stream_type_proto(value: &str) -> u64 {
    match value {
        "terminal_interactive" => 1,
        "localhost_http_proxy" => 2,
        "file_read" => 3,
        _ => 0,
    }
}

fn stream_type_json(value: u64) -> &'static str {
    match value {
        2 => "localhost_http_proxy",
        3 => "file_read",
        _ => "terminal_interactive",
    }
}

fn stream_state_proto(value: &str) -> u64 {
    match value {
        "opening" => 1,
        "open" => 2,
        "half_closed_local" => 3,
        "half_closed_remote" => 4,
        "closed" => 5,
        "reset" => 6,
        "unknown" => 7,
        "expired" => 8,
        _ => 0,
    }
}

fn stream_state_json(value: u64) -> &'static str {
    match value {
        1 => "opening",
        2 => "open",
        3 => "half_closed_local",
        4 => "half_closed_remote",
        5 => "closed",
        6 => "reset",
        8 => "expired",
        _ => "unknown",
    }
}

fn stream_reset_reason_proto(value: &str) -> u64 {
    match value {
        "canceled" => 1,
        "policy_denied" => 2,
        "transport_lost" => 3,
        "timeout" => 4,
        "backpressure" => 5,
        "protocol_error" => 6,
        "local_error" => 7,
        "remote_error" => 8,
        _ => 0,
    }
}

fn stream_reset_reason_json(value: u64) -> &'static str {
    match value {
        1 => "canceled",
        2 => "policy_denied",
        3 => "transport_lost",
        4 => "timeout",
        5 => "backpressure",
        7 => "local_error",
        8 => "remote_error",
        _ => "protocol_error",
    }
}

fn payload_field_for_frame_type(frame_type: &str) -> Option<u32> {
    Some(match frame_type {
        "error" => 101,
        "hello" => 102,
        "hello_ack" => 103,
        "hello_challenge" => 104,
        "hello_proof" => 105,
        "heartbeat" => 106,
        "heartbeat_ack" => 107,
        "terminal_ensure" => 120,
        "terminal_status" => 121,
        "terminal_input" => 122,
        "terminal_resize" => 123,
        "terminal_close" => 124,
        "terminal_send" => 125,
        "terminal_send_result" => 126,
        "terminal_observe" => 127,
        "terminal_observe_result" => 128,
        "terminal_output" => 129,
        "terminal_ready" => 130,
        "reconnect_report" => 150,
        "reconciliation_decision" => 151,
        "data_attach" => 170,
        "data_attach_ack" => 171,
        "stream_data" => 172,
        "stream_credit" => 173,
        "stream_reset" => 174,
        "stream_close" => 175,
        "proxy_open" => 176,
        "proxy_open_result" => 177,
        "file_open" => 178,
        "file_open_result" => 179,
        _ => return None,
    })
}

fn frame_type_for_payload_field(field_number: u32) -> Option<&'static str> {
    Some(match field_number {
        101 => "error",
        102 => "hello",
        103 => "hello_ack",
        104 => "hello_challenge",
        105 => "hello_proof",
        106 => "heartbeat",
        107 => "heartbeat_ack",
        120 => "terminal_ensure",
        121 => "terminal_status",
        122 => "terminal_input",
        123 => "terminal_resize",
        124 => "terminal_close",
        125 => "terminal_send",
        126 => "terminal_send_result",
        127 => "terminal_observe",
        128 => "terminal_observe_result",
        129 => "terminal_output",
        130 => "terminal_ready",
        150 => "reconnect_report",
        151 => "reconciliation_decision",
        170 => "data_attach",
        171 => "data_attach_ack",
        172 => "stream_data",
        173 => "stream_credit",
        174 => "stream_reset",
        175 => "stream_close",
        176 => "proxy_open",
        177 => "proxy_open_result",
        178 => "file_open",
        179 => "file_open_result",
        _ => return None,
    })
}

fn proto_for_frame_type(frame_type: &str) -> &'static str {
    if frame_type.starts_with("terminal_") {
        "0.2"
    } else {
        "0.1"
    }
}

fn traffic_class_from_proto(value: u64) -> TrafficClass {
    match value {
        2 => TrafficClass::Interactive,
        3 => TrafficClass::ProxyActive,
        4 => TrafficClass::Bulk,
        5 => TrafficClass::Telemetry,
        _ => TrafficClass::Control,
    }
}

fn transport_kind_from_proto(value: u64) -> EnvelopeTransportKind {
    match value {
        2 => EnvelopeTransportKind::H2Grpc,
        3 => EnvelopeTransportKind::H2Data,
        4 => EnvelopeTransportKind::Quic,
        _ => EnvelopeTransportKind::WebSocket,
    }
}

fn timestamp_millis_to_rfc3339(timestamp_millis: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_millis as i64)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn write_uint32(out: &mut Vec<u8>, field_number: u32, value: u32) {
    write_varint_field(out, field_number, value as u64);
}

fn write_enum(out: &mut Vec<u8>, field_number: u32, value: u64) {
    write_varint_field(out, field_number, value);
}

fn write_optional_enum(out: &mut Vec<u8>, field_number: u32, value: u64) {
    if value > 0 {
        write_enum(out, field_number, value);
    }
}

fn write_varint_field(out: &mut Vec<u8>, field_number: u32, value: u64) {
    write_varint(out, ((field_number as u64) << 3) | WIRE_VARINT as u64);
    write_varint(out, value);
}

fn write_string(out: &mut Vec<u8>, field_number: u32, value: &str) {
    write_bytes(out, field_number, value.as_bytes());
}

fn write_optional_string(out: &mut Vec<u8>, field_number: u32, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        write_string(out, field_number, value);
    }
}

fn write_optional_nullable_string(out: &mut Vec<u8>, field_number: u32, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        write_string(out, field_number, value);
    }
}

fn write_optional_bool(out: &mut Vec<u8>, field_number: u32, value: Option<bool>) {
    if let Some(value) = value {
        write_varint_field(out, field_number, if value { 1 } else { 0 });
    }
}

fn write_optional_u32(out: &mut Vec<u8>, field_number: u32, value: Option<u64>) {
    if let Some(value) = value.filter(|value| *value <= u32::MAX as u64) {
        write_varint_field(out, field_number, value);
    }
}

fn write_optional_u64(out: &mut Vec<u8>, field_number: u32, value: Option<u64>) {
    if let Some(value) = value {
        write_varint_field(out, field_number, value);
    }
}

fn write_optional_i32(out: &mut Vec<u8>, field_number: u32, value: Option<i64>) {
    if let Some(value) = value.filter(|value| *value >= 0 && *value <= i32::MAX as i64) {
        write_varint_field(out, field_number, value as u64);
    }
}

fn write_optional_message(out: &mut Vec<u8>, field_number: u32, value: Option<Vec<u8>>) {
    if let Some(value) = value {
        write_bytes(out, field_number, &value);
    }
}

fn write_optional_json_bytes(
    out: &mut Vec<u8>,
    field_number: u32,
    value: Option<&Value>,
) -> Result<()> {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        write_bytes(out, field_number, &serde_json::to_vec(value)?);
    }
    Ok(())
}

fn write_optional_base64_bytes(
    out: &mut Vec<u8>,
    field_number: u32,
    value: Option<&str>,
) -> Result<()> {
    if let Some(value) = value {
        write_bytes(out, field_number, &BASE64_STANDARD.decode(value)?);
    }
    Ok(())
}

fn write_string_map(out: &mut Vec<u8>, field_number: u32, values: Vec<(String, String)>) {
    for (key, value) in values {
        let mut entry = Vec::new();
        write_string(&mut entry, 1, &key);
        write_string(&mut entry, 2, &value);
        write_bytes(out, field_number, &entry);
    }
}

fn write_repeated_messages(out: &mut Vec<u8>, field_number: u32, values: Vec<Vec<u8>>) {
    for value in values {
        write_bytes(out, field_number, &value);
    }
}

fn write_repeated_strings(out: &mut Vec<u8>, field_number: u32, values: Vec<&str>) {
    for value in values {
        write_string(out, field_number, value);
    }
}

fn write_bytes(out: &mut Vec<u8>, field_number: u32, value: &[u8]) {
    write_varint(
        out,
        ((field_number as u64) << 3) | WIRE_LENGTH_DELIMITED as u64,
    );
    write_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

struct ProtoReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ProtoReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn done(&self) -> bool {
        self.offset >= self.bytes.len()
    }

    fn read_tag(&mut self) -> Result<(u32, u8)> {
        let tag = self.read_varint()?;
        Ok(((tag >> 3) as u32, (tag & 0x07) as u8))
    }

    fn read_varint_for_wire_type(&mut self, wire_type: u8) -> Result<u64> {
        if wire_type != WIRE_VARINT {
            bail!("expected varint wire type, got {}", wire_type);
        }
        self.read_varint()
    }

    fn read_string_for_wire_type(&mut self, wire_type: u8) -> Result<String> {
        let bytes = self.read_bytes_for_wire_type(wire_type)?;
        String::from_utf8(bytes.to_vec()).map_err(|err| err.into())
    }

    fn read_bytes_for_wire_type(&mut self, wire_type: u8) -> Result<&'a [u8]> {
        if wire_type != WIRE_LENGTH_DELIMITED {
            bail!("expected length-delimited wire type, got {}", wire_type);
        }
        let length = self.read_varint()? as usize;
        let start = self.offset;
        let end = start + length;
        if end > self.bytes.len() {
            bail!("protobuf length-delimited field exceeds buffer length");
        }
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn skip(&mut self, wire_type: u8) -> Result<()> {
        match wire_type {
            WIRE_VARINT => {
                self.read_varint()?;
            }
            WIRE_64_BIT => {
                self.offset += 8;
            }
            WIRE_LENGTH_DELIMITED => {
                let length = self.read_varint()? as usize;
                self.offset += length;
            }
            WIRE_32_BIT => {
                self.offset += 4;
            }
            other => bail!("unsupported protobuf wire type: {}", other),
        }
        if self.offset > self.bytes.len() {
            bail!("protobuf skip exceeded buffer length");
        }
        Ok(())
    }

    fn read_varint(&mut self) -> Result<u64> {
        let mut result = 0_u64;
        let mut shift = 0_u32;
        while self.offset < self.bytes.len() {
            let byte = self.bytes[self.offset];
            self.offset += 1;
            result |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift > 63 {
                bail!("protobuf varint is too large");
            }
        }
        bail!("unexpected end of protobuf varint");
    }
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
    use serde_json::json;

    use super::*;

    #[test]
    fn encodes_and_decodes_legacy_json_frame() {
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_ensure",
            "id": "msg_test",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test"
        });

        let bytes = encode_legacy_json_frame(&frame).expect("encode frame");
        let decoded = decode_legacy_json_frame(&bytes).expect("decode frame");
        let decoded_value: Value = serde_json::from_str(&decoded).expect("decode json");

        assert_eq!(decoded_value, frame);
    }

    #[test]
    fn encodes_known_frames_with_typed_payload_field() {
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_ensure",
            "id": "msg_test",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test"
        });

        let bytes = encode_legacy_json_frame(&frame).expect("encode frame");
        assert_eq!(top_level_payload_fields(&bytes), vec![120]);
        assert!(!nested_payload_contains_field(
            &bytes,
            120,
            TYPED_FRAME_JSON_FIELD
        ));

        let decoded = decode_legacy_json_frame(&bytes).expect("decode frame");
        let decoded_value: Value = serde_json::from_str(&decoded).expect("decode json");
        assert_eq!(decoded_value, frame);
    }

    #[test]
    fn keeps_typed_json_envelope_helper_on_frame_json_for_grpc_adapter() {
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_ensure",
            "id": "msg_test",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test"
        });

        let bytes = encode_typed_json_envelope(
            "msg_test",
            "2026-04-25T16:00:00.000Z",
            TrafficClass::Interactive,
            EnvelopeTransportKind::H2Grpc,
            Some("terminal_ensure"),
            Some("0.2"),
            serde_json::to_vec(&frame).expect("frame json").as_slice(),
        )
        .expect("encode frame");

        assert_eq!(top_level_payload_fields(&bytes), vec![120]);
        assert!(nested_payload_contains_field(
            &bytes,
            120,
            TYPED_FRAME_JSON_FIELD
        ));

        let decoded = decode_legacy_json_frame(&bytes).expect("decode frame");
        let decoded_value: Value = serde_json::from_str(&decoded).expect("decode json");
        assert_eq!(decoded_value, frame);
    }

    #[test]
    fn encodes_terminal_result_with_field_level_payload() {
        let frame = json!({
            "proto": "0.2",
            "type": "terminal_send_result",
            "id": "msg_terminal_send_result",
            "ts": 1777132800000_u64,
            "ext": {},
            "session_id": "sess_test",
            "request_id": "req_test",
            "submitted": true,
            "delta": {
                "changed": true,
                "text": "hello",
                "truncated": false
            },
            "readiness": {
                "ready": true,
                "confidence": 0.94,
                "trigger": "prompt"
            },
            "error": null
        });

        let bytes = encode_legacy_json_frame(&frame).expect("encode frame");
        assert_eq!(top_level_payload_fields(&bytes), vec![126]);
        assert!(!nested_payload_contains_field(
            &bytes,
            126,
            TYPED_FRAME_JSON_FIELD
        ));

        let decoded = decode_legacy_json_frame(&bytes).expect("decode frame");
        let decoded_value: Value = serde_json::from_str(&decoded).expect("decode json");
        assert_eq!(decoded_value, frame);
    }

    #[test]
    fn encodes_data_attach_with_typed_payload_field() {
        let frame = json!({
            "proto": "0.1",
            "type": "data_attach",
            "id": "msg_data_attach",
            "ts": 1777132800000_u64,
            "ext": {},
            "bud_id": "b_test",
            "device_session_id": "s_test",
            "streams": ["terminal_output"],
            "max_chunk_bytes": 16384
        });

        let bytes = encode_typed_json_envelope(
            "msg_data_attach",
            "2026-04-25T16:00:00.000Z",
            TrafficClass::Control,
            EnvelopeTransportKind::H2Data,
            Some("data_attach"),
            Some("0.1"),
            serde_json::to_vec(&frame).expect("frame json").as_slice(),
        )
        .expect("encode frame");

        assert_eq!(top_level_payload_fields(&bytes), vec![170]);
        let decoded = decode_legacy_json_envelope(&bytes).expect("decode frame");
        assert_eq!(decoded.transport_kind, Some(EnvelopeTransportKind::H2Data));
        assert_eq!(decoded.payload.frame_type.as_deref(), Some("data_attach"));
        assert_eq!(
            serde_json::from_slice::<Value>(&decoded.payload.json).expect("decode json"),
            frame,
        );
    }

    #[test]
    fn encodes_stream_data_with_typed_payload_field() {
        let frame = json!({
            "proto": "0.1",
            "type": "stream_data",
            "id": "msg_stream_data",
            "ts": 1777132800000_u64,
            "ext": {},
            "stream_id": "st_test",
            "stream_type": "localhost_http_proxy",
            "offset": 0,
            "data": "",
            "end_stream": false
        });

        let bytes = encode_typed_json_envelope(
            "msg_stream_data",
            "2026-04-25T16:00:00.000Z",
            TrafficClass::ProxyActive,
            EnvelopeTransportKind::H2Data,
            Some("stream_data"),
            Some("0.1"),
            serde_json::to_vec(&frame).expect("frame json").as_slice(),
        )
        .expect("encode frame");

        assert_eq!(top_level_payload_fields(&bytes), vec![172]);
        let decoded = decode_legacy_json_envelope(&bytes).expect("decode frame");
        assert_eq!(decoded.transport_kind, Some(EnvelopeTransportKind::H2Data));
        assert_eq!(decoded.payload.frame_type.as_deref(), Some("stream_data"));
        assert_eq!(
            serde_json::from_slice::<Value>(&decoded.payload.json).expect("decode json"),
            frame,
        );
    }

    #[test]
    fn classifies_file_stream_data_as_bulk() {
        let frame = json!({
            "proto": "0.1",
            "type": "stream_data",
            "id": "msg_stream_data",
            "ts": 1777132800000_u64,
            "ext": {},
            "stream_id": "st_test",
            "stream_type": "file_read",
            "offset": 0,
            "data": "",
            "end_stream": false
        });

        let bytes = encode_typed_json_envelope(
            "msg_stream_data",
            "2026-04-25T16:00:00.000Z",
            traffic_class_for_frame(&frame),
            EnvelopeTransportKind::H2Data,
            Some("stream_data"),
            Some("0.1"),
            serde_json::to_vec(&frame).expect("frame json").as_slice(),
        )
        .expect("encode frame");

        let decoded = decode_legacy_json_envelope(&bytes).expect("decode frame");
        assert_eq!(decoded.traffic_class, TrafficClass::Bulk);
    }

    #[test]
    fn matches_shared_legacy_terminal_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../proto/fixtures/legacy-terminal-ensure.json"
        ))
        .expect("fixture json");
        let binary_base64 = fixture
            .get("binary_base64")
            .and_then(Value::as_str)
            .expect("binary_base64");
        let message_id = fixture
            .get("message_id")
            .and_then(Value::as_str)
            .expect("message_id");
        let sent_at = fixture
            .get("sent_at")
            .and_then(Value::as_str)
            .expect("sent_at");
        let frame_json = fixture
            .get("frame_json")
            .and_then(Value::as_str)
            .expect("frame_json");

        let encoded = encode_legacy_json_envelope(
            message_id,
            sent_at,
            TrafficClass::Interactive,
            EnvelopeTransportKind::WebSocket,
            Some("terminal_ensure"),
            Some("0.2"),
            frame_json.as_bytes(),
        )
        .expect("encode fixture");
        assert_eq!(BASE64_STANDARD.encode(&encoded), binary_base64);

        let decoded_bytes = BASE64_STANDARD
            .decode(binary_base64)
            .expect("decode fixture base64");
        let decoded = decode_legacy_json_envelope(&decoded_bytes).expect("decode fixture");
        assert_eq!(decoded.envelope_version, BUD_ENVELOPE_VERSION);
        assert_eq!(decoded.message_id, message_id);
        assert_eq!(decoded.sent_at, sent_at);
        assert_eq!(decoded.traffic_class, TrafficClass::Interactive);
        assert_eq!(
            decoded.transport_kind,
            Some(EnvelopeTransportKind::WebSocket)
        );
        assert_eq!(String::from_utf8(decoded.payload.json).unwrap(), frame_json);
    }

    #[test]
    fn tolerates_unknown_protobuf_fields() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../proto/fixtures/legacy-terminal-ensure.json"
        ))
        .expect("fixture json");
        let binary_base64 = fixture
            .get("binary_base64")
            .and_then(Value::as_str)
            .expect("binary_base64");
        let mut bytes = BASE64_STANDARD
            .decode(binary_base64)
            .expect("decode fixture base64");
        bytes.extend_from_slice(&[0xd2, 0x0f, 0x00]);

        let decoded = decode_legacy_json_envelope(&bytes).expect("decode fixture");
        assert_eq!(decoded.message_id, "msg_fixture_terminal_ensure");
    }

    fn top_level_payload_fields(bytes: &[u8]) -> Vec<u32> {
        let mut reader = ProtoReader::new(bytes);
        let mut payload_fields = Vec::new();
        while !reader.done() {
            let (field_number, wire_type) = reader.read_tag().expect("read tag");
            if field_number >= 100 {
                payload_fields.push(field_number);
            }
            reader.skip(wire_type).expect("skip field");
        }
        payload_fields
    }

    fn nested_payload_contains_field(
        bytes: &[u8],
        payload_field_number: u32,
        nested_field_number: u32,
    ) -> bool {
        let mut reader = ProtoReader::new(bytes);
        while !reader.done() {
            let (field_number, wire_type) = reader.read_tag().expect("read tag");
            if field_number == payload_field_number {
                let payload = reader
                    .read_bytes_for_wire_type(wire_type)
                    .expect("read payload");
                let mut payload_reader = ProtoReader::new(payload);
                while !payload_reader.done() {
                    let (field_number, wire_type) =
                        payload_reader.read_tag().expect("read nested tag");
                    if field_number == nested_field_number {
                        return true;
                    }
                    payload_reader.skip(wire_type).expect("skip nested field");
                }
                return false;
            }
            reader.skip(wire_type).expect("skip field");
        }
        false
    }
}
