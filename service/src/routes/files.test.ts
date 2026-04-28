import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { db } from "../db/client.js";
import { registerFileRoutes } from "./files.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type RegisteredRoute = {
  method: string | string[];
  path: string;
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

function createServer(): FastifyInstance & {
  routes: RegisteredRoute[];
  handlers: Map<string, RouteHandler>;
} {
  const routes: RegisteredRoute[] = [];
  const handlers = new Map<string, RouteHandler>();

  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      routes.push({ method, path });
      handlers.set(`${method} ${path}`, handler);
    };

  return {
    routes,
    handlers,
    get: addRoute("GET"),
    post: addRoute("POST"),
    delete: addRoute("DELETE"),
    route(options: { method: string | string[]; url: string; handler: RouteHandler }) {
      routes.push({ method: options.method, path: options.url });
      handlers.set(
        `${Array.isArray(options.method) ? options.method.join("|") : options.method} ${options.url}`,
        options.handler,
      );
    },
  } as unknown as FastifyInstance & { routes: RegisteredRoute[]; handlers: Map<string, RouteHandler> };
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
    expiresAt: new Date("2026-04-21T21:00:00.000Z"),
  },
};

const FILE_SESSION_ROW = {
  fileSessionId: "fs_test",
  budId: "bud-1",
  threadId: null,
  operationId: null,
  activeStreamId: null,
  rootKey: "workspace",
  relativePath: "README.md",
  permissions: ["stat", "read", "range"],
  maxBytes: 1024,
  state: "ready",
  contentIdentity: null,
  displayMetadata: {},
  auditCorrelationId: "fc_test",
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  revokedByUserId: null,
  revokeReason: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-21T20:00:00.000Z"),
  updatedAt: new Date("2026-04-21T20:00:00.000Z"),
};

test("file routes register the Phase 4 session and edge contract", async () => {
  const server = createServer();

  await registerFileRoutes(server);

  assert.deepEqual(
    server.routes
      .map(({ method, path }) => `${Array.isArray(method) ? method.join("|") : method} ${path}`)
      .sort(),
    [
      "DELETE /api/file-sessions/:fileSessionId",
      "GET /api/buds/:budId/file-sessions",
      "GET /api/file-sessions/:fileSessionId",
      "GET|HEAD /api/files/:fileSessionId",
      "POST /api/buds/:budId/file-sessions",
    ].sort(),
  );
});

test("file routes reject unauthenticated create and edge requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);

  const server = createServer();
  await registerFileRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/file-sessions");
  const edgeHandler = server.handlers.get("GET|HEAD /api/files/:fileSessionId");
  assert.ok(createHandler);
  assert.ok(edgeHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
  assert.deepEqual(
    await invokeRoute(edgeHandler, {
      method: "GET",
      params: { fileSessionId: "fs_test" },
      headers: {},
    }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
});

test("file routes return 404 for signed-in non-owners before daemon work", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.budTable, "findFirst", async () => null);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  }) as never);

  const server = createServer();
  await registerFileRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/file-sessions");
  const edgeHandler = server.handlers.get("GET|HEAD /api/files/:fileSessionId");
  assert.ok(createHandler);
  assert.ok(edgeHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 404, payload: { error: "bud_not_found" } },
  );
  assert.deepEqual(
    await invokeRoute(edgeHandler, {
      method: "GET",
      params: { fileSessionId: "fs_test" },
      headers: {},
    }),
    { statusCode: 404, payload: { error: "file_session_not_found" } },
  );
});

test("file routes serialize an owned session through owner-filtered lookup", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([FILE_SESSION_ROW]);
            },
          };
        },
      };
    },
  }) as never);

  const server = createServer();
  await registerFileRoutes(server);

  const handler = server.handlers.get("GET /api/file-sessions/:fileSessionId");
  assert.ok(handler);
  const response = await invokeRoute(handler, { params: { fileSessionId: "fs_test" } });

  assert.equal(response.statusCode, 200);
  assert.equal((response.payload as { file_session_id: string }).file_session_id, "fs_test");
  assert.equal((response.payload as { bud_id: string }).bud_id, "bud-1");
});
