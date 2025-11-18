import type WebSocket from "ws";
import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/client.js";
import {
  budTable,
  sessionLogTable,
  sessionTable,
  threadTable
} from "../db/schema.js";
import { PROTO_VERSION, config } from "../config.js";
import { eq } from "drizzle-orm";
import { sendFrameToBud } from "../ws/gateway.js";

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
  | { type: "status"; status: string; exit_code?: number | null; error?: string | null };

type SessionContext = {
  sessionId: string;
  budId: string;
  threadId: string;
  backend: SessionBackend;
  attachToken: string;
  status: "opening" | "open" | "closed" | "failed";
  clients: Set<WebSocket>;
  logsBytes: number;
  logTruncated: boolean;
  bytesOut: number;
};

export class SessionManager {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly logLimit: number;

  constructor(private readonly logger: FastifyBaseLogger) {
    this.logLimit = config.runLogMaxBytes;
  }

  async createSession(options: SessionCreateOptions): Promise<{ sessionId: string; attachToken: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, options.threadId)
    });
    if (!thread) {
      throw new Error("thread not found");
    }
    if (thread.budId !== options.budId) {
      throw new Error("thread does not belong to bud");
    }
    const bud = await db.query.budTable.findFirst({
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

    await db.insert(sessionTable).values({
      sessionId,
      budId: options.budId,
      threadId: options.threadId,
      backend,
      status: "opening",
      startedAt: now,
      hardTtlSec: 12 * 60 * 60,
      idleKillSec: 20 * 60
    });

    this.sessions.set(sessionId, {
      sessionId,
      budId: options.budId,
      threadId: options.threadId,
      backend,
      attachToken,
      status: "opening",
      clients: new Set(),
      logsBytes: 0,
      logTruncated: false,
      bytesOut: 0
    });

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
      await db
        .update(sessionTable)
        .set({ status: "failed", finishedAt: new Date(), error: "BUD_OFFLINE" })
        .where(eq(sessionTable.sessionId, sessionId));
      throw new Error("bud disconnected");
    }

    return { sessionId, attachToken };
  }

  async handleSessionOpened(payload: { session_id: string; backend: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    if (!ctx) return;
    ctx.status = "open";
    await db
      .update(sessionTable)
      .set({ status: "open" })
      .where(eq(sessionTable.sessionId, payload.session_id));
    this.broadcast(ctx, { type: "status", status: "open" });
  }

  async handleSessionOutput(payload: { session_id: string; seq: number; data: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    if (!ctx) return;
    const buffer = Buffer.from(payload.data, "base64");
    const remaining = Math.max(this.logLimit - ctx.logsBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
    if (toStore.length > 0) {
      await db
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
      await db
        .update(sessionTable)
        .set({
          logsBytes: ctx.logsBytes,
          logTruncated: ctx.logsBytes >= this.logLimit,
          bytesOut: ctx.bytesOut + buffer.length
        })
        .where(eq(sessionTable.sessionId, payload.session_id));
      if (ctx.logsBytes >= this.logLimit) {
        ctx.logTruncated = true;
      }
    }
    ctx.bytesOut += buffer.length;
    this.broadcast(ctx, { type: "output", data: payload.data });
  }

  async handleSessionClosed(payload: {
    session_id: string;
    exit_code: number | null | undefined;
    signal?: string | null;
    canceled?: boolean;
  }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    await db
      .update(sessionTable)
      .set({
        status: payload.canceled ? "closed" : "closed",
        finishedAt: new Date(),
        exitCode: payload.exit_code ?? null,
        signal: payload.signal ?? null
      })
      .where(eq(sessionTable.sessionId, payload.session_id));
    if (ctx) {
      ctx.status = "closed";
      this.broadcast(ctx, {
        type: "status",
        status: "closed",
        exit_code: payload.exit_code ?? null
      });
      this.sessions.delete(payload.session_id);
    }
  }

  async handleSessionError(payload: { session_id: string; code: string; message: string }): Promise<void> {
    const ctx = this.sessions.get(payload.session_id);
    await db
      .update(sessionTable)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: payload.code
      })
      .where(eq(sessionTable.sessionId, payload.session_id));
    if (ctx) {
      ctx.status = "failed";
      this.broadcast(ctx, {
        type: "status",
        status: "failed",
        error: payload.message
      });
      this.sessions.delete(payload.session_id);
    }
  }

  attachClient(sessionId: string, token: string, socket: WebSocket): { ok: boolean; error?: string } {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return { ok: false, error: "session not found" };
    }
    if (ctx.attachToken !== token) {
      return { ok: false, error: "invalid attach token" };
    }
    ctx.clients.add(socket);
    socket.on("close", () => {
      ctx.clients.delete(socket);
    });
    this.broadcastToSocket(socket, { type: "status", status: ctx.status });
    return { ok: true };
  }

  sendInput(sessionId: string, dataB64: string): boolean {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return false;
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
    return sendFrameToBud(ctx.budId, payload);
  }

  resize(sessionId: string, rows: number, cols: number): boolean {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) {
      return false;
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
    return sendFrameToBud(ctx.budId, payload);
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

  private broadcast(ctx: SessionContext, message: BrowserMessage) {
    for (const client of ctx.clients) {
      this.broadcastToSocket(client, message);
    }
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
