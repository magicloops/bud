import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { providerRegistry } from "../../llm/index.js";
import { registerThreadMessageRoutes } from "./messages.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type InsertedReadState = {
  threadId?: string;
  userId?: string;
  lastSeenMessageId?: string;
};

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
    log: {
      info() {
        // noop
      },
      warn() {
        // noop
      },
      debug() {
        // noop
      },
      error() {
        // noop
      },
    },
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

const ACCESS = {
  thread: {
    threadId: "11111111-1111-4111-8111-111111111111",
    budId: "bud-1",
    title: null,
    lastActivityAt: new Date("2026-04-21T20:00:00.000Z"),
    lastMessagePreview: null,
    messageCount: 1,
    pinned: false,
    archived: false,
    modelId: null,
    reasoningEffort: null,
    deletedAt: null,
    tenantId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-04-21T20:00:00.000Z"),
    updatedAt: new Date("2026-04-21T20:00:00.000Z"),
    lastAttentionMessageId: null,
    lastAttentionMessageCreatedAt: null,
    lastAttentionKind: null,
  },
};

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

test("POST /api/threads/:threadId/read upserts the watermark when the message is newer", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadMessageRoutes(
    server,
    {} as never,
    {} as never,
  );

  const handler = server.routes.get("POST /api/threads/:threadId/read");
  assert.ok(handler, "expected read-watermark route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => ACCESS.thread as never);

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([
                {
                  messageId: "22222222-2222-4222-8222-222222222222",
                  createdAt: new Date("2026-04-21T20:15:00.000Z"),
                },
              ]);
            },
          };
        },
      };
    },
  }) as never);

  mock.method(db.query.threadReadStateTable, "findFirst", async () => ({
    threadId: ACCESS.thread.threadId,
    userId: SESSION.user.id,
    lastSeenMessageId: "33333333-3333-4333-8333-333333333333",
    lastSeenMessageCreatedAt: new Date("2026-04-21T20:10:00.000Z"),
  }) as never);

  let insertedValues: InsertedReadState | null = null;
  let conflictConfig: Record<string, unknown> | null = null;

  mock.method(db, "insert", () => ({
    values(values: InsertedReadState) {
      insertedValues = values;
      return {
        onConflictDoUpdate(config: Record<string, unknown>) {
          conflictConfig = config;
          return Promise.resolve(undefined);
        },
      };
    },
  }) as never);

  const response = await invokeRoute(handler, {
    params: { threadId: ACCESS.thread.threadId },
    body: { last_seen_message_id: "22222222-2222-4222-8222-222222222222" },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    ok: true,
    updated: true,
    last_seen_message_id: "22222222-2222-4222-8222-222222222222",
  });
  const capturedInsert = insertedValues as InsertedReadState | null;
  assert.equal(capturedInsert?.threadId, ACCESS.thread.threadId);
  assert.equal(capturedInsert?.userId, SESSION.user.id);
  assert.equal(capturedInsert?.lastSeenMessageId, "22222222-2222-4222-8222-222222222222");
  assert.ok(conflictConfig, "expected onConflictDoUpdate to be configured");
});

test("POST /api/threads/:threadId/read returns updated=false for stale watermarks", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadMessageRoutes(
    server,
    {} as never,
    {} as never,
  );

  const handler = server.routes.get("POST /api/threads/:threadId/read");
  assert.ok(handler, "expected read-watermark route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => ACCESS.thread as never);

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([
                {
                  messageId: "22222222-2222-4222-8222-222222222222",
                  createdAt: new Date("2026-04-21T20:15:00.000Z"),
                },
              ]);
            },
          };
        },
      };
    },
  }) as never);

  mock.method(db.query.threadReadStateTable, "findFirst", async () => ({
    threadId: ACCESS.thread.threadId,
    userId: SESSION.user.id,
    lastSeenMessageId: "44444444-4444-4444-8444-444444444444",
    lastSeenMessageCreatedAt: new Date("2026-04-21T20:20:00.000Z"),
  }) as never);

  let insertCalled = false;
  mock.method(db, "insert", () => {
    insertCalled = true;
    throw new Error("insert should not be called for stale watermark");
  });

  const response = await invokeRoute(handler, {
    params: { threadId: ACCESS.thread.threadId },
    body: { last_seen_message_id: "22222222-2222-4222-8222-222222222222" },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    ok: true,
    updated: false,
    last_seen_message_id: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal(insertCalled, false);
});

test("GET /api/threads/:threadId/messages returns intermediate assistant phase metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadMessageRoutes(
    server,
    {} as never,
    {} as never,
  );

  const handler = server.routes.get("GET /api/threads/:threadId/messages");
  assert.ok(handler, "expected message history route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => ACCESS.thread as never);

  const commentaryMessage = {
    messageId: "55555555-5555-4555-8555-555555555555",
    clientId: "66666666-6666-4666-8666-666666666666",
    threadId: ACCESS.thread.threadId,
    role: "assistant",
    displayRole: "Bud Agent",
    content: "I will inspect the terminal first.",
    metadata: {
      status: "succeeded",
      turn_id: "turn-1",
      segment_kind: "intermediate",
      assistant_phase: "commentary",
      followed_by_tool_call: true,
    },
    createdByUserId: SESSION.user.id,
    createdAt: new Date("2026-05-22T20:00:05.000Z"),
    updatedAt: new Date("2026-05-22T20:00:05.000Z"),
  };

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            orderBy() {
              return {
                limit() {
                  return Promise.resolve([commentaryMessage]);
                },
              };
            },
          };
        },
      };
    },
  }) as never);

  const response = await invokeRoute(handler, {
    params: { threadId: ACCESS.thread.threadId },
    query: { limit: 100 },
    headers: {},
  });

  assert.equal(response.statusCode, 200);
  const payload = response.payload as {
    messages: Array<Record<string, unknown>>;
    page: Record<string, unknown>;
  };
  assert.deepEqual(payload.messages, [
    {
      message_id: commentaryMessage.messageId,
      client_id: commentaryMessage.clientId,
      role: "assistant",
      display_role: "Bud Agent",
      content: "I will inspect the terminal first.",
      metadata: {
        status: "succeeded",
        turn_id: "turn-1",
        segment_kind: "intermediate",
        assistant_phase: "commentary",
        followed_by_tool_call: true,
      },
      created_at: commentaryMessage.createdAt,
    },
  ]);
  assert.equal(payload.page.limit, 100);
  assert.equal(payload.page.returned, 1);
  assert.equal(payload.page.has_more_before, false);
  assert.equal(payload.page.has_more_after, false);
  assert.equal(typeof payload.page.before_cursor, "string");
  assert.equal(payload.page.before_cursor, payload.page.after_cursor);
});

test("POST /api/threads/:threadId/messages rejects invalid explicit reasoning before persistence", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const server = createServer();
  await registerThreadMessageRoutes(
    server,
    {} as never,
    {} as never,
  );

  const handler = server.routes.get("POST /api/threads/:threadId/messages");
  assert.ok(handler, "expected create-message route to register");

  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => ACCESS.thread as never);
  mock.method(providerRegistry, "getProviderForModel", () => ({ name: "openai" }) as never);

  let selectCalled = false;
  mock.method(db, "select", () => {
    selectCalled = true;
    throw new Error("select should not be called for invalid model selection");
  });

  const response = await invokeRoute(handler, {
    params: { threadId: ACCESS.thread.threadId },
    body: {
      text: "hello",
      model: "gpt-5.5",
      reasoning_effort: "max",
    },
    headers: {},
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.payload, {
    error: "invalid_reasoning_effort",
    message: "Reasoning effort max is not supported by gpt-5.5",
    model: "gpt-5.5",
    supported_values: ["none", "low", "medium", "high", "xhigh"],
  });
  assert.equal(selectCalled, false);
});
