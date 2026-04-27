import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";

import type { Viewer } from "../auth/session.js";
import type { FileSessionPermission } from "../files/file-session.js";

const FILE_STREAM_TYPE = "file_read";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const budBinary = path.join(repoRoot, "bud", "target", "debug", "bud");

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

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${options.label}.${suffix}`);
}

function spawnBud(options: {
  controlPort: number;
  dataPort: number;
  deviceName: string;
  identityFile: string;
  terminalBaseDir: string;
  token: string;
  workspaceDir: string;
}): ChildProcessWithoutNullStreams {
  const child = spawn(budBinary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BUD_DEBUG: "true",
      BUD_DEFAULT_CWD: options.workspaceDir,
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

async function stopBud(child: ChildProcessWithoutNullStreams | null): Promise<void> {
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
const token = `smoke-file-${smokeId}`;
const deviceName = `bud-grpc-file-smoke-${smokeId}`;

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
  createFileSession,
  effectiveFileSessionState,
  filePermissionAllowedForSession,
  getAuthorizedFileSession,
  resolveFileTransportStatus,
  serializeFileTransportStatus,
} = await import("../files/file-session.js");
const { openFileEdgeStream } = await import("../files/file-edge.js");

const {
  auditEventTable,
  authUserTable,
  budOperationTable,
  budStreamTable,
  budTable,
  fileSessionTable,
  transportSessionTable,
} = schema;

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "bud-smoke-file-"));
const identityFile = path.join(tmpDir, "identity.json");
const terminalBaseDir = path.join(tmpDir, "terminal");
const workspaceDir = path.join(tmpDir, "workspace");
const relativePath = "fixtures/file-smoke.txt";
const filePath = path.join(workspaceDir, relativePath);
const fileBody = [
  `file smoke ${smokeId}`,
  "line 1: daemon file adapter",
  "line 2: range response",
  "line 3: content identity",
  "",
].join("\n");
const rangeStart = fileBody.indexOf("daemon");
const rangeEnd = rangeStart + "daemon file".length - 1;
const expectedRangeBody = fileBody.slice(rangeStart, rangeEnd + 1);
await mkdir(path.dirname(filePath), { recursive: true });
await writeFile(filePath, fileBody, "utf-8");

const eventBus = new TerminalEventBus();
const logger = createLogger();
const terminalManager = new TerminalSessionManager(logger as never, eventBus);
const viewer: Viewer = {
  authType: "bearer",
  email: "smoke-file@example.local",
  sessionId: null,
  userId: `smoke-file-user-${ulid()}`,
};

let bud: ChildProcessWithoutNullStreams | null = null;
let controlServer: Awaited<ReturnType<typeof startGrpcControlGateway>> | null = null;
let dataServer: Awaited<ReturnType<typeof startGrpcDataGateway>> | null = null;
let budId: string | null = null;
let fileSessionId: string | null = null;

const app = Fastify({ logger: false });
app.route({
  method: ["GET", "HEAD"],
  url: "/api/files/:fileSessionId",
  async handler(request, reply) {
    const params = request.params as { fileSessionId?: string };
    const requestedFileSessionId = params.fileSessionId;
    if (!requestedFileSessionId) {
      return reply.status(400).send({ error: "missing_file_session" });
    }

    const session = await getAuthorizedFileSession(viewer, requestedFileSessionId);
    if (!session) {
      return reply.status(404).send({ error: "file_session_not_found" });
    }

    const requiredPermission: FileSessionPermission =
      request.method === "HEAD" ? "stat" : request.headers.range ? "range" : "read";
    if (!filePermissionAllowedForSession(session, requiredPermission)) {
      return reply.status(403).send({ error: "file_permission_denied" });
    }

    const state = effectiveFileSessionState(session);
    if (state !== "ready") {
      return reply.status(410).send({
        error: "file_session_not_ready",
        state,
      });
    }

    const transportStatus = resolveFileTransportStatus(session.budId);
    if (!transportStatus.available) {
      return reply.status(424).send({
        error: "file_transport_unavailable",
        transport: serializeFileTransportStatus(transportStatus),
      });
    }

    return openFileEdgeStream({
      reply,
      request,
      session,
      transportStatus,
      viewer,
      requiredPermission,
    });
  },
});

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
    identityFile,
    terminalBaseDir,
    token,
    workspaceDir,
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
        if (tracker.budId === budId && tracker.streams.has(FILE_STREAM_TYPE)) {
          return tracker;
        }
      }
      return null;
    },
    { label: "file data stream registration" },
  );

  await db.insert(authUserTable).values({
    id: viewer.userId,
    email: viewer.email ?? "smoke-file@example.local",
    emailVerified: true,
    name: "File Smoke",
  });

  const fileSession = await createFileSession({
    body: {
      display_metadata: { smoke: true },
      max_bytes: 1024 * 1024,
      permissions: ["stat", "read", "range"],
      relative_path: relativePath,
      root_key: "workspace",
      ttl_seconds: 900,
    },
    budId,
    viewer,
  });
  fileSessionId = fileSession.session.fileSessionId;
  assert(
    fileSession.session.state === "ready",
    `Expected ready file session, got ${fileSession.session.state}`,
  );

  const framesBefore = dataTracker.framesReceived;
  const bytesBefore = dataTracker.bytesReceived;

  const headResponse = await app.inject({
    method: "HEAD",
    url: `/api/files/${fileSessionId}`,
  });
  assert(
    headResponse.statusCode === 200,
    `Expected file HEAD status 200, got ${headResponse.statusCode}: ${headResponse.body}`,
  );
  assert.equal(
    Number(headResponse.headers["content-length"]),
    Buffer.byteLength(fileBody),
    "HEAD content-length did not match file size",
  );

  const readResponse = await app.inject({
    method: "GET",
    url: `/api/files/${fileSessionId}`,
  });
  assert(
    readResponse.statusCode === 200,
    `Expected file read status 200, got ${readResponse.statusCode}: ${readResponse.body}`,
  );
  assert.equal(readResponse.body, fileBody, "Full file response body did not match");

  const rangeResponse = await app.inject({
    headers: {
      range: `bytes=${rangeStart}-${rangeEnd}`,
    },
    method: "GET",
    url: `/api/files/${fileSessionId}`,
  });
  assert(
    rangeResponse.statusCode === 206,
    `Expected file range status 206, got ${rangeResponse.statusCode}: ${rangeResponse.body}`,
  );
  assert.equal(rangeResponse.body, expectedRangeBody, "Range response body did not match");
  assert.equal(
    rangeResponse.headers["content-range"],
    `bytes ${rangeStart}-${rangeEnd}/${Buffer.byteLength(fileBody)}`,
    "Range response content-range did not match",
  );

  const sessionWithIdentity = await waitFor(
    async () => {
      const [session] = await db
        .select()
        .from(fileSessionTable)
        .where(eq(fileSessionTable.fileSessionId, fileSessionId!))
        .limit(1);
      return session?.contentIdentity ? session : null;
    },
    { label: "file session content identity" },
  );

  await writeFile(filePath, `${fileBody}mutated-${ulid()}\n`, "utf-8");
  const staleRangeResponse = await app.inject({
    headers: {
      range: `bytes=${rangeStart}-${rangeEnd}`,
    },
    method: "GET",
    url: `/api/files/${fileSessionId}`,
  });
  assert(
    staleRangeResponse.statusCode === 409,
    `Expected stale file range status 409, got ${staleRangeResponse.statusCode}: ${staleRangeResponse.body}`,
  );
  const stalePayload = JSON.parse(staleRangeResponse.body) as { error?: string };
  assert.equal(stalePayload.error, "content_changed", "Stale range did not return content_changed");

  const durableResult = await waitFor(
    async () => {
      const operations = await db
        .select()
        .from(budOperationTable)
        .where(
          and(
            eq(budOperationTable.budId, budId!),
            eq(budOperationTable.operationType, FILE_STREAM_TYPE),
          ),
        )
        .orderBy(desc(budOperationTable.createdAt))
        .limit(10);
      const succeeded = operations.filter((operation) => operation.state === "succeeded");
      const rejected = operations.find((operation) => operation.state === "rejected");
      if (succeeded.length < 3 || !rejected) {
        return null;
      }

      const streams = await db
        .select()
        .from(budStreamTable)
        .where(eq(budStreamTable.budId, budId!));
      const closed = streams.filter((stream) => stream.streamType === FILE_STREAM_TYPE && stream.state === "closed");
      if (closed.length < 3) {
        return null;
      }
      return { closed, rejected, succeeded };
    },
    { label: "durable file operation and stream outcomes" },
  );

  await waitFor(
    async () => {
      const [session] = await db
        .select()
        .from(fileSessionTable)
        .where(eq(fileSessionTable.fileSessionId, fileSessionId!))
        .limit(1);
      return session?.activeStreamId === null ? session : null;
    },
    { label: "file session active stream cleanup" },
  );

  await waitFor(
    async () => {
      const rows = await db
        .select()
        .from(auditEventTable)
        .where(
          and(
            eq(auditEventTable.budId, budId!),
            eq(auditEventTable.eventType, "file.stream_open"),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    { label: "file audit event" },
  );

  assert(
    dataTracker.framesReceived > framesBefore,
    "File stream did not record inbound gRPC data frames",
  );
  assert(
    dataTracker.bytesReceived > bytesBefore,
    "File stream did not record inbound gRPC data bytes",
  );

  console.log(
    JSON.stringify(
      {
        body_bytes: Buffer.byteLength(readResponse.body),
        bud_id: budId,
        content_identity: sessionWithIdentity.contentIdentity,
        data_bytes_delta: dataTracker.bytesReceived - bytesBefore,
        data_frames_delta: dataTracker.framesReceived - framesBefore,
        file_session_id: fileSessionId,
        range_body: rangeResponse.body,
        rejected_operation_id: durableResult.rejected.operationId,
        status_codes: {
          head: headResponse.statusCode,
          read: readResponse.statusCode,
          range: rangeResponse.statusCode,
          stale_range: staleRangeResponse.statusCode,
        },
        stream_receive_offsets: durableResult.closed.map((stream) => stream.receiveOffset).sort((a, b) => a - b),
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

  if (budId) {
    await db.delete(auditEventTable).where(eq(auditEventTable.budId, budId));
    await db.delete(fileSessionTable).where(eq(fileSessionTable.budId, budId));
    await db.delete(budStreamTable).where(eq(budStreamTable.budId, budId));
    await db.delete(budOperationTable).where(eq(budOperationTable.budId, budId));
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
