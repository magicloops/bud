import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserMedia } from "./media.js";
import type { BrowserControl } from "./control.js";
import type { BrowserCarrier } from "./transport.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw Error("condition timed out");
}

test("operation-driven media idles across heartbeat windows, coalesces credit, and revokes idle viewers", async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  let authorized = true, ownerAllowed = true, captures = 0, acks = true, checks = 0;
  let daemon!: WebSocket;
  let refreshDuringCapture = false;
  const carrier = { operationDrivenMedia: true, current: () => true } as BrowserCarrier;
  const control = {
    onFence: () => {}, expireControllers: () => {},
    repository: { command: (_: unknown, command: unknown) => ({ command }) },
    mediaAuthority: async (owner: string) => {
      assert.equal(owner, "alice");
      if (!ownerAllowed) throw Error("revoked ownership");
      return { session: { id: "browser", generation: "generation", control_epoch: 1 }, carrier };
    },
  } as unknown as BrowserControl;
  const media = new BrowserMedia(control, `${endpoint}/daemon`, async (_, request) => {
    assert.equal(request.command.operation_driven, true);
    daemon = new WebSocket(`${endpoint}/daemon`);
    sockets.add(daemon);
    daemon.on("message", () => {
      captures++;
      if (refreshDuringCapture) {
        refreshDuringCapture = false;
        daemon.send('{"refresh":true}');
      }
      daemon.send(JSON.stringify({ target_id: "page", document_id: "doc", frame_token: "frame",
        width: 800, height: 600, image: "fixture", targets: [] }));
    });
    await once(daemon, "open");
    daemon.send(JSON.stringify({ ticket: request.command.ticket }));
    return { ok: true, outcome: "completed", data: {} };
  });
  server.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.on("error", () => {});
    if (request.url === "/daemon") media.attachDaemon(socket);
    else void media.attachViewer(socket, "alice", "browser", request.url!, async () => {
      checks++; return authorized;
    }).catch(() => socket.terminate());
  });
  t.after(async () => {
    media.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const connect = async (name: string) => {
    const viewer = new WebSocket(`${endpoint}/${name}`);
    sockets.add(viewer);
    viewer.on("message", raw => {
      if (JSON.parse(raw.toString()).type === "frame" && acks) viewer.send('{"type":"ack"}');
    });
    await once(viewer, "open");
    return viewer;
  };
  const viewer = await connect("first");
  await until(() => captures === 1);
  await sleep(11_000); // Beyond the old idle timeout, with native pongs only.
  assert.equal(captures, 1);
  assert.equal(viewer.readyState, WebSocket.OPEN);
  assert.ok(checks >= 3, "idle authorization must be rechecked");
  assert.equal(control.isSizingViewer("alice", { id: "browser", generation: "generation", control_epoch: 1 } as never, "/first"), true, "idle first viewer retains sizing authority");

  acks = false;
  daemon.send('{"refresh":true}');
  await until(() => captures === 2);
  for (let i = 0; i < 10; i++) daemon.send('{"refresh":true}');
  await sleep(100);
  assert.equal(captures, 2, "no credit, no capture");
  acks = true;
  viewer.send('{"type":"ack"}');
  await until(() => captures === 3);
  await sleep(100);
  assert.equal(captures, 3, "coalesced refreshes consume one capture");

  const second = await connect("second");
  await until(() => captures === 4);
  await sleep(100);
  assert.equal(captures, 4, "attachment refresh must settle");
  authorized = false;
  await until(() => viewer.readyState === WebSocket.CLOSED && second.readyState === WebSocket.CLOSED);
  assert.equal(captures, 4, "revocation does not require a screenshot");

  authorized = true;
  const third = await connect("third");
  await until(() => captures === 5);
  ownerAllowed = false;
  await until(() => third.readyState === WebSocket.CLOSED);
  assert.equal(captures, 5);

  ownerAllowed = true;
  const fourth = await connect("fourth");
  await until(() => captures === 6);
  refreshDuringCapture = true;
  daemon.send('{"refresh":true}');
  await until(() => captures === 8);
  await sleep(100);
  assert.equal(captures, 8, "refresh during delivery must not be lost or loop");
  acks = false;
  daemon.send('{"refresh":true}');
  await until(() => captures === 9);
  const closed = once(fourth, "close");
  await Promise.race([closed, sleep(7000).then(() => { throw Error("missing ACK was kept alive by pongs"); })]);
  assert.equal(captures, 9);
});
