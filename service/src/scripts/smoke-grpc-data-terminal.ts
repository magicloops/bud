import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";

type SmokeMode = "data" | "control-fallback" | "large-output";

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(serviceDir, "..");
const budBinary = path.join(repoRoot, "bud/target/debug/bud");

const smokeMode = parseSmokeMode(process.env.SMOKE_GRPC_DATA_MODE);
const dataEnabled = smokeMode !== "control-fallback";
const largeOutput = smokeMode === "large-output";
const controlPort = await reservePort();
const dataPort = await reservePort();
const smokeId = ulid();
const token = `smoke-token-${smokeId}`;
const deviceName = `bud-grpc-data-smoke-${smokeId}`;
const marker = `bud-data-smoke-${smokeId}`;
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "bud-grpc-data-smoke-"));
const identityFile = path.join(tmpDir, "identity.json");
const terminalBaseDir = path.join(tmpDir, "terminal");

process.env.GRPC_CONTROL_ENABLED = "true";
process.env.GRPC_CONTROL_HOST = "127.0.0.1";
process.env.GRPC_CONTROL_PORT = String(controlPort);
process.env.GRPC_DATA_ENABLED = dataEnabled ? "true" : "false";
process.env.GRPC_DATA_HOST = "127.0.0.1";
process.env.GRPC_DATA_PORT = String(dataPort);
process.env.DEV_BUD_TOKEN_BYPASS = token;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const { db, pool } = await import("../db/client.js");
const { budTable, terminalSessionOutputTable, threadTable, transportSessionTable } = await import("../db/schema.js");
const { TerminalEventBus } = await import("../runtime/event-bus.js");
const { TerminalSessionManager } = await import("../runtime/terminal-session-manager.js");
const { startGrpcControlGateway } = await import("../grpc/control-gateway.js");
const { startGrpcDataGateway } = await import("../grpc/data-gateway.js");
const { grpcDataSessions } = await import("../transport/grpc-data-router.js");
const { authPool } = await import("../auth/auth.js");

const logger = createLogger();
const events = new TerminalEventBus();
const terminalSessionManager = new TerminalSessionManager(logger as never, events);
let daemon: ChildProcessWithoutNullStreams | null = null;
let budId: string | null = null;
let threadId: string | null = null;
let sessionId: string | null = null;
const daemonOutput: string[] = [];

const controlGateway = await startGrpcControlGateway(terminalSessionManager, logger as never);
const dataGateway = await startGrpcDataGateway(terminalSessionManager, logger as never);

try {
  if (!controlGateway || (dataEnabled && !dataGateway)) {
    throw new Error("required gRPC gateways did not start for this smoke");
  }
  if (!dataEnabled && dataGateway) {
    throw new Error("gRPC data gateway started while control-fallback mode disabled it");
  }

  daemon = spawnBudDaemon();
  budId = await waitForBudId(deviceName);
  await waitForTransport(budId, "h2_grpc");
  if (dataEnabled) {
    await waitForTransport(budId, "h2_data");
  } else {
    await assertNoActiveTransport(budId, "h2_data");
  }

  threadId = randomUUID();
  const userId = `smoke-user-${smokeId}`;
  await db.insert(threadTable).values({
    threadId,
    budId,
    title: "gRPC data smoke",
    createdByUserId: userId,
  });

  const ensured = await terminalSessionManager.ensureSessionRecordForThread(threadId, budId, userId);
  sessionId = ensured.session.sessionId;
  const ensureResult = await terminalSessionManager.ensureSession(sessionId);
  if (!ensureResult.ok) {
    throw new Error(`terminal ensure failed: ${ensureResult.error ?? "unknown"}`);
  }

  await waitForSessionOutput(sessionId, {
    timeoutMs: 15_000,
    acceptAnyOutput: true,
  });
  const command = largeOutput ? buildLargeOutputCommand(marker) : buildMarkerCommand(marker);
  const inputStartedAt = Date.now();
  const inputResult = await terminalSessionManager.sendInput(
    sessionId,
    Buffer.from(command, "utf8"),
    { source: "system", userId },
  );
  const inputDispatchMs = Date.now() - inputStartedAt;
  if (!inputResult.ok) {
    throw new Error(`terminal input failed: ${inputResult.error ?? "unknown"}`);
  }
  if (largeOutput && inputDispatchMs > 5_000) {
    throw new Error(`large-output input dispatch was too slow: ${inputDispatchMs}ms`);
  }

  const output = await waitForSessionOutput(sessionId, {
    timeoutMs: largeOutput ? 30_000 : 20_000,
    marker,
  });
  const dataTracker = Array.from(grpcDataSessions.values()).find((tracker) => tracker.budId === budId);
  if (dataEnabled) {
    if (!dataTracker || dataTracker.framesReceived <= 0 || dataTracker.bytesReceived <= 0) {
      throw new Error("terminal output persisted, but no gRPC data tracker recorded received bytes");
    }
    if (largeOutput && (dataTracker.framesReceived < 2 || dataTracker.bytesReceived < 65_536)) {
      throw new Error(
        `large output did not exercise enough data frames: frames=${dataTracker.framesReceived}, bytes=${dataTracker.bytesReceived}`,
      );
    }
  } else {
    if (dataTracker) {
      throw new Error("control-fallback mode unexpectedly registered a gRPC data tracker");
    }
    await assertNoActiveTransport(budId, "h2_data");
  }

  console.log(JSON.stringify({
    ok: true,
    mode: smokeMode,
    bud_id: budId,
    device_session_id: dataTracker?.deviceSessionId ?? null,
    data_transport_session_id: dataTracker?.transportSessionId ?? null,
    session_id: sessionId,
    marker_found: output.includes(marker),
    output_bytes: Buffer.byteLength(output, "utf8"),
    input_dispatch_ms: inputDispatchMs,
    data_enabled: dataEnabled,
    data_frames_received: dataTracker?.framesReceived ?? 0,
    data_bytes_received: dataTracker?.bytesReceived ?? 0,
    control_port: controlPort,
    data_port: dataEnabled ? dataPort : null,
  }, null, 2));
} catch (err) {
  console.error("gRPC data terminal smoke failed");
  console.error(err);
  console.error("Recent daemon output:");
  console.error(daemonOutput.slice(-80).join("\n"));
  throw err;
} finally {
  if (sessionId) {
    await terminalSessionManager.closeSession(sessionId, "grpc_data_smoke_complete").catch(() => undefined);
  }
  if (daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
    await onceExit(daemon, 5_000).catch(() => {
      daemon?.kill("SIGKILL");
    });
  }
  await dataGateway?.close().catch(() => undefined);
  await controlGateway?.close().catch(() => undefined);
  if (budId) {
    await db.delete(budTable).where(eq(budTable.budId, budId)).catch(() => undefined);
  }
  if (threadId) {
    await db.delete(threadTable).where(eq(threadTable.threadId, threadId)).catch(() => undefined);
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await authPool.end().catch(() => undefined);
}

function spawnBudDaemon(): ChildProcessWithoutNullStreams {
  const child = spawn(budBinary, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BUD_SERVER_URL: "http://127.0.0.1:3000",
      BUD_GRPC_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      BUD_ENROLLMENT_TOKEN: token,
      BUD_DEVICE_NAME: deviceName,
      BUD_IDENTITY_FILE: identityFile,
      BUD_TERMINAL_ENABLED: "true",
      BUD_TERMINAL_BASE_DIR: terminalBaseDir,
      BUD_RECONNECT_BASE_SEC: "60",
      BUD_DEBUG: "true",
      ...(dataEnabled ? { BUD_GRPC_DATA_URL: `http://127.0.0.1:${dataPort}` } : {}),
    },
  });

  child.stdout.on("data", (chunk) => daemonOutput.push(String(chunk).trimEnd()));
  child.stderr.on("data", (chunk) => daemonOutput.push(String(chunk).trimEnd()));
  return child;
}

async function waitForBudId(name: string): Promise<string> {
  return waitFor(async () => {
    const rows = await db
      .select({ budId: budTable.budId })
      .from(budTable)
      .where(eq(budTable.name, name))
      .orderBy(desc(budTable.createdAt))
      .limit(1);
    return rows[0]?.budId ?? null;
  }, { timeoutMs: 15_000, label: "bud enrollment" });
}

async function waitForTransport(budId: string, transportKind: string): Promise<void> {
  await waitFor(async () => {
    const rows = await db
      .select({ transportSessionId: transportSessionTable.transportSessionId })
      .from(transportSessionTable)
      .where(and(
        eq(transportSessionTable.budId, budId),
        eq(transportSessionTable.transportKind, transportKind),
        eq(transportSessionTable.status, "active"),
      ))
      .limit(1);
    return rows.length > 0 ? true : null;
  }, { timeoutMs: 15_000, label: `${transportKind} transport` });
}

async function assertNoActiveTransport(budId: string, transportKind: string): Promise<void> {
  const rows = await db
    .select({ transportSessionId: transportSessionTable.transportSessionId })
    .from(transportSessionTable)
    .where(and(
      eq(transportSessionTable.budId, budId),
      eq(transportSessionTable.transportKind, transportKind),
      eq(transportSessionTable.status, "active"),
    ))
    .limit(1);
  if (rows.length > 0) {
    throw new Error(`unexpected active ${transportKind} transport`);
  }
}

async function waitForSessionOutput(
  terminalSessionId: string,
  options: { timeoutMs: number; marker?: string; acceptAnyOutput?: boolean },
): Promise<string> {
  return waitFor(async () => {
    const rows = await db
      .select({ data: terminalSessionOutputTable.data })
      .from(terminalSessionOutputTable)
      .where(eq(terminalSessionOutputTable.sessionId, terminalSessionId))
      .orderBy(terminalSessionOutputTable.byteOffset);
    const output = Buffer.concat(rows.map((row) => Buffer.from(row.data))).toString("utf8");
    if (options.marker && output.includes(options.marker)) {
      return output;
    }
    if (options.acceptAnyOutput && output.length > 0) {
      return output;
    }
    return null;
  }, { timeoutMs: options.timeoutMs, label: options.marker ? `terminal output marker ${options.marker}` : "terminal output" });
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  options: { timeoutMs: number; label: string },
): Promise<T> {
  const started = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - started < options.timeoutMs) {
    try {
      const value = await fn();
      if (value !== null) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${options.label}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve TCP port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function parseSmokeMode(value: string | undefined): SmokeMode {
  if (!value || value === "data") {
    return "data";
  }
  if (value === "control-fallback" || value === "large-output") {
    return value;
  }
  throw new Error(`unknown SMOKE_GRPC_DATA_MODE: ${value}`);
}

function buildMarkerCommand(value: string): string {
  return `printf '%s\\n' ${shellSingleQuote(value)}\n`;
}

function buildLargeOutputCommand(value: string): string {
  return [
    "i=0",
    "while [ \"$i\" -lt 3000 ]; do printf 'bud-data-large-%04d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' \"$i\"; i=$((i+1)); done",
    `printf '%s\\n' ${shellSingleQuote(value)}`,
  ].join("; ") + "\n";
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function onceExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit after signal")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function createLogger() {
  const log = (_meta?: unknown, _message?: string) => undefined;
  return {
    info: log,
    warn: log,
    error: log,
    debug: log,
    child() {
      return this;
    },
  };
}
