import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { budTable, terminalSessionTable, threadReadStateTable, threadTable } from "../../db/schema.js";
import { hasUnseenAttention } from "../../notifications/index.js";
import { serializeThreadModelSelection } from "./shared.js";
import type { ThreadListCursor } from "./list-cursor.js";

/** Caller resolves the viewer; every projection repeats owner scope in SQL. */
export async function loadThreadSummaries(owner: string, options: { budId?: string; threadId?: string; limit?: number; cursor?: ThreadListCursor | null } = {}) {
    const threads = await db
      .select({
        threadId: threadTable.threadId,
        budId: threadTable.budId,
        title: threadTable.title,
        createdAt: threadTable.createdAt,
        lastActivityAt: threadTable.lastActivityAt,
        lastConversationAt: threadTable.lastConversationAt,
        lastMessagePreview: threadTable.lastMessagePreview,
        messageCount: threadTable.messageCount,
        pinned: threadTable.pinned,
        archived: threadTable.archived,
        modelId: threadTable.modelId,
        reasoningEffort: threadTable.reasoningEffort,
        lastAttentionMessageId: threadTable.lastAttentionMessageId,
        lastAttentionMessageCreatedAt: threadTable.lastAttentionMessageCreatedAt,
        lastAttentionKind: threadTable.lastAttentionKind,
        lastSeenMessageId: threadReadStateTable.lastSeenMessageId,
        lastSeenMessageCreatedAt: threadReadStateTable.lastSeenMessageCreatedAt,
        sessionId: terminalSessionTable.sessionId,
        sessionState: terminalSessionTable.state
      })
      .from(threadTable)
      .innerJoin(budTable, and(eq(budTable.budId, threadTable.budId), eq(budTable.createdByUserId, owner)))
      .leftJoin(
        threadReadStateTable,
        and(
          eq(threadReadStateTable.threadId, threadTable.threadId),
          eq(threadReadStateTable.userId, owner),
        ),
      )
      .leftJoin(
        terminalSessionTable,
        and(
          eq(threadTable.threadId, terminalSessionTable.threadId),
          eq(terminalSessionTable.createdByUserId, owner),
          isNull(terminalSessionTable.closedAt),
        ),
      )
      .where(
        and(
          eq(threadTable.createdByUserId, owner),
          isNull(threadTable.deletedAt),
          options.threadId ? eq(threadTable.threadId, options.threadId) : undefined,
          options.budId ? eq(threadTable.budId, options.budId) : undefined,
          options.cursor ? sql`(date_trunc('milliseconds', ${threadTable.lastConversationAt}),
            date_trunc('milliseconds', ${threadTable.createdAt}), ${threadTable.threadId})
            < (${options.cursor.at}::timestamptz, ${options.cursor.created}::timestamptz, ${options.cursor.id}::uuid)` : undefined,
        ),
      )
      // JSON Date serialization has millisecond precision; use the same ties as clients.
      .orderBy(
        desc(sql`date_trunc('milliseconds', ${threadTable.lastConversationAt})`),
        desc(sql`date_trunc('milliseconds', ${threadTable.createdAt})`),
        desc(threadTable.threadId),
      ).limit(options.threadId ? 1 : options.limit ?? 51);

    return threads.map((row) => ({
      thread_id: row.threadId,
      bud_id: row.budId,
      title: row.title,
      created_at: row.createdAt,
      last_activity_at: row.lastActivityAt,
      last_conversation_at: row.lastConversationAt,
      last_message_preview: row.lastMessagePreview,
      message_count: row.messageCount,
      pinned: row.pinned,
      archived: row.archived,
      ...serializeThreadModelSelection(row),
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
}
