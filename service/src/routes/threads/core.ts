import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { terminalSessionTable, threadReadStateTable, threadTable } from "../../db/schema.js";
import { getAuthorizedBud, requireViewer } from "../../auth/session.js";
import { getActiveBudIds } from "../../ws/gateway.js";
import type { TerminalSessionManager } from "../../runtime/terminal-session-manager.js";
import { hasUnseenAttention } from "../../notifications/index.js";
import {
  CreateThreadSchema,
  ThreadListQuerySchema,
  ThreadParamsSchema,
  requireAuthorizedThreadAccess,
  serializeThread,
} from "./shared.js";

export async function registerThreadCoreRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager,
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
        lastAttentionMessageId: threadTable.lastAttentionMessageId,
        lastAttentionMessageCreatedAt: threadTable.lastAttentionMessageCreatedAt,
        lastAttentionKind: threadTable.lastAttentionKind,
        lastSeenMessageId: threadReadStateTable.lastSeenMessageId,
        lastSeenMessageCreatedAt: threadReadStateTable.lastSeenMessageCreatedAt,
        sessionId: terminalSessionTable.sessionId,
        sessionState: terminalSessionTable.state
      })
      .from(threadTable)
      .leftJoin(
        threadReadStateTable,
        and(
          eq(threadReadStateTable.threadId, threadTable.threadId),
          eq(threadReadStateTable.userId, viewer.userId),
        ),
      )
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
      has_unseen_attention: hasUnseenAttention({
        lastAttentionMessageId: row.lastAttentionMessageId,
        lastAttentionMessageCreatedAt: row.lastAttentionMessageCreatedAt,
        lastSeenMessageId: row.lastSeenMessageId,
        lastSeenMessageCreatedAt: row.lastSeenMessageCreatedAt,
      }),
      last_attention_kind: row.lastAttentionKind,
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

  server.delete("/api/threads/:threadId", async (request, reply) => {
    const params = ThreadParamsSchema.parse(request.params);
    const access = await requireAuthorizedThreadAccess(request, reply, params.threadId);
    if (!access) {
      return;
    }

    const { thread } = access;
    const session = await terminalSessionManager.getSessionForThread(params.threadId);
    if (session && session.state !== "closed") {
      const activeBuds = getActiveBudIds();
      if (!activeBuds.includes(thread.budId)) {
        return reply.code(409).send({
          error: "session_active_bud_offline",
          message:
            "Cannot delete thread: terminal session is active but Bud is offline. Wait for Bud to reconnect or try again later."
        });
      }

      await terminalSessionManager.closeSession(session.sessionId, "thread_deleted");
    }

    await db
      .update(threadTable)
      .set({ deletedAt: new Date() })
      .where(eq(threadTable.threadId, params.threadId));

    return { ok: true, deleted_at: new Date().toISOString() };
  });
}
