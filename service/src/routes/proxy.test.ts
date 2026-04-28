import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { db } from "../db/client.js";
import { registerProxyRoutes } from "./proxy.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type RegisteredRoute = {
  method: string | string[];
  path: string;
};

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;
  headers: Record<string, string> = {};

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: string): this {
    this.headers[name] = value;
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

const PROXY_SESSION_ROW = {
  proxySessionId: "ps_test",
  budId: "bud-1",
  threadId: null,
  operationId: null,
  activeStreamId: null,
  targetHost: "127.0.0.1",
  targetPort: 3000,
  allowedMethods: ["GET", "HEAD"],
  state: "ready",
  displayMetadata: {},
  auditCorrelationId: "pc_test",
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  revokedByUserId: null,
  revokeReason: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-21T20:00:00.000Z"),
  updatedAt: new Date("2026-04-21T20:00:00.000Z"),
};

test("proxy routes register the Phase 4.2 session and edge contract", async () => {
  const server = createServer();

  await registerProxyRoutes(server);

  assert.deepEqual(
    server.routes
      .map(({ method, path }) => `${Array.isArray(method) ? method.join("|") : method} ${path}`)
      .sort(),
    [
      "DELETE /api/proxy-sessions/:proxySessionId",
      "GET /api/buds/:budId/proxy-sessions",
      "GET /api/proxy-sessions/:proxySessionId",
      "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /api/proxy/:proxySessionId/*",
      "POST /api/buds/:budId/proxy-sessions",
    ].sort(),
  );
});

test("proxy routes reject unauthenticated create and edge requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);

  const server = createServer();
  await registerProxyRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/proxy-sessions");
  const edgeHandler = server.handlers.get("GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /api/proxy/:proxySessionId/*");
  assert.ok(createHandler);
  assert.ok(edgeHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
  assert.deepEqual(
    await invokeRoute(edgeHandler, {
      method: "GET",
      params: { proxySessionId: "ps_test" },
      url: "/api/proxy/ps_test/",
      headers: {},
    }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
});

test("proxy routes return 404 for signed-in non-owners before daemon work", async (t) => {
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
  await registerProxyRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/proxy-sessions");
  const edgeHandler = server.handlers.get("GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS /api/proxy/:proxySessionId/*");
  assert.ok(createHandler);
  assert.ok(edgeHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 404, payload: { error: "bud_not_found" } },
  );
  assert.deepEqual(
    await invokeRoute(edgeHandler, {
      method: "GET",
      params: { proxySessionId: "ps_test" },
      url: "/api/proxy/ps_test/",
      headers: {},
    }),
    { statusCode: 404, payload: { error: "proxy_session_not_found" } },
  );
});

test("proxy routes serialize an owned session through owner-filtered lookup", async (t) => {
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
              return Promise.resolve([PROXY_SESSION_ROW]);
            },
          };
        },
      };
    },
  }) as never);

  const server = createServer();
  await registerProxyRoutes(server);

  const handler = server.handlers.get("GET /api/proxy-sessions/:proxySessionId");
  assert.ok(handler);
  const response = await invokeRoute(handler, { params: { proxySessionId: "ps_test" } });

  assert.equal(response.statusCode, 200);
  assert.equal((response.payload as { proxy_session_id: string }).proxy_session_id, "ps_test");
  assert.deepEqual((response.payload as { allowed_methods: string[] }).allowed_methods, ["GET", "HEAD"]);
});
