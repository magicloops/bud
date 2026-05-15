import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import { config, PROTO_VERSION } from "../config.js";
import { db } from "../db/client.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  resetRuntimeStreamsForDataPlaneTracker,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import { websocketDaemonTransportRouter } from "../transport/websocket-daemon-router.js";
import {
  buildProxyRequestBody,
  buildProxyRequestHeaders,
  filterProxyResponseSetCookies,
  openProxiedSiteEdgeStream,
} from "./proxy-edge.js";
import { LOCALHOST_PROXY_STREAM_TYPE } from "./proxy-session.js";
import { getProxyRuntimeStream, handleProxyOpenResult } from "./proxy-runtime.js";

test("proxy request body builder preserves buffered bodies for mutation methods", () => {
  const json = buildProxyRequestBody(
    {
      headers: { "content-type": "application/json" },
      body: { name: "Bud" },
    } as never,
    "POST",
  );

  assert.equal(json.ok, true);
  assert.equal(json.ok ? json.body.toString("utf-8") : "", "{\"name\":\"Bud\"}");

  const binary = buildProxyRequestBody(
    {
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([1, 2, 3]),
    } as never,
    "PATCH",
  );

  assert.equal(binary.ok, true);
  assert.deepEqual(json.ok && binary.ok ? [...binary.body] : [], [1, 2, 3]);
});

test("proxy request body builder ignores GET and rejects unavailable declared bodies", () => {
  const get = buildProxyRequestBody(
    {
      headers: { "content-length": "100" },
      body: Buffer.from("ignored"),
    } as never,
    "GET",
  );
  assert.equal(get.ok, true);
  assert.equal(get.ok ? get.body.byteLength : -1, 0);

  const missing = buildProxyRequestBody(
    {
      headers: { "content-length": "5" },
      body: undefined,
    } as never,
    "POST",
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? 0 : missing.statusCode, 400);
});

test("proxy request headers forward only endpoint-host local app cookies", () => {
  const endpointHost = buildProxyRequestHeaders(
    {
      accept: "text/html",
      authorization: "Bearer secret",
      cookie: [
        `${config.proxyViewerCookieName}=viewer-token`,
        "app_session=abc",
        "bud_proxy_other=reserved",
        "__Host-bud_proxy_viewer=reserved",
        "theme=dark",
      ].join("; "),
    },
    { allowLocalAppCookies: true },
  );

  assert.equal(endpointHost.ok, true);
  assert.deepEqual(endpointHost.ok ? endpointHost.headers : {}, {
    accept: "text/html",
    cookie: "app_session=abc; theme=dark",
  });

  const rawProxy = buildProxyRequestHeaders(
    {
      cookie: "app_session=abc",
    },
    { allowLocalAppCookies: false },
  );
  assert.equal(rawProxy.ok, true);
  assert.equal(rawProxy.ok ? rawProxy.headers.cookie : "unexpected", undefined);
});

test("proxy request headers reject oversized forwarded cookie sets", () => {
  const tooManyCookies = Array.from(
    { length: config.proxyLocalAppCookieMaxCount + 1 },
    (_, index) => `c${index}=v`,
  ).join("; ");
  const result = buildProxyRequestHeaders(
    { cookie: tooManyCookies },
    { allowLocalAppCookies: true },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok ? 200 : result.statusCode, 431);
  assert.equal(result.ok ? "" : result.payload.error, "proxy_cookie_count_exceeded");
});

test("proxy response set-cookie filtering keeps app cookies endpoint-host scoped", () => {
  const filtered = filterProxyResponseSetCookies(
    [
      "app_session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax",
      `${config.proxyViewerCookieName}=evil; Path=/`,
      "bad=line\r\nSet-Cookie: injected=true; Path=/",
      "theme=dark; Max-Age=3600; Secure",
    ],
    { allowLocalAppCookies: true },
  );

  assert.deepEqual(filtered, [
    "app_session=abc; Path=/; HttpOnly; SameSite=Lax",
    "theme=dark; Max-Age=3600; Secure",
  ]);
  assert.deepEqual(
    filterProxyResponseSetCookies(["app_session=abc; Path=/"], {
      allowLocalAppCookies: false,
    }),
    [],
  );
});

test("proxy response set-cookie filtering caps forwarded app cookies", () => {
  const filtered = filterProxyResponseSetCookies(
    Array.from(
      { length: config.proxyLocalAppCookieMaxCount + 1 },
      (_, index) => `c${index}=v; Path=/`,
    ),
    { allowLocalAppCookies: true },
  );

  assert.equal(filtered.length, config.proxyLocalAppCookieMaxCount);
});

test("proxied HTTP edge stream cleans up when data-plane carrier resets after open", async (t) => {
  t.after(() => {
    dataPlaneSessions.clear();
    mock.restoreAll();
  });
  dataPlaneSessions.clear();

  const updates: unknown[] = [];
  mockDbUpdate(updates);
  mockDaemonStateStore();
  const controlFrames: Record<string, unknown>[] = [];
  const dataFrames: Record<string, unknown>[] = [];
  mock.method(websocketDaemonTransportRouter, "sendFrameToBud", (_budId: string, payload: Record<string, unknown>) => {
    controlFrames.push(payload);
    return true;
  });
  const tracker = registerHttpDataPlaneForTest(dataFrames);
  const request = {
    method: "GET",
    url: "/",
    headers: {},
    body: undefined,
    raw: new EventEmitter(),
  };
  const reply = new TestReply();

  const responsePromise = openProxiedSiteEdgeStream({
    viewer: {
      userId: "user-1",
      sessionId: "session-1",
      email: "test@example.com",
      authType: "cookie",
    },
    site: PROXIED_SITE_ROW as never,
    transportStatus: {
      available: true,
      code: null,
      message: null,
      deviceSessionId: "ds_test",
      controlTransportSessionId: "ts_control_data",
      dataTransportSessionId: "ts_control_data",
      transportKind: "websocket",
      role: "control_data",
      health: { status: "healthy", score: 100, reason: null, checkedAt: null },
      selectionReason: "test",
      candidateTransports: [],
    } as never,
    request: request as never,
    reply: reply as never,
  });

  const openFrame = await waitFor(() =>
    controlFrames.find((frame) => frame.type === "proxy_open") ?? null,
  );
  assert.equal(tracker.runtimeStreams.has(openFrame.stream_id as string), true);
  assert.ok(getProxyRuntimeStream(openFrame.stream_id as string));

  handleProxyOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_open_result",
    id: "msg_proxy_open_result",
    ts: Date.now(),
    ext: {},
    operation_id: openFrame.operation_id,
    stream_id: openFrame.stream_id,
    accepted: true,
    status_code: 200,
    headers: { "content-type": "text/plain" },
    set_cookies: [],
  });
  await responsePromise;
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["content-type"], "text/plain");
  assert.ok(reply.payload instanceof PassThrough);

  (reply.payload as PassThrough).on("error", () => undefined);
  await resetRuntimeStreamsForDataPlaneTracker({
    tracker,
    reason: "test disconnect",
    logger: { warn() {} } as never,
    daemonStateStore: new DaemonStateStore(),
  });

  assert.equal(getProxyRuntimeStream(openFrame.stream_id as string), null);
  assert.equal(tracker.runtimeStreams.size, 0);
  assert.equal((reply.payload as PassThrough).destroyed, true);
  assert.equal(dataFrames.length, 0);
  await waitFor(() =>
    updates.some((value) => (value as { activeStreamId?: string | null }).activeStreamId === null) ? true : null,
  );
});

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;
  headers: Record<string, unknown> = {};
  raw = new EventEmitter();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: unknown): this {
    this.headers[name] = value;
    return this;
  }

  getHeader(name: string): number | string | string[] | undefined {
    const value = this.headers[name];
    if (typeof value === "number" || typeof value === "string" || Array.isArray(value)) {
      return value as number | string | string[];
    }
    return undefined;
  }

  send(payload?: unknown): this {
    this.payload = payload;
    this.sent = true;
    return this;
  }
}

const PROXIED_SITE_ROW = {
  proxiedSiteId: "site_http_test",
  budId: "bud-1",
  operationId: null,
  activeStreamId: null,
  displayName: "HTTP app",
  slug: "http-app",
  endpointHost: "http-app.proxy.localhost",
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
  auditCorrelationId: "psc_http_test",
  expiresAt: new Date(Date.now() + 60_000),
  lastAccessedAt: null,
  lastRenewedAt: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  updatedAt: new Date("2026-05-01T00:00:00Z"),
};

function registerHttpDataPlaneForTest(sentFrames: Record<string, unknown>[]): DataPlaneSessionTracker {
  const tracker: DataPlaneSessionTracker = {
    budId: PROXIED_SITE_ROW.budId,
    deviceSessionId: "ds_test",
    controlTransportSessionId: "ts_control_data",
    transportSessionId: "ts_control_data",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set([LOCALHOST_PROXY_STREAM_TYPE]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame: async (frame) => {
      sentFrames.push(frame);
    },
    isActive: () => true,
  };
  registerActiveDataPlaneSessionTracker(tracker);
  return tracker;
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

function mockDaemonStateStore(): void {
  mock.method(DaemonStateStore.prototype, "createOperation", async () => ({}));
  mock.method(DaemonStateStore.prototype, "createStream", async () => ({}));
  mock.method(DaemonStateStore.prototype, "transitionOperation", async () => undefined);
  mock.method(DaemonStateStore.prototype, "transitionStream", async () => undefined);
  mock.method(DaemonStateStore.prototype, "appendAuditEvent", async () => undefined);
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
