import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { PrivateStreamRelay, parseStreamPacket, streamErrorCode } from "./stream-media.js";
function packet(sequence: number, generation = "g1") {
  const header = Buffer.from(JSON.stringify({ media_generation: generation, frame_sequence: sequence,
    target_id: "t", document_id: "d", frame_token: `token${sequence}`, width: 440, height: 816,
    bitmap_width: 220, bitmap_height: 408, image_bytes: 1, source_age_ms: 0 }));
  const prefix = Buffer.alloc(8); prefix.write("BSC1"); prefix.writeUInt32BE(header.length, 4);
  return Buffer.concat([prefix, header, Buffer.from([0])]);
}
class Socket {
  readyState = WebSocket.OPEN; bufferedAmount = 0; sent: (string | Buffer)[] = [];
  send(value: string | Buffer) { this.sent.push(value); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const reset = (generation = "g1") => JSON.stringify({ type: "reset", media_version: 1, media_generation: generation, targets: [] });
const ack = (sequence: number, generation = "g1") => JSON.stringify({ type: "frame_ack", media_generation: generation, frame_sequence: sequence, disposition: "presented" });
test("relay serializes reset, bounds pending work and accepts only exact delivered feedback", async () => {
  const daemon = new Socket(), viewer = new Socket(); let failed = 0;
  let resolve!: (ok: boolean) => void;
  let authorization: Promise<boolean> = new Promise(done => { resolve = done; });
  const relay = new PrivateStreamRelay(daemon as unknown as WebSocket, viewer as unknown as WebSocket, () => authorization, () => failed++);
  try {
    const resetting = relay.reset(reset());
    relay.frame(packet(1)); relay.frame(packet(2)); relay.frame(packet(3));
    assert.throws(() => relay.feedback(ack(1)), /unforwarded/);
    assert.equal(viewer.sent.length, 0);
    resolve(true); await resetting; await tick();
    assert.equal(JSON.parse(viewer.sent[0] as string).type, "reset");
    assert.deepEqual(viewer.sent.slice(1).map(value => parseStreamPacket(value as Buffer).frame_sequence), [1, 3]);
    assert.equal(JSON.parse(daemon.sent[0] as string).disposition, "discarded");
    relay.feedback(ack(1)); assert.throws(() => relay.feedback(ack(1)), /unforwarded/);
    relay.feedback(ack(3));
    authorization = Promise.resolve(false); relay.frame(packet(4)); await tick();
    assert.equal(failed, 1); assert.equal(viewer.sent.length, 3);
  } finally { relay.dispose(); }
});
test("relay rejects overflow and expires missing feedback", async t => {
  const daemon = new Socket(), viewer = new Socket(); let failed = 0;
  const relay = new PrivateStreamRelay(daemon as unknown as WebSocket, viewer as unknown as WebSocket, async () => true, () => failed++);
  try {
    await relay.reset(reset());
    for (let sequence = 1; sequence <= 3; sequence++) { relay.frame(packet(sequence)); await tick(); }
    assert.throws(() => relay.frame(packet(4)), /credit/);
    assert.throws(() => relay.feedback(ack(2, "foreign")), /invalid_ack/);
    t.mock.method(Date, "now", () => Number.MAX_SAFE_INTEGER);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(failed, 1);
  } finally { relay.dispose(); }
});
test("relay invalidates queued frames while generation authorization is pending", async () => {
  const daemon = new Socket(), viewer = new Socket(); let allowed!: (ok: boolean) => void;
  let authorization = Promise.resolve(true);
  const relay = new PrivateStreamRelay(daemon as unknown as WebSocket, viewer as unknown as WebSocket, () => authorization, () => {});
  try {
    await relay.reset(reset());
    authorization = new Promise(resolve => { allowed = resolve; });
    relay.frame(packet(1)); const resetting = relay.reset(reset("g2"));
    allowed(true); await resetting; await tick();
    assert.equal(viewer.sent.filter(Buffer.isBuffer).length, 0);
    assert.equal(JSON.parse(daemon.sent[0] as string).disposition, "discarded");
    assert.throws(() => relay.frame(packet(2)), /sequence/);
  } finally { relay.dispose(); }
});
test("packet bounds reject malformed images before fanout", () => {
  assert.throws(() => parseStreamPacket(Buffer.alloc(8)));
  const bad = packet(1); bad.writeUInt32BE(4097, 4);
  assert.throws(() => parseStreamPacket(bad), /header_bounds/);
  assert.throws(() => parseStreamPacket(Buffer.concat([packet(1), Buffer.from([0])])), /image_bounds/);
});
test("superseding resets coalesce during authorization and fence old images", async () => {
  const daemon = new Socket(), viewer = new Socket(); let failed = 0, calls = 0;
  const approvals: ((ok: boolean) => void)[] = [];
  const relay = new PrivateStreamRelay(daemon as unknown as WebSocket, viewer as unknown as WebSocket,
    () => { calls++; return new Promise(resolve => approvals.push(resolve)); }, () => failed++);
  try {
    const first = relay.reset(reset());
    relay.frame(packet(1));
    const second = relay.reset(reset("g2"));
    const third = relay.reset(reset("g3"));
    assert.equal(first, second); assert.equal(second, third);
    assert.equal(calls, 1);
    assert.throws(() => relay.frame(packet(2, "g2")), /sequence/);
    approvals.shift()!(true); await tick();
    assert.equal(viewer.sent.length, 0);
    assert.equal(calls, 2);
    approvals.shift()!(true); await first; await tick();
    while (approvals.length) { approvals.shift()!(true); await tick(); }
    assert.deepEqual(viewer.sent.map(value => JSON.parse(value as string).media_generation), ["g3"]);
    relay.frame(packet(3, "g3")); await tick();
    approvals.shift()!(true); await tick();
    assert.equal(parseStreamPacket(viewer.sent[1] as Buffer).media_generation, "g3");
    assert.equal(failed, 0);
  } finally { relay.dispose(); }
});

test("stream diagnostics never emit arbitrary exception details", () => {
  assert.equal(streamErrorCode(new Error("stream_sequence")), "stream_sequence");
  assert.equal(streamErrorCode(new SyntaxError("private page text")), "stream_json");
  assert.equal(streamErrorCode(new Error("stream_sequence private page text")), "redacted");
});
