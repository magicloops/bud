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
          submitted: true,
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
