import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserMedia } from "./media.js";
import { parseStreamPacket } from "./stream-media.js";
import type { BrowserControl } from "./control.js";
import type { BrowserCarrier } from "./transport.js";

// Uses the local development certificate, never disables certificate validation.
const certPath = new URL("../../../.certs/bud-local.pem", import.meta.url);
const keyPath = new URL("../../../.certs/bud-local-key.pem", import.meta.url);
test("private binary frames traverse dedicated authenticated WSS and retire on a control fence", {
  skip: !existsSync(certPath) || !existsSync(keyPath) || !process.env.BUD_STREAM_TEST_CA,
}, async t => {
  const old = process.env.BUD_BROWSER_STREAMING_EXPERIMENT;
  process.env.BUD_BROWSER_STREAMING_EXPERIMENT = "1";
  const cert = readFileSync(certPath);
  const https = createServer({ cert, key: readFileSync(keyPath) });
  const server = new WebSocketServer({ server: https, maxPayload: 1_420_000 });
  https.listen(0, "127.0.0.1"); await once(https, "listening");
  const address = https.address(); assert.ok(address && typeof address === "object");
  const endpoint = `wss://localhost:${address.port}`;
  const sockets = new Set<WebSocket>();
  const carrier = { current: () => true } as BrowserCarrier;
  const control = {
    onFence() {}, expireControllers() {},
    repository: { command: (_session: unknown, command: unknown) => ({ command }) },
    mediaAuthority: async () => ({ session: { id: "workspace", browser_id: "browser", generation: "runtime", browser_epoch: 2 },
      carrier, controllerId: "controller" }),
  } as unknown as BrowserControl;
  let terminalFeedback!: (value: unknown) => void;
  const feedback = new Promise(resolve => { terminalFeedback = resolve; });
  const connect = (path: string) => {
    const socket = new WebSocket(`${endpoint}${path}`, { ca: readFileSync(process.env.BUD_STREAM_TEST_CA!), family: 4 }); sockets.add(socket); socket.on("error", () => {}); return socket;
  };
  const media = new BrowserMedia(control, `${endpoint}/daemon`, async (_, request) => {
    const daemon = connect("/daemon");
    daemon.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "frame_ack") { terminalFeedback(message); return; }
      assert.equal(message.mode, "screencast_v1");
      daemon.send(JSON.stringify({ type: "reset", media_version: 1, media_generation: "g", targets: [] }));
      const header = Buffer.from(JSON.stringify({ media_generation: "g", frame_sequence: 1, target_id: "t", document_id: "d",
        frame_token: "token", width: 440, height: 816, bitmap_width: 220, bitmap_height: 408, image_bytes: 1, source_age_ms: 0 }));
      const prefix = Buffer.alloc(8); prefix.write("BSC1"); prefix.writeUInt32BE(header.length, 4);
      daemon.send(Buffer.concat([prefix, header, Buffer.from([0])]), { binary: true });
    });
    await once(daemon, "open"); daemon.send(JSON.stringify({ ticket: request.command.ticket }));
    return { ok: true, outcome: "completed", data: {} };
  });
  server.on("connection", (socket, request) => {
    sockets.add(socket); socket.on("error", () => {});
    if (request.url === "/daemon") media.attachDaemon(socket);
    else void media.attachViewer(socket, "owner", "workspace", "viewer", async () => true).catch(() => socket.terminate());
  });
  t.after(async () => {
    media.stop(); for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => https.close(() => resolve()));
    if (old === undefined) delete process.env.BUD_BROWSER_STREAMING_EXPERIMENT; else process.env.BUD_BROWSER_STREAMING_EXPERIMENT = old;
  });
  const viewer = connect("/viewer"); let resetSeen = false;
  viewer.on("message", (raw, binary) => {
    if (!binary) { resetSeen ||= JSON.parse(raw.toString()).type === "reset"; return; }
    assert.ok(resetSeen);
    const header = parseStreamPacket(raw as Buffer);
    viewer.send(JSON.stringify({ type: "frame_ack", media_generation: header.media_generation, frame_sequence: header.frame_sequence, disposition: "presented" }));
  });
  const received = await Promise.race([feedback, new Promise((_, reject) => setTimeout(() => reject(new Error("feedback timeout")), 3000).unref())]);
  assert.deepEqual(received, { type: "frame_ack", media_generation: "g", frame_sequence: 1, disposition: "presented" });
  const closed = once(viewer, "close"); control.onFence("browser"); await closed;
});
