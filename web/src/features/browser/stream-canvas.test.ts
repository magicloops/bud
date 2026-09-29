import assert from "node:assert/strict";
import test from "node:test";
import { StreamCanvas, parseStreamPacket } from "./stream-canvas.ts";
function packet(sequence: number, generation = "g1") {
  const header = new TextEncoder().encode(JSON.stringify({ media_generation: generation, frame_sequence: sequence,
    target_id: "t", document_id: "d", frame_token: `token${sequence}`, width: 440, height: 816,
    bitmap_width: 220, bitmap_height: 408, image_bytes: 1, source_age_ms: 0 }));
  const result = new Uint8Array(header.length + 9); result.set(new TextEncoder().encode("BSC1"));
  new DataView(result.buffer).setUint32(4, header.length); result.set(header, 8);
  return result.buffer;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("stream decoder bounds pending images and fences a late decode on reset", async () => {
  const original = globalThis.createImageBitmap;
  const completions: ((value: ImageBitmap) => void)[] = [];
  let closedBitmaps = 0, cleared = 0, failed = 0;
  globalThis.createImageBitmap = (() => new Promise(resolve => completions.push(resolve))) as typeof createImageBitmap;
  const feedback: { frame_sequence: number; disposition: string }[] = [];
  const painted: string[] = [];
  const viewer = new StreamCanvas((_bitmap, frame) => painted.push(frame.frame_token), () => cleared++,
    text => feedback.push(JSON.parse(text)), () => failed++);
  const reset = (generation: string) => viewer.reset({ media_version: 1, media_generation: generation, targets: [] });
  const complete = () => completions.shift()!({ width: 220, height: 408, close() { closedBitmaps++; } } as ImageBitmap);
  try {
    reset("g1"); viewer.receive(packet(1)); viewer.receive(packet(2)); viewer.receive(packet(3));
    assert.equal(completions.length, 1);
    assert.deepEqual(feedback.map(f => [f.frame_sequence, f.disposition]), [[2, "discarded"]]);
    reset("g2"); viewer.receive(packet(4, "g2")); complete(); await tick();
    assert.deepEqual(painted, []);
    complete(); await tick();
    assert.deepEqual(painted, ["token4"]);
    assert.deepEqual(feedback.map(f => [f.frame_sequence, f.disposition]), [[2, "discarded"], [3, "discarded"], [1, "discarded"], [4, "presented"]]);
    assert.throws(() => viewer.receive(packet(4, "g2")), /sequence/);
    viewer.receive(packet(5, "g2")); viewer.dispose(); complete(); await tick();
    assert.deepEqual(painted, ["token4"]);
    assert.equal(closedBitmaps, 3); assert.equal(failed, 0); assert.equal(cleared, 3);
  } finally { viewer.dispose(); globalThis.createImageBitmap = original; }
});
test("binary parser rejects malformed lengths before decoding", () => {
  assert.throws(() => parseStreamPacket(new ArrayBuffer(2)));
  const oversized = packet(1); new DataView(oversized).setUint32(4, 4097);
  assert.throws(() => parseStreamPacket(oversized), /header_bounds/);
  const extra = new Uint8Array(packet(1).byteLength + 1); extra.set(new Uint8Array(packet(1)));
  assert.throws(() => parseStreamPacket(extra.buffer), /header/);
});

test("target selection fences decoding and arriving old frames until a new reset", async () => {
  const original = globalThis.createImageBitmap;
  let finish!: (bitmap: ImageBitmap) => void;
  globalThis.createImageBitmap = (() => new Promise(resolve => { finish = resolve; })) as typeof createImageBitmap;
  const painted: string[] = [], discarded: number[] = [];
  const viewer = new StreamCanvas((_bitmap, frame) => painted.push(frame.frame_token), () => {},
    text => discarded.push(JSON.parse(text).frame_sequence), () => assert.fail("decode failed"));
  try {
    viewer.reset({ media_version: 1, media_generation: "g1", targets: [] });
    viewer.receive(packet(1)); viewer.fence(); viewer.receive(packet(2));
    finish({ width: 220, height: 408, close() {} } as ImageBitmap); await tick();
    assert.deepEqual(painted, []); assert.deepEqual(discarded, [2, 1]);
    viewer.reset({ media_version: 1, media_generation: "g2", targets: [] });
    viewer.receive(packet(3, "g2"));
    finish({ width: 220, height: 408, close() {} } as ImageBitmap); await tick();
    assert.deepEqual(painted, ["token3"]);
  } finally { viewer.dispose(); globalThis.createImageBitmap = original; }
});
