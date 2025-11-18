import { sql } from "drizzle-orm";
import { db } from "./client.js";

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

export async function recordThreadMessageMetadata(threadId: string, preview?: string | null): Promise<void> {
  const now = new Date();
  const sanitized = createPreview(preview);
  if (sanitized) {
    await db.execute(sql`
      UPDATE "thread"
      SET
        last_activity_at = ${now},
        last_message_preview = ${sanitized},
        message_count = COALESCE(message_count, 0) + 1
      WHERE thread_id = ${threadId}
    `);
    return;
  }

  await db.execute(sql`
    UPDATE "thread"
    SET
      last_activity_at = ${now},
      message_count = COALESCE(message_count, 0) + 1
    WHERE thread_id = ${threadId}
  `);
}
