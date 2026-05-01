import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadFileRoutes } from "./files.js";

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

function createServer(): FastifyInstance & {
  handlers: Map<string, RouteHandler>;
  post: (path: string, handler: RouteHandler) => void;
} {
  const handlers = new Map<string, RouteHandler>();
  return {
    handlers,
    post(path: string, handler: RouteHandler) {
      handlers.set(`POST ${path}`, handler);
    },
  } as unknown as FastifyInstance & {
    handlers: Map<string, RouteHandler>;
    post: (path: string, handler: RouteHandler) => void;
  };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

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
    expiresAt: new Date("2026-05-01T21:00:00.000Z"),
  },
};

const THREAD = {
  threadId: "11111111-1111-4111-8111-111111111111",
  budId: "bud-1",
  title: null,
  lastMessagePreview: null,
  lastActivityAt: new Date("2026-05-01T20:00:00.000Z"),
  messageCount: 0,
  pinned: false,
  archived: false,
  modelId: null,
  reasoningEffort: null,
  deletedAt: null,
  lastAttentionMessageId: null,
  lastAttentionMessageCreatedAt: null,
  lastAttentionKind: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-05-01T20:00:00.000Z"),
};

test("thread file-open route rejects unauthenticated requests", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => null);

  const server = createServer();
  await registerThreadFileRoutes(server);

  const handler = server.handlers.get("POST /api/threads/:threadId/files/open");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD.threadId },
      body: { path: "README.md" },
    }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
});

test("thread file-open route returns 404 for non-owned threads", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => null);

  const server = createServer();
  await registerThreadFileRoutes(server);

  const handler = server.handlers.get("POST /api/threads/:threadId/files/open");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD.threadId },
      body: { path: "README.md" },
    }),
    { statusCode: 404, payload: { error: "thread_not_found" } },
  );
});

test("thread file-open route creates a viewer-scoped file session", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  let insertedSession: Record<string, unknown> | null = null;
  mock.method(db, "transaction", (async (callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert() {
        return {
          values(values: Record<string, unknown>) {
            if ("fileSessionId" in values) {
              insertedSession = values;
              return {
                returning: async () => [
                  {
                    ...values,
                    operationId: null,
                    activeStreamId: null,
                    contentIdentity: null,
                    revokedAt: null,
                    revokedByUserId: null,
                    revokeReason: null,
                    tenantId: null,
                    createdAt: new Date("2026-05-01T20:00:00.000Z"),
                    updatedAt: new Date("2026-05-01T20:00:00.000Z"),
                  },
                ],
              };
            }
            return Promise.resolve();
          },
        };
      },
    };
    return callback(tx);
  }) as never);

  const server = createServer();
  await registerThreadFileRoutes(server);

  const handler = server.handlers.get("POST /api/threads/:threadId/files/open");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD.threadId },
    body: {
      path: "./service/src/files/file-session.ts:42:7",
      source: {
        kind: "assistant_message",
        message_id: "22222222-2222-4222-8222-222222222222",
        client_id: "33333333-3333-4333-8333-333333333333",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  const capturedSession = insertedSession as Record<string, unknown> | null;
  assert.ok(capturedSession);
  assert.equal(capturedSession.budId, "bud-1");
  assert.equal(capturedSession.threadId, THREAD.threadId);
  assert.equal(capturedSession.createdByUserId, "user-1");
  assert.equal(capturedSession.rootKey, "workspace");
  assert.equal(capturedSession.relativePath, "service/src/files/file-session.ts");
  assert.equal(capturedSession.maxBytes, 1024 * 1024);
  assert.deepEqual(capturedSession.permissions, ["stat", "read", "range"]);

  const payload = response.payload as {
    file_session: {
      thread_id: string;
      bud_id: string;
      max_bytes: number;
      path: { raw_path: string; relative_path: string };
      display_metadata: { line: number; column: number };
    };
    viewer: { suggested_kind: string; language: string; line: number; column: number };
  };
  assert.equal(payload.file_session.bud_id, "bud-1");
  assert.equal(payload.file_session.thread_id, THREAD.threadId);
  assert.equal(payload.file_session.max_bytes, 1024 * 1024);
  assert.equal(payload.file_session.path.raw_path, "./service/src/files/file-session.ts:42:7");
  assert.equal(payload.file_session.path.relative_path, "service/src/files/file-session.ts");
  assert.equal(payload.file_session.display_metadata.line, 42);
  assert.equal(payload.file_session.display_metadata.column, 7);
  assert.equal(payload.viewer.suggested_kind, "code");
  assert.equal(payload.viewer.language, "typescript");
  assert.equal(payload.viewer.line, 42);
  assert.equal(payload.viewer.column, 7);
});

test("thread file-open route rejects unsupported path forms", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const server = createServer();
  await registerThreadFileRoutes(server);

  const handler = server.handlers.get("POST /api/threads/:threadId/files/open");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD.threadId },
    body: { path: "/Users/adam/bud/README.md" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal((response.payload as { error: string }).error, "invalid_file_path");
});
