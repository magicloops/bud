import { Buffer } from "node:buffer";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  messageTable,
  runLogTable,
  runStepTable,
  runSummaryTable,
  runTable,
  threadTable,
  terminalSessionTable
} from "../db/schema.js";
import { AgentService, ThreadTitleService } from "../agent/index.js";
import { RunManager } from "../runtime/run-manager.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import type { TerminalEventBus } from "../runtime/event-bus.js";
import type { ContextSyncService } from "../terminal/context-sync-service.js";
import { getActiveBudIds } from "../ws/gateway.js";
import { getAuthorizedBud, getAuthorizedThread, requireViewer } from "../auth/session.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";

const CreateThreadSchema = z.object({
  bud_id: z.string().min(1),
  title: z.string().optional()
});

const CreateMessageSchema = z.object({
  text: z.string().min(1),
  client_id: z.string().uuid().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  reasoning_effort: z.enum(["none", "low", "medium", "high"]).optional()
});

const ThreadParamsSchema = z.object({
  threadId: z.string().uuid()
});

const ThreadListQuerySchema = z.object({
  bud_id: z.string().optional()
});

const StreamResumeQuerySchema = z.object({
  after: z.string().min(1).optional(),
  last_event_id: z.string().min(1).optional(),
}).refine((value) => !(value.after && value.last_event_id), {
  message: "after and last_event_id cannot both be set",
});

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
}).refine((value) => !(value.before && value.after), {
  message: "before and after cannot both be set",
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
    client_id: row.clientId,
    role: row.role,
    display_role: row.displayRole ?? row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    created_at: row.createdAt
  };
}

const MessageCursorSchema = z.object({
  created_at: z.string(),
  message_id: z.string().uuid(),
});

type MessageCursor = {
  createdAt: Date;
  messageId: string;
};

function encodeMessageCursor(row: Pick<typeof messageTable.$inferSelect, "createdAt" | "messageId">) {
  return Buffer.from(
    JSON.stringify({
      created_at: row.createdAt.toISOString(),
      message_id: row.messageId,
    }),
    "utf-8",
  ).toString("base64url");
}

function decodeMessageCursor(value: string): MessageCursor | null {
  try {
    const parsed = MessageCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf-8")),
    );
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return {
      createdAt,
      messageId: parsed.message_id,
    };
  } catch {
    return null;
  }
}

function olderThanMessageCursor(cursor: MessageCursor) {
  return or(
    lt(messageTable.createdAt, cursor.createdAt),
    and(eq(messageTable.createdAt, cursor.createdAt), lt(messageTable.messageId, cursor.messageId)),
  );
}

function newerThanMessageCursor(cursor: MessageCursor) {
  return or(
    gt(messageTable.createdAt, cursor.createdAt),
    and(eq(messageTable.createdAt, cursor.createdAt), gt(messageTable.messageId, cursor.messageId)),
  );
}

async function requireAuthorizedThreadAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  threadId: string,
) {
  const viewer = await requireViewer(request, reply);
  if (!viewer) {
    return null;
  }

  const thread = await getAuthorizedThread(viewer, threadId);
  if (!thread) {
    reply.code(404).send({ error: "thread_not_found" });
    return null;
  }

  return { viewer, thread };
}

function readLastEventId(request: FastifyRequest, queryValue?: string) {
  if (queryValue) {
    return queryValue;
  }

  const header = request.headers["last-event-id"];
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }

  return typeof header === "string" && header.length > 0 ? header : null;
}

async function findOwnedUserMessageByClientId(
  threadId: string,
  userId: string,
  clientId: string,
): Promise<{ messageId: string } | null> {
  const [message] = await db
    .select({ messageId: messageTable.messageId })
    .from(messageTable)
    .where(
      and(
        eq(messageTable.threadId, threadId),
        eq(messageTable.createdByUserId, userId),
        eq(messageTable.role, "user"),
        eq(messageTable.clientId, clientId),
      ),
    )
    .limit(1);

  return message ?? null;
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export async function registerThreadRoutes(
  server: FastifyInstance,
  _runManager: RunManager,
  agentService: AgentService,
  agentRuntime: AgentRuntimeStateManager,
  contextSyncService: ContextSyncService,
  threadTitleService: ThreadTitleService,
): Promise<void> {
  server.get("/api/threads", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const query = ThreadListQuerySchema.parse(request.query ?? {});
    if (query.bud_id) {
      if (!(await getAuthorizedBud(viewer, query.bud_id))) {
        reply.code(404).send({ error: "bud_not_found" });
        return;
      }
    }

    const threads = await db
      .select({
        threadId: threadTable.threadId,
        budId: threadTable.budId,
        title: threadTable.title,
        createdAt: threadTable.createdAt,
        lastActivityAt: threadTable.lastActivityAt,
        lastMessagePreview: threadTable.lastMessagePreview,
        messageCount: threadTable.messageCount,
        pinned: threadTable.pinned,
        archived: threadTable.archived,
        sessionId: terminalSessionTable.sessionId,
        sessionState: terminalSessionTable.state
      })
      .from(threadTable)
      .leftJoin(
        terminalSessionTable,
        and(
          eq(threadTable.threadId, terminalSessionTable.threadId),
          eq(terminalSessionTable.createdByUserId, viewer.userId),
          isNull(terminalSessionTable.closedAt),
        ),
      )
      .where(
        and(
          eq(threadTable.createdByUserId, viewer.userId),
          isNull(threadTable.deletedAt),
          query.bud_id ? eq(threadTable.budId, query.bud_id) : undefined,
        ),
      )
      .orderBy(desc(threadTable.lastActivityAt));

    return threads.map((row) => ({
      thread_id: row.threadId,
      bud_id: row.budId,
      title: row.title,
      created_at: row.createdAt,
      last_activity_at: row.lastActivityAt,
      last_message_preview: row.lastMessagePreview,
      message_count: row.messageCount,
      pinned: row.pinned,
      archived: row.archived,
      has_terminal_session: row.sessionId !== null,
      session_state: row.sessionState,
      session_id: row.sessionId
    }));
  });

  server.post("/api/threads", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const body = CreateThreadSchema.parse(request.body ?? {});
    if (!(await getAuthorizedBud(viewer, body.bud_id))) {
      reply.code(404).send({ error: "bud_not_found" });
      return;
    }

    const [thread] = await db
      .insert(threadTable)
      .values({
        budId: body.bud_id,
        title: body.title ?? null,
        createdByUserId: viewer.userId,
      })
      .returning({ threadId: threadTable.threadId });

    reply.code(201).send({ thread_id: thread.threadId });
  });

  server.get("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }
    const { thread } = access;
    reply.send(serializeThread(thread));
  });

  server.get("/api/threads/:threadId/messages", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const parsedQuery = MessagesQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      reply.code(400).send({ error: "invalid_query", details: parsedQuery.error.message });
      return;
    }
    const query = parsedQuery.data;
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const beforeCursor = query.before ? decodeMessageCursor(query.before) : null;
    const afterCursor = query.after ? decodeMessageCursor(query.after) : null;

    if ((query.before && !beforeCursor) || (query.after && !afterCursor)) {
      reply.code(400).send({ error: "invalid_cursor" });
      return;
    }

    const fetchNewerWindow = Boolean(afterCursor);
    const rows = await db
      .select()
      .from(messageTable)
      .where(
        and(
          eq(messageTable.threadId, thread.threadId),
          eq(messageTable.createdByUserId, viewer.userId),
          beforeCursor ? olderThanMessageCursor(beforeCursor) : undefined,
          afterCursor ? newerThanMessageCursor(afterCursor) : undefined,
        ),
      )
      .orderBy(
        fetchNewerWindow ? asc(messageTable.createdAt) : desc(messageTable.createdAt),
        fetchNewerWindow ? asc(messageTable.messageId) : desc(messageTable.messageId),
      )
      .limit(query.limit + 1);

    const hasExtraRow = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const orderedRows = fetchNewerWindow ? pageRows : [...pageRows].reverse();
    const hasMoreBefore = afterCursor ? true : hasExtraRow;
    const hasMoreAfter = beforeCursor ? true : hasExtraRow && fetchNewerWindow;

    reply.send({
      messages: orderedRows.map(serializeMessage),
      page: {
        limit: query.limit,
        returned: orderedRows.length,
        has_more_before: hasMoreBefore,
        has_more_after: hasMoreAfter,
        before_cursor: orderedRows.length > 0 ? encodeMessageCursor(orderedRows[0]) : null,
        after_cursor:
          orderedRows.length > 0 ? encodeMessageCursor(orderedRows[orderedRows.length - 1]) : null,
      },
    });
  });

  server.get("/api/threads/:threadId/runs", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = RunsQuerySchema.parse(request.query ?? {});

    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;

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
          eq(runTable.createdByUserId, viewer.userId),
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

    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;
    const ownerUserId = thread.createdByUserId ?? viewer.userId;
    const effectiveClientId = body.client_id ?? generateMessageClientId();

    const existingMessage = await findOwnedUserMessageByClientId(
      thread.threadId,
      viewer.userId,
      effectiveClientId,
    );
    if (existingMessage) {
      reply.code(200).send({
        message_id: existingMessage.messageId,
        client_id: effectiveClientId,
      });
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pre-flight context sync
    // Check for terminal state changes and inject context message if needed
    // ─────────────────────────────────────────────────────────────────────────
    const session = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, params.threadId),
        isNull(terminalSessionTable.closedAt)
      ),
      columns: { sessionId: true }
    });

    if (session) {
      const isAgentActive = agentService.isThreadActive(params.threadId);

      if (!isAgentActive) {
        try {
          const contextUpdate = await contextSyncService.checkAndSync(
            session.sessionId,
            params.threadId,
            ownerUserId,
          );

          if (contextUpdate) {
            server.log.info(
              { threadId: params.threadId, update: contextUpdate },
              "Context sync: injected state change message"
            );
          }
        } catch (err) {
          // Log but don't fail the request if context sync fails
          server.log.warn({ threadId: params.threadId, err }, "Context sync failed");
        }
      } else {
        server.log.debug({ threadId: params.threadId }, "Skipping context sync - agent active");
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Create user message and start agent
    // ─────────────────────────────────────────────────────────────────────────
    const metadata: Record<string, unknown> = body.cwd ? { preferred_cwd: body.cwd } : {};
    let messageId: string;

    try {
      const [message] = await db
        .insert(messageTable)
        .values({
          clientId: effectiveClientId,
          threadId: thread.threadId,
          role: "user",
          displayRole: "User",
          content: body.text,
          createdByUserId: viewer.userId,
          metadata
        })
        .returning({ messageId: messageTable.messageId });
      messageId = message.messageId;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const duplicateMessage = await findOwnedUserMessageByClientId(
          thread.threadId,
          viewer.userId,
          effectiveClientId,
        );
        if (duplicateMessage) {
          reply.code(200).send({
            message_id: duplicateMessage.messageId,
            client_id: effectiveClientId,
          });
          return;
        }

        reply.code(409).send({ error: "client_id_conflict" });
        return;
      }

      throw err;
    }

    await recordThreadMessageMetadata(thread.threadId, body.text);

    try {
      await agentService.startUserMessage(thread.threadId, {
        model: body.model ?? null,
        reasoningEffort: body.reasoning_effort ?? null,
        ownerUserId,
      });

      void threadTitleService.maybeGenerateFromFirstUserMessage({
        threadId: thread.threadId,
        userMessageId: messageId,
        userMessageText: body.text,
      }).catch((err) => {
        server.log.warn(
          { err, threadId: thread.threadId, messageId, component: "thread_title" },
          "Thread title generation failed",
        );
      });

      reply.code(201).send({ message_id: messageId, client_id: effectiveClientId });
    } catch (err) {
      server.log.error({ err }, "Agent failed to queue message");
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  server.get("/api/threads/:threadId/agent/state", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    reply.send(agentRuntime.getSnapshot(params.threadId));
  });

  // GET /api/threads/:threadId/agent/stream - SSE for agent events
  server.get("/api/threads/:threadId/agent/stream", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const query = StreamResumeQuerySchema.parse(request.query ?? {});
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const resumeCursor =
      readLastEventId(request) ??
      query.after ??
      query.last_event_id ??
      null;

    const attachment = agentRuntime.attach(params.threadId, reply, {
      afterCursor: resumeCursor,
    });
    if (attachment.status === "resync_required") {
      reply.sse({
        event: "agent.resync_required",
        data: JSON.stringify({
          error: "resync_required",
          provided_cursor: attachment.provided_cursor,
        }),
      });
      reply.raw.end();
      return;
    }

    // Send periodic heartbeat
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
      attachment.detach();
    });
  });

  server.post("/api/threads/:threadId/cancel", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }
    const { thread } = access;
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
  // POST /api/threads/:threadId/terminal - Create/get terminal session (DB only, no bud communication)
  // This always succeeds if the thread exists, regardless of bud online status
  server.post("/api/threads/:threadId/terminal", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread, viewer } = access;

    // Get or create session record in DB
    let session = await terminalSessionManager.getSessionForThread(params.threadId);
    const created = !session;

    if (!session) {
      await terminalSessionManager.createSessionForThread(
        params.threadId,
        thread.budId,
        thread.createdByUserId ?? viewer.userId,
      );
      session = await terminalSessionManager.getSessionForThread(params.threadId);
    }

    if (!session) {
      return reply.code(500).send({ error: "session_create_failed" });
    }

    return {
      session_id: session.sessionId,
      bud_id: session.budId,
      state: session.state,
      created
    };
  });

  // POST /api/threads/:threadId/terminal/ensure - Ensure terminal is running on bud
  // This may fail if bud is offline - caller should handle gracefully
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
      // Return 503 with error details - caller can decide how to handle
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

  // GET /api/threads/:threadId/terminal - Get session info
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

  // GET /api/threads/:threadId/terminal/stream - SSE output stream
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

    // Subscribe to session events using the event bus
    const detach = terminalEvents.attach(session.sessionId, reply, {
      lastEventId: readLastEventId(request, query.last_event_id),
    });

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
  });

  // POST /api/threads/:threadId/terminal/input - Send input
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

  // POST /api/threads/:threadId/terminal/interrupt - Send Ctrl+C
  server.post("/api/threads/:threadId/terminal/interrupt", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

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

  // GET /api/threads/:threadId/terminal/history - Get output history
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

  // DELETE /api/threads/:threadId - Soft delete thread
  server.delete("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread } = access;

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
