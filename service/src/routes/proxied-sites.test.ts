import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { db } from "../db/client.js";
import { registerProxiedSiteRoutes } from "./proxied-sites.js";

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

  redirect(value: string): unknown {
    this.statusCode = 302;
    this.headers.Location = value;
    this.sent = true;
    this.payload = "";
    return "";
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
    patch: addRoute("PATCH"),
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

const PROXIED_SITE_ROW = {
  proxiedSiteId: "site_test",
  budId: "bud-1",
  operationId: null,
  activeStreamId: null,
  displayName: "Vite app",
  slug: "vite-app-a8f2",
  endpointHost: "vite-app-a8f2.proxy.localhost",
  targetScheme: "http",
  targetHost: "127.0.0.1",
  targetPort: 5173,
  defaultPath: "/",
  accessPolicy: "private_owner",
  enabled: true,
  disabledAt: null,
  disabledByUserId: null,
  disableReason: null,
  displayMetadata: {},
  auditCorrelationId: "psc_test",
  expiresAt: new Date(Date.now() + 60_000),
  lastAccessedAt: null,
  lastRenewedAt: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-04-21T20:00:00.000Z"),
  updatedAt: new Date("2026-04-21T20:00:00.000Z"),
};

test("proxied site routes register product and gateway contracts", async () => {
  const server = createServer();

  await registerProxiedSiteRoutes(server);

  assert.deepEqual(
    server.routes
      .map(({ method, path }) => `${Array.isArray(method) ? method.join("|") : method} ${path}`)
      .sort(),
    [
      "DELETE /api/proxied-sites/:proxiedSiteId",
      "DELETE /api/threads/:threadId/web-view",
      "GET /api/buds/:budId/proxied-sites",
      "GET /api/proxied-sites/:proxiedSiteId",
      "GET /api/threads/:threadId/web-view",
      "GET|HEAD /*",
      "PATCH /api/proxied-sites/:proxiedSiteId",
      "POST /api/buds/:budId/proxied-sites",
      "POST /api/proxied-sites/:proxiedSiteId/viewer-grants",
      "POST /api/threads/:threadId/web-view/attach",
    ].sort(),
  );
});

test("proxied site routes reject unauthenticated product requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/proxied-sites");
  assert.ok(createHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
});

test("proxied site routes return 404 for signed-in non-owner sites", async (t) => {
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
  await registerProxiedSiteRoutes(server);

  const createHandler = server.handlers.get("POST /api/buds/:budId/proxied-sites");
  const readHandler = server.handlers.get("GET /api/proxied-sites/:proxiedSiteId");
  assert.ok(createHandler);
  assert.ok(readHandler);

  assert.deepEqual(
    await invokeRoute(createHandler, { params: { budId: "bud-1" }, body: {} }),
    { statusCode: 404, payload: { error: "bud_not_found" } },
  );
  assert.deepEqual(
    await invokeRoute(readHandler, { params: { proxiedSiteId: "site_test" } }),
    { statusCode: 404, payload: { error: "proxied_site_not_found" } },
  );
});

test("proxied site routes serialize owned sites through owner-filtered lookup", async (t) => {
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
              return Promise.resolve([PROXIED_SITE_ROW]);
            },
          };
        },
      };
    },
  }) as never);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /api/proxied-sites/:proxiedSiteId");
  assert.ok(handler);
  const response = await invokeRoute(handler, { params: { proxiedSiteId: "site_test" } });

  assert.equal(response.statusCode, 200);
  assert.equal((response.payload as { proxied_site_id: string }).proxied_site_id, "site_test");
  assert.equal((response.payload as { endpoint_host: string }).endpoint_host, "vite-app-a8f2.proxy.localhost");
});
