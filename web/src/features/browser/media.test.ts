import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCanvas } from "./media.ts";

test("JPEG to PNG preserves fitted CSS coordinates and one-frame credit", async t => {
  const originalSocket = globalThis.WebSocket;
  const originalBitmap = globalThis.createImageBitmap;
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    sent: string[] = [];
    constructor() { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.createImageBitmap = (async (blob: Blob) => ({
    width: blob.type === "image/png" ? 1200 : 600,
    height: blob.type === "image/png" ? 800 : 400,
    close() {},
  })) as typeof createImageBitmap;
  let clears = 0;
  const canvas = {
    width: 0, height: 0, style: { width: "", height: "" },
    parentElement: { getBoundingClientRect: () => ({ width: 300, height: 400 }) },
    getContext: () => ({ drawImage() {}, clearRect() { clears++; } }),
  };
  const states: string[] = [];
  let drawn!: () => void;
  const client = new BrowserCanvas(canvas as unknown as HTMLCanvasElement, "ws://fixture",
    "viewer", state => { states.push(state); if (state === "connected") drawn(); }, () => 2);
  const socket = sockets[0];
  try {
    socket.onopen!();
    const base = { type: "frame", target_id: "page", document_id: "doc", frame_token: "opaque",
      width: 600, height: 400, image: "AA==", targets: [] };
    for (const image_format of [undefined, "png"]) {
      const ready = new Promise<void>(resolve => { drawn = resolve; });
      socket.onmessage!({ data: JSON.stringify({ ...base, image_format }) });
      await ready;
      assert.equal(canvas.style.width, "300px");
      assert.equal(canvas.style.height, "200px");
      assert.equal(client.frame?.width, 600);
      assert.equal(canvas.width, image_format ? 1200 : 600);
    }
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    t.mock.timers.tick(30_000);
    assert.equal(client.frame?.target_id, "page", "idle canvas retains its latest frame");
    assert.equal(clears, 0);
    assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [
      { viewer_id: "viewer" }, { type: "ack", pixel_ratio: 2 }, { type: "ack", pixel_ratio: 2 },
    ]);
    socket.onmessage!({ data: '{"type":"empty"}' });
    assert.equal(client.frame, null);
    assert.equal(states.at(-1), "empty");
    assert.equal(clears, 1);
    assert.equal(JSON.parse(socket.sent.at(-1)!).type, "ack");
    socket.onmessage!({ data: '{"type":"revoked"}' });
    assert.equal(client.frame, null);
    assert.equal(clears, 2, "revocation clears retained pixels immediately");
  } finally {
    client.close();
    globalThis.WebSocket = originalSocket;
    globalThis.createImageBitmap = originalBitmap;
  }
});
