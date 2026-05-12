import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { handleFileResolveResult } from "../../files/file-resolve.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  type DataPlaneSessionTracker,
} from "../../transport/data-plane-router.js";
import { daemonTransportRouter } from "../../transport/composite-daemon-router.js";
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

const BUD_WITH_FILE_RESOLVE = {
  budId: "bud-1",
  createdByUserId: "user-1",
  capabilities: {
    files: {
      workspace_read: true,
      roots: ["workspace"],
      permissions: ["stat", "read", "range"],
      resolve: { absolute_posix: true },
    },
  },
};

function makeDataPlaneTracker(streams: string[]): DataPlaneSessionTracker {
  return {
    budId: "bud-1",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_ws",
    transportSessionId: "ts_ws",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(streams),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame() {
      // noop
    },
    isActive() {
      return true;
    },
  };
}

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
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([
                {
                  metadata: {
                    path_context: {
                      schema: "terminal_cwd_v1",
                      source: "terminal_runtime_cache",
                      reported_by: "tmux_pane_current_path",
                      terminal_session_id: "sess_test",
                      host_cwd: "/Users/adam/bud/service",
                      captured_at: "2026-05-01T20:00:00.000Z",
                    },
                  },
                },
              ]);
            },
          };
        },
      };
    },
  }) as never);

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
  assert.deepEqual((capturedSession.displayMetadata as Record<string, unknown>).path_context, {
    schema: "terminal_cwd_v1",
    source: "terminal_runtime_cache",
    reported_by: "tmux_pane_current_path",
    terminal_session_id: "sess_test",
    host_cwd: "/Users/adam/bud/service",
    captured_at: "2026-05-01T20:00:00.000Z",
  });

  const payload = response.payload as {
    file_session: {
      thread_id: string;
      bud_id: string;
      max_bytes: number;
      path: { raw_path: string; relative_path: string };
      display_metadata: {
        line: number;
        column: number;
        path_context: Record<string, unknown>;
      };
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
  assert.equal(payload.file_session.display_metadata.path_context.host_cwd, "/Users/adam/bud/service");
  assert.equal(payload.viewer.suggested_kind, "code");
  assert.equal(payload.viewer.language, "typescript");
  assert.equal(payload.viewer.line, 42);
  assert.equal(payload.viewer.column, 7);
});

test("thread file-open route resolves absolute POSIX paths through the daemon", async (t) => {
  t.after(() => {
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);
  mock.method(db.query.budTable, "findFirst", async () => BUD_WITH_FILE_RESOLVE as never);
  registerActiveDataPlaneSessionTracker(makeDataPlaneTracker(["file_read"]));

  let resolveFrame: Record<string, unknown> | null = null;
  mock.method(daemonTransportRouter, "sendFrameToBud", (_budId: string, frame: Record<string, unknown>) => {
    resolveFrame = frame;
    queueMicrotask(() => {
      handleFileResolveResult({
        proto: "0.1",
        type: "file_resolve_result",
        id: "msg_file_resolve_result",
        ts: Date.now(),
        ext: {},
        operation_id: frame.operation_id,
        accepted: true,
        root_key: "workspace",
        requested_path_kind: "absolute_posix",
        resolved_against: "absolute_path",
        resolved_relative_path: "docs/proto.md",
        content_identity: { size: 4096, modified_ms: 1777132800000 },
        size: 4096,
      });
    });
    return true;
  });

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
                    contentIdentity: values.contentIdentity ?? null,
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
      path: "/Users/adam/bud/docs/proto.md:12",
      source: {
        kind: "markdown_preview",
        message_id: "22222222-2222-4222-8222-222222222222",
        client_id: "33333333-3333-4333-8333-333333333333",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  const capturedResolveFrame = resolveFrame as Record<string, unknown> | null;
  assert.ok(capturedResolveFrame);
  assert.equal(capturedResolveFrame.type, "file_resolve");
  assert.equal(capturedResolveFrame.requested_path, "/Users/adam/bud/docs/proto.md");
  assert.equal(capturedResolveFrame.requested_path_kind, "absolute_posix");

  const capturedSession = insertedSession as Record<string, unknown> | null;
  assert.ok(capturedSession);
  assert.equal(capturedSession.relativePath, "docs/proto.md");
  assert.deepEqual(capturedSession.contentIdentity, { size: 4096, modified_ms: 1777132800000 });
  assert.equal((capturedSession.displayMetadata as Record<string, unknown>).requested_path_kind, "absolute_posix");
  assert.equal((capturedSession.displayMetadata as Record<string, unknown>).resolved_against, "absolute_path");

  const payload = response.payload as {
    file_session: {
      path: { raw_path: string; relative_path: string };
      content_identity: Record<string, unknown>;
      display_metadata: Record<string, unknown>;
    };
    viewer: { display_name: string; suggested_kind: string; line: number };
  };
  assert.equal(payload.file_session.path.raw_path, "/Users/adam/bud/docs/proto.md:12");
  assert.equal(payload.file_session.path.relative_path, "docs/proto.md");
  assert.deepEqual(payload.file_session.content_identity, { size: 4096, modified_ms: 1777132800000 });
  assert.equal(payload.file_session.display_metadata.resolved_against, "absolute_path");
  assert.equal(payload.viewer.display_name, "proto.md");
  assert.equal(payload.viewer.suggested_kind, "markdown");
  assert.equal(payload.viewer.line, 12);
});

test("thread file-open route maps daemon absolute path denial to 403", async (t) => {
  t.after(() => {
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);
  mock.method(db.query.budTable, "findFirst", async () => BUD_WITH_FILE_RESOLVE as never);
  mock.method(db, "transaction", async () => {
    throw new Error("transaction should not run for denied resolve");
  });
  registerActiveDataPlaneSessionTracker(makeDataPlaneTracker(["file_read"]));
  mock.method(daemonTransportRouter, "sendFrameToBud", (_budId: string, frame: Record<string, unknown>) => {
    queueMicrotask(() => {
      handleFileResolveResult({
        proto: "0.1",
        type: "file_resolve_result",
        id: "msg_file_resolve_result",
        ts: Date.now(),
        ext: {},
        operation_id: frame.operation_id,
        accepted: false,
        error: {
          code: "POLICY_DENIED",
          message: "path is outside the Bud file-viewer scope",
          retryable: false,
        },
      });
    });
    return true;
  });

  const server = createServer();
  await registerThreadFileRoutes(server);

  const handler = server.handlers.get("POST /api/threads/:threadId/files/open");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD.threadId },
    body: { path: "/Users/adam/secrets.txt" },
  });

  assert.equal(response.statusCode, 403);
  assert.equal((response.payload as { code: string }).code, "POLICY_DENIED");
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
    body: { path: "https://example.com/file.ts" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal((response.payload as { error: string }).error, "invalid_file_path");
});
