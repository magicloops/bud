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

    // Proto 0.3 resume contract (§6.7.7): the terminal stream's Last-Event-ID
    // is the stringified byte offset the client last APPLIED. Output events
    // carry `id: String(byte_offset + bytes.length)`; non-output events carry
    // no SSE id so the browser cursor always remains an output offset. On
    // resume we replay stored output from that offset before attaching live.
    const lastEventId = readLastEventId(request, query.last_event_id);
    const resumeOffset = parseOffsetEventId(lastEventId);

    let detach: () => void;
    const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
    const heartbeatInterval = setInterval(() => {
      try {
        reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, heartbeatMs);

    if (resumeOffset === null) {
      detach = terminalEvents.attach(session.sessionId, reply, { lastEventId });
    } else {
      let forwardedEnd = resumeOffset;
      const sendEvent = (evt: { event: string; data: Record<string, unknown>; id?: string }) => {
        if (evt.event === "terminal.output") {
          const chunkStart = typeof evt.data.byte_offset === "number" ? evt.data.byte_offset : null;
          if (chunkStart === null || chunkStart < forwardedEnd) {
            return; // Already served by the durable replay (or older).
          }
          const chunkBytes =
            typeof evt.data.data === "string" ? Buffer.from(evt.data.data, "base64").length : 0;
          forwardedEnd = chunkStart + chunkBytes;
        }
        reply.sse({ event: evt.event, data: JSON.stringify(evt.data), id: evt.id });
      };

      // Attach BEFORE the durable read so nothing emitted mid-replay is lost;
      // queue live events until the replay finishes, then flush with the
      // offset dedupe above.
      const queued: Array<{ event: string; data: Record<string, unknown>; id?: string }> = [];
      let replaying = true;
      detach = terminalEvents.attachCallback(
        session.sessionId,
        (evt) => {
          if (replaying) {
            queued.push(evt);
            return;
          }
          sendEvent(evt);
        },
        { replay: false },
      );

      try {
        // Prime the SSE response so headers flush even when nothing replays.
        reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now(), resume_offset: resumeOffset }) });

        let cursor = resumeOffset;
        for (;;) {
          const read = await terminalSessionManager.readOutputRange(session.sessionId, {
            startOffset: cursor,
            maxBytes: 256 * 1024,
          });
          if (read.data.length > 0) {
            reply.sse({
              event: "terminal.output",
              data: JSON.stringify({
                data: read.data.toString("base64"),
                byte_offset: read.startOffset,
              }),
              id: String(read.endOffset),
            });
            forwardedEnd = Math.max(forwardedEnd, read.endOffset);
          }
          if (!read.truncated || read.nextOffset === null) {
            break;
          }
          cursor = read.nextOffset;
        }
      } catch (err) {
        request.log.warn(
          { err, sessionId: session.sessionId, resumeOffset, component: "terminal_stream" },
          "Terminal stream offset replay failed",
        );
      } finally {
        replaying = false;
        for (const evt of queued) {
          sendEvent(evt);
        }
      }
    }

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
      submitted: result.dispatched === true,
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

    if (sinceOffset !== undefined && Number.isFinite(sinceOffset)) {
      const read = await terminalSessionManager.readOutputRange(session.sessionId, {
        startOffset: Math.max(sinceOffset, 0),
        maxBytes,
      });
      const totalBytes = await terminalSessionManager.getStoredOutputBytes(session.sessionId);
      return {
        session_id: session.sessionId,
        bytes: read.data.length,
        start_offset: read.startOffset,
        end_offset: read.endOffset,
        truncated: read.truncated,
        next_offset: read.nextOffset,
        total_bytes_available: totalBytes,
        data_base64: read.data.toString("base64")
      };
    }

    const tail = await terminalSessionManager.tailOutput(session.sessionId, maxBytes);
    return {
      session_id: session.sessionId,
      bytes: tail.data.length,
      start_offset: tail.startOffset,
      end_offset: tail.endOffset,
      truncated: false,
      next_offset: null,
      total_bytes_available: tail.totalBytesStored,
      data_base64: tail.data.toString("base64")
    };
  });
}

function parseOffsetEventId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
