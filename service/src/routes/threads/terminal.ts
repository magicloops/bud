import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TerminalEventBus } from "../../runtime/event-bus.js";
import type { TerminalSessionManager } from "../../runtime/terminal-session-manager.js";
import {
  TerminalInputBodySchema,
  TerminalResizeBodySchema,
  ThreadParamsSchema,
  readLastEventId,
  requireAuthorizedThreadAccess,
} from "./shared.js";

const SNAPSHOT_DEFAULT_LINES = 1000;
const SNAPSHOT_MAX_LINES = 2000;

const TerminalSnapshotQuerySchema = z.object({
  lines: z.coerce.number().int().positive().optional(),
});

// Terminal stream resume cursors: `from_offset` is the query-param alternative
// to the SSE `Last-Event-ID` header (browsers cannot set the header on the
// first EventSource connect). Both are the byte offset the client last
// applied. When BOTH are present the HIGHER numeric cursor wins: a native
// EventSource auto-reconnect reuses the original URL (with a now-stale
// `from_offset`) while also sending a fresher `Last-Event-ID` — letting the
// stale query param win would replay already-rendered output on every
// auto-reconnect.
const TerminalStreamResumeQuerySchema = z.object({
  last_event_id: z.string().min(1).optional(),
  from_offset: z.string().min(1).optional(),
  // `grid=1` opts this SSE connection into grid-sync (proto §6.8): the
  // connection is registered as a grid viewer for its lifetime, which arms
  // daemon-side `terminal_grid` emission (refcounted across connections).
  grid: z.string().optional(),
});

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

  // Line-oriented terminal snapshot served from the daemon emulator's grid
  // (Phase 3 §3.1): scrollback history plus the rendered screen, with the
  // stream watermark to resume the SSE stream from. Replaces the byte-tail
  // history replay for initial render (raw byte tails render ~no lines after
  // TUI-heavy sessions).
  server.get("/api/threads/:threadId/terminal/snapshot", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const query = TerminalSnapshotQuerySchema.safeParse(request.query ?? {});
    const lines = Math.min(query.success ? query.data.lines ?? SNAPSHOT_DEFAULT_LINES : SNAPSHOT_DEFAULT_LINES, SNAPSHOT_MAX_LINES);

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    if (!terminalSessionManager.isBudOnline(session.budId)) {
      return reply.code(503).send({ error: "bud_offline" });
    }

    // Two observes on the same session: history (scrollback text) first, then
    // screen (rendered grid). ring_next_offset is taken from the SCREEN
    // observe — the later watermark — so a client that resumes the stream
    // from it sees no duplicated output. Accepted race: a line that scrolls
    // off between the two observes appears in neither history_text nor
    // screen_text and is lost from the snapshot only (the durable output
    // stream still has its bytes).
    let history: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
    let screen: Awaited<ReturnType<TerminalSessionManager["observeTerminal"]>>;
    try {
      history = await terminalSessionManager.observeTerminal(session.sessionId, {
        view: "history",
        lines,
      });
      screen = await terminalSessionManager.observeTerminal(session.sessionId, {
        view: "screen",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "observe_failed";
      if (message === "bud_offline") {
        return reply.code(503).send({ error: "bud_offline" });
      }
      request.log.warn(
        { err, sessionId: session.sessionId, component: "terminal_snapshot" },
        "Terminal snapshot observe failed",
      );
      return reply.code(502).send({ error: "observe_failed" });
    }

    const context = terminalSessionManager.getSessionContext(session.sessionId);
    return {
      session_id: session.sessionId,
      mode: screen.mode ?? context.mode,
      integration: screen.integration ?? context.integration,
      alt_screen: screen.altScreen ?? false,
      history_text: history.output,
      screen_text: screen.output,
      // ANSI-serialized screen (SGR runs + cursor position) when the daemon
      // provides it: rendering this instead of screen_text preserves
      // colors/styles/cursor — reloading into a colorful TUI looks right.
      ...(screen.outputAnsi !== undefined ? { screen_ansi: screen.outputAnsi } : {}),
      cols: session.cols,
      rows: session.rows,
      // Older daemons may omit ring_next_offset on observe results; fall back
      // to the service's durable stream watermark so resume stays possible.
      ring_next_offset: screen.ringNextOffset ?? terminalSessionManager.getLastOffset(session.sessionId),
    };
  });

  server.get("/api/threads/:threadId/terminal/stream", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = TerminalStreamResumeQuerySchema.parse(request.query ?? {});
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
    // `?from_offset=<n>` carries the same cursor via the query string for
    // first connects (e.g. resuming from a snapshot's ring_next_offset) where
    // the browser cannot set the Last-Event-ID header. Highest cursor wins
    // (see the schema comment above).
    const lastEventId = maxResumeCursor(
      query.from_offset ?? null,
      readLastEventId(request, query.last_event_id)
    );
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

    const gridViewer = query.grid === "1";
    if (gridViewer) {
      // Grid connections attach live-only: their state rebuilds from the
      // watch re-arm's full frame, buffered output is ignored for rendering,
      // and replayed stale status/presence noise would only mislead them.
      reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now(), grid: true }) });
      detach = terminalEvents.attachCallback(
        session.sessionId,
        (evt) => {
          reply.sse({ event: evt.event, data: JSON.stringify(evt.data), id: evt.id });
        },
        { replay: false },
      );
    } else if (resumeOffset === null) {
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

    // Grid viewer registration AFTER the listener is attached, so the
    // watch-enable's immediate full frame is never missed.
    if (gridViewer) {
      void terminalSessionManager.addGridViewer(session.sessionId);
    }

    reply.raw.on("close", () => {
      clearInterval(heartbeatInterval);
      detach();
      if (gridViewer) {
        void terminalSessionManager.removeGridViewer(session.sessionId);
      }
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

/** Highest numeric cursor wins; a lone non-numeric value passes through. */
function maxResumeCursor(a: string | null, b: string | null): string | null {
  const na = a !== null && /^\d+$/.test(a) ? Number(a) : null;
  const nb = b !== null && /^\d+$/.test(b) ? Number(b) : null;
  if (na === null && nb === null) return a ?? b;
  if (na === null) return String(nb);
  if (nb === null) return String(na);
  return String(Math.max(na, nb));
}

function parseOffsetEventId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
