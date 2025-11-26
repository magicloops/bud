import type WebSocket from "ws";
import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  budTable,
  sessionLogTable,
  sessionTable,
  threadTable
} from "../db/schema.js";
import { PROTO_VERSION, config } from "../config.js";
import { sendFrameToBud } from "../ws/gateway.js";
import { SessionEventBus } from "./event-bus.js";

type SessionBackend = "pty" | "tmux";

type SessionCreateOptions = {
  budId: string;
  threadId: string;
  backend: SessionBackend;
  cmd?: string | null;
  cwd?: string | null;
  rows?: number | null;
  cols?: number | null;
};

type BrowserMessage =
  | { type: "output"; data: string }
  | {
      type: "status";
      status: string;
      exit_code?: number | null;
      error?: string | null;
      role?: "writer" | "spectator";
      truncated?: boolean;
    };

type SessionContext = {
  sessionId: string;
  budId: string;
  threadId: string;
  backend: SessionBackend;
  attachToken: string;
  status: "opening" | "open" | "closed" | "failed";
  writer: WebSocket | null;
  spectators: Set<WebSocket>;
  logsBytes: number;
  logTruncated: boolean;
  bytesOut: number;
  bytesIn: number;
  lastActivity: number;
};

const LONG_TTL_SEC = 365 * 24 * 60 * 60;

export class SessionManager {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly logLimit: number;
  private readonly logger: FastifyBaseLogger;
  private readonly events: SessionEventBus;
  private readonly dbClient: typeof db;

  constructor(
    logger: FastifyBaseLogger,
    events: SessionEventBus,
    options: { db?: typeof db; logLimit?: number } = {}
  ) {
    this.logger = logger;
    this.events = events;
    this.dbClient = options.db ?? db;
    this.logLimit = options.logLimit ?? config.runLogMaxBytes;
  }

  async createSession(options: SessionCreateOptions): Promise<{ sessionId: string; attachToken: string }> {
    const thread = await this.dbClient.query.threadTable.findFirst({
      where: eq(threadTable.threadId, options.threadId)
    });
    if (!thread) {
      throw new Error("thread not found");
    }
    if (thread.budId !== options.budId) {
      throw new Error("thread does not belong to bud");
    }
    const bud = await this.dbClient.query.budTable.findFirst({
      where: eq(budTable.budId, options.budId)
    });
    if (!bud) {
      throw new Error("bud not found");
    }
    if (bud.status !== "online") {
      throw new Error("bud is offline");
    }
    const caps = (bud.capabilities ?? {}) as Record<string, unknown>;
    if (caps.sessions !== true) {
      throw new Error("bud does not support interactive sessions");
    }
    const backendsRaw = Array.isArray(caps.sessions_backends) ? (caps.sessions_backends as unknown[]) : [];
    const supportsTmux = backendsRaw.some((entry) => entry === "tmux");
    if (options.backend === "tmux" && !supportsTmux) {
      throw new Error("tmux durability not available on this bud");
    }

    const sessionId = `sess_${ulid()}`;
    const attachToken = `sess_att_${ulid()}`;
    const backend: SessionBackend = options.backend === "tmux" ? "tmux" : "pty";
    const now = new Date();

    await this.dbClient.insert(sessionTable).values({
      sessionId,
      budId: options.budId,
      threadId: options.threadId,
      backend,
      status: "opening",
      startedAt: now,
      lastActivityAt: now,
      hardTtlSec: LONG_TTL_SEC,
      idleKillSec: LONG_TTL_SEC
    });

    this.sessions.set(sessionId, {
      sessionId,
      budId: options.budId,
      threadId: options.threadId,
      backend,
      attachToken,
      status: "opening",
      writer: null,
      spectators: new Set(),
      logsBytes: 0,
      logTruncated: false,
      bytesOut: 0,
      bytesIn: 0,
      lastActivity: now.getTime()
    });
    this.logger.info(
      { sessionId, budId: options.budId, backend, component: "session_manager" },
      "Session created"
    );

    this.emitStatus(sessionId, "opening", { truncated: false });

    const payload: Record<string, unknown> = {
      proto: PROTO_VERSION,
      type: "session_open",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      backend,
      cmd: options.cmd ?? defaultSessionCommand(),
      cwd: options.cwd ?? null,
      pty: {
        rows: options.rows ?? 24,
        cols: options.cols ?? 80
      }
    };

    const sent = sendFrameToBud(options.budId, payload);
    if (!sent) {
      this.sessions.delete(sessionId);
      await this.dbClient
        .update(sessionTable)
        .set({ status: "failed", finishedAt: new Date(), error: "BUD_OFFLINE" })
        .where(eq(sessionTable.sessionId, sessionId));
      this.emitStatus(sessionId, "failed", { error: "bud disconnected" });
      throw new Error("bud disconnected");
    }

    return { sessionId, attachToken };
  }

  async ensureThreadSession(threadId: string): Promise<{ sessionId: string; attachToken: string }> {
    const thread = await this.dbClient.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId)
    });
    if (!thread) {
      throw new Error("thread not found");
    }
    const existingId = thread.currentSessionId;
    if (existingId) {
      const ctx = this.sessions.get(existingId);
      if (ctx) {
        return { sessionId: existingId, attachToken: ctx.attachToken };
      }
    }
    const created = await this.createSession({
      budId: thread.budId,
      threadId: thread.threadId,
      backend: "pty"
    });
    await this.dbClient
      .update(threadTable)
      .set({ currentSessionId: created.sessionId })
      .where(eq(threadTable.threadId, thread.threadId));
    return created;
  }

  async handleSessionOpened(payload: { session_id: string; backend: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    if (!ctx) return;
    ctx.status = "open";
    await this.dbClient
      .update(sessionTable)
      .set({ status: "open" })
      .where(eq(sessionTable.sessionId, payload.session_id));
    this.broadcast(ctx, { type: "status", status: "open", truncated: ctx.logTruncated });
    this.emitStatus(payload.session_id, "open", { truncated: ctx.logTruncated });
  }

  async handleSessionOutput(payload: { session_id: string; seq: number; data: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    if (!ctx) return;
    const buffer = Buffer.from(payload.data, "base64");
    const now = new Date();
    const remaining = Math.max(this.logLimit - ctx.logsBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
    let truncatedNow = false;
    if (toStore.length > 0) {
      await this.dbClient
        .insert(sessionLogTable)
        .values({
          sessionId: payload.session_id,
          seq: payload.seq,
          data: toStore
        })
        .onConflictDoNothing({
          target: [sessionLogTable.sessionId, sessionLogTable.seq]
        });
      ctx.logsBytes += toStore.length;
      if (!ctx.logTruncated && ctx.logsBytes >= this.logLimit) {
        ctx.logTruncated = true;
        truncatedNow = true;
      }
      await this.dbClient
        .update(sessionTable)
        .set({
          logsBytes: ctx.logsBytes,
          logTruncated: ctx.logTruncated,
          bytesOut: ctx.bytesOut + buffer.length,
          lastActivityAt: now
        })
        .where(eq(sessionTable.sessionId, payload.session_id));
    }
    ctx.bytesOut += buffer.length;
    ctx.lastActivity = now.getTime();
    this.broadcast(ctx, { type: "output", data: payload.data });
    if (truncatedNow) {
      this.broadcast(ctx, { type: "status", status: ctx.status, truncated: true });
      this.logger.warn(
        { sessionId: payload.session_id, component: "session_manager" },
        "session logs truncated at soft cap"
      );
      this.emitStatus(payload.session_id, ctx.status, { truncated: true });
    }
  }

  async handleSessionClosed(payload: {
    session_id: string;
    exit_code: number | null | undefined;
    signal?: string | null;
    canceled?: boolean;
  }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    await this.dbClient
      .update(sessionTable)
      .set({
        status: payload.canceled ? "canceled" : "closed",
        finishedAt: new Date(),
        lastActivityAt: new Date(),
        exitCode: payload.exit_code ?? null,
        signal: payload.signal ?? null
      })
      .where(eq(sessionTable.sessionId, payload.session_id));
    await this.dbClient
      .update(threadTable)
      .set({ currentSessionId: null })
      .where(eq(threadTable.currentSessionId, payload.session_id));
    if (ctx) {
      const nextStatus = payload.canceled ? "canceled" : "closed";
      ctx.status = nextStatus;
      this.broadcast(ctx, {
        type: "status",
        status: nextStatus,
        exit_code: payload.exit_code ?? null
      });
      this.emitStatus(payload.session_id, nextStatus, {
        exit_code: payload.exit_code ?? null,
        truncated: ctx.logTruncated
      });
      this.emitFinal(payload.session_id, nextStatus, {
        exit_code: payload.exit_code ?? null,
        signal: payload.signal ?? null,
        canceled: payload.canceled ?? false,
        bytes_out: ctx.bytesOut,
        bytes_in: ctx.bytesIn
      });
      this.logger.info(
        {
          sessionId: payload.session_id,
          bytesOut: ctx.bytesOut,
          bytesIn: ctx.bytesIn,
          component: "session_manager"
        },
        "Session closed"
      );
      this.closeAllSockets(ctx);
      this.sessions.delete(payload.session_id);
    }
  }

  async handleSessionError(payload: { session_id: string; code: string; message: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    await this.dbClient
      .update(sessionTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        lastActivityAt: new Date(),
        error: payload.code
      })
      .where(eq(sessionTable.sessionId, payload.session_id));
    await this.dbClient
      .update(threadTable)
      .set({ currentSessionId: null })
      .where(eq(threadTable.currentSessionId, payload.session_id));
    if (ctx) {
      ctx.status = "failed";
      this.broadcast(ctx, {
        type: "status",
        status: "failed",
        error: payload.message
      });
      this.emitStatus(payload.session_id, "failed", { error: payload.message });
      this.emitFinal(payload.session_id, "failed", {
        exit_code: null,
        signal: null,
        canceled: false,
        error: payload.message,
        bytes_out: ctx.bytesOut,
        bytes_in: ctx.bytesIn
      });
      this.logger.error(
        { sessionId: payload.session_id, error: payload.code, component: "session_manager" },
        "Session failed"
      );
      this.closeAllSockets(ctx);
      this.sessions.delete(payload.session_id);
    }
  }

  attachClient(
    sessionId: string,
    token: string,
    socket: WebSocket
  ): { ok: boolean; error?: string; role?: "writer" | "spectator" } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      this.logger.warn({ sessionId }, "attachClient failed: session missing");
      return { ok: false, error: "session not found" };
    }
    if (ctx.attachToken !== token) {
      this.logger.warn({ sessionId }, "attachClient failed: invalid token");
      return { ok: false, error: "invalid attach token" };
    }
    let role: "writer" | "spectator" = "spectator";
    if (!ctx.writer) {
      ctx.writer = socket;
      role = "writer";
      this.emitWriter(sessionId, true);
    } else {
      ctx.spectators.add(socket);
    }
    socket.on("close", () => {
      this.detachSocket(sessionId, socket);
    });
    this.logger.info({ sessionId, role }, "Client attached to session");
    this.sendStatus(socket, ctx.status, role, ctx.logTruncated);
    return { ok: true, role };
  }

  sendInput(sessionId: string, socket: WebSocket, dataB64: string): { ok: boolean; error?: string } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      this.logger.warn({ sessionId }, "sendInput failed: session missing");
      return { ok: false, error: "session not found" };
    }
    if (ctx.writer !== socket) {
      this.logger.warn({ sessionId }, "sendInput failed: socket not writer");
      return { ok: false, error: "not_writer" };
    }
    const payload = {
      proto: PROTO_VERSION,
      type: "session_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      data: dataB64
    };
    const bytes = Buffer.from(dataB64, "base64").length;
    if (!sendFrameToBud(ctx.budId, payload)) {
      this.logger.error({ sessionId }, "sendInput failed: Bud unavailable");
      return { ok: false, error: "session_closed" };
    }
    ctx.bytesIn += bytes;
    ctx.lastActivity = Date.now();
    this.touchSession(sessionId);
    this.logger.info(
      { sessionId, bytes, component: "session_manager" },
      "session input forwarded"
    );
    return { ok: true };
  }

  sendInputDirect(sessionId: string, dataB64: string): { ok: boolean; error?: string } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      this.logger.warn({ sessionId }, "sendInputDirect failed: session missing");
      return { ok: false, error: "session not found" };
    }
    const payload = {
      proto: PROTO_VERSION,
      type: "session_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      data: dataB64
    };
    const bytes = Buffer.from(dataB64, "base64").length;
    if (!sendFrameToBud(ctx.budId, payload)) {
      this.logger.error({ sessionId }, "sendInputDirect failed: Bud unavailable");
      return { ok: false, error: "session_closed" };
    }
    ctx.bytesIn += bytes;
    ctx.lastActivity = Date.now();
    this.touchSession(sessionId);
    this.logger.info({ sessionId, bytes, component: "session_manager" }, "session input forwarded (direct)");
    return { ok: true };
  }

  resize(sessionId: string, socket: WebSocket, rows: number, cols: number): { ok: boolean; error?: string } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return { ok: false, error: "session not found" };
    }
    if (ctx.writer !== socket) {
      return { ok: false, error: "not_writer" };
    }
    const payload = {
      proto: PROTO_VERSION,
      type: "session_resize",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      rows,
      cols
    };
    if (!sendFrameToBud(ctx.budId, payload)) {
      return { ok: false, error: "session_closed" };
    }
    this.touchSession(sessionId);
    return { ok: true };
  }

  close(sessionId: string): boolean {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return false;
    }
    const payload = {
      proto: PROTO_VERSION,
      type: "session_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      reason: "user_request"
    };
    return sendFrameToBud(ctx.budId, payload);
  }

  takeWriter(sessionId: string): { ok: boolean; error?: string; attachToken?: string } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return { ok: false, error: "session not found" };
    }
    ctx.attachToken = `sess_att_${ulid()}`;
    if (ctx.writer) {
      try {
        ctx.writer.close(4401, "writer transfer");
      } catch {
        /* noop */
      }
      ctx.writer = null;
      this.emitWriter(sessionId, false);
    }
    return { ok: true, attachToken: ctx.attachToken };
  }

  private detachSocket(sessionId: string, socket: WebSocket) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    if (ctx.writer === socket) {
      ctx.writer = null;
      this.emitWriter(sessionId, false);
    }
    if (ctx.spectators.has(socket)) {
      ctx.spectators.delete(socket);
    }
  }

  private closeAllSockets(ctx: SessionContext) {
    if (ctx.writer) {
      try {
        ctx.writer.close();
      } catch {
        /* noop */
      }
      ctx.writer = null;
      this.emitWriter(ctx.sessionId, false);
    }
    for (const socket of ctx.spectators) {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    }
    ctx.spectators.clear();
  }

  private broadcast(ctx: SessionContext, message: BrowserMessage) {
    if (ctx.writer) {
      this.broadcastToSocket(ctx.writer, message);
    }
    for (const socket of ctx.spectators) {
      this.broadcastToSocket(socket, message);
    }
  }

  private sendStatus(socket: WebSocket, status: string, role: "writer" | "spectator", truncated: boolean) {
    this.broadcastToSocket(socket, {
      type: "status",
      status,
      role,
      truncated
    });
  }

  private touchSession(sessionId: string) {
    void this.dbClient
      .update(sessionTable)
      .set({ lastActivityAt: new Date() })
      .where(eq(sessionTable.sessionId, sessionId))
      .catch((err) => {
        this.logger.warn({ err, sessionId, component: "session_manager" }, "Failed to update session activity");
      });
  }

  private emitStatus(sessionId: string, status: string, extra?: Record<string, unknown>) {
    this.events.emit(sessionId, {
      event: "session.status",
      data: { session_id: sessionId, status, ...(extra ?? {}) },
      id: ulid()
    });
  }

  private emitFinal(
    sessionId: string,
    status: string,
    payload: {
      exit_code: number | null;
      signal: string | null;
      canceled: boolean;
      bytes_out: number;
      bytes_in: number;
      error?: string | null;
    }
  ) {
    this.events.emit(sessionId, {
      event: "session.final",
      data: { session_id: sessionId, status, ...payload },
      id: ulid()
    });
  }

  private emitWriter(sessionId: string, writerPresent: boolean) {
    this.events.emit(sessionId, {
      event: "session.writer_changed",
      data: { session_id: sessionId, writer_present: writerPresent },
      id: ulid()
    });
  }

  private broadcastToSocket(socket: WebSocket, message: BrowserMessage) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      this.logger.warn({ err, component: "session_manager" }, "Failed to send session message");
    }
  }
}

function defaultSessionCommand() {
  return "/bin/bash -l";
}
