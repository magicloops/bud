import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  budTable,
  messageTable,
  runLogTable,
  runStepTable,
  runSummaryTable,
  runTable,
  threadTable
} from "../db/schema.js";
import { AgentService } from "../agent/index.js";
import { RunManager } from "../runtime/run-manager.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { and, asc, desc, eq, lt, isNull } from "drizzle-orm";
import { SessionManager } from "../runtime/session-manager.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { TerminalEventBus } from "../runtime/event-bus.js";
import { getActiveBudIds } from "../ws/gateway.js";

const CreateThreadSchema = z.object({
  bud_id: z.string().min(1),
  title: z.string().optional()
});

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  cwd: z.string().optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional()
});

const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});

const ThreadListQuerySchema = z.object({
  bud_id: z.string().optional()
});

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

const RunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  cursor: z.string().optional()
});

const TerminalEnsureBodySchema = z
  .object({
    shell: z.string().optional(),
    cwd: z.string().optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  .partial();

const TerminalResizeBodySchema = z.object({
  cols: z.number().int().positive().min(1).max(500),
  rows: z.number().int().positive().min(1).max(200)
});

const TerminalInputBodySchema = z.object({
  input: z.string().min(1)
});

const RUN_TAIL_MAX_BYTES = 16 * 1024;
const RUN_TAIL_MAX_ROWS = 400;

async function readRunTail(
  runId: string,
  stream: "stdout" | "stderr",
  maxBytes = RUN_TAIL_MAX_BYTES
): Promise<{ text: string; bytes: number }> {
  const rows = await db
    .select({
      seq: runLogTable.seq,
      data: runLogTable.data
    })
    .from(runLogTable)
    .where(and(eq(runLogTable.runId, runId), eq(runLogTable.stream, stream)))
    .orderBy(desc(runLogTable.seq))
    .limit(RUN_TAIL_MAX_ROWS);

  if (rows.length === 0) {
    return { text: "", bytes: 0 };
  }

  let remaining = maxBytes;
  const buffers: Buffer[] = [];
  let collected = 0;

  for (const row of rows) {
    if (remaining <= 0) break;
    const buf = Buffer.from(row.data);
    if (buf.length > remaining) {
      buffers.push(buf.subarray(buf.length - remaining));
      collected += remaining;
      remaining = 0;
    } else {
      buffers.push(buf);
      collected += buf.length;
      remaining -= buf.length;
    }
  }

  buffers.reverse();
  const text = Buffer.concat(buffers).toString("utf-8");
  return { text, bytes: collected };
}

function serializeThread(row: typeof threadTable.$inferSelect) {
  return {
    thread_id: row.threadId,
    bud_id: row.budId,
    title: row.title,
    created_at: row.createdAt,
    last_activity_at: row.lastActivityAt,
    last_message_preview: row.lastMessagePreview,
    message_count: row.messageCount,
    pinned: row.pinned,
    archived: row.archived
  };
}

function serializeMessage(row: typeof messageTable.$inferSelect) {
  return {
    message_id: row.messageId,
    role: row.role,
    display_role: row.displayRole ?? row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    created_at: row.createdAt
  };
}

export async function registerThreadRoutes(
  server: FastifyInstance,
  _runManager: RunManager,
  agentService: AgentService,
  sessionManager: SessionManager
): Promise<void> {
  server.get("/api/threads", async (request) => {
    const query = ThreadListQuerySchema.parse(request.query ?? {});
    const threads = await db
      .select()
      .from(threadTable)
      .where(query.bud_id ? eq(threadTable.budId, query.bud_id) : undefined)
      .orderBy(desc(threadTable.lastActivityAt));
    return threads.map(serializeThread);
  });

  server.post("/api/threads", async (request, reply) => {
    const body = CreateThreadSchema.parse(request.body ?? {});
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, body.bud_id)
    });
    if (!bud) {
      reply.code(404).send({ error: "bud not found" });
      return;
    }

    const [thread] = await db
      .insert(threadTable)
      .values({
        budId: body.bud_id,
        title: body.title ?? null
      })
      .returning({ threadId: threadTable.threadId });

    reply.code(201).send({ threadId: thread.threadId });
  });

  server.get("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }
    reply.send(serializeThread(thread));
  });

  server.post("/api/threads/:threadId/session", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    try {
      const ensured = await sessionManager.ensureThreadSession(params.threadId);
      reply.send({ session_id: ensured.sessionId, attach_token: ensured.attachToken });
    } catch (err) {
      server.log.error({ err, threadId: params.threadId }, "Failed to ensure session for thread");
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  server.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = MessagesQuerySchema.parse(request.query ?? {});
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }
    const rows = await db
      .select()
      .from(messageTable)
      .where(eq(messageTable.threadId, thread.threadId))
      .orderBy(desc(messageTable.createdAt))
      .limit(query.limit);
    reply.send(rows.map(serializeMessage));
  });

  server.get("/api/threads/:threadId/runs", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = RunsQuerySchema.parse(request.query ?? {});

    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }

    let cursorDate: Date | null = null;
    if (query.cursor) {
      const parsed = new Date(query.cursor);
      if (!Number.isNaN(parsed.getTime())) {
        cursorDate = parsed;
      }
    }

    const rows = await db
      .select({
        run: runTable,
        summary: runSummaryTable,
        firstStep: runStepTable
      })
      .from(runTable)
      .leftJoin(runSummaryTable, eq(runSummaryTable.runId, runTable.runId))
      .leftJoin(
        runStepTable,
        and(eq(runStepTable.runId, runTable.runId), eq(runStepTable.idx, 0))
      )
      .where(
        and(
          eq(runTable.threadId, thread.threadId),
          cursorDate ? lt(runTable.startedAt, cursorDate) : undefined
        )
      )
      .orderBy(desc(runTable.startedAt))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const slice = rows.slice(0, query.limit);

    const runs = await Promise.all(
      slice.map(async ({ run, summary, firstStep }) => {
        const args = (firstStep?.argsJson ?? {}) as Record<string, unknown>;
        const command =
          typeof args?.cmd === "string" && args.cmd.length > 0 ? (args.cmd as string) : null;
        const stepCwd =
          typeof args?.cwd === "string" && args.cwd.length > 0 ? (args.cwd as string) : null;
        const stdoutTail = await readRunTail(run.runId, "stdout");
        const stderrTail = await readRunTail(run.runId, "stderr");
        const stdoutBytes = summary?.stdoutBytes ?? stdoutTail.bytes;
        const stderrBytes = summary?.stderrBytes ?? stderrTail.bytes;
        return {
          run_id: run.runId,
          status: run.status,
          exit_code: summary?.exitCode ?? null,
          started_at: run.startedAt ? run.startedAt.toISOString() : null,
          finished_at: run.finishedAt ? run.finishedAt.toISOString() : null,
          cwd: run.workspacePath ?? stepCwd ?? null,
          error: run.error ?? null,
          command,
          stdout: stdoutTail.text,
          stderr: stderrTail.text,
          stdout_truncated: stdoutBytes > stdoutTail.bytes,
          stderr_truncated: stderrBytes > stderrTail.bytes,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes
        };
      })
    );

    const nextCursor =
      hasMore && rows[query.limit]?.run.startedAt
        ? rows[query.limit]?.run.startedAt?.toISOString()
        : null;

    reply.send({
      runs,
      next_cursor: nextCursor
    });
  });

  server.post("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = CreateMessageSchema.parse(request.body ?? {});

    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }

    const metadata: Record<string, unknown> = body.cwd ? { preferred_cwd: body.cwd } : {};
    const [message] = await db
      .insert(messageTable)
      .values({
        threadId: thread.threadId,
        role: "user",
        displayRole: "User",
        content: body.text,
        metadata
      })
      .returning({ messageId: messageTable.messageId });
    await recordThreadMessageMetadata(thread.threadId, body.text);

    try {
      const { sessionId } = await agentService.startUserMessage(thread.threadId, {
        reasoningEffort: body.reasoning_effort ?? null
      });
      reply.code(201).send({ messageId: message.messageId, sessionId });
    } catch (err) {
      server.log.error({ err }, "Agent failed to queue message");
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  server.post("/api/threads/:threadId/cancel", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, params.threadId)
    });
    if (!thread) {
      reply.code(404).send({ error: "thread not found" });
      return;
    }
    agentService.cancelThread(thread.threadId);
    reply.send({ ok: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread Terminal Routes
// ─────────────────────────────────────────────────────────────────────────────

export async function registerThreadTerminalRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager,
  terminalEvents: TerminalEventBus
): Promise<void> {
  // POST /api/threads/:threadId/terminal - Create/ensure terminal session
  server.post("/api/threads/:threadId/terminal", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const body = TerminalEnsureBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body" });
    }

    // Get thread to find budId
    const thread = await db.query.threadTable.findFirst({
      where: and(
        eq(threadTable.threadId, params.threadId),
        isNull(threadTable.deletedAt)
      )
    });
    if (!thread) {
      return reply.code(404).send({ error: "thread_not_found" });
    }

    // Get or create session
    let session = await terminalSessionManager.getSessionForThread(params.threadId);
    const created = !session;

    if (!session) {
      const sessionId = await terminalSessionManager.createSessionForThread(
        params.threadId,
        thread.budId
      );
      session = await terminalSessionManager.getSessionForThread(params.threadId);
    }

    if (!session) {
      return reply.code(500).send({ error: "session_create_failed" });
    }

    // Ensure running on Bud
    const { ok, resumed, error } = await terminalSessionManager.ensureSession(session.sessionId);
    if (!ok) {
      return reply.code(503).send({ error: error ?? "terminal_unavailable" });
    }

    return {
      session_id: session.sessionId,
      bud_id: session.budId,
      state: session.state,
      created,
      resumed
    };
  });

  // GET /api/threads/:threadId/terminal - Get session info
  server.get("/api/threads/:threadId/terminal", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);

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

  // GET /api/threads/:threadId/terminal/stream - SSE output stream
  server.get("/api/threads/:threadId/terminal/stream", (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);

    // Look up session synchronously isn't possible, so we need to handle this async
    // but still use the reply.sse() pattern for proper flushing
    void (async () => {
      const session = await terminalSessionManager.getSessionForThread(params.threadId);
      if (!session) {
        reply.code(404).send({ error: "no_terminal_session" });
        return;
      }

      // Subscribe to session events using the event bus
      const detach = terminalEvents.attach(session.sessionId, reply);

      // Send periodic heartbeat to keep connection alive
      const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
      const heartbeatInterval = setInterval(() => {
        try {
          reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, heartbeatMs);

      // Cleanup on close
      reply.raw.on("close", () => {
        clearInterval(heartbeatInterval);
        detach();
      });
    })();
  });

  // POST /api/threads/:threadId/terminal/input - Send input
  server.post("/api/threads/:threadId/terminal/input", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
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
      { source: "user" }
    );

    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  // POST /api/threads/:threadId/terminal/interrupt - Send Ctrl+C
  server.post("/api/threads/:threadId/terminal/interrupt", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);

    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (!session) {
      return reply.code(404).send({ error: "no_terminal_session" });
    }

    const result = await terminalSessionManager.sendInterrupt(session.sessionId);
    if (!result.ok) {
      return reply.code(503).send({ error: result.error ?? "terminal_unavailable" });
    }

    return { ok: true };
  });

  // POST /api/threads/:threadId/terminal/resize - Resize terminal
  server.post("/api/threads/:threadId/terminal/resize", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
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

  // GET /api/threads/:threadId/terminal/history - Get output history
  server.get("/api/threads/:threadId/terminal/history", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = request.query as { bytes?: string; sinceOffset?: string };
    const maxBytes = Math.max(parseInt(query.bytes ?? "4096", 10) || 4096, 0);
    const sinceOffset = query.sinceOffset ? parseInt(query.sinceOffset, 10) : undefined;

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

  // DELETE /api/threads/:threadId - Soft delete thread
  server.delete("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);

    const thread = await db.query.threadTable.findFirst({
      where: and(
        eq(threadTable.threadId, params.threadId),
        isNull(threadTable.deletedAt)
      )
    });
    if (!thread) {
      return reply.code(404).send({ error: "thread_not_found" });
    }

    // Check for active session
    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (session && session.state !== "closed") {
      // Check if bud is online
      const activeBuds = getActiveBudIds();
      if (!activeBuds.includes(thread.budId)) {
        return reply.code(409).send({
          error: "session_active_bud_offline",
          message:
            "Cannot delete thread: terminal session is active but Bud is offline. Wait for Bud to reconnect or try again later."
        });
      }

      // Close the session
      await terminalSessionManager.closeSession(session.sessionId, "thread_deleted");
    }

    // Soft delete thread
    await db
      .update(threadTable)
      .set({ deletedAt: new Date() })
      .where(eq(threadTable.threadId, params.threadId));

    return { ok: true, deleted_at: new Date().toISOString() };
  });
}
