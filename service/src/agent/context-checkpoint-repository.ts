import { ulid } from "ulid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  agentContextCheckpointTable,
  llmCallTable,
  messageTable,
  threadTable,
} from "../db/schema.js";
import type { CanonicalMessage, CanonicalProviderId, ReasoningLevel } from "../llm/index.js";

export type AgentContextCheckpointTrigger = "auto" | "manual" | "model_downshift";
export type AgentContextCheckpointReason =
  | "context_limit"
  | "context_error_retry"
  | "model_downshift"
  | "user_requested";
export type AgentContextCheckpointPhase = "pre_turn" | "mid_turn" | "standalone_turn";
export type AgentContextCheckpointImplementation = "local_summary";
export type AgentContextCheckpointStatus = "completed" | "failed" | "canceled";

export type AgentContextCheckpointBoundary = {
  messageCreatedAt: Date | null;
  messageId: string | null;
  llmCallCreatedAt: Date | null;
  llmCallId: string | null;
};

export type AgentContextCheckpointRow = typeof agentContextCheckpointTable.$inferSelect;

export type AgentContextCheckpoint = Omit<AgentContextCheckpointRow, "replacementHistory"> & {
  replacementHistory: CanonicalMessage[];
};

export type RecordCompletedContextCheckpointArgs = {
  threadId: string;
  trigger: AgentContextCheckpointTrigger;
  reason: AgentContextCheckpointReason;
  phase: AgentContextCheckpointPhase;
  implementation?: AgentContextCheckpointImplementation;
  sourceProvider: CanonicalProviderId;
  sourceModel: string;
  sourceReasoningEffort?: ReasoningLevel | null;
  summary: string;
  replacementHistory: CanonicalMessage[];
  boundaries: AgentContextCheckpointBoundary;
  inputTokensBefore?: number | null;
  estimatedTokensAfter?: number | null;
  ownerUserId?: string | null;
  tenantId?: string | null;
};

export type RecordFailedContextCheckpointArgs = {
  threadId: string;
  trigger: AgentContextCheckpointTrigger;
  reason: AgentContextCheckpointReason;
  phase: AgentContextCheckpointPhase;
  implementation?: AgentContextCheckpointImplementation;
  sourceProvider?: CanonicalProviderId | null;
  sourceModel?: string | null;
  sourceReasoningEffort?: ReasoningLevel | null;
  boundaries?: AgentContextCheckpointBoundary | null;
  inputTokensBefore?: number | null;
  error: Record<string, unknown>;
  ownerUserId?: string | null;
  tenantId?: string | null;
};

export async function getLatestCompletedContextCheckpoint(
  threadId: string,
): Promise<AgentContextCheckpoint | null> {
  const [row] = await db
    .select()
    .from(agentContextCheckpointTable)
    .where(and(
      eq(agentContextCheckpointTable.threadId, threadId),
      eq(agentContextCheckpointTable.status, "completed"),
    ))
    .orderBy(
      desc(agentContextCheckpointTable.createdAt),
      desc(agentContextCheckpointTable.checkpointId),
    )
    .limit(1);

  return row ? normalizeCheckpointRow(row) : null;
}

export async function getCurrentContextCheckpointBoundary(
  threadId: string,
): Promise<AgentContextCheckpointBoundary> {
  const [message] = await db
    .select({
      messageId: messageTable.messageId,
      createdAt: messageTable.createdAt,
    })
    .from(messageTable)
    .where(eq(messageTable.threadId, threadId))
    .orderBy(desc(messageTable.createdAt), desc(messageTable.messageId))
    .limit(1);

  const [llmCall] = await db
    .select({
      llmCallId: llmCallTable.llmCallId,
      createdAt: llmCallTable.createdAt,
    })
    .from(llmCallTable)
    .where(eq(llmCallTable.threadId, threadId))
    .orderBy(desc(llmCallTable.createdAt), desc(llmCallTable.llmCallId))
    .limit(1);

  return {
    messageCreatedAt: message?.createdAt ?? null,
    messageId: message?.messageId ?? null,
    llmCallCreatedAt: llmCall?.createdAt ?? null,
    llmCallId: llmCall?.llmCallId ?? null,
  };
}

export async function getThreadCheckpointOwner(threadId: string): Promise<{
  ownerUserId: string | null;
  tenantId: string | null;
}> {
  const thread = await db.query.threadTable.findFirst({
    where: eq(threadTable.threadId, threadId),
    columns: {
      createdByUserId: true,
      tenantId: true,
    },
  });

  return {
    ownerUserId: thread?.createdByUserId ?? null,
    tenantId: thread?.tenantId ?? null,
  };
}

export async function recordCompletedContextCheckpoint(
  args: RecordCompletedContextCheckpointArgs,
): Promise<AgentContextCheckpoint> {
  const checkpointId = ulid();
  const [row] = await db
    .insert(agentContextCheckpointTable)
    .values({
      checkpointId,
      threadId: args.threadId,
      trigger: args.trigger,
      reason: args.reason,
      phase: args.phase,
      implementation: args.implementation ?? "local_summary",
      status: "completed",
      sourceProvider: args.sourceProvider,
      sourceModel: args.sourceModel,
      sourceReasoningEffort: args.sourceReasoningEffort ?? undefined,
      summary: args.summary,
      replacementHistory: serializeReplacementHistory(args.replacementHistory),
      compactedThroughMessageCreatedAt: args.boundaries.messageCreatedAt ?? undefined,
      compactedThroughMessageId: args.boundaries.messageId ?? undefined,
      compactedThroughLlmCallCreatedAt: args.boundaries.llmCallCreatedAt ?? undefined,
      compactedThroughLlmCallId: args.boundaries.llmCallId ?? undefined,
      inputTokensBefore: args.inputTokensBefore ?? undefined,
      estimatedTokensAfter: args.estimatedTokensAfter ?? undefined,
      tenantId: args.tenantId ?? undefined,
      createdByUserId: args.ownerUserId ?? undefined,
      completedAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("context_checkpoint_insert_failed");
  }
  return normalizeCheckpointRow(row);
}

export async function recordFailedContextCheckpoint(
  args: RecordFailedContextCheckpointArgs,
): Promise<AgentContextCheckpointRow> {
  const checkpointId = ulid();
  const [row] = await db
    .insert(agentContextCheckpointTable)
    .values({
      checkpointId,
      threadId: args.threadId,
      trigger: args.trigger,
      reason: args.reason,
      phase: args.phase,
      implementation: args.implementation ?? "local_summary",
      status: "failed",
      sourceProvider: args.sourceProvider ?? undefined,
      sourceModel: args.sourceModel ?? undefined,
      sourceReasoningEffort: args.sourceReasoningEffort ?? undefined,
      replacementHistory: [],
      compactedThroughMessageCreatedAt: args.boundaries?.messageCreatedAt ?? undefined,
      compactedThroughMessageId: args.boundaries?.messageId ?? undefined,
      compactedThroughLlmCallCreatedAt: args.boundaries?.llmCallCreatedAt ?? undefined,
      compactedThroughLlmCallId: args.boundaries?.llmCallId ?? undefined,
      inputTokensBefore: args.inputTokensBefore ?? undefined,
      error: boundErrorRecord(args.error),
      tenantId: args.tenantId ?? undefined,
      createdByUserId: args.ownerUserId ?? undefined,
      completedAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("context_checkpoint_insert_failed");
  }
  return row;
}

function normalizeCheckpointRow(row: AgentContextCheckpointRow): AgentContextCheckpoint {
  return {
    ...row,
    replacementHistory: parseReplacementHistory(row.replacementHistory),
  };
}

function serializeReplacementHistory(messages: CanonicalMessage[]): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(messages)) as Record<string, unknown>[];
}

function parseReplacementHistory(value: unknown): CanonicalMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isCanonicalMessage);
}

function isCanonicalMessage(value: unknown): value is CanonicalMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.role === "system" || record.role === "user" || record.role === "assistant") &&
    (typeof record.content === "string" || Array.isArray(record.content))
  );
}

function boundErrorRecord(error: Record<string, unknown>): Record<string, unknown> {
  const message = typeof error.message === "string" ? error.message : undefined;
  return {
    ...error,
    ...(message && message.length > 1_000
      ? { message: `${message.slice(0, 1_000)}... [truncated]` }
      : {}),
  };
}
