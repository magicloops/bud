import { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import type { RawData } from "ws";
import type WebSocket from "ws";
import { z } from "zod";
import { hashEnrollmentToken } from "../auth/enrollment-token.js";
import { PROTO_VERSION, config } from "../config.js";
import { db } from "../db/client.js";
import { budTable, deviceAuthFlowTable, enrollmentTokenTable } from "../db/schema.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { ReadinessAssessment } from "../terminal/types.js";
import { logGatewayDebug } from "./debug.js";
import {
  EnvelopeSchema,
  ErrorFrameSchema,
  HelloProofSchema,
  HelloSchema,
  TerminalEnvelopeSchema,
  TerminalObserveResultSchema,
  TerminalOutputSchema,
  TerminalReadySchema,
  TerminalSendResultSchema,
  TerminalStatusSchema,
} from "./protocol.js";
import type { ConnectionState, HelloFrame, HelloWithBudId } from "./protocol.js";
import {
  SessionTracker,
  clearTrackerTimeout,
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  sessions,
} from "./session-trackers.js";

export class BudConnection {
  private state: ConnectionState = { kind: "awaiting_hello" };
  private lastPresenceWrite = 0;
  private tracker: SessionTracker | null = null;
  private readonly server: FastifyInstance;
  private readonly socket: WebSocket;
  private readonly terminalSessionManager: TerminalSessionManager;

  constructor(
    server: FastifyInstance,
    socket: WebSocket,
    terminalSessionManager: TerminalSessionManager
  ) {
    this.server = server;
    this.socket = socket;
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

    const envelope = EnvelopeSchema.or(TerminalEnvelopeSchema).safeParse(parsed);
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
      case "terminal_status":
        await this.handleTerminalStatus(parsed);
        break;
      case "terminal_output":
        await this.handleTerminalOutput(parsed);
        break;
      case "terminal_ready":
        await this.handleTerminalReady(parsed);
        break;
      case "terminal_observe_result":
        await this.handleTerminalObserveResult(parsed);
        break;
      case "terminal_send_result":
        await this.handleTerminalSendResult(parsed);
        break;
      default:
        this.server.log.warn({ type: envelope.data.type }, "Unhandled WS frame type");
        break;
    }
  }

  private async handleTerminalStatus(raw: unknown) {
    if (!config.terminalEnabled) {
      return;
    }
    if (this.state.kind !== "connected") {
      logGatewayDebug({}, "terminal_status received before hello");
      return;
    }
    const result = TerminalStatusSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_status frame");
      return;
    }

    await this.terminalSessionManager.handleTerminalStatus(result.data.session_id, {
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

    this.server.log.info(
      {
        sessionId: result.data.session_id,
        budId: this.state.budId,
        seq: result.data.seq,
        byte_offset: result.data.byte_offset,
        component: "ws_gateway"
      },
      "terminal_output frame received from bud"
    );

    await this.terminalSessionManager.handleTerminalOutput(result.data.session_id, {
      seq: result.data.seq,
      data: result.data.data,
      byte_offset: result.data.byte_offset
    });
  }

  private async handleTerminalReady(raw: unknown) {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalReadySchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_ready frame");
      return;
    }

    await this.terminalSessionManager.handleTerminalReady(result.data.session_id, {
      assessment: result.data.assessment as ReadinessAssessment,
    });
  }

  private async handleTerminalObserveResult(raw: unknown) {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalObserveResultSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_observe_result frame");
      return;
    }

    this.terminalSessionManager.handleObserveResult(result.data.session_id, {
      requestId: result.data.request_id,
      view: result.data.view,
      output: result.data.output,
      outputBytes: result.data.output_bytes,
      linesCaptured: result.data.lines_captured,
      changed: result.data.changed ?? undefined,
      truncated: result.data.truncated ?? undefined,
      readiness: result.data.readiness as ReadinessAssessment,
      error: result.data.error
    });
  }

  private async handleTerminalSendResult(raw: unknown): Promise<void> {
    if (!config.terminalEnabled || this.state.kind !== "connected") {
      return;
    }
    const result = TerminalSendResultSchema.safeParse(raw);
    if (!result.success) {
      logGatewayDebug({ error: result.error.message }, "Invalid terminal_send_result frame");
      return;
    }

    this.terminalSessionManager.handleSendResult(result.data.session_id, {
      requestId: result.data.request_id,
      submitted: result.data.submitted,
      delta: result.data.delta ?? null,
      readiness: result.data.readiness as ReadinessAssessment,
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
    const tokenHash = hashEnrollmentToken(frame.token);

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
          installationId: frame.installation_id,
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
            installationId: frame.installation_id,
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
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
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
    if (bud.installationId && frame.installation_id && bud.installationId !== frame.installation_id) {
      await this.sendError("AUTH_FAILED", "installation_id mismatch");
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
        installationId: hello.installation_id ?? undefined,
        status: "online",
        lastSeenAt: new Date(),
        name: hello.name,
        os: hello.os,
        arch: hello.arch,
        version: hello.version,
        capabilities: hello.capabilities
      })
      .where(eq(budTable.budId, budId));

    if (hello.installation_id) {
      await db
        .update(deviceAuthFlowTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          issuedDeviceSecret: null
        })
        .where(
          and(
            eq(deviceAuthFlowTable.installationId, hello.installation_id),
            eq(deviceAuthFlowTable.budId, budId),
            eq(deviceAuthFlowTable.status, "approved")
          )
        );
    }

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
    await this.terminalSessionManager.emitBudOnlineForSessions(budId);
  }

  private async handleHeartbeat(ts: number) {
    if (this.state.kind !== "connected") {
      return;
    }
    const now = Date.now();
    const tracker = this.getCurrentTracker();
    if (tracker) {
      tracker.lastHeartbeat = ts;
      this.scheduleTimeout(tracker);
    } else {
      this.server.log.info(
        { budId: this.state.budId, sessionId: this.state.sessionId },
        "Ignoring heartbeat for superseded bud session"
      );
      return;
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
    const previous = registerActiveSessionTracker(sessions, tracker);
    this.tracker = tracker;
    this.server.log.info(
      {
        budId,
        sessionId,
        replacedSessionId: previous?.sessionId ?? null
      },
      previous ? "Replaced active bud session tracker" : "Registered active bud session tracker"
    );
    this.scheduleTimeout(tracker);
    if (previous && previous.socket !== tracker.socket && previous.socket.readyState === previous.socket.OPEN) {
      this.server.log.warn(
        {
          budId,
          sessionId,
          replacedSessionId: previous.sessionId
        },
        "Closing superseded bud socket"
      );
      try {
        previous.socket.close();
      } catch {
        /* noop */
      }
    }
  }

  private scheduleTimeout(tracker: SessionTracker) {
    clearTrackerTimeout(tracker);
    tracker.timeout = setTimeout(() => {
      const deleted = deleteSessionTrackerIfCurrent(sessions, tracker);
      if (!deleted) {
        this.server.log.info(
          { budId: tracker.budId, sessionId: tracker.sessionId },
          "Ignoring timeout for superseded bud session"
        );
        return;
      }
      this.server.log.warn(
        { budId: tracker.budId, sessionId: tracker.sessionId },
        "Active bud session heartbeat timed out"
      );
      void this.handleOfflineTransition(tracker.budId);
      try {
        tracker.socket.close();
      } catch {
        /* noop */
      }
    }, config.offlineGraceSec * 1000);
  }

  private async handleClose() {
    if (this.state.kind === "connected") {
      const deleted = deleteSessionTrackerIfCurrent(sessions, this.tracker);
      if (!deleted) {
        clearTrackerTimeout(this.tracker);
        this.server.log.info(
          { budId: this.state.budId, sessionId: this.state.sessionId },
          "Ignoring close for superseded bud session"
        );
      } else {
        this.server.log.info(
          { budId: this.state.budId, sessionId: this.state.sessionId },
          "Active bud session closed"
        );
        await this.handleOfflineTransition(this.state.budId);
      }
    }
    this.tracker = null;
    this.state = { kind: "closed" };
  }

  private getCurrentTracker(): SessionTracker | null {
    if (this.state.kind !== "connected") {
      return null;
    }
    return getActiveSessionTracker(sessions, this.state.budId, this.tracker);
  }

  private async handleOfflineTransition(budId: string) {
    await this.terminalSessionManager.rejectPendingRequestsForBud(budId, "bud_offline");
    await this.terminalSessionManager.clearCachesForBud(budId);
    await this.terminalSessionManager.clearEventBuffersForBud(budId);
    await this.terminalSessionManager.suspendSessionsForBud(budId);
    await this.terminalSessionManager.emitBudOfflineForSessions(budId);
    await markBudOffline(budId, this.server);
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
