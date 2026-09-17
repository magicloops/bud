import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserMedia } from "./media.js";
import type { BrowserControl } from "./control.js";
import type { BrowserSession } from "./control-repository.js";
import type { BrowserCarrier } from "./transport.js";

const until = async (check: () => boolean) => {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("media credit isolates slow viewers, revokes live auth, and consumes tickets once", async (t) => {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    maxPayload: 1_420_000,
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  let live = true,
    authorized = true,
    captures = 0,
    ticket = "";
  const carrier = {
    bootId: "boot",
    handoff: true,
    hidpiCapture: true,
    current: () => live,
  } as BrowserCarrier;
  const control = {
    onFence: () => {},
    expireControllers: () => {},
    repository: {
      command: (_session: unknown, command: unknown) => ({ command }),
    },
    mediaAuthority: async () => ({
      session: { id: "browser", generation: "generation", control_epoch: 1 },
      carrier,
    }),
  } as unknown as BrowserControl;
  const ratios: (number | undefined)[] = [];
  const media = new BrowserMedia(
    control,
    `${endpoint}/daemon`,
    async (_carrier, request) => {
      assert.equal(request.command.operation_driven, undefined);
      ticket = request.command.ticket as string;
      const daemon = new WebSocket(`${endpoint}/daemon`);
      sockets.add(daemon);
      daemon.on("error", () => {});
      daemon.on("message", raw => {
        const ratio = JSON.parse(raw.toString()).pixel_ratio;
        ratios.push(ratio);
        captures++;
        daemon.send(
          JSON.stringify({
            target_id: "page",
            document_id: "document",
            frame_token: "frame",
            width: 800,
            height: 600,
            image: "fixture",
            ...(ratio ? { image_format: "png" } : {}),
            targets: [{ target_id: "page", origin: "https://example.test" }],
          }),
        );
      });
      await once(daemon, "open");
      daemon.send(JSON.stringify({ ticket }));
      return {
        ok: true,
        outcome: "completed",
        data: { media_connecting: true },
      };
    },
  );
  server.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.on("error", () => {});
    if (request.url === "/daemon") media.attachDaemon(socket);
    else
      void media
        .attachViewer(
          socket,
          "alice",
          "browser",
          request.url!,
          async () => authorized,
        )
        .catch(() => socket.terminate());
  });
  t.after(async () => {
    live = false;
    media.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const fast = new WebSocket(`${endpoint}/fast`);
  sockets.add(fast);
  let fastFrames = 0;
  fast.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "frame") {
      fastFrames++;
      setTimeout(() => {
        if (fast.readyState === WebSocket.OPEN) fast.send('{"type":"ack","pixel_ratio":2}');
      }, 20);
    }
  });
  await once(fast, "open");
  await until(() => fastFrames >= 3);
  assert.equal(ratios[0], undefined);
  assert.ok(ratios.includes(2));
  const slow = new WebSocket(`${endpoint}/slow`);
  sockets.add(slow);
  let slowFrames = 0;
  slow.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "frame") {
      assert.equal(JSON.parse(raw.toString()).image_format, undefined);
      slowFrames++;
    }
  });
  await once(slow, "open");
  await until(() => slowFrames === 1 && fastFrames >= 5);
  const session = { id: "browser", generation: "generation", control_epoch: 1 } as BrowserSession;
  assert.equal(control.isSizingViewer("alice", session, "/fast"), true);
  assert.equal(control.isSizingViewer("alice", session, "/slow"), false);
  assert.equal(control.isSizingViewer("bob", session, "/fast"), false);
  assert.equal(control.isSizingViewer("alice", { ...session, control_epoch: 2 }, "/fast"), true);
  assert.equal(slowFrames, 1);
  assert.equal(ratios.at(-1), undefined);
  const replay = new WebSocket(`${endpoint}/daemon`);
  sockets.add(replay);
  await once(replay, "open");
  const replayClosed = once(replay, "close");
  replay.send(JSON.stringify({ ticket }));
  await replayClosed;
  assert.equal(fast.readyState, WebSocket.OPEN);
  authorized = false;
  await until(() => fast.readyState === WebSocket.CLOSED);
  assert.equal(control.isSizingViewer("alice", session, "/slow"), true);
  // The slow client has no credit. Explicit fence clears its already displayed
  // content and stops the capture task as well.
  control.onFence("browser");
  await until(() => slow.readyState === WebSocket.CLOSED);
  const count = captures;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(captures, count);
});

test(`agent epoch continuity and pending-delivery revocation`, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const sockets = new Set<WebSocket>();
  const session = { id: 'browser', generation: 'gen', control_epoch: 1 } as BrowserSession;
  const carrier = { operationDrivenMedia: true, current: () => true } as BrowserCarrier;
  let daemon!: WebSocket, attachments = 0, frames = 0, pending = false;
  let unblock: (() => void) | undefined;
  const control = {
    expireControllers() {}, onFence() {},
    repository: { command: (_session: unknown, command: unknown) => ({ command }) },
    mediaAuthority: async () => {
      if (pending) await new Promise<void>(resolve => { unblock = resolve });
      return { session: { ...session }, carrier };
    },
  } as unknown as BrowserControl;
  const media = new BrowserMedia(control, `${endpoint}/daemon`, async (_, request) => {
    attachments++;
    daemon = new WebSocket(`${endpoint}/daemon`);
    sockets.add(daemon);
    daemon.on('error', () => {});
    daemon.on('message', () => daemon.send(JSON.stringify({
      target_id: 'page', document_id: 'doc', frame_token: 'frame', width: 800, height: 600, image: 'fixture', targets: [],
    })));
    await once(daemon, 'open');
    daemon.send(JSON.stringify({ ticket: request.command.ticket }));
    return { ok: true, outcome: 'completed', data: {} };
  });
  server.on('connection', (socket, request) => {
    sockets.add(socket);
    socket.on('error', () => {});
    if (request.url === '/daemon') media.attachDaemon(socket);
    else void media.attachViewer(socket, 'alice', 'browser', request.url!, async () => true).catch(() => socket.terminate());
  });
  t.after(async () => {
    unblock?.(); media.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const connect = async (name: string) => {
    const socket = new WebSocket(`${endpoint}/${name}`);
    sockets.add(socket);
    socket.on('message', raw => {
      if (JSON.parse(raw.toString()).type === 'frame') { frames++; socket.send('{"type":"ack"}'); }
    });
    await once(socket, 'open');
    return socket;
  };
  const first = await connect('first');
  await until(() => frames === 1);
  session.control_epoch = 2;
  daemon.send('{"refresh":true}');
  await until(() => frames === 2);
  assert.equal(first.readyState, WebSocket.OPEN);
  assert.equal(control.isSizingViewer('alice', session, '/first'), true);
  assert.equal(control.isSizingViewer('bob', session, '/first'), false);
  const second = await connect('second');
  await until(() => frames >= 4);
  assert.equal(attachments, 1, 'new epoch joins the same daemon socket');
  assert.equal(control.isSizingViewer('alice', session, '/second'), false);
  pending = true;
  daemon.send('{"refresh":true}');
  await until(() => Boolean(unblock));
  const before = frames;
  control.onFence('browser'); // Takeover while authorization is awaiting IO.
  pending = false;
  unblock!();
  await until(() => first.readyState === WebSocket.CLOSED && second.readyState === WebSocket.CLOSED);
  assert.equal(frames, before, 'delayed authorization cannot deliver after the fence');
});
