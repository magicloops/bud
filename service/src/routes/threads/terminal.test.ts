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
