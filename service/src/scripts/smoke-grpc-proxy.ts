import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Viewer } from "../auth/session.js";

const PROXY_STREAM_TYPE = "localhost_http_proxy";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const budBinary = path.join(repoRoot, "bud", "target", "debug", "bud");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve TCP port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  options: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${options.label}.${suffix}`);
}

type TargetRequest = {
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
};

async function startTargetServer(marker: string): Promise<{
  port: number;
  requests: TargetRequest[];
  server: Server;
}> {
  const requests: TargetRequest[] = [];
  const server = http.createServer((request, response) => {
    requests.push({
      headers: request.headers,
      method: request.method ?? "GET",
      url: request.url ?? "/",
    });

    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "no-store");

    if (request.method === "HEAD") {
      response.statusCode = 200;
      response.end();
      return;
    }

    if (!request.url?.startsWith("/hello")) {
      response.statusCode = 404;
      response.end("not found\n");
      return;
    }

    response.statusCode = 200;
    response.write(`proxy smoke ${marker}\n`);
    setTimeout(() => {
      response.end(`target path ${request.url}\n`);
    }, 25);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert(address && typeof address !== "string", "Target server did not bind");

  return { port: address.port, requests, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function spawnBud(options: {
  controlPort: number;
  dataPort: number;
  env: Record<string, string>;
  identityFile: string;
  terminalBaseDir: string;
  token: string;
  deviceName: string;
}): ChildProcessWithoutNullStreams {
  const child = spawn(budBinary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...options.env,
      BUD_DEBUG: "true",
      BUD_DEVICE_NAME: options.deviceName,
      BUD_ENROLLMENT_TOKEN: options.token,
      BUD_GRPC_CONTROL_URL: `http://127.0.0.1:${options.controlPort}`,
      BUD_GRPC_DATA_URL: `http://127.0.0.1:${options.dataPort}`,
      BUD_IDENTITY_FILE: options.identityFile,
      BUD_RECONNECT_BASE_SEC: "60",
      BUD_SERVER_URL: "http://127.0.0.1:3000",
      BUD_TERMINAL_BASE_DIR: options.terminalBaseDir,
      BUD_TERMINAL_ENABLED: "false",
      RUST_LOG: "warn",
    },
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[bud stdout] ${chunk.toString()}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[bud stderr] ${chunk.toString()}`);
  });

  return child;
}

async function stopBud(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 3_000),
    ),
  ]);
}

const controlPort = await reservePort();
const dataPort = await reservePort();
const smokeId = ulid();
const token = `smoke-proxy-${smokeId}`;
const deviceName = `bud-grpc-proxy-smoke-${smokeId}`;

process.env.GRPC_CONTROL_ENABLED = "true";
process.env.GRPC_CONTROL_HOST = "127.0.0.1";
process.env.GRPC_CONTROL_PORT = String(controlPort);
process.env.GRPC_DATA_ENABLED = "true";
process.env.GRPC_DATA_HOST = "127.0.0.1";
process.env.GRPC_DATA_PORT = String(dataPort);
process.env.DEV_BUD_TOKEN_BYPASS = token;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const [
  { db, pool },
  { authPool },
  schema,
  { TerminalEventBus },
  { TerminalSessionManager },
  { startGrpcControlGateway },
  { startGrpcDataGateway },
  { grpcDataSessions },
] = await Promise.all([
    import("../db/client.js"),
    import("../auth/auth.js"),
    import("../db/schema.js"),
    import("../runtime/event-bus.js"),
    import("../runtime/terminal-session-manager.js"),
    import("../grpc/control-gateway.js"),
    import("../grpc/data-gateway.js"),
    import("../transport/grpc-data-router.js"),
  ]);

const {
  createProxySession,
  effectiveProxySessionState,
  getAuthorizedProxySession,
  methodAllowedForProxySession,
  resolveProxyTransportStatus,
  serializeProxyTransportStatus,
} = await import("../proxy/proxy-session.js");
const { openProxyEdgeStream } = await import("../proxy/proxy-edge.js");

const {
  auditEventTable,
  authUserTable,
  budOperationTable,
  budStreamTable,
  budTable,
  proxySessionTable,
  transportSessionTable,
} = schema;
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "bud-smoke-proxy-"));
const identityFile = path.join(tmpDir, "identity.json");
const terminalBaseDir = path.join(tmpDir, "terminal");
const targetMarker = ulid();
const target = await startTargetServer(targetMarker);
const eventBus = new TerminalEventBus();
const logger = createLogger();
const terminalManager = new TerminalSessionManager(logger as never, eventBus);
const viewer: Viewer = {
  authType: "bearer",
  email: "smoke-proxy@example.local",
  sessionId: null,
  userId: `smoke-proxy-user-${ulid()}`,
};

let bud: ChildProcessWithoutNullStreams | null = null;
let controlServer: Awaited<ReturnType<typeof startGrpcControlGateway>> | null =
  null;
let dataServer: Awaited<ReturnType<typeof startGrpcDataGateway>> | null = null;

const app = Fastify({ logger: false });
app.route({
  method: ["GET", "HEAD"],
  url: "/api/proxy/:proxySessionId/*",
  async handler(request, reply) {
    const params = request.params as { proxySessionId?: string };
    const proxySessionId = params.proxySessionId;
    if (!proxySessionId) {
      return reply.status(400).send({ error: "missing_proxy_session" });
    }

    const session = await getAuthorizedProxySession(viewer, proxySessionId);
    if (!session) {
      return reply.status(404).send({ error: "proxy_session_not_found" });
    }

    const state = effectiveProxySessionState(session);
    if (state !== "ready") {
      return reply.status(410).send({
        error: "proxy_session_not_ready",
        state,
      });
    }

    if (!methodAllowedForProxySession(session, request.method)) {
      return reply.status(405).send({ error: "method_not_allowed" });
    }

    const transportStatus = resolveProxyTransportStatus(session.budId);
    if (!transportStatus.available) {
      return reply.status(424).send({
        error: "proxy_transport_unavailable",
        transport: serializeProxyTransportStatus(transportStatus),
      });
    }

    return openProxyEdgeStream({
      reply,
      request,
      session,
      transportStatus,
      viewer,
    });
  },
});

let budId: string | null = null;

try {
  controlServer = await startGrpcControlGateway(terminalManager, logger as never);
  dataServer = await startGrpcDataGateway(terminalManager, logger as never);
  assert(controlServer, "gRPC control gateway did not start");
  assert(dataServer, "gRPC data gateway did not start");
  await app.ready();

  bud = spawnBud({
    controlPort,
    dataPort,
    deviceName,
    env: {},
    identityFile,
    terminalBaseDir,
    token,
  });

  const budRow = await waitFor(
    async () => {
      const rows = await db
        .select()
        .from(budTable)
        .where(eq(budTable.name, deviceName))
        .orderBy(desc(budTable.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    { label: "Bud enrollment" },
  );
  budId = budRow.budId;

  await db
    .update(budTable)
    .set({ createdByUserId: viewer.userId })
    .where(eq(budTable.budId, budId));

  await waitFor(
    async () => {
      const rows = await db
        .select()
        .from(transportSessionTable)
        .where(
          and(
            eq(transportSessionTable.budId, budId!),
            eq(transportSessionTable.transportKind, "h2_grpc"),
            eq(transportSessionTable.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    { label: "active gRPC control transport" },
  );

  await waitFor(
    async () => {
      const rows = await db
        .select()
        .from(transportSessionTable)
        .where(
          and(
            eq(transportSessionTable.budId, budId!),
            eq(transportSessionTable.transportKind, "h2_data"),
            eq(transportSessionTable.status, "active"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    { label: "active gRPC data transport" },
  );

  const dataTracker = await waitFor(
    () => {
      for (const tracker of grpcDataSessions.values()) {
        if (tracker.budId === budId && tracker.streams.has(PROXY_STREAM_TYPE)) {
          return tracker;
        }
      }
      return null;
    },
    { label: "proxy data stream registration" },
  );

  const framesBefore = dataTracker.framesReceived;
  const bytesBefore = dataTracker.bytesReceived;

  await db.insert(authUserTable).values({
    id: viewer.userId,
    email: viewer.email ?? "smoke-proxy@example.local",
    emailVerified: true,
    name: "Proxy Smoke",
  });

  const proxySession = await createProxySession({
    body: {
      allowed_methods: ["GET", "HEAD"],
      display_metadata: { smoke: true },
      target_host: "127.0.0.1",
      target_port: target.port,
      ttl_seconds: 900,
    },
    budId,
    viewer,
  });

  assert(
    proxySession.session.state === "ready",
    `Expected ready proxy session, got ${proxySession.session.state}`,
  );

  const response = await app.inject({
    headers: {
      accept: "text/plain",
      authorization: "Bearer should-not-forward",
      cookie: "session=should-not-forward",
    },
    method: "GET",
    url: `/api/proxy/${proxySession.session.proxySessionId}/hello?marker=${targetMarker}`,
  });

  assert(
    response.statusCode === 200,
    `Expected proxy response status 200, got ${response.statusCode}: ${response.body}`,
  );
  assert(
    response.body.includes(`proxy smoke ${targetMarker}`),
    "Proxy response body did not include target marker",
  );
  assert(
    response.body.includes(`/hello?marker=${targetMarker}`),
    "Proxy response body did not include target path",
  );

  const targetRequest = target.requests.find(
    (request) => request.method === "GET" && request.url.startsWith("/hello"),
  );
  assert(targetRequest, "Target HTTP server did not receive proxied GET");
  assert(
    targetRequest.headers.accept === "text/plain",
    "Proxy did not forward safe Accept header",
  );
  assert(
    targetRequest.headers.authorization === undefined,
    "Proxy forwarded Authorization header to target",
  );
  assert(
    targetRequest.headers.cookie === undefined,
    "Proxy forwarded Cookie header to target",
  );

  const durableResult = await waitFor(
    async () => {
      const [operation] = await db
        .select()
        .from(budOperationTable)
        .where(
          and(
            eq(budOperationTable.budId, budId!),
            eq(budOperationTable.operationType, PROXY_STREAM_TYPE),
          ),
        )
        .orderBy(desc(budOperationTable.createdAt))
        .limit(1);
      if (!operation || operation.state !== "succeeded") {
        return null;
      }

      const [stream] = await db
        .select()
        .from(budStreamTable)
        .where(eq(budStreamTable.operationId, operation.operationId))
        .limit(1);
      if (!stream || stream.state !== "closed") {
        return null;
      }

      return { operation, stream };
    },
    { label: "durable proxy operation and stream close" },
  );

  await waitFor(
    async () => {
      const [session] = await db
        .select()
        .from(proxySessionTable)
        .where(eq(proxySessionTable.proxySessionId, proxySession.session.proxySessionId))
        .limit(1);
      return session?.activeStreamId === null ? session : null;
    },
    { label: "proxy session active stream cleanup" },
  );

  await waitFor(
    async () => {
      const rows = await db
        .select()
        .from(auditEventTable)
        .where(
          and(
            eq(auditEventTable.budId, budId!),
            eq(auditEventTable.eventType, "proxy.stream_open"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    { label: "proxy audit event" },
  );

  const dataTrackerAfter = dataTracker;
  assert(
    dataTrackerAfter.framesReceived > framesBefore,
    "Proxy stream did not record inbound gRPC data frames",
  );
  assert(
    dataTrackerAfter.bytesReceived > bytesBefore,
    "Proxy stream did not record inbound gRPC data bytes",
  );

  console.log(
    JSON.stringify(
      {
        body_bytes: Buffer.byteLength(response.body),
        bud_id: budId,
        data_bytes_delta: dataTrackerAfter.bytesReceived - bytesBefore,
        data_frames_delta: dataTrackerAfter.framesReceived - framesBefore,
        operation_id: durableResult.operation.operationId,
        proxy_session_id: proxySession.session.proxySessionId,
        status_code: response.statusCode,
        stream_id: durableResult.stream.streamId,
        stream_receive_offset: durableResult.stream.receiveOffset,
        target_port: target.port,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await stopBud(bud);
  if (controlServer) {
    await controlServer.close();
  }
  if (dataServer) {
    await dataServer.close();
  }
  await closeServer(target.server);

  if (budId) {
    await db
      .delete(auditEventTable)
      .where(eq(auditEventTable.budId, budId));
    await db
      .delete(proxySessionTable)
      .where(eq(proxySessionTable.budId, budId));
    await db
      .delete(budStreamTable)
      .where(eq(budStreamTable.budId, budId));
    await db
      .delete(budOperationTable)
      .where(eq(budOperationTable.budId, budId));
    await db.delete(budTable).where(eq(budTable.budId, budId));
  }
  await db.delete(authUserTable).where(eq(authUserTable.id, viewer.userId));

  await rm(tmpDir, { force: true, recursive: true });
  await pool.end();
  await authPool.end();
}

function createLogger() {
  const log = (_meta?: unknown, _message?: string) => undefined;
  return {
    child() {
      return this;
    },
    debug: log,
    error: log,
    info: log,
    warn: log,
  };
}
