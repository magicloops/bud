import { and, asc, desc, eq, getTableColumns } from "drizzle-orm";
import { db, type Database } from "../../db/client.js";
import { messageTable } from "../../db/schema.js";
import type { AgentService } from "../../agent/index.js";
import { messageCursorTimestamp, encodeMessageCursor, newerThanMessageCursor, olderThanMessageCursor, serializeMessage, type MessageCursor } from "./shared.js";

export async function loadMessagePage(owner: string, threadId: string, agentService: AgentService,
  limit: number, beforeCursor: MessageCursor | null = null, afterCursor: MessageCursor | null = null, database: Pick<Database, "select"> = db) {
    const fetchNewerWindow = Boolean(afterCursor);
    const rows = await database
      .select({ ...getTableColumns(messageTable), cursorTimestamp: messageCursorTimestamp })
      .from(messageTable)
      .where(
        and(
          eq(messageTable.threadId, threadId),
          eq(messageTable.createdByUserId, owner),
          beforeCursor ? olderThanMessageCursor(beforeCursor) : undefined,
          afterCursor ? newerThanMessageCursor(afterCursor) : undefined,
        ),
      )
      .orderBy(
        fetchNewerWindow ? asc(messageTable.createdAt) : desc(messageTable.createdAt),
        fetchNewerWindow ? asc(messageTable.messageId) : desc(messageTable.messageId),
      )
      .limit(limit + 1);

    const hasExtraRow = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const orderedRows = fetchNewerWindow ? pageRows : [...pageRows].reverse();
    const hasMoreBefore = afterCursor ? true : hasExtraRow;
    const hasMoreAfter = beforeCursor ? true : hasExtraRow && fetchNewerWindow;

    return {
      messages: orderedRows.map(serializeMessage),
      turn_timings: await agentService.durableInvocations?.timingsForTurns(owner, threadId,
        orderedRows.flatMap(row => typeof row.metadata.turn_id === "string" ? [row.metadata.turn_id] : [])) ?? [],
      page: {
        limit: limit,
        returned: orderedRows.length,
        has_more_before: hasMoreBefore,
        has_more_after: hasMoreAfter,
        before_cursor: orderedRows.length > 0 ? encodeMessageCursor(orderedRows[0]) : null,
        after_cursor:
          orderedRows.length > 0 ? encodeMessageCursor(orderedRows[orderedRows.length - 1]) : null,
      },
    };
}
