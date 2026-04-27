use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

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
        PayloadEncoding::TypedWhenKnown,
    )
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
        PayloadEncoding::TypedWhenKnown,
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

    if payload_encoding == PayloadEncoding::TypedWhenKnown {
        if let Some(field_number) = frame_type.and_then(payload_field_for_frame_type) {
            let mut payload = Vec::new();
            write_bytes(&mut payload, TYPED_FRAME_JSON_FIELD, legacy_json);
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

pub fn decode_legacy_json_envelope(bytes: &[u8]) -> Result<LegacyJsonEnvelope> {
    let mut reader = ProtoReader::new(bytes);
    let mut envelope_version: Option<u32> = None;
    let mut message_id: Option<String> = None;
    let mut sent_at: Option<String> = None;
    let mut traffic_class: Option<TrafficClass> = None;
    let mut transport_kind: Option<EnvelopeTransportKind> = None;
    let mut payload: Option<LegacyJsonPayload> = None;

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
                    payload = Some(decode_typed_json_payload(
                        reader.read_bytes_for_wire_type(wire_type)?,
                        frame_type,
                    )?);
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

    Ok(LegacyJsonEnvelope {
        envelope_version,
        message_id: message_id.ok_or_else(|| anyhow!("missing message_id"))?,
        sent_at: sent_at.ok_or_else(|| anyhow!("missing sent_at"))?,
        traffic_class: traffic_class.ok_or_else(|| anyhow!("missing traffic_class"))?,
        transport_kind,
        payload: payload.ok_or_else(|| anyhow!("missing legacy_json payload"))?,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PayloadEncoding {
    LegacyJson,
    TypedWhenKnown,
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

fn decode_typed_json_payload(bytes: &[u8], frame_type: &str) -> Result<LegacyJsonPayload> {
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

fn write_varint_field(out: &mut Vec<u8>, field_number: u32, value: u64) {
    write_varint(out, ((field_number as u64) << 3) | WIRE_VARINT as u64);
    write_varint(out, value);
}

fn write_string(out: &mut Vec<u8>, field_number: u32, value: &str) {
    write_bytes(out, field_number, value.as_bytes());
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
}
