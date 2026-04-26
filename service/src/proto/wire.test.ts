import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  decodeBudEnvelope,
  decodeBudEnvelopePayloadCase,
  decodeLegacyJsonFrame,
  encodeBudEnvelope,
  encodeLegacyJsonFrame,
  makeLegacyJsonEnvelope,
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
    sentAt: fixture.sent_at,
    trafficClass: "interactive",
    transportKind: "websocket",
  });

  assert.equal(decodeBudEnvelopePayloadCase(bytes), "terminal_ensure");
  assert.notEqual(Buffer.from(bytes).toString("base64"), fixture.binary_base64);
  assert.deepEqual(decodeLegacyJsonFrame(bytes), fixture.frame);
});

test("tolerates unknown protobuf fields", () => {
  const bytes = Buffer.concat([
    Buffer.from(fixture.binary_base64, "base64"),
    Buffer.from([0xd2, 0x0f, 0x00]), // field 250, length-delimited, zero bytes
  ]);

  assert.deepEqual(decodeLegacyJsonFrame(bytes), fixture.frame);
});
