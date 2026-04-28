import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulid";

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(serviceDir, "..");
const budBinary = path.join(repoRoot, "bud/target/debug/bud");

const serverPort = await reservePort();
const smokeId = ulid();
const token = `smoke-token-${smokeId}`;
const deviceName = `bud-ws-terminal-smoke-${smokeId}`;
const marker = `bud-ws-terminal-smoke-${smokeId}`;
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "bud-ws-terminal-smoke-"));
const identityFile = path.join(tmpDir, "identity.json");
const terminalBaseDir = path.join(tmpDir, "terminal");

process.env.GRPC_CONTROL_ENABLED = "false";
process.env.GRPC_DATA_ENABLED = "false";
delete process.env.BUD_GRPC_CONTROL_URL;
delete process.env.BUD_GRPC_DATA_URL;
process.env.DEV_BUD_TOKEN_BYPASS = token;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const { db, pool } = await import("../db/client.js");
const { authPool } = await import("../auth/auth.js");
const {
  auditEventTable,
  budTable,
  terminalSessionOutputTable,
  threadTable,
  transportSessionTable,
} = await import("../db/schema.js");
const { TerminalEventBus } = await import("../runtime/event-bus.js");
const { TerminalSessionManager } = await import("../runtime/terminal-session-manager.js");
const { registerWsGateway } = await import("../ws/gateway.js");
const { sessions } = await import("../ws/session-trackers.js");

const logger = createLogger();
const events = new TerminalEventBus();
const terminalSessionManager = new TerminalSessionManager(logger as never, events);
const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });
let daemon: ChildProcessWithoutNullStreams | null = null;
let budId: string | null = null;
let threadId: string | null = null;
let sessionId: string | null = null;
const daemonOutput: string[] = [];

try {
  await server.register(websocketPlugin, {
    options: {
      perMessageDeflate: {
        threshold: 1024,
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
      },
    },
  });
  await registerWsGateway(server, terminalSessionManager);
  await server.listen({ port: serverPort, host: "127.0.0.1" });

  daemon = spawnBudDaemon();
  budId = await waitForBudId(deviceName);
  const bud = await waitForEnvelopeCapability(budId);
  await waitForTransport(budId, "websocket");
  await assertNoActiveTransport(budId, "h2_grpc");
  await assertNoActiveTransport(budId, "h2_data");
  await waitForBinarySessionTracker(budId);
  await waitForReconnectAudit(budId);

  threadId = randomUUID();
  const userId = `smoke-user-${smokeId}`;
  await db.insert(threadTable).values({
    threadId,
    budId,
    title: "WebSocket terminal smoke",
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
  const inputResult = await terminalSessionManager.sendInput(
    sessionId,
    Buffer.from(buildMarkerCommand(marker), "utf8"),
    { source: "system", userId },
  );
  if (!inputResult.ok) {
    throw new Error(`terminal input failed: ${inputResult.error ?? "unknown"}`);
  }

  const output = await waitForSessionOutput(sessionId, {
    timeoutMs: 20_000,
    marker,
  });

  console.log(JSON.stringify({
    ok: true,
    mode: "websocket",
    bud_id: budId,
    session_id: sessionId,
    marker_found: output.includes(marker),
    output_bytes: Buffer.byteLength(output, "utf8"),
    websocket_port: serverPort,
    bud_envelope: bud.capabilities.bud_envelope,
    active_transport: "websocket",
    h2_grpc_active: false,
    h2_data_active: false,
    reconnect_audit_seen: true,
  }, null, 2));
} catch (err) {
  console.error("WebSocket terminal smoke failed");
  console.error(err);
  console.error("Recent daemon output:");
  console.error(daemonOutput.slice(-80).join("\n"));
  throw err;
} finally {
  if (sessionId) {
    await terminalSessionManager.closeSession(sessionId, "ws_terminal_smoke_complete").catch(() => undefined);
  }
  if (daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
    await onceExit(daemon, 5_000).catch(() => {
      daemon?.kill("SIGKILL");
    });
  }
  await server.close().catch(() => undefined);
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
      BUD_SERVER_URL: `ws://127.0.0.1:${serverPort}/ws`,
      BUD_ENROLLMENT_TOKEN: token,
      BUD_DEVICE_NAME: deviceName,
      BUD_IDENTITY_FILE: identityFile,
      BUD_TERMINAL_ENABLED: "true",
      BUD_TERMINAL_BASE_DIR: terminalBaseDir,
      BUD_RECONNECT_BASE_SEC: "60",
      BUD_DEBUG: "true",
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

async function waitForEnvelopeCapability(budId: string): Promise<{ capabilities: Record<string, unknown> }> {
  return waitFor(async () => {
    const rows = await db
      .select({ capabilities: budTable.capabilities })
      .from(budTable)
      .where(eq(budTable.budId, budId))
      .limit(1);
    const capabilities = rows[0]?.capabilities;
    if (!isRecord(capabilities)) {
      return null;
    }
    const envelope = capabilities.bud_envelope;
    if (isRecord(envelope) && envelope.version === 1 && envelope.websocket_binary === true) {
      return { capabilities };
    }
    return null;
  }, { timeoutMs: 10_000, label: "bud envelope websocket capability" });
}

async function waitForBinarySessionTracker(budId: string): Promise<void> {
  await waitFor(async () => {
    const tracker = sessions.get(budId);
    return tracker?.supportsEnvelopeBinary === true ? true : null;
  }, { timeoutMs: 10_000, label: "binary WebSocket session tracker" });
}

async function waitForReconnectAudit(budId: string): Promise<void> {
  await waitFor(async () => {
    const rows = await db
      .select({ auditEventId: auditEventTable.auditEventId })
      .from(auditEventTable)
      .where(and(
        eq(auditEventTable.budId, budId),
        eq(auditEventTable.eventType, "daemon.reconnect_report"),
      ))
      .limit(1);
    return rows.length > 0 ? true : null;
  }, { timeoutMs: 10_000, label: "reconnect report audit event" });
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

function buildMarkerCommand(value: string): string {
  return `printf '%s\\n' ${shellSingleQuote(value)}\n`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
