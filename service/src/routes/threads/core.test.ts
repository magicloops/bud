import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadCoreRoutes } from "./core.js";

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
    delete: addRoute("DELETE"),
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

test("GET /api/threads includes unread-attention fields in the serialized response", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadCoreRoutes(server, {} as never);

  const handler = server.routes.get("GET /api/threads");
  assert.ok(handler, "expected thread list route to register");

  mock.method(auth.api, "getSession", async () => ({
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
  }) as never);

  const rows = [
    {
      threadId: "11111111-1111-4111-8111-111111111111",
      budId: "bud-1",
      title: "Deploy work",
      createdAt: new Date("2026-04-21T20:00:00.000Z"),
      lastActivityAt: new Date("2026-04-21T20:20:00.000Z"),
      lastMessagePreview: "Done",
      messageCount: 4,
      pinned: false,
      archived: false,
      lastAttentionMessageId: "22222222-2222-4222-8222-222222222222",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T20:19:00.000Z"),
      lastAttentionKind: "assistant_completed",
      lastSeenMessageId: "33333333-3333-4333-8333-333333333333",
      lastSeenMessageCreatedAt: new Date("2026-04-21T20:10:00.000Z"),
      sessionId: "session-abc",
      sessionState: "ready",
    },
    {
      threadId: "44444444-4444-4444-8444-444444444444",
      budId: "bud-1",
      title: "Already read",
      createdAt: new Date("2026-04-21T19:00:00.000Z"),
      lastActivityAt: new Date("2026-04-21T19:30:00.000Z"),
      lastMessagePreview: "Earlier",
      messageCount: 2,
      pinned: false,
      archived: false,
      lastAttentionMessageId: "55555555-5555-4555-8555-555555555555",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T19:10:00.000Z"),
      lastAttentionKind: "assistant_completed",
      lastSeenMessageId: "66666666-6666-4666-8666-666666666666",
      lastSeenMessageCreatedAt: new Date("2026-04-21T19:15:00.000Z"),
      sessionId: null,
      sessionState: null,
    },
  ];

  mock.method(db, "select", () => {
    const chain = {
      from() {
        return chain;
      },
      leftJoin() {
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return Promise.resolve(rows);
      },
    };

    return chain;
  });

  const response = await invokeRoute(handler, {
    query: {},
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, [
    {
      thread_id: "11111111-1111-4111-8111-111111111111",
      bud_id: "bud-1",
      title: "Deploy work",
      created_at: new Date("2026-04-21T20:00:00.000Z"),
      last_activity_at: new Date("2026-04-21T20:20:00.000Z"),
      last_message_preview: "Done",
      message_count: 4,
      pinned: false,
      archived: false,
      has_unseen_attention: true,
      last_attention_kind: "assistant_completed",
      has_terminal_session: true,
      session_state: "ready",
      session_id: "session-abc",
    },
    {
      thread_id: "44444444-4444-4444-8444-444444444444",
      bud_id: "bud-1",
      title: "Already read",
      created_at: new Date("2026-04-21T19:00:00.000Z"),
      last_activity_at: new Date("2026-04-21T19:30:00.000Z"),
      last_message_preview: "Earlier",
      message_count: 2,
      pinned: false,
      archived: false,
      has_unseen_attention: false,
      last_attention_kind: "assistant_completed",
      has_terminal_session: false,
      session_state: null,
      session_id: null,
    },
  ]);
});
