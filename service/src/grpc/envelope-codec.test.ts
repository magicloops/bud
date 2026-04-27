import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { decodeGrpcLegacyJsonEnvelope, encodeGrpcLegacyJsonEnvelope } from "./envelope-codec.js";

test("encodes known JSON frames as typed gRPC BudEnvelope payloads", () => {
  const frame = {
    proto: "0.2",
    type: "terminal_ensure",
    id: "msg_test",
    ts: 1777132800000,
    ext: {},
    session_id: "sess_test",
  };

  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_grpc" });

  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(envelope.messageId, "msg_test");
  assert.equal(envelope.trafficClass, "TRAFFIC_CLASS_INTERACTIVE");
  assert.equal(envelope.transportKind, "TRANSPORT_KIND_H2_GRPC");
  assert.ok(envelope.terminalEnsure);
  assert.deepEqual(decodeGrpcLegacyJsonEnvelope(envelope), frame);
});

test("decodes proto-loader typed frame_json payload shapes", () => {
  const frame = {
    proto: "0.1",
    type: "heartbeat",
    id: "msg_heartbeat",
    ts: 1777132800000,
    ext: {},
    session_id: "s_test",
  };

  assert.deepEqual(
    decodeGrpcLegacyJsonEnvelope({
      envelopeVersion: 1,
      messageId: "msg_heartbeat",
      trafficClass: "TRAFFIC_CLASS_CONTROL",
      transportKind: "TRANSPORT_KIND_H2_GRPC",
      heartbeat: { frameJson: Buffer.from(JSON.stringify(frame), "utf-8") },
    }),
    frame,
  );
});

test("encodes data stream frames as typed gRPC BudEnvelope payloads", () => {
  const frame = {
    proto: "0.1",
    type: "data_attach",
    id: "msg_data_attach",
    ts: 1777132800000,
    ext: {},
    bud_id: "b_test",
    device_session_id: "s_test",
    streams: ["terminal_output"],
    max_chunk_bytes: 16384,
  };

  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_data" });

  assert.equal(envelope.transportKind, "TRANSPORT_KIND_H2_DATA");
  assert.ok(envelope.dataAttach);
  assert.deepEqual(decodeGrpcLegacyJsonEnvelope(envelope), frame);
});

test("encodes generic stream data with proxy traffic class", () => {
  const frame = {
    proto: "0.1",
    type: "stream_data",
    id: "msg_stream_data",
    ts: 1777132800000,
    ext: {},
    stream_id: "st_test",
    stream_type: "localhost_http_proxy",
    offset: 0,
    data: Buffer.from("GET / HTTP/1.1\r\n\r\n").toString("base64"),
    end_stream: false,
  };

  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_data" });

  assert.equal(envelope.trafficClass, "TRAFFIC_CLASS_PROXY_ACTIVE");
  assert.ok(envelope.streamData);
  assert.deepEqual(decodeGrpcLegacyJsonEnvelope(envelope), frame);
});

test("encodes proxy open results as typed gRPC BudEnvelope payloads", () => {
  const frame = {
    proto: "0.1",
    type: "proxy_open_result",
    id: "msg_proxy_open_result",
    ts: 1777132800000,
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    accepted: true,
    status_code: 200,
    headers: { "content-type": "text/html" },
  };

  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_grpc" });

  assert.equal(envelope.trafficClass, "TRAFFIC_CLASS_CONTROL");
  assert.ok(envelope.proxyOpenResult);
  assert.deepEqual(decodeGrpcLegacyJsonEnvelope(envelope), frame);
});

test("encodes file open results as typed gRPC BudEnvelope payloads", () => {
  const frame = {
    proto: "0.1",
    type: "file_open_result",
    id: "msg_file_open_result",
    ts: 1777132800000,
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    accepted: true,
    status_code: 206,
    headers: { "content-range": "bytes 0-4/10" },
    content_identity: { size: 10, modified_ms: 1777132800000 },
    size: 10,
  };

  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_grpc" });

  assert.equal(envelope.trafficClass, "TRAFFIC_CLASS_CONTROL");
  assert.ok(envelope.fileOpenResult);
  assert.deepEqual(decodeGrpcLegacyJsonEnvelope(envelope), frame);
});
