import { test } from "node:test";
import assert from "node:assert/strict";
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
