import { and, eq, sql } from "drizzle-orm";
import { db, type Database } from "./client.js";
import { threadReadStateTable } from "./schema.js";

/** Compare the same millisecond timestamp/UUID tuple used by attention clients. */
export async function advanceThreadReadState(owner: string, threadId: string,
  message: { messageId: string; createdAt: Date }, database: Database = db) {
  const [changed] = await database.insert(threadReadStateTable).values({
    threadId, userId: owner, createdByUserId: owner,
    lastSeenMessageId: message.messageId, lastSeenMessageCreatedAt: message.createdAt,
    lastSeenAt: new Date(),
  }).onConflictDoUpdate({
    target: [threadReadStateTable.threadId, threadReadStateTable.userId],
    set: { lastSeenMessageId: message.messageId, lastSeenMessageCreatedAt: message.createdAt,
      lastSeenAt: new Date(), updatedAt: new Date() },
    setWhere: sql`${threadReadStateTable.lastSeenMessageCreatedAt} IS NULL
      OR ${threadReadStateTable.lastSeenMessageId} IS NULL
      OR (date_trunc('milliseconds', ${threadReadStateTable.lastSeenMessageCreatedAt}), ${threadReadStateTable.lastSeenMessageId})
        < (date_trunc('milliseconds', ${message.createdAt}::timestamptz), ${message.messageId}::uuid)`,
  }).returning({ lastSeenMessageId: threadReadStateTable.lastSeenMessageId });
  // A rejected conditional update still locks the conflicting row. A new read
  // sees the committed winner rather than the insertion statement's old snapshot.
  const stored = changed ?? await database.query.threadReadStateTable.findFirst({
    where: and(eq(threadReadStateTable.threadId, threadId), eq(threadReadStateTable.userId, owner)),
    columns: { lastSeenMessageId: true },
  });
  if (!stored) throw new Error("read_watermark_missing");
  return { ok: true, updated: !!changed, last_seen_message_id: stored.lastSeenMessageId };
}

export async function loadNotificationSummary(owner: string, database: Pick<Database, "execute"> = db) {
  const result = await database.execute<{ unseen_thread_count: number; updated_at: Date }>(sql`
    SELECT count(*)::integer AS unseen_thread_count, statement_timestamp() AS updated_at
    FROM thread t JOIN bud b ON b.bud_id = t.bud_id AND b.created_by_user_id = ${owner}
    LEFT JOIN thread_read_state r ON r.thread_id = t.thread_id AND r.user_id = ${owner}
    WHERE t.created_by_user_id = ${owner} AND t.deleted_at IS NULL
      AND t.last_attention_message_id IS NOT NULL AND t.last_attention_message_created_at IS NOT NULL
      AND (r.last_seen_message_id IS NULL OR r.last_seen_message_created_at IS NULL
        OR (date_trunc('milliseconds', t.last_attention_message_created_at), t.last_attention_message_id)
          > (date_trunc('milliseconds', r.last_seen_message_created_at), r.last_seen_message_id))
  `);
  const row = result.rows[0];
  return { unseen_thread_count: row.unseen_thread_count, updated_at: new Date(row.updated_at).toISOString() };
}
