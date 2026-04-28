import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import type { TerminalEventBus } from "../../runtime/event-bus.js";
import type { TerminalSessionManager } from "../../runtime/terminal-session-manager.js";
import {
  StreamResumeQuerySchema,
  TerminalInputBodySchema,
  TerminalResizeBodySchema,
  ThreadParamsSchema,
  readLastEventId,
  requireAuthorizedThreadAccess,
} from "./shared.js";

export async function registerThreadTerminalRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager,
  terminalEvents: TerminalEventBus
): Promise<void> {
  server.post("/api/threads/:threadId/terminal", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const ensured = await terminalSessionManager.ensureSessionRecordForThread(
      params.threadId,
      thread.budId,
      thread.createdByUserId ?? viewer.userId,
    );
    const session = ensured.session;

    return {
      session_id: session.sessionId,
      bud_id: session.budId,
      state: session.state,
      created: ensured.created
    };
  });

  server.post("/api/threads/:threadId/terminal/ensure", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const { ok, resumed, error } = await terminalSessionManager.ensureSession(session.sessionId);
    if (!ok) {
      return reply.code(503).send({
        error: error ?? "terminal_unavailable",
        session_id: session.sessionId,
        bud_id: session.budId
      });
    }

    return {
      ok: true,
      session_id: session.sessionId,
      bud_id: session.budId,
      state: session.state,
      resumed
    };
  });

  server.get("/api/threads/:threadId/terminal", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    return {
      session_id: session.sessionId,
      thread_id: session.threadId,
      bud_id: session.budId,
      state: session.state,
      cols: session.cols,
      rows: session.rows,
      created_at: session.createdAt?.toISOString(),
      started_at: session.startedAt?.toISOString(),
      last_activity_at: session.lastActivityAt?.toISOString()
    };
  });

  server.get("/api/threads/:threadId/terminal/stream", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = StreamResumeQuerySchema.parse(request.query ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      reply.code(404).send({ error: "no_terminal_session" });
      return;
    }

    const detach = terminalEvents.attach(session.sessionId, reply, {
      lastEventId: readLastEventId(request, query.last_event_id),
    });

    const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
    const heartbeatInterval = setInterval(() => {
      try {
        reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, heartbeatMs);

    reply.raw.on("close", () => {
      clearInterval(heartbeatInterval);
      detach();
    });
  });

  server.post("/api/threads/:threadId/terminal/input", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { viewer } = access;
    const body = TerminalInputBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "input_required" });
    }

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await terminalSessionManager.sendInput(
      session.sessionId,
      Buffer.from(body.data.input, "utf-8"),
      { source: "user", userId: viewer.userId }
    );

    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  server.post("/api/threads/:threadId/terminal/interrupt", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const result = await terminalSessionManager.interruptThreadTerminal(params.threadId);
    if (!result.ok) {
      const status = result.error === "no_terminal_session" ? 404 : 503;
      return reply.code(status).send({ error: result.error ?? "terminal_interrupt_failed" });
    }

    return {
      ok: true,
      session_id: result.sessionId,
      submitted: result.submitted === true,
      rejected_pending_requests: result.rejectedPendingRequests ?? 0,
    };
  });

  server.post("/api/threads/:threadId/terminal/resize", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const body = TerminalResizeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", details: body.error.message });
    }

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await terminalSessionManager.sendResize(
      session.sessionId,
      body.data.cols,
      body.data.rows
    );
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  server.get("/api/threads/:threadId/terminal/history", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const query = request.query as { bytes?: string; since_offset?: string };
    const maxBytes = Math.max(parseInt(query.bytes ?? "4096", 10) || 4096, 0);
    const sinceOffset = query.since_offset ? parseInt(query.since_offset, 10) : undefined;

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const { data, totalBytes } = await terminalSessionManager.tailOutput(
      session.sessionId,
      maxBytes,
      { sinceOffset }
    );

    return {
      session_id: session.sessionId,
      bytes: data.length,
      total_bytes_available: totalBytes,
      data_base64: data.toString("base64")
    };
  });
}
