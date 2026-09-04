import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { messageTable } from "../db/schema.js";
import type { AgentContextCheckpoint } from "./context-checkpoint-repository.js";

/**
 * Compactions as transcript rows (plan/durable-compaction-transcript-rows.md).
 *
 * One `role: "compaction"` message per completed checkpoint, written right
 * after the checkpoint is recorded, so the transcript shows where the
 * model's context was cut and what summary it now carries. The checkpoint
 * table stays the model's source of truth; this row is a display artifact:
 * the loader never replays it and previews / message_count / attention /
 * notifications never see it (same treatment as "reasoning" rows).
 */
export const COMPACTION_MESSAGE_ROLE = "compaction";
export const COMPACTION_MESSAGE_DISPLAY_ROLE = "Context compacted";
export const COMPACTION_ARTIFACT_KIND = "context_compaction";

export type SerializedCompactionMessage = {
  message_id: string;
  client_id: string;
  role: typeof COMPACTION_MESSAGE_ROLE;
  display_role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type CompactionMessageOptions = {
  /** Known when written live by the agent loop; absent for backfilled rows. */
  turnId?: string | null;
};

export function buildCompactionMessageValues(
  checkpoint: AgentContextCheckpoint,
  options: CompactionMessageOptions = {},
): typeof messageTable.$inferInsert {
  return {
    messageId: randomUUID(),
    clientId: generateMessageClientId(),
    threadId: checkpoint.threadId,
    role: COMPACTION_MESSAGE_ROLE,
    displayRole: COMPACTION_MESSAGE_DISPLAY_ROLE,
    content: checkpoint.summary ?? "",
    createdByUserId: checkpoint.createdByUserId ?? undefined,
    tenantId: checkpoint.tenantId ?? undefined,
    // The cut happens when the checkpoint completes: chronologically right
    // after the last message the model still sees verbatim.
    createdAt: checkpoint.completedAt ?? checkpoint.createdAt ?? new Date(),
    metadata: {
      artifact_kind: COMPACTION_ARTIFACT_KIND,
      model_visible: false,
      status: "completed",
      checkpoint_id: checkpoint.checkpointId,
      ...(options.turnId ? { turn_id: options.turnId } : {}),
      trigger: checkpoint.trigger,
      reason: checkpoint.reason,
      phase: checkpoint.phase,
      tokens_before: checkpoint.inputTokensBefore ?? null,
      tokens_after: checkpoint.estimatedTokensAfter ?? null,
      compacted_through_message_id: checkpoint.compactedThroughMessageId ?? null,
      compacted_through_llm_call_id: checkpoint.compactedThroughLlmCallId ?? null,
      source_provider: checkpoint.sourceProvider ?? null,
      source_model: checkpoint.sourceModel ?? null,
      source_reasoning_effort: checkpoint.sourceReasoningEffort ?? null,
      replacement_history_message_count: checkpoint.replacementHistory.length,
    },
  };
}

export function serializeCompactionMessage(row: {
  messageId: string;
  clientId: string;
  displayRole: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}): SerializedCompactionMessage {
  return {
    message_id: row.messageId,
    client_id: row.clientId,
    role: COMPACTION_MESSAGE_ROLE,
    display_role: row.displayRole ?? COMPACTION_MESSAGE_DISPLAY_ROLE,
    content: row.content,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
  };
}

export async function insertCompactionMessage(
  checkpoint: AgentContextCheckpoint,
  options: CompactionMessageOptions = {},
): Promise<SerializedCompactionMessage> {
  const values = buildCompactionMessageValues(checkpoint, options);
  const [row] = await db
    .insert(messageTable)
    .values(values)
    .returning({
      messageId: messageTable.messageId,
      clientId: messageTable.clientId,
      displayRole: messageTable.displayRole,
      content: messageTable.content,
      metadata: messageTable.metadata,
      createdAt: messageTable.createdAt,
    });
  return serializeCompactionMessage({
    messageId: row?.messageId ?? values.messageId!,
    clientId: row?.clientId ?? values.clientId,
    displayRole: row?.displayRole ?? values.displayRole ?? null,
    content: row?.content ?? values.content,
    metadata: row?.metadata ?? values.metadata ?? null,
    createdAt:
      row?.createdAt instanceof Date
        ? row.createdAt
        : values.createdAt instanceof Date
          ? values.createdAt
          : new Date(),
  });
}
