import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { ulid } from "ulid";
import { randomBytes, createHmac } from "node:crypto";
import { z } from "zod";
import { db } from "../db/client.js";
import { budTable, enrollmentTokenTable } from "../db/schema.js";
import { PROTO_VERSION, TERMINAL_PROTO_VERSION, config } from "../config.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { RunManager } from "../runtime/run-manager.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";

type HelloFrame = z.infer<typeof HelloSchema>;
type HelloWithBudId = HelloFrame & { bud_id: string };

const EnvelopeSchema = z.object({
  proto: z.literal(PROTO_VERSION),
  type: z.string(),
  id: z.string(),
  ts: z.number(),
  ext: z.record(z.unknown()).default({})
});

const TerminalEnvelopeSchema = z.object({
  proto: z.literal(TERMINAL_PROTO_VERSION),
  type: z.string(),
  id: z.string(),
  ts: z.number(),
  ext: z.record(z.unknown()).default({})
});

const CapabilitiesSchema = z
  .object({
    max_concurrency: z.number().int().positive().default(1),
    supports_pty: z.boolean().default(false),
    shell_default: z.string().optional(),
    sessions: z.boolean().default(false),
    sessions_backends: z.array(z.string()).default([]),
    tmux_version: z.string().optional(),
    terminal: z.boolean().optional().default(false),
    terminal_proto: z.string().optional(),
    terminal_backends: z.array(z.string()).optional().default([])
  })
  .default({
    max_concurrency: 1,
    supports_pty: false,
    sessions: false,
    sessions_backends: [],
    terminal: false,
    terminal_backends: []
  });

const HelloSchema = EnvelopeSchema.extend({
  type: z.literal("hello"),
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string().optional(),
  token: z.string().optional(),
  bud_id: z.string().optional(),
  capabilities: CapabilitiesSchema
});

const HelloProofSchema = EnvelopeSchema.extend({
  type: z.literal("hello_proof"),
  bud_id: z.string(),
  hmac: z.string()
});

const StreamSchema = EnvelopeSchema.extend({
  type: z.union([z.literal("stdout"), z.literal("stderr")]),
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string()
});

const RunFinishedSchema = EnvelopeSchema.extend({
  type: z.literal("run_finished"),
  run_id: z.string(),
  exit_code: z.number().int().nullable().optional(),
  canceled: z.boolean().optional(),
  signal: z.string().nullable().optional(),
  cwd: z.string().optional(),
  error: z.string().optional()
});

const SessionOpenedSchema = EnvelopeSchema.extend({
  type: z.literal("session_opened"),
  session_id: z.string(),
  backend: z.string()
});

const SessionOutputSchema = EnvelopeSchema.extend({
  type: z.literal("session_output"),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string()
});

const SessionClosedSchema = EnvelopeSchema.extend({
  type: z.literal("session_closed"),
  session_id: z.string(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  canceled: z.boolean().optional()
});

const SessionErrorSchema = EnvelopeSchema.extend({
  type: z.literal("session_error"),
  session_id: z.string(),
  code: z.string(),
  message: z.string()
});

const TerminalStatusSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_status"),
  session_id: z.string(),
  state: z.string(),
  info: z
    .object({
      tmux_session: z.string().optional(),
      pid: z.number().int().optional(),
      shell: z.string().optional(),
      cwd: z.string().optional(),
      cols: z.number().int().optional(),
      rows: z.number().int().optional(),
      output_log_bytes: z.number().int().optional(),
      started_at: z.string().optional(),
      last_activity_at: z.string().optional()
    })
    .optional()
});

const TerminalOutputSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_output"),
  session_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string(),
  byte_offset: z.number().int().nonnegative()
});

const TerminalReadySchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_ready"),
  session_id: z.string(),
  assessment: z.record(z.unknown())
});

const TerminalCaptureResponseSchema = TerminalEnvelopeSchema.extend({
  type: z.literal("terminal_capture_response"),
  session_id: z.string(),
  request_id: z.string(),
  output: z.string(),  // base64
  output_bytes: z.number().int().nonnegative(),
  lines_captured: z.number().int().nonnegative(),
  error: z.string().nullable()
});

const ErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal("error"),
  code: z.string(),
  message: z.string()
});

type ConnectionState =
  | { kind: "awaiting_hello" }
  | {
    kind: "awaiting_proof";
    budId: string;
    deviceSecret: string;
    nonce: string;
    hello: HelloFrame;
  }
  | {
    kind: "connected";
    budId: string;
    sessionId: string;
    hello: HelloFrame;
  }
  | { kind: "closed" };

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface SessionTracker {
  budId: string;
  sessionId: string;
  lastHeartbeat: number;
  socket: WebSocket;
  timeout?: TimeoutHandle;
}

const sessions = new Map<string, SessionTracker>();
let gatewayLogger: FastifyBaseLogger | null = null;

export function getActiveBudIds(): string[] {
  return Array.from(sessions.keys());
}

export function isBudOnline(budId: string): boolean {
  const session = sessions.get(budId);
  return session !== undefined && session.socket.readyState === session.socket.OPEN;
}

export function sendFrameToBud(budId: string, payload: Record<string, unknown>): boolean {
  const session = sessions.get(budId);
  if (!session) {
    logDebug({ budId, activeBuds: getActiveBudIds() }, "No active session for bud; dropping frame ");
    return false;
  }
  if (session.socket.readyState !== session.socket.OPEN) {
    logDebug(
      {
        budId,
        readyState: session.socket.readyState
      },
      "WS socket not open; dropping frame"
    );
    return false;
  }
  session.socket.send(JSON.stringify(payload));
  logDebug({ budId, type: payload.type }, "Frame sent to Bud");
  return true;
}

export async function registerWsGateway(
  server: FastifyInstance,
  runManager: RunManager,
  sessionManager: SessionManager,
  terminalSessionManager: TerminalSessionManager
): Promise<void> {
  gatewayLogger = server.log.child({ component: "ws_gateway" });
  server.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const connection = new BudConnection(server, socket, runManager, sessionManager, terminalSessionManager);
    connection.start().catch((err) => {
      server.log.error({ err }, "WS connection failed");
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
  });
}

class BudConnection {
  private state: ConnectionState = { kind: "awaiting_hello" };
  private lastPresenceWrite = 0;
  private readonly server: FastifyInstance;
  private readonly socket: WebSocket;
  private readonly runManager: RunManager;
  private readonly sessionManager: SessionManager;
  private readonly terminalSessionManager: TerminalSessionManager;

  constructor(
    server: FastifyInstance,
    socket: WebSocket,
    runManager: RunManager,
    sessionManager: SessionManager,
    terminalSessionManager: TerminalSessionManager
  ) {
    this.server = server;
    this.socket = socket;
    this.runManager = runManager;
    this.sessionManager = sessionManager;
    this.terminalSessionManager = terminalSessionManager;
    socket.on("close", () => {
      void this.handleClose();
    });
  }

  async start(): Promise<void> {
    this.socket.on("message", (raw: RawData) => {
      if (typeof raw === "string") {
        void this.handleRaw(raw);
        return;
      }
      if (Buffer.isBuffer(raw)) {
        void this.handleRaw(raw.toString("utf-8"));
        return;
      }
      if (Array.isArray(raw)) {
        raw.forEach((chunk) => {
          if (Buffer.isBuffer(chunk)) {
            void this.handleRaw(chunk.toString("utf-8"));
          }
        });
        return;
      }
      if (raw instanceof ArrayBuffer) {
        void this.handleRaw(Buffer.from(raw).toString("utf-8"));
      }
    });
  }

  private async handleRaw(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.server.log.warn({ err }, "Failed to parse WS frame");
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid JSON");
      this.socket.close();
      return;
    }

    const envelope = z.union([EnvelopeSchema, TerminalEnvelopeSchema]).safeParse(parsed);
    if (!envelope.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid envelope");
      this.socket.close();
      return;
    }

    switch (envelope.data.type) {
      case "hello":
        await this.handleHello(parsed);
        break;
      case "hello_proof":
        await this.handleHelloProof(parsed);
        break;
      case "heartbeat":
        await this.handleHeartbeat(envelope.data.ts);
        break;
      case "stdout":
      case "stderr":
        await this.handleStreamFrame(parsed);
        break;
      case "run_finished":
        await this.handleRunFinished(parsed);
        break;
      case "session_opened":
        await this.handleSessionOpened(parsed);
        break;
      case "session_output":
        await this.handleSessionOutput(parsed);
        break;
      case "session_closed":
        await this.handleSessionClosed(parsed);
        break;
      case "session_error":
        await this.handleSessionError(parsed);
        break;
      case "terminal_status":
        await this.handleTerminalStatus(parsed);
        break;
      case "terminal_output":
        await this.handleTerminalOutput(parsed);
        break;
      case "terminal_ready":
        await this.handleTerminalReady(parsed);
        break;
      case "terminal_capture_response":
        await this.handleTerminalCaptureResponse(parsed);
        break;
      default:
        this.server.log.warn({ type: envelope.data.type }, "Unhandled WS frame type");
        break;
    }
  }

  private async handleStreamFrame(raw: unknown) {
    const result = StreamSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid stream frame");
      return;
    }
    logDebug(
      { runId: result.data.run_id, stream: result.data.type, seq: result.data.seq },
      "Stream frame received"
    );
    await this.runManager.handleStreamChunk(
      result.data.run_id,
      result.data.type,
      result.data.data,
      result.data.seq
    );
  }

  private async handleRunFinished(raw: unknown) {
    const result = RunFinishedSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid run_finished frame");
      return;
    }
    logDebug(
      {
        runId: result.data.run_id,
        exit_code: result.data.exit_code,
        canceled: result.data.canceled,
        signal: result.data.signal
      },
      "run_finished frame received"
    );
    await this.runManager.handleRunFinished(result.data.run_id, {
      exit_code: result.data.exit_code ?? null,
      canceled: result.data.canceled,
      signal: result.data.signal,
      cwd: result.data.cwd
    });
  }

  private async handleSessionOpened(raw: unknown) {
    const result = SessionOpenedSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid session_opened frame");
      return;
    }
    await this.sessionManager.handleSessionOpened({
      session_id: result.data.session_id,
      backend: result.data.backend
    });
  }

  private async handleSessionOutput(raw: unknown) {
    const result = SessionOutputSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid session_output frame");
      return;
    }
    await this.sessionManager.handleSessionOutput({
      session_id: result.data.session_id,
      seq: result.data.seq,
      data: result.data.data
    });
  }

  private async handleSessionClosed(raw: unknown) {
    const result = SessionClosedSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid session_closed frame");
      return;
    }
    await this.sessionManager.handleSessionClosed({
      session_id: result.data.session_id,
      exit_code: result.data.exit_code,
      signal: result.data.signal,
      canceled: result.data.canceled
    });
  }

  private async handleSessionError(raw: unknown) {
    const result = SessionErrorSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid session_error frame");
      return;
    }
    await this.sessionManager.handleSessionError({
      session_id: result.data.session_id,
      code: result.data.code,
      message: result.data.message
    });
  }

  private async handleTerminalStatus(raw: unknown) {
    if (!config.terminalEnabled) {
      return;
    }
    if (this.state.kind !== "connected") {
      logDebug({}, "terminal_status received before hello");
      return;
    }
    const result = TerminalStatusSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid terminal_status frame");
      return;
    }

    const sessionId = result.data.session_id;
    await this.terminalSessionManager.handleTerminalStatus(sessionId, {
      state: result.data.state,
      info: result.data.info
    });
  }

  private async handleTerminalOutput(raw: unknown) {
    if (!config.terminalEnabled) {
      this.server.log.warn({ component: "ws_gateway" }, "terminal_output ignored; terminalEnabled=false");
      return;
    }
    if (this.state.kind !== "connected") {
      this.server.log.warn({ component: "ws_gateway" }, "terminal_output received before hello");
      return;
    }
    const result = TerminalOutputSchema.safeParse(raw);
    if (!result.success) {
      this.server.log.warn({ error: result.error.message, component: "ws_gateway" }, "Invalid terminal_output frame");
      return;
    }

    const sessionId = result.data.session_id;
    this.server.log.info(
      {
        sessionId,
        budId: this.state.budId,
        seq: result.data.seq,
        byte_offset: result.data.byte_offset,
        component: "ws_gateway"
      },
      "terminal_output frame received from bud"
    );

    await this.terminalSessionManager.handleTerminalOutput(sessionId, {
      seq: result.data.seq,
      data: result.data.data,
      byte_offset: result.data.byte_offset
    });
  }

  private async handleTerminalReady(raw: unknown) {
    if (!config.terminalEnabled) {
      return;
    }
    if (this.state.kind !== "connected") {
      return;
    }
    const result = TerminalReadySchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid terminal_ready frame");
      return;
    }

    const sessionId = result.data.session_id;
    await this.terminalSessionManager.handleTerminalReady(sessionId, result.data.assessment as unknown as import("../terminal/types.js").ReadinessAssessment);
  }

  private async handleTerminalCaptureResponse(raw: unknown) {
    if (!config.terminalEnabled) {
      return;
    }
    if (this.state.kind !== "connected") {
      return;
    }
    const result = TerminalCaptureResponseSchema.safeParse(raw);
    if (!result.success) {
      logDebug({ error: result.error.message }, "Invalid terminal_capture_response frame");
      return;
    }

    const sessionId = result.data.session_id;
    this.terminalSessionManager.handleCaptureResponse(sessionId, {
      requestId: result.data.request_id,
      output: result.data.output,
      outputBytes: result.data.output_bytes,
      linesCaptured: result.data.lines_captured,
      error: result.data.error
    });
  }

  private async handleHello(raw: unknown) {
    const result = HelloSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Malformed hello frame");
      this.socket.close();
      return;
    }
    const frame = result.data;
    if (frame.token) {
      await this.handleEnrollmentHello(frame);
      return;
    }
    if (frame.bud_id) {
      await this.issueChallenge(frame as HelloWithBudId);
      return;
    }
    await this.sendError("AUTH_FAILED", "hello requires token or bud_id");
    this.socket.close();
  }

  private async handleEnrollmentHello(frame: HelloFrame) {
    if (!frame.token) {
      await this.sendError("AUTH_FAILED", "Missing enrollment token");
      this.socket.close();
      return;
    }
    const bypassToken =
      config.devTokenBypass && frame.token === config.devTokenBypass ? config.devTokenBypass : null;
    const tokenHash = hashToken(frame.token);

    if (!bypassToken) {
      const tokenRow = await db.query.enrollmentTokenTable.findFirst({
        where: and(
          eq(enrollmentTokenTable.tokenHash, tokenHash),
          isNull(enrollmentTokenTable.consumedAt),
          gt(enrollmentTokenTable.expiresAt, new Date())
        )
      });
      if (!tokenRow) {
        await this.sendError("AUTH_FAILED", "Enrollment token invalid or expired");
        this.socket.close();
        return;
      }
    }

    const budId = `b_${ulid()}`;
    const deviceSecret = randomBytes(32).toString("base64url");
    const sessionId = `s_${ulid()}`;
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(budTable)
        .values({
          budId,
          name: frame.name,
          os: frame.os,
          arch: frame.arch,
          version: frame.version,
          status: "online",
          lastSeenAt: now,
          deviceSecret,
          capabilities: frame.capabilities
        })
        .onConflictDoUpdate({
          target: budTable.budId,
          set: {
            name: frame.name,
            os: frame.os,
            arch: frame.arch,
            version: frame.version,
            status: "online",
            lastSeenAt: now,
            capabilities: frame.capabilities
          }
        });

      if (!bypassToken) {
        await tx
          .update(enrollmentTokenTable)
          .set({ consumedAt: now })
          .where(eq(enrollmentTokenTable.tokenHash, tokenHash));
      }
    });

    if (bypassToken) {
      this.server.log.warn({ budId }, "Dev token bypass used for enrollment");
    }
    this.server.log.info({ budId }, "Bud enrolled");

    // Notify all SSE clients that this bud is online (in case of re-enrollment)
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);

    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      device_secret: deviceSecret,
      heartbeat_sec: config.heartbeatSec
    });

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello: frame
    };
    this.registerSession(budId, sessionId);
  }

  private async issueChallenge(frame: HelloWithBudId) {
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, frame.bud_id)
    });
    if (!bud || !bud.deviceSecret) {
      await this.sendError("AUTH_FAILED", "Unknown bud_id");
      this.socket.close();
      return;
    }

    const nonce = randomBytes(32).toString("base64url");
    this.state = {
      kind: "awaiting_proof",
      budId: bud.budId,
      deviceSecret: bud.deviceSecret,
      nonce,
      hello: frame
    };
    await this.sendFrame("hello_challenge", { nonce });
  }

  private async handleHelloProof(raw: unknown) {
    const result = HelloProofSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("AUTH_FAILED", "Malformed hello_proof");
      this.socket.close();
      return;
    }
    if (this.state.kind !== "awaiting_proof") {
      await this.sendError("AUTH_FAILED", "Unexpected hello_proof");
      this.socket.close();
      return;
    }
    const { budId, deviceSecret, nonce, hello } = this.state;
    const computed = createHmac("sha256", deviceSecret).update(nonce).digest("base64url");
    if (computed !== result.data.hmac) {
      await this.sendError("AUTH_FAILED", "Invalid proof");
      this.socket.close();
      return;
    }

    const sessionId = `s_${ulid()}`;
    await db
      .update(budTable)
      .set({
        status: "online",
        lastSeenAt: new Date(),
        name: hello.name,
        os: hello.os,
        arch: hello.arch,
        version: hello.version,
        capabilities: hello.capabilities
      })
      .where(eq(budTable.budId, budId));

    // Notify all SSE clients that this bud is back online
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);

    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      heartbeat_sec: config.heartbeatSec
    });

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello
    };
    this.registerSession(budId, sessionId);
  }

  private async handleHeartbeat(ts: number) {
    if (this.state.kind !== "connected") {
      return;
    }
    const now = Date.now();
    const session = sessions.get(this.state.budId);
    if (session) {
      session.lastHeartbeat = ts;
      this.scheduleTimeout(session);
    }
    if (now - this.lastPresenceWrite > 5_000) {
      this.lastPresenceWrite = now;
      await db
        .update(budTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(budTable.budId, this.state.budId));
    }
  }

  private registerSession(budId: string, sessionId: string) {
    const tracker: SessionTracker = {
      budId,
      sessionId,
      lastHeartbeat: Date.now(),
      socket: this.socket
    };
    sessions.set(budId, tracker);
    this.scheduleTimeout(tracker);
  }

  private scheduleTimeout(tracker: SessionTracker) {
    if (tracker.timeout) {
      clearTimeout(tracker.timeout);
    }
    tracker.timeout = setTimeout(() => {
      sessions.delete(tracker.budId);
      void markBudOffline(tracker.budId, this.server);
      try {
        tracker.socket.close();
      } catch {
        /* noop */
      }
    }, config.offlineGraceSec * 1000);
  }

  private async handleClose() {
    if (this.state.kind === "connected") {
      sessions.delete(this.state.budId);
      // Clear terminal caches (readiness, byte offsets) to avoid stale data on reconnect
      await this.terminalSessionManager.clearCachesForBud(this.state.budId);
      // Clear event buffers to prevent stale events from being replayed
      await this.terminalSessionManager.clearEventBuffersForBud(this.state.budId);
      // Suspend terminal sessions so ensureSession won't short-circuit on stale "ready" state
      await this.terminalSessionManager.suspendSessionsForBud(this.state.budId);
      // Notify all SSE clients that this bud went offline
      await this.terminalSessionManager.emitBudOfflineForSessions(this.state.budId);
      await markBudOffline(this.state.budId, this.server);
    }
    this.state = { kind: "closed" };
  }

  private async sendError(code: string, message: string) {
    const frame = {
      proto: PROTO_VERSION,
      type: "error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      code,
      message
    } satisfies z.infer<typeof ErrorFrameSchema>;
    await this.send(frame);
  }

  private async sendFrame(type: string, payload: Record<string, unknown>) {
    const frame = {
      proto: PROTO_VERSION,
      type,
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ...payload
    };
    await this.send(frame);
  }

  private async send(frame: object) {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

async function markBudOffline(budId: string, server: FastifyInstance) {
  await db
    .update(budTable)
    .set({ status: "offline", lastSeenAt: new Date() })
    .where(eq(budTable.budId, budId));
  server.log.info({ budId }, "Bud marked offline");
}

function hashToken(token: string) {
  return createHmac("sha256", config.enrollmentHashSecret).update(token).digest("hex");
}

function logDebug(meta: Record<string, unknown>, message: string) {
  if (!config.agentDebug || !gatewayLogger) {
    return;
  }
  gatewayLogger.info({ ...meta, component: "ws_gateway" }, message);
}
