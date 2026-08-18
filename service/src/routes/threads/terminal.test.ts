import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadTerminalRoutes } from "./terminal.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(payload: unknown): unknown {
    this.payload = payload;
    this.sent = true;
    return payload;
  }
}

function createServer(): FastifyInstance & { routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>();

  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    };

  return {
    routes,
    get: addRoute("GET"),
    post: addRoute("POST"),
  } as unknown as FastifyInstance & { routes: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler(request, reply);

  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

const SESSION = {
  user: {
    id: "user-1",
    email: "test@example.com",
    emailVerified: true,
    name: "Test User",
    image: null,
  },
  session: {
    id: "session-1",
    expiresAt: new Date("2026-04-21T21:00:00.000Z"),
  },
};

const THREAD = {
  threadId: THREAD_ID,
  budId: "bud-1",
  title: null,
  lastActivityAt: new Date("2026-04-21T20:00:00.000Z"),
  lastMessagePreview: null,
  messageCount: 1,
  pinned: false,
  archived: false,
  deletedAt: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-21T20:00:00.000Z"),
  updatedAt: new Date("2026-04-21T20:00:00.000Z"),
  lastAttentionMessageId: null,
  lastAttentionMessageCreatedAt: null,
  lastAttentionKind: null,
};

test("POST /api/threads/:threadId/terminal/interrupt sends Ctrl+C through the terminal manager", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  const interruptCalls: string[] = [];
  await registerThreadTerminalRoutes(
    server,
    {
      async interruptThreadTerminal(threadId: string) {
        interruptCalls.push(threadId);
        return {
          ok: true,
          sessionId: "sess-1",
          dispatched: true,
          rejectedPendingRequests: 1,
        };
      },
    } as never,
    {} as never,
  );

  const handler = server.routes.get("POST /api/threads/:threadId/terminal/interrupt");
  assert.ok(handler, "expected terminal interrupt route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD_ID },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(interruptCalls, [THREAD_ID]);
  assert.deepEqual(response.payload, {
    ok: true,
    session_id: "sess-1",
    submitted: true,
    rejected_pending_requests: 1,
  });
});

test("POST /api/threads/:threadId/terminal/interrupt returns 404 without an active terminal session", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadTerminalRoutes(
    server,
    {
      async interruptThreadTerminal() {
        return { ok: false, error: "no_terminal_session" };
      },
    } as never,
    {} as never,
  );

  const handler = server.routes.get("POST /api/threads/:threadId/terminal/interrupt");
  assert.ok(handler, "expected terminal interrupt route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD_ID },
    headers: {},
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, { error: "no_terminal_session" });
});

type ObserveCall = { sessionId: string; options: { view?: string; lines?: number } };

function createSnapshotManager(overrides: Record<string, unknown> = {}) {
  const observeCalls: ObserveCall[] = [];
  const manager = {
    async getSessionForThread() {
      return {
        sessionId: "sess-1",
        threadId: THREAD_ID,
        budId: "bud-1",
        state: "active",
        cols: 120,
        rows: 40,
        createdAt: new Date(),
        startedAt: null,
        lastActivityAt: null,
      };
    },
    isBudOnline() {
      return true;
    },
    async observeTerminal(sessionId: string, options: { view?: string; lines?: number }) {
      observeCalls.push({ sessionId, options });
      if (options.view === "history") {
        return {
          view: "history",
          output: "line one\nline two",
          linesCaptured: 2,
        };
      }
      return {
        view: "screen",
        output: "prompt $ ",
        linesCaptured: 1,
        mode: "shell",
        integration: "osc133",
        altScreen: false,
        ringNextOffset: 84213,
      };
    },
    getSessionContext() {
      return { mode: "unknown", integration: null, cwd: null };
    },
    getLastOffset() {
      return 42;
    },
    ...overrides,
  };
  return { manager, observeCalls };
}

async function invokeSnapshot(
  manager: Record<string, unknown>,
  request: Record<string, unknown>,
): Promise<{ statusCode: number; payload: unknown }> {
  const server = createServer();
  await registerThreadTerminalRoutes(server, manager as never, {} as never);
  const handler = server.routes.get("GET /api/threads/:threadId/terminal/snapshot");
  assert.ok(handler, "expected terminal snapshot route to register");
  return invokeRoute(handler, {
    params: { threadId: THREAD_ID },
    headers: {},
    log: { warn() {} },
    ...request,
  });
}

test("GET /terminal/snapshot observes history then screen and reports the screen watermark", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const { manager, observeCalls } = createSnapshotManager();
  const response = await invokeSnapshot(manager, { query: {} });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(observeCalls, [
    { sessionId: "sess-1", options: { view: "history", lines: 1000 } },
    { sessionId: "sess-1", options: { view: "screen" } },
  ]);
  assert.deepEqual(response.payload, {
    session_id: "sess-1",
    mode: "shell",
    integration: "osc133",
    alt_screen: false,
    history_text: "line one\nline two",
    screen_text: "prompt $ ",
    cols: 120,
    rows: 40,
    ring_next_offset: 84213,
  });
});

test("GET /terminal/snapshot caps lines at 2000 and falls back to runtime context and stored watermark", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const observeCalls: ObserveCall[] = [];
  const { manager } = createSnapshotManager({
    async observeTerminal(sessionId: string, options: { view?: string; lines?: number }) {
      observeCalls.push({ sessionId, options });
      // Older daemon: no mode/integration/ring_next_offset facts on results.
      return {
        view: options.view ?? "screen",
        output: options.view === "history" ? "old history" : "old screen",
        linesCaptured: 1,
      };
    },
    getSessionContext() {
      return { mode: "tui", integration: "none", cwd: "/repo" };
    },
  });

  const response = await invokeSnapshot(manager, { query: { lines: "99999" } });

  assert.equal(response.statusCode, 200);
  assert.equal(observeCalls[0]?.options.lines, 2000);
  const payload = response.payload as Record<string, unknown>;
  assert.equal(payload.mode, "tui");
  assert.equal(payload.integration, "none");
  assert.equal(payload.alt_screen, false);
  assert.equal(payload.ring_next_offset, 42);
});

test("GET /terminal/snapshot returns 401 for unauthenticated requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => null as never);

  const { manager } = createSnapshotManager();
  const response = await invokeSnapshot(manager, { query: {} });

  assert.equal(response.statusCode, 401);
});

test("GET /terminal/snapshot returns 404 without an open terminal session", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const { manager } = createSnapshotManager({
    async getSessionForThread() {
      return null;
    },
  });
  const response = await invokeSnapshot(manager, { query: {} });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, { error: "no_terminal_session" });
});

test("GET /terminal/snapshot returns 503 when the bud is offline", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const offline = createSnapshotManager({
    isBudOnline() {
      return false;
    },
  });
  const offlineResponse = await invokeSnapshot(offline.manager, { query: {} });
  assert.equal(offlineResponse.statusCode, 503);
  assert.deepEqual(offlineResponse.payload, { error: "bud_offline" });

  // Race: the bud drops between the online check and the observe dispatch.
  const raced = createSnapshotManager({
    async observeTerminal() {
      throw new Error("bud_offline");
    },
  });
  const racedResponse = await invokeSnapshot(raced.manager, { query: {} });
  assert.equal(racedResponse.statusCode, 503);
  assert.deepEqual(racedResponse.payload, { error: "bud_offline" });
});

test("GET /terminal/snapshot returns 502 when a daemon observe fails or times out", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const { manager } = createSnapshotManager({
    async observeTerminal(_sessionId: string, options: { view?: string }) {
      if (options.view === "history") {
        return { view: "history", output: "line", linesCaptured: 1 };
      }
      throw new Error("observe_timeout");
    },
  });
  const response = await invokeSnapshot(manager, { query: {} });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.payload, { error: "observe_failed" });
});

test("GET /terminal/stream resumes from a byte-offset Last-Event-ID via durable replay", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const { TerminalEventBus } = await import("../../runtime/event-bus.js");
  const terminalEvents = new TerminalEventBus();
  const stored = Buffer.from("hello world", "utf-8");

  const server = createServer();
  await registerThreadTerminalRoutes(
    server,
    {
      async getSessionForThread() {
        return {
          sessionId: "sess-1",
          threadId: THREAD_ID,
          budId: "bud-1",
          state: "active",
          cols: 200,
          rows: 50,
          createdAt: new Date(),
          startedAt: null,
          lastActivityAt: null,
        };
      },
      async readOutputRange(
        sessionId: string,
        options: { startOffset: number; endOffset?: number; maxBytes: number },
      ) {
        if (sessionId !== "sess-1") {
          throw new Error("unexpected session");
        }
        const data = stored.subarray(options.startOffset);
        return {
          data,
          startOffset: options.startOffset,
          endOffset: options.startOffset + data.length,
          truncated: false,
          nextOffset: null,
        };
      },
    } as never,
    terminalEvents as never,
  );

  const handler = server.routes.get("GET /api/threads/:threadId/terminal/stream");
  assert.ok(handler, "expected terminal stream route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const sseEvents: Array<{ event?: string; data?: string; id?: string }> = [];
  const closeCallbacks: Array<() => void> = [];
  const reply = new TestReply() as TestReply & {
    sse: (evt: { event?: string; data?: string; id?: string }) => void;
    raw: { on: (event: string, cb: () => void) => void };
    log: { warn: (...args: unknown[]) => void };
  };
  reply.sse = (evt) => {
    sseEvents.push(evt);
  };
  reply.raw = {
    on(event, cb) {
      if (event === "close") {
        closeCallbacks.push(cb);
      }
    },
  };
  reply.log = { warn() {} };
  t.after(() => {
    for (const cb of closeCallbacks) {
      cb();
    }
  });

  await handler(
    {
      params: { threadId: THREAD_ID },
      query: {},
      headers: { "last-event-id": "4" },
      log: { warn() {} },
    },
    reply,
  );

  // Live events after replay: an overlapping chunk (dropped), a new chunk and
  // a terminal.event (both forwarded).
  terminalEvents.emit("sess-1", {
    event: "terminal.output",
    data: { data: Buffer.from("world").toString("base64"), byte_offset: 6 },
    id: "11",
  });
  terminalEvents.emit("sess-1", {
    event: "terminal.output",
    data: { data: Buffer.from("!").toString("base64"), byte_offset: 11 },
    id: "12",
  });
  terminalEvents.emit("sess-1", {
    event: "terminal.event",
    data: { session_id: "sess-1", event: "prompt_ready", data: { cwd: "/tmp" }, ts: 1 },
  });

  const outputEvents = sseEvents.filter((evt) => evt.event === "terminal.output");
  assert.equal(outputEvents.length, 2);

  const replayed = JSON.parse(outputEvents[0]!.data!) as { data: string; byte_offset: number };
  assert.equal(replayed.byte_offset, 4);
  assert.equal(Buffer.from(replayed.data, "base64").toString("utf-8"), "o world");
  assert.equal(outputEvents[0]!.id, "11");

  const live = JSON.parse(outputEvents[1]!.data!) as { data: string; byte_offset: number };
  assert.equal(live.byte_offset, 11);
  assert.equal(outputEvents[1]!.id, "12");

  const forwardedEvent = sseEvents.find((evt) => evt.event === "terminal.event");
  assert.ok(forwardedEvent, "expected terminal.event to be forwarded live");
});

// Shared harness for the resume-cursor matrix: durable store holds
// "hello world" (offsets 0..11); after attach, live events replay an
// overlapping chunk at 6, a new chunk at 11, and a terminal.event.
async function runStreamResume(request: {
  query: Record<string, string>;
  headers: Record<string, string>;
}): Promise<{
  sseEvents: Array<{ event?: string; data?: string; id?: string }>;
  cleanup: () => void;
}> {
  const { TerminalEventBus } = await import("../../runtime/event-bus.js");
  const terminalEvents = new TerminalEventBus();
  const stored = Buffer.from("hello world", "utf-8");

  const server = createServer();
  await registerThreadTerminalRoutes(
    server,
    {
      async getSessionForThread() {
        return {
          sessionId: "sess-1",
          threadId: THREAD_ID,
          budId: "bud-1",
          state: "active",
          cols: 200,
          rows: 50,
          createdAt: new Date(),
          startedAt: null,
          lastActivityAt: null,
        };
      },
      async readOutputRange(
        sessionId: string,
        options: { startOffset: number; endOffset?: number; maxBytes: number },
      ) {
        if (sessionId !== "sess-1") {
          throw new Error("unexpected session");
        }
        const data = stored.subarray(options.startOffset);
        return {
          data,
          startOffset: options.startOffset,
          endOffset: options.startOffset + data.length,
          truncated: false,
          nextOffset: null,
        };
      },
    } as never,
    terminalEvents as never,
  );

  const handler = server.routes.get("GET /api/threads/:threadId/terminal/stream");
  assert.ok(handler, "expected terminal stream route to register");

  const sseEvents: Array<{ event?: string; data?: string; id?: string }> = [];
  const closeCallbacks: Array<() => void> = [];
  const reply = new TestReply() as TestReply & {
    sse: (evt: { event?: string; data?: string; id?: string }) => void;
    raw: { on: (event: string, cb: () => void) => void };
    log: { warn: (...args: unknown[]) => void };
  };
  reply.sse = (evt) => {
    sseEvents.push(evt);
  };
  reply.raw = {
    on(event, cb) {
      if (event === "close") {
        closeCallbacks.push(cb);
      }
    },
  };
  reply.log = { warn() {} };

  await handler(
    {
      params: { threadId: THREAD_ID },
      query: request.query,
      headers: request.headers,
      log: { warn() {} },
    },
    reply,
  );

  terminalEvents.emit("sess-1", {
    event: "terminal.output",
    data: { data: Buffer.from("world").toString("base64"), byte_offset: 6 },
    id: "11",
  });
  terminalEvents.emit("sess-1", {
    event: "terminal.output",
    data: { data: Buffer.from("!").toString("base64"), byte_offset: 11 },
    id: "12",
  });
  terminalEvents.emit("sess-1", {
    event: "terminal.event",
    data: { session_id: "sess-1", event: "prompt_ready", data: { cwd: "/tmp" }, ts: 1 },
  });

  return {
    sseEvents,
    cleanup: () => {
      for (const cb of closeCallbacks) {
        cb();
      }
    },
  };
}

test("GET /terminal/stream resumes from ?from_offset with replay-then-live ordering and cursor filtering", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const { sseEvents, cleanup } = await runStreamResume({
    query: { from_offset: "4" },
    headers: {},
  });
  t.after(cleanup);

  const outputEvents = sseEvents.filter((evt) => evt.event === "terminal.output");
  assert.equal(outputEvents.length, 2);

  // Replayed durable output first, from exactly the requested cursor.
  const replayed = JSON.parse(outputEvents[0]!.data!) as { data: string; byte_offset: number };
  assert.equal(replayed.byte_offset, 4);
  assert.equal(Buffer.from(replayed.data, "base64").toString("utf-8"), "o world");
  assert.equal(outputEvents[0]!.id, "11");

  // The live chunk at offset 6 overlaps the replay (< replay end 11) and is
  // filtered; the live chunk at 11 flows through after the replay.
  const live = JSON.parse(outputEvents[1]!.data!) as { data: string; byte_offset: number };
  assert.equal(live.byte_offset, 11);
  assert.equal(outputEvents[1]!.id, "12");

  const forwardedEvent = sseEvents.find((evt) => evt.event === "terminal.event");
  assert.ok(forwardedEvent, "expected terminal.event to be forwarded live");
});

test("GET /terminal/stream resumes from the HIGHEST cursor when both are present", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  // from_offset higher than the header: from_offset wins.
  {
    const { sseEvents, cleanup } = await runStreamResume({
      query: { from_offset: "6" },
      headers: { "last-event-id": "0" },
    });
    t.after(cleanup);
    const outputEvents = sseEvents.filter((evt) => evt.event === "terminal.output");
    assert.equal(outputEvents.length, 2);
    const replayed = JSON.parse(outputEvents[0]!.data!) as { data: string; byte_offset: number };
    assert.equal(replayed.byte_offset, 6);
    assert.equal(Buffer.from(replayed.data, "base64").toString("utf-8"), "world");
  }

  // Native EventSource auto-reconnect: stale from_offset in the reused URL,
  // fresher Last-Event-ID header — the header must win or the reconnect
  // replays already-rendered output.
  {
    const { sseEvents, cleanup } = await runStreamResume({
      query: { from_offset: "0" },
      headers: { "last-event-id": "6" },
    });
    t.after(cleanup);
    const outputEvents = sseEvents.filter((evt) => evt.event === "terminal.output");
    assert.equal(outputEvents.length, 2);
    const replayed = JSON.parse(outputEvents[0]!.data!) as { data: string; byte_offset: number };
    assert.equal(replayed.byte_offset, 6, "stale from_offset must not beat a fresher Last-Event-ID");
  }
});
