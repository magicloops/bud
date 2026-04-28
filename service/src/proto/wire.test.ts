import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  decodeBudEnvelope,
  decodeBudEnvelopePayloadEncoding,
  decodeBudEnvelopePayloadCase,
  decodeLegacyJsonFrame,
  encodeBudEnvelope,
  encodeLegacyJsonFrame,
  makeLegacyJsonEnvelope,
  UnsupportedBudEnvelopePayloadError,
} from "./wire.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../proto/fixtures/legacy-terminal-ensure.json", import.meta.url), "utf-8"),
) as {
  binary_base64: string;
  sent_at: string;
  message_id: string;
  frame: Record<string, unknown>;
};

test("encodes the shared legacy terminal fixture as BudEnvelope protobuf", () => {
  const envelope = makeLegacyJsonEnvelope(fixture.frame, {
    messageId: fixture.message_id,
    sentAt: fixture.sent_at,
    trafficClass: "interactive",
    transportKind: "websocket",
  });

  assert.equal(
    Buffer.from(encodeBudEnvelope(envelope, { forceLegacyJsonPayload: true })).toString("base64"),
    fixture.binary_base64,
  );
});

test("decodes the shared legacy terminal fixture", () => {
  const bytes = Buffer.from(fixture.binary_base64, "base64");
  const envelope = decodeBudEnvelope(bytes);

  assert.equal(envelope.envelope_version, 1);
  assert.equal(envelope.message_id, fixture.message_id);
  assert.equal(envelope.sent_at, fixture.sent_at);
  assert.equal(envelope.traffic_class, "interactive");
  assert.equal(envelope.transport_kind, "websocket");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), fixture.frame);
});

test("encodes known frames as typed protobuf payloads", () => {
  const bytes = encodeLegacyJsonFrame(fixture.frame, {
    messageId: fixture.message_id,
    sentAt: new Date(fixture.frame.ts as number).toISOString(),
    trafficClass: "interactive",
    transportKind: "websocket",
  });

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "terminal_ensure");
  assert.equal(decodeBudEnvelopePayloadEncoding(bytes), "typed_fields");
  assert.notEqual(Buffer.from(bytes).toString("base64"), fixture.binary_base64);
  assert.deepEqual(decodeLegacyJsonFrame(bytes), fixture.frame);
});

test("round-trips terminal result frames with typed protobuf fields", () => {
  const frame = {
    proto: "0.2",
    type: "terminal_send_result",
    id: "msg_terminal_send_result",
    ts: 1777132800000,
    ext: {},
    session_id: "sess_test",
    request_id: "req_test",
    submitted: true,
    delta: {
      changed: true,
      text: "hello",
      truncated: false,
    },
    readiness: {
      ready: true,
      confidence: 0.94,
      trigger: "prompt",
    },
    error: null,
  };

  const bytes = encodeLegacyJsonFrame(frame);

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "terminal_send_result");
  assert.equal(decodeBudEnvelopePayloadEncoding(bytes), "typed_fields");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("round-trips terminal output frames with typed protobuf fields", () => {
  const frame = {
    proto: "0.2",
    type: "terminal_output",
    id: "msg_terminal_output",
    ts: 1777132800000,
    ext: {},
    session_id: "sess_test",
    seq: 42,
    data: Buffer.from("hello").toString("base64"),
    byte_offset: 1024,
  };

  const bytes = encodeLegacyJsonFrame(frame);

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "terminal_output");
  assert.equal(decodeBudEnvelopePayloadEncoding(bytes), "typed_fields");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("round-trips reconnect reports with typed protobuf fields", () => {
  const frame = {
    proto: "0.1",
    type: "reconnect_report",
    id: "msg_reconnect_report",
    ts: 1777132800000,
    ext: {},
    bud_id: "bud_test",
    device_session_id: "dev_test",
    operations: [
      {
        operation_id: "op_test",
        state: "running",
        operation_type: "terminal",
        updated_at: "2026-04-25T16:00:00.000Z",
      },
    ],
    streams: [
      {
        stream_id: "st_test",
        operation_id: "op_test",
        stream_type: "terminal_interactive",
        state: "open",
        send_offset: 12,
        receive_offset: 34,
        updated_at: "2026-04-25T16:00:00.000Z",
      },
    ],
    local_policy_version: "policy_test",
    terminal_sessions: ["sess_test"],
  };

  const bytes = encodeLegacyJsonFrame(frame);

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "reconnect_report");
  assert.equal(decodeBudEnvelopePayloadEncoding(bytes), "typed_fields");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("encodes generic stream frames as typed protobuf payloads", () => {
  const frame = {
    proto: "0.1",
    type: "stream_data",
    id: "msg_stream_data",
    ts: 1777132800000,
    ext: {},
    stream_id: "st_test",
    stream_type: "file_read",
    offset: 0,
    data: Buffer.from("hello").toString("base64"),
    end_stream: false,
  };
  const bytes = encodeLegacyJsonFrame(frame, { transportKind: "h2_data" });
  const envelope = decodeBudEnvelope(bytes);

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "stream_data");
  assert.equal(decodeBudEnvelopePayloadEncoding(bytes), "typed_frame_json");
  assert.equal(envelope.traffic_class, "bulk");
  assert.equal(envelope.transport_kind, "h2_data");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("encodes proxy open frames as typed protobuf payloads", () => {
  const frame = {
    proto: "0.1",
    type: "proxy_open",
    id: "msg_proxy_open",
    ts: 1777132800000,
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    proxy_session_id: "ps_test",
    stream_type: "localhost_http_proxy",
    target_host: "127.0.0.1",
    target_port: 5173,
    method: "GET",
    path: "/",
    headers: {},
    initial_credit_bytes: 1048576,
    max_chunk_bytes: 16384,
  };
  const bytes = encodeLegacyJsonFrame(frame, { transportKind: "h2_grpc" });

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "proxy_open");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("encodes file open frames as typed protobuf payloads", () => {
  const frame = {
    proto: "0.1",
    type: "file_open",
    id: "msg_file_open",
    ts: 1777132800000,
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    file_session_id: "fs_test",
    stream_type: "file_read",
    root_key: "workspace",
    relative_path: "src/index.ts",
    mode: "range",
    range_start: 0,
    range_end: 10,
    max_bytes: 1048576,
    initial_credit_bytes: 1048576,
    max_chunk_bytes: 16384,
  };
  const bytes = encodeLegacyJsonFrame(frame, { transportKind: "h2_grpc" });

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "file_open");
  assert.deepEqual(decodeLegacyJsonFrame(bytes), frame);
});

test("tolerates unknown protobuf fields", () => {
  const bytes = Buffer.concat([
    Buffer.from(fixture.binary_base64, "base64"),
    Buffer.from([0xd2, 0x0f, 0x00]), // field 250, length-delimited, zero bytes
  ]);

  assert.deepEqual(decodeLegacyJsonFrame(bytes), fixture.frame);
});

test("rejects unknown protobuf payload fields with a typed unsupported-payload error", () => {
  const bytes = encodeEnvelopeWithUnknownPayloadField(190);

  assert.throws(() => decodeBudEnvelope(bytes), UnsupportedBudEnvelopePayloadError);
  assert.throws(() => decodeBudEnvelopePayloadCase(bytes), UnsupportedBudEnvelopePayloadError);
  assert.throws(() => decodeBudEnvelopePayloadEncoding(bytes), UnsupportedBudEnvelopePayloadError);
});

function encodeEnvelopeWithUnknownPayloadField(fieldNumber: number): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeStringField(2, "msg_unknown_payload"),
    encodeStringField(10, "2026-04-25T16:00:00.000Z"),
    encodeVarintField(11, 1),
    encodeLengthDelimitedField(fieldNumber, Buffer.alloc(0)),
  ]);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  return encodeLengthDelimitedField(fieldNumber, Buffer.from(value, "utf8"));
}

function encodeLengthDelimitedField(fieldNumber: number, bytes: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function encodeVarint(value: number): Buffer {
  const chunks: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    chunks.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  chunks.push(remaining);
  return Buffer.from(chunks);
}
