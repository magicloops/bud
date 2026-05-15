import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../auth/auth.js";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import {
  ProxyWebSocketRuntimeSession,
  clearProxyWebSocketRuntimeSessionsForTests,
  countActiveProxyWebSocketRuntimeSessionsForSite,
  closeProxyWebSocketRuntimeSessionsForSite,
  handleProxyWebSocketClose,
  handleProxyWebSocketMessage,
  handleProxyWebSocketOpenResult,
  registerProxyWebSocketRuntimeSession,
} from "../proxy/proxy-ws-runtime.js";
import { LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE } from "../proxy/proxy-session.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  resetRuntimeStreamsForDataPlaneTracker,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import { websocketDaemonTransportRouter } from "../transport/websocket-daemon-router.js";
import { registerProxiedSiteRoutes } from "./proxied-sites.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type WebSocketRouteHandler = (socket: TestWebSocket, request: Record<string, unknown>) => Promise<void> | void;
type RegisteredRoute = {
  method: string | string[];
  path: string;
  wsHandler?: WebSocketRouteHandler;
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
    route(options: { method: string | string[]; url: string; handler: RouteHandler; wsHandler?: unknown }) {
      routes.push({
        method: options.method,
        path: options.url,
        wsHandler: typeof options.wsHandler === "function"
          ? options.wsHandler as WebSocketRouteHandler
          : undefined,
      });
      handlers.set(
        `${Array.isArray(options.method) ? options.method.join("|") : options.method} ${options.url}`,
        options.handler,
      );
    },
  } as unknown as FastifyInstance & { routes: RegisteredRoute[]; handlers: Map<string, RouteHandler> };
}

class TestWebSocket {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = this.OPEN;
  sent: Array<{ payload: string | Buffer; options?: { binary?: boolean } }> = [];
  closed: Array<{ code: number; reason: string }> = [];
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const eventListeners = this.listeners.get(event) ?? new Set();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const onceListener = (...args: unknown[]) => {
      this.off(event, onceListener);
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(...args);
    }
  }

  send(payload: string | Buffer, options?: { binary?: boolean }) {
    this.sent.push({ payload, options });
  }

  close(code: number, reason: string) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const response = await invokeRouteWithReply(handler, request);
  return {
    statusCode: response.statusCode,
    payload: response.payload,
  };
}

async function invokeRouteWithReply(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown; headers: Record<string, string> }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
    headers: reply.headers,
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

const VIEWER_SESSION_ROW = {
  viewerSessionId: "pvs_test",
  proxiedSiteId: PROXIED_SITE_ROW.proxiedSiteId,
  budId: PROXIED_SITE_ROW.budId,
  userId: PROXIED_SITE_ROW.createdByUserId,
  authSessionId: null,
  tokenHash: "ignored-by-db-mock",
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  lastSeenAt: new Date("2026-04-21T20:00:00.000Z"),
  lastRefreshedAt: new Date(),
  tenantId: null,
  createdByUserId: PROXIED_SITE_ROW.createdByUserId,
  createdAt: new Date("2026-04-21T20:00:00.000Z"),
  updatedAt: new Date("2026-04-21T20:00:00.000Z"),
};

const VIEWER_GRANT_ROW = {
  viewerGrantId: "pvg_test",
  proxiedSiteId: PROXIED_SITE_ROW.proxiedSiteId,
  budId: PROXIED_SITE_ROW.budId,
  userId: PROXIED_SITE_ROW.createdByUserId,
  authSessionId: "session-1",
  grantHash: "ignored-by-db-mock",
  redirectPath: "/",
  expiresAt: new Date(Date.now() + 60_000),
  consumedAt: null,
  tenantId: null,
  createdByUserId: PROXIED_SITE_ROW.createdByUserId,
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
      "GET /*",
      "GET /api/buds/:budId/proxied-sites",
      "GET /api/proxied-sites/:proxiedSiteId",
      "GET /api/threads/:threadId/web-view",
      "HEAD /*",
      "PATCH /api/proxied-sites/:proxiedSiteId",
      "POST /api/buds/:budId/proxied-sites",
      "POST /api/proxied-sites/:proxiedSiteId/viewer-grants",
      "POST /api/threads/:threadId/web-view/attach",
      "POST|PUT|PATCH|DELETE|OPTIONS /*",
    ].sort(),
  );
  assert.equal(
    typeof server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler,
    "function",
  );
  assert.equal(
    server.routes.find((route) => route.method === "HEAD" && route.path === "/*")?.wsHandler,
    undefined,
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

test("proxied site viewer grant route requires an owned site before minting grants", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mockGatewayLookups([[]]);
  let insertCalled = false;
  mock.method(db, "insert", () => {
    insertCalled = true;
    throw new Error("unexpected grant insert");
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("POST /api/proxied-sites/:proxiedSiteId/viewer-grants");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, { params: { proxiedSiteId: "site_test" }, body: { path: "/" } }),
    { statusCode: 404, payload: { error: "proxied_site_not_found" } },
  );
  assert.equal(insertCalled, false);
});

test("proxied site viewer grant route mints owner-only bootstrap URLs", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mockGatewayLookups([[PROXIED_SITE_ROW]]);
  const inserted: unknown[] = [];
  mockDbInsert(inserted);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("POST /api/proxied-sites/:proxiedSiteId/viewer-grants");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    params: { proxiedSiteId: "site_test" },
    body: { path: "/dashboard?tab=logs" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(inserted.length, 1);
  assert.equal((inserted[0] as { proxiedSiteId: string }).proxiedSiteId, PROXIED_SITE_ROW.proxiedSiteId);
  assert.equal((inserted[0] as { userId: string }).userId, PROXIED_SITE_ROW.createdByUserId);
  assert.equal((inserted[0] as { authSessionId: string }).authSessionId, SESSION.session.id);
  assert.match((response.payload as { bootstrap_url: string }).bootstrap_url, /^http:\/\/vite-app-a8f2\.proxy\.localhost:3000\/__bud\/bootstrap\?grant=/);
  assert.equal(
    (response.payload as { view_url: string }).view_url,
    "http://vite-app-a8f2.proxy.localhost:3000/dashboard?tab=logs",
  );
});

test("proxied site gateway bootstrap rejects missing, consumed, or expired grants", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockGatewayLookups([[]]);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /*");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      headers: { host: PROXIED_SITE_ROW.endpointHost },
      query: { grant: "missing-or-consumed" },
      url: "/__bud/bootstrap?grant=missing-or-consumed",
    }),
    { statusCode: 401, payload: { error: "invalid_viewer_grant" } },
  );
});

test("proxied site gateway bootstrap rejects grants for a different endpoint host", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockGatewayLookups([[VIEWER_GRANT_ROW], []]);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /*");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      headers: { host: "other-site.proxy.localhost" },
      query: { grant: "grant-for-vite-app" },
      url: "/__bud/bootstrap?grant=grant-for-vite-app",
    }),
    { statusCode: 401, payload: { error: "proxied_site_not_found" } },
  );
});

test("proxied site gateway bootstrap consumes grants and sets endpoint-host viewer cookies", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockGatewayLookups([[VIEWER_GRANT_ROW], [PROXIED_SITE_ROW]]);
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  mockDbTransaction({ inserts, updates });

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /*");
  assert.ok(handler);

  const response = await invokeRouteWithReply(handler, {
    headers: { host: PROXIED_SITE_ROW.endpointHost },
    query: { grant: "grant-token" },
    url: "/__bud/bootstrap?grant=grant-token&to=%2F",
  });

  assert.equal(response.statusCode, 302);
  assert.equal(response.payload, "");
  assert.equal(response.headers.Location, "http://vite-app-a8f2.proxy.localhost:3000/");
  assert.match(response.headers["Set-Cookie"], /^bud_proxy_viewer=/);
  assert.match(response.headers["Set-Cookie"], /Path=\//);
  assert.match(response.headers["Set-Cookie"], /HttpOnly/);
  assert.match(response.headers["Set-Cookie"], /Max-Age=604800/);
  assert.match(response.headers["Set-Cookie"], /SameSite=Lax/);
  assert.doesNotMatch(response.headers["Set-Cookie"], /Secure/);
  assert.equal(updates.length, 1);
  assert.equal(inserts.length, 1);
  assert.equal((inserts[0] as { proxiedSiteId: string }).proxiedSiteId, PROXIED_SITE_ROW.proxiedSiteId);
});

test("proxied site gateway refreshes stale authenticated viewer sessions before proxy transport lookup", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const staleViewerSession = {
    ...VIEWER_SESSION_ROW,
    authSessionId: SESSION.session.id,
    lastRefreshedAt: new Date(Date.now() - (config.proxyViewerCookieRefreshSeconds + 60) * 1000),
  };
  mockGatewayLookups([[PROXIED_SITE_ROW], [staleViewerSession], [{ id: SESSION.session.id }]]);
  const updates: unknown[] = [];
  mockDbUpdate(updates);

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /*");
  assert.ok(handler);

  const response = await invokeRouteWithReply(handler, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/",
    raw: {},
  });

  assert.equal(response.statusCode, 424);
  assert.equal((response.payload as { error: string }).error, "DATA_PLANE_UNAVAILABLE");
  assert.match(response.headers["Set-Cookie"], /^bud_proxy_viewer=/);
  assert.equal(updates.length, 1);
});

test("proxied site HTTP gateway rejects invalid viewer sessions before daemon allocation", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockGatewayLookups([[PROXIED_SITE_ROW], []]);
  let operationCreated = false;
  mock.method(DaemonStateStore.prototype, "createOperation", async () => {
    operationCreated = true;
    throw new Error("unexpected daemon allocation");
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);

  const handler = server.handlers.get("GET /*");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      headers: {
        host: PROXIED_SITE_ROW.endpointHost,
        cookie: `${config.proxyViewerCookieName}=invalid`,
      },
      url: "/",
    }),
    { statusCode: 401, payload: { error: "proxy_viewer_unauthorized" } },
  );
  assert.equal(operationCreated, false);
});

test("proxied site WebSocket gateway rejects missing viewer cookie before daemon allocation", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  let selectCalls = 0;
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              selectCalls += 1;
              return Promise.resolve(selectCalls === 1 ? [PROXIED_SITE_ROW] : []);
            },
          };
        },
      };
    },
  }) as never);
  let operationCreated = false;
  mock.method(DaemonStateStore.prototype, "createOperation", async () => {
    operationCreated = true;
    throw new Error("unexpected daemon allocation");
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  await wsHandler(socket, {
    headers: { host: PROXIED_SITE_ROW.endpointHost },
    url: "/@vite/client",
  });

  assert.deepEqual(socket.closed, [{ code: 1008, reason: "proxy viewer unauthorized" }]);
  assert.equal(selectCalls, 1);
  assert.equal(operationCreated, false);
});

test("proxied site WebSocket gateway rejects invalid viewer cookie before daemon allocation", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  let selectCalls = 0;
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              selectCalls += 1;
              return Promise.resolve(selectCalls === 1 ? [PROXIED_SITE_ROW] : []);
            },
          };
        },
      };
    },
  }) as never);
  let operationCreated = false;
  mock.method(DaemonStateStore.prototype, "createOperation", async () => {
    operationCreated = true;
    throw new Error("unexpected daemon allocation");
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  await wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=invalid`,
    },
    url: "/@vite/client",
  });

  assert.deepEqual(socket.closed, [{ code: 1008, reason: "proxy viewer unauthorized" }]);
  assert.equal(selectCalls, 2);
  assert.equal(operationCreated, false);
});

test("proxied site WebSocket gateway rejects disabled and expired sites before viewer auth", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  const sites = [
    { ...PROXIED_SITE_ROW, enabled: false, disabledAt: new Date(), disableReason: "user_requested" },
    { ...PROXIED_SITE_ROW, expiresAt: new Date(Date.now() - 60_000) },
  ];
  let selectCalls = 0;
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve([sites[selectCalls++]]);
            },
          };
        },
      };
    },
  }) as never);
  let operationCreated = false;
  mock.method(DaemonStateStore.prototype, "createOperation", async () => {
    operationCreated = true;
    throw new Error("unexpected daemon allocation");
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const disabledSocket = new TestWebSocket();
  await wsHandler(disabledSocket, {
    headers: { host: PROXIED_SITE_ROW.endpointHost },
    url: "/@vite/client",
  });
  assert.deepEqual(disabledSocket.closed, [{ code: 1008, reason: "proxied site disabled" }]);

  const expiredSocket = new TestWebSocket();
  await wsHandler(expiredSocket, {
    headers: { host: PROXIED_SITE_ROW.endpointHost },
    url: "/@vite/client",
  });
  assert.deepEqual(expiredSocket.closed, [{ code: 1008, reason: "proxied site expired" }]);
  assert.equal(selectCalls, 2);
  assert.equal(operationCreated, false);
});

test("proxied site WebSocket gateway dispatches authorized endpoint-host upgrades", async (t) => {
  t.after(() => {
    closeProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId, {
      reason: "test_cleanup",
      closeCode: 1001,
      error: {
        code: "TEST_CLEANUP",
        message: "test cleanup",
        retryable: false,
      },
    });
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  mockDbUpdate();
  mockDaemonStateStore();
  registerWebSocketDataPlaneForTest();
  const sentFrames: Array<{ budId: string; payload: Record<string, unknown> }> = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (budId: string, payload: Record<string, unknown>) => {
    sentFrames.push({ budId, payload });
    return true;
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  const handlerPromise = Promise.resolve(wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
      "sec-websocket-protocol": "vite-hmr, invalid protocol, vite-hmr",
    },
    url: "/@vite/client?import",
  }));
  const openFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_open")?.payload ?? null,
  );

  assert.equal(openFrame.operation_id !== undefined, true);
  assert.equal(openFrame.ws_session_id !== undefined, true);
  assert.equal(openFrame.proxied_site_id, PROXIED_SITE_ROW.proxiedSiteId);
  assert.equal(openFrame.target_host, PROXIED_SITE_ROW.targetHost);
  assert.equal(openFrame.target_port, PROXIED_SITE_ROW.targetPort);
  assert.equal(openFrame.path, "/@vite/client?import");
  assert.deepEqual(openFrame.protocols, ["vite-hmr"]);

  handleProxyWebSocketOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_ws_open_result",
    id: "msg_open_result",
    ts: Date.now(),
    ext: {},
    operation_id: openFrame.operation_id,
    ws_session_id: openFrame.ws_session_id,
    accepted: true,
    selected_protocol: "vite-hmr",
  });
  await handlerPromise;

  assert.equal(socket.closed.length, 0);

  sentFrames.length = 0;
  socket.emit("message", Buffer.from("hello from browser"), false);
  socket.emit("message", Buffer.from([1, 2, 3]), true);
  const browserFrames = await waitFor(() => sentFrames.length >= 2 ? sentFrames.slice() : null);
  assert.equal(browserFrames[0]?.payload.type, "proxy_ws_message");
  assert.equal(browserFrames[0]?.payload.message_type, "text");
  assert.equal(browserFrames[0]?.payload.data, "hello from browser");
  assert.equal(browserFrames[1]?.payload.type, "proxy_ws_message");
  assert.equal(browserFrames[1]?.payload.message_type, "binary");
  assert.equal(browserFrames[1]?.payload.data, Buffer.from([1, 2, 3]).toString("base64"));

  handleProxyWebSocketMessage({
    proto: PROTO_VERSION,
    type: "proxy_ws_message",
    id: "msg_daemon_text",
    ts: Date.now(),
    ext: {},
    ws_session_id: openFrame.ws_session_id as string,
    message_type: "text",
    data: "hello from daemon",
  });
  handleProxyWebSocketMessage({
    proto: PROTO_VERSION,
    type: "proxy_ws_message",
    id: "msg_daemon_binary",
    ts: Date.now(),
    ext: {},
    ws_session_id: openFrame.ws_session_id as string,
    message_type: "binary",
    data: Buffer.from([4, 5, 6]).toString("base64"),
  });

  assert.equal(socket.sent[0]?.payload, "hello from daemon");
  assert.deepEqual(socket.sent[0]?.options, { binary: false });
  assert.deepEqual(socket.sent[1]?.payload, Buffer.from([4, 5, 6]));
  assert.deepEqual(socket.sent[1]?.options, { binary: true });

  handleProxyWebSocketClose({
    proto: PROTO_VERSION,
    type: "proxy_ws_close",
    id: "msg_daemon_close",
    ts: Date.now(),
    ext: {},
    ws_session_id: openFrame.ws_session_id as string,
    code: 1000,
    reason: "done",
  });

  assert.deepEqual(socket.closed, [{ code: 1000, reason: "done" }]);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 0);
});

test("proxied site WebSocket gateway closes active sessions when the data-plane carrier resets", async (t) => {
  t.after(() => {
    closeProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId, {
      reason: "test_cleanup",
      closeCode: 1001,
      error: {
        code: "TEST_CLEANUP",
        message: "test cleanup",
        retryable: false,
      },
    });
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  const updates: unknown[] = [];
  mockDbUpdate(updates);
  mockDaemonStateStore();
  const tracker = registerWebSocketDataPlaneForTest();
  const sentFrames: Array<{ budId: string; payload: Record<string, unknown> }> = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (budId: string, payload: Record<string, unknown>) => {
    sentFrames.push({ budId, payload });
    return true;
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  const handlerPromise = Promise.resolve(wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  }));
  const openFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_open")?.payload ?? null,
  );
  handleProxyWebSocketOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_ws_open_result",
    id: "msg_open_result_reset",
    ts: Date.now(),
    ext: {},
    operation_id: openFrame.operation_id,
    ws_session_id: openFrame.ws_session_id,
    accepted: true,
  });
  await handlerPromise;

  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 1);
  assert.equal(tracker.runtimeStreams.has(openFrame.ws_session_id as string), true);

  await resetRuntimeStreamsForDataPlaneTracker({
    tracker,
    reason: "test disconnect",
    logger: { warn() {} } as never,
    daemonStateStore: new DaemonStateStore(),
  });

  assert.equal(socket.closed[0]?.code, 1011);
  assert.match(socket.closed[0]?.reason, /data-plane carrier closed/);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 0);
  assert.equal(tracker.runtimeStreams.size, 0);
  await waitFor(() =>
    updates.some((value) => (value as { activeStreamId?: string | null }).activeStreamId === null) ? true : null,
  );
});

test("proxied site WebSocket gateway forwards browser close to the daemon", async (t) => {
  t.after(() => {
    closeProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId, {
      reason: "test_cleanup",
      closeCode: 1001,
      error: {
        code: "TEST_CLEANUP",
        message: "test cleanup",
        retryable: false,
      },
    });
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  mockDbUpdate();
  mockDaemonStateStore();
  registerWebSocketDataPlaneForTest();
  const sentFrames: Array<{ budId: string; payload: Record<string, unknown> }> = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (budId: string, payload: Record<string, unknown>) => {
    sentFrames.push({ budId, payload });
    return true;
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  const handlerPromise = Promise.resolve(wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  }));
  const openFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_open")?.payload ?? null,
  );
  handleProxyWebSocketOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_ws_open_result",
    id: "msg_open_result_browser_close",
    ts: Date.now(),
    ext: {},
    operation_id: openFrame.operation_id,
    ws_session_id: openFrame.ws_session_id,
    accepted: true,
  });
  await handlerPromise;

  sentFrames.length = 0;
  socket.emit("close", 1000, Buffer.from("client done"));
  const closeFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_close")?.payload ?? null,
  );
  assert.equal(closeFrame.ws_session_id, openFrame.ws_session_id);
  assert.equal(closeFrame.code, 1000);
  assert.equal(closeFrame.reason, "client done");
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 0);
});

test("proxied site WebSocket gateway rejects oversized browser messages with typed service close", async (t) => {
  const originalMaxMessageBytes = config.proxyWebSocketMaxMessageBytes;
  t.after(() => {
    config.proxyWebSocketMaxMessageBytes = originalMaxMessageBytes;
    closeProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId, {
      reason: "test_cleanup",
      closeCode: 1001,
      error: {
        code: "TEST_CLEANUP",
        message: "test cleanup",
        retryable: false,
      },
    });
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  config.proxyWebSocketMaxMessageBytes = 4;
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  mockDbUpdate();
  mockDaemonStateStore();
  registerWebSocketDataPlaneForTest();
  const sentFrames: Array<{ budId: string; payload: Record<string, unknown> }> = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (budId: string, payload: Record<string, unknown>) => {
    sentFrames.push({ budId, payload });
    return true;
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  const handlerPromise = Promise.resolve(wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  }));
  const openFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_open")?.payload ?? null,
  );
  handleProxyWebSocketOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_ws_open_result",
    id: "msg_open_result_oversized",
    ts: Date.now(),
    ext: {},
    operation_id: openFrame.operation_id,
    ws_session_id: openFrame.ws_session_id,
    accepted: true,
  });
  await handlerPromise;

  sentFrames.length = 0;
  socket.emit("message", Buffer.from("too large"), false);
  const errorFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_error")?.payload ?? null,
  );
  const closeFrame = await waitFor(() =>
    sentFrames.find((entry) => entry.payload.type === "proxy_ws_close")?.payload ?? null,
  );
  assert.equal((errorFrame.error as { code?: string }).code, "PROXY_WS_MESSAGE_TOO_LARGE");
  assert.equal(closeFrame.ws_session_id, openFrame.ws_session_id);
  assert.equal(closeFrame.code, 1011);
  assert.equal(closeFrame.reason, "message_too_large");
  assert.equal(socket.closed[0]?.code, 1011);
  assert.match(socket.closed[0]?.reason, /message exceeded/);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 0);
});

test("proxied site WebSocket gateway times out local opens with typed service close", async (t) => {
  const originalOpenTimeoutMs = config.proxyWebSocketOpenTimeoutMs;
  t.after(() => {
    config.proxyWebSocketOpenTimeoutMs = originalOpenTimeoutMs;
    closeProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId, {
      reason: "test_cleanup",
      closeCode: 1001,
      error: {
        code: "TEST_CLEANUP",
        message: "test cleanup",
        retryable: false,
      },
    });
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  config.proxyWebSocketOpenTimeoutMs = 10;
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  const updates: unknown[] = [];
  mockDbUpdate(updates);
  mockDaemonStateStore();
  registerWebSocketDataPlaneForTest();
  const sentFrames: Array<{ budId: string; payload: Record<string, unknown> }> = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (budId: string, payload: Record<string, unknown>) => {
    sentFrames.push({ budId, payload });
    return true;
  });

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  await wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  });

  const errorFrame = sentFrames.find((entry) => entry.payload.type === "proxy_ws_error")?.payload;
  const closeFrame = sentFrames.find((entry) => entry.payload.type === "proxy_ws_close")?.payload;
  assert.ok(errorFrame);
  assert.ok(closeFrame);
  assert.equal((errorFrame.error as { code?: string }).code, "PROXY_WS_OPEN_TIMEOUT");
  assert.equal(closeFrame.code, 1013);
  assert.equal(closeFrame.reason, "timeout");
  assert.equal(socket.closed[0]?.code, 1013);
  assert.match(socket.closed[0]?.reason, /open timed out/);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite(PROXIED_SITE_ROW.proxiedSiteId), 0);
  await waitFor(() =>
    updates.some((value) => (value as { activeStreamId?: string | null }).activeStreamId === null) ? true : null,
  );
});

test("proxied site WebSocket gateway enforces per-site connection limits before daemon allocation", async (t) => {
  t.after(() => {
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  seedActiveProxyWebSocketSessions({
    count: config.proxyWebSocketMaxConnectionsPerSite,
    budId: PROXIED_SITE_ROW.budId,
    proxiedSiteId: PROXIED_SITE_ROW.proxiedSiteId,
  });
  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  mockDbUpdate();
  mockDaemonStateStore({
    createOperation: async () => {
      throw new Error("unexpected daemon allocation");
    },
  });
  registerWebSocketDataPlaneForTest();

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  await wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  });

  assert.deepEqual(socket.closed, [{ code: 1013, reason: "proxied site WebSocket limit exceeded" }]);
});

test("proxied site WebSocket gateway enforces per-Bud connection limits before daemon allocation", async (t) => {
  t.after(() => {
    clearProxyWebSocketRuntimeSessionsForTests();
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  clearProxyWebSocketRuntimeSessionsForTests();
  dataPlaneSessions.clear();

  seedActiveProxyWebSocketSessions({
    count: config.proxyWebSocketMaxConnectionsPerBud,
    budId: PROXIED_SITE_ROW.budId,
    proxiedSiteIdPrefix: "site_existing_",
  });
  mockGatewayLookups([[PROXIED_SITE_ROW], [VIEWER_SESSION_ROW]]);
  mockDbUpdate();
  mockDaemonStateStore({
    createOperation: async () => {
      throw new Error("unexpected daemon allocation");
    },
  });
  registerWebSocketDataPlaneForTest();

  const server = createServer();
  await registerProxiedSiteRoutes(server);
  const wsHandler = server.routes.find((route) => route.method === "GET" && route.path === "/*")?.wsHandler;
  assert.ok(wsHandler);

  const socket = new TestWebSocket();
  await wsHandler(socket, {
    headers: {
      host: PROXIED_SITE_ROW.endpointHost,
      cookie: `${config.proxyViewerCookieName}=viewer-token`,
    },
    url: "/@vite/client",
  });

  assert.deepEqual(socket.closed, [{ code: 1013, reason: "Bud WebSocket proxy limit exceeded" }]);
});

function mockGatewayLookups(rows: unknown[][]): void {
  let selectCalls = 0;
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            limit() {
              return Promise.resolve(rows[selectCalls++] ?? []);
            },
          };
        },
      };
    },
  }) as never);
}

function mockDbInsert(inserts: unknown[] = []): void {
  mock.method(db, "insert", () => ({
    values(value: unknown) {
      inserts.push(value);
      return Promise.resolve([]);
    },
  }) as never);
}

function mockDbTransaction(args: { inserts?: unknown[]; updates?: unknown[] } = {}): void {
  mock.method(db, "transaction", async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      update() {
        return {
          set(value: unknown) {
            args.updates?.push(value);
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          },
        };
      },
      insert() {
        return {
          values(value: unknown) {
            args.inserts?.push(value);
            return Promise.resolve([]);
          },
        };
      },
    }),
  );
}

function mockDbUpdate(updates?: unknown[]): void {
  mock.method(db, "update", () => ({
    set(value: unknown) {
      updates?.push(value);
      return {
        where() {
          return Promise.resolve([]);
        },
      };
    },
  }) as never);
}

function mockDaemonStateStore(args: {
  createOperation?: (...args: unknown[]) => Promise<unknown>;
} = {}): void {
  const createOperation = args.createOperation ?? (async () => ({}));
  mock.method(DaemonStateStore.prototype, "createOperation", createOperation);
  mock.method(DaemonStateStore.prototype, "createStream", async () => ({}));
  mock.method(DaemonStateStore.prototype, "transitionOperation", async () => undefined);
  mock.method(DaemonStateStore.prototype, "transitionStream", async () => undefined);
  mock.method(DaemonStateStore.prototype, "appendAuditEvent", async () => undefined);
}

function registerWebSocketDataPlaneForTest(): DataPlaneSessionTracker {
  const tracker: DataPlaneSessionTracker = {
    budId: PROXIED_SITE_ROW.budId,
    deviceSessionId: "ds_test",
    controlTransportSessionId: "ts_control_data",
    transportSessionId: "ts_control_data",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set([LOCALHOST_WEBSOCKET_PROXY_STREAM_TYPE]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame: async () => undefined,
    isActive: () => true,
  };
  registerActiveDataPlaneSessionTracker(tracker);
  return tracker;
}

function seedActiveProxyWebSocketSessions(args: {
  count: number;
  budId: string;
  proxiedSiteId?: string;
  proxiedSiteIdPrefix?: string;
}): void {
  for (let index = 0; index < args.count; index += 1) {
    const wsSessionId = `st_limit_${index}`;
    const proxiedSiteId = args.proxiedSiteId ?? `${args.proxiedSiteIdPrefix ?? "site_limit_"}${index}`;
    registerProxyWebSocketRuntimeSession(new ProxyWebSocketRuntimeSession(
      wsSessionId,
      `op_${wsSessionId}`,
      args.budId,
      proxiedSiteId,
      new TestWebSocket() as never,
      () => true,
      () => undefined,
    ));
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}
