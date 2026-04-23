import { sql } from "drizzle-orm";
import { db, type Database } from "./client.js";

type SqlExecutor = Pick<Database, "execute">;

const MESSAGE_PREVIEW_LIMIT = 360;

function createPreview(text?: string | null): string | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_PREVIEW_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, MESSAGE_PREVIEW_LIMIT - 3)}...`;
}

export async function recordThreadMessageMetadata(
  threadId: string,
  preview?: string | null,
  executor: SqlExecutor = db,
): Promise<void> {
  const now = new Date();
  const sanitized = createPreview(preview);
  if (sanitized) {
    await executor.execute(sql`
      UPDATE "thread"
      SET
        last_activity_at = ${now},
        last_message_preview = ${sanitized},
        message_count = COALESCE(message_count, 0) + 1
      WHERE thread_id = ${threadId}
    `);
    return;
  }

  await executor.execute(sql`
    UPDATE "thread"
    SET
      last_activity_at = ${now},
      message_count = COALESCE(message_count, 0) + 1
    WHERE thread_id = ${threadId}
  `);
}

export async function recordThreadAttentionMetadata(
  args: {
    threadId: string;
    messageId: string;
    messageCreatedAt: Date;
    kind: string;
  },
  executor: SqlExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    UPDATE "thread"
    SET
      last_attention_message_id = ${args.messageId}::uuid,
      last_attention_message_created_at = ${args.messageCreatedAt},
      last_attention_kind = ${args.kind}
    WHERE thread_id = ${args.threadId}::uuid
  `);
}
