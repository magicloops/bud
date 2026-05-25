import { and, desc, eq, gt, or, type SQL } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { llmCallTable, messageTable } from "../db/schema.js";
import {
  resolveEffectiveModelSelection,
  type CanonicalMessage,
  type CanonicalProviderId,
  type ReasoningConfig,
  type ReasoningLevel,
  type TokenUsage,
} from "../llm/index.js";
import type { AgentRuntimeSnapshot } from "../runtime/agent-runtime-state.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import {
  estimateCanonicalMessagesTokens,
  type ContextBudget,
  resolveContextBudget,
} from "./context-budget.js";
import {
  buildContextBudgetStateFromConversation,
  type ContextBudgetProviderUsageEstimate,
  type ContextBudgetSnapshot,
} from "./context-budget-state.js";
import {
  getLatestCompletedContextCheckpoint,
  type AgentContextCheckpoint,
} from "./context-checkpoint-repository.js";
import { AGENT_TOOL_SCHEMA_TOKENS } from "./tool-definitions.js";

export type {
  ContextBudgetConfidence,
  ContextBudgetEstimateBasis,
  ContextBudgetProviderUsageEstimate,
  ContextBudgetSnapshot,
  ContextBudgetSnapshotPhase,
  ContextBudgetSnapshotReason,
  ContextBudgetSnapshotSource,
  ContextBudgetUnknownReason,
} from "./context-budget-state.js";

export type ContextBudgetUsageAnchor = {
  llmCallId: string;
  createdAt: Date;
  provider: CanonicalProviderId;
  model: string;
  usage: TokenUsage;
  reasoning: ReasoningConfig | null;
};

type ThreadContextBudgetRow = {
  threadId: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

type LoadedContextBudgetInput = {
  model: string;
  provider: string;
  budget: ContextBudget;
  conversation: CanonicalMessage[];
  checkpoint: AgentContextCheckpoint | null;
  usageAnchor?: ContextBudgetUsageAnchor | null;
  deltaMessages?: ContextBudgetDeltaMessage[];
  toolSchemaTokens?: number;
  stale?: boolean;
  now?: Date;
};

type ContextBudgetDeltaMessage = {
  role: string;
  content: string;
  metadata: unknown;
};

export async function getThreadContextBudgetSnapshot(args: {
  thread: ThreadContextBudgetRow;
  runtimeSnapshot?: Pick<AgentRuntimeSnapshot, "active"> | null;
}): Promise<ContextBudgetSnapshot> {
  const now = new Date();
  try {
    const selection = resolveEffectiveModelSelection({
      threadModel: args.thread.modelId ?? null,
      threadReasoning: args.thread.reasoningEffort ?? null,
      serviceDefaultModel: config.defaultModel,
      validateAvailability: false,
    });
    const modelReasoning = selection.modelReasoning;
    const provider = modelReasoning.providerName;
    const providerId = parseCanonicalProviderId(provider);
    const budget = resolveContextBudget({
      model: selection.model,
      modelReasoning,
    });

    const checkpoint = await getLatestCompletedContextCheckpoint(args.thread.threadId);
    const conversationLoader = new AgentConversationLoader({
      async getLatestCompletedCheckpoint() {
        return checkpoint;
      },
    });
    const loadedConversation = await conversationLoader.loadWithDiagnostics(
      args.thread.threadId,
      providerId
        ? {
            provider: providerId,
            targetModel: modelReasoning.providerModel,
            targetReasoning: modelReasoning.reasoning,
          }
        : undefined,
    );

    const usageAnchor = providerId
      ? await loadLatestContextUsageAnchor({
          threadId: args.thread.threadId,
          provider: providerId,
          providerModel: modelReasoning.providerModel,
          targetReasoning: modelReasoning.reasoning,
          checkpoint,
        })
      : null;
    const deltaMessages = usageAnchor
      ? await loadDeltaMessagesAfterUsageAnchor(args.thread.threadId, usageAnchor)
      : [];

    return buildContextBudgetSnapshot({
      model: selection.model,
      provider,
      budget,
      conversation: loadedConversation.messages,
      checkpoint,
      usageAnchor,
      deltaMessages,
      stale: args.runtimeSnapshot?.active === true,
      now,
    });
  } catch {
    return {
      status: "unknown",
      model: args.thread.modelId ?? config.defaultModel,
      provider: null,
      reason: "count_failed",
      source: "durable_reconstruction",
      phase: "idle",
      turn_id: null,
      checked_at: now.toISOString(),
      stale: args.runtimeSnapshot?.active === true,
      updated_at: now.toISOString(),
    };
  }
}

export function buildContextBudgetSnapshot(args: LoadedContextBudgetInput): ContextBudgetSnapshot {
  const now = args.now ?? new Date();
  const providerUsageEstimate = buildProviderUsageEstimate({
    usageAnchor: args.usageAnchor ?? null,
    deltaMessages: args.deltaMessages ?? [],
  });
  return buildContextBudgetStateFromConversation({
    model: args.model,
    provider: args.provider,
    budget: args.budget,
    conversation: args.conversation,
    checkpoint: args.checkpoint,
    source: "durable_reconstruction",
    phase: "idle",
    reason: null,
    turnId: null,
    providerUsageEstimate,
    toolSchemaTokens: args.toolSchemaTokens ?? AGENT_TOOL_SCHEMA_TOKENS,
    stale: args.stale === true,
    now,
    checkedAt: now,
  });
}

function buildProviderUsageEstimate(args: {
  usageAnchor: ContextBudgetUsageAnchor | null;
  deltaMessages: ContextBudgetDeltaMessage[];
}): ContextBudgetProviderUsageEstimate | null {
  if (!args.usageAnchor) {
    return null;
  }

  const deltaTokens = estimateDeltaMessagesTokens(args.deltaMessages, args.usageAnchor.llmCallId);
  const estimatedInputTokens =
    args.usageAnchor.usage.input_tokens +
    args.usageAnchor.usage.output_tokens +
    deltaTokens;

  return {
    estimated_input_tokens: estimatedInputTokens,
    input_tokens: args.usageAnchor.usage.input_tokens,
    output_tokens: args.usageAnchor.usage.output_tokens,
    ...(args.usageAnchor.usage.reasoning_tokens !== undefined
      ? { reasoning_tokens: args.usageAnchor.usage.reasoning_tokens }
      : {}),
    delta_tokens: deltaTokens,
    llm_call_id: args.usageAnchor.llmCallId,
    confidence: args.usageAnchor.usage.reasoning_tokens ? "medium" : "high",
  };
}

function estimateDeltaMessagesTokens(
  rows: ContextBudgetDeltaMessage[],
  anchorLlmCallId: string,
): number {
  const messages = rows.flatMap((row): CanonicalMessage[] => {
    const metadata = parseRecord(row.metadata);
    if (
      row.role === "assistant" &&
      typeof metadata?.llm_call_id === "string" &&
      metadata.llm_call_id === anchorLlmCallId
    ) {
      return [];
    }

    if (row.role === "tool") {
      const callId = parseToolCallId(row.content) ?? `delta_tool_${anchorLlmCallId}`;
      return [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content: row.content,
            },
          ],
        },
      ];
    }

    if (row.role === "assistant" || row.role === "user" || row.role === "system") {
      return [
        {
          role: row.role,
          content: [{ type: "text", text: row.content }],
        },
      ];
    }

    return [];
  });

  return estimateCanonicalMessagesTokens(messages);
}

async function loadLatestContextUsageAnchor(args: {
  threadId: string;
  provider: CanonicalProviderId;
  providerModel: string;
  targetReasoning: ReasoningConfig;
  checkpoint: AgentContextCheckpoint | null;
}): Promise<ContextBudgetUsageAnchor | null> {
  const conditions: SQL<unknown>[] = [
    eq(llmCallTable.threadId, args.threadId),
    eq(llmCallTable.provider, args.provider),
    eq(llmCallTable.model, args.providerModel),
    eq(llmCallTable.status, "completed"),
  ];
  const afterBoundary = llmCallAfterCheckpointBoundary(args.checkpoint);
  if (afterBoundary) {
    conditions.push(afterBoundary);
  }

  const rows = await db
    .select({
      llmCallId: llmCallTable.llmCallId,
      createdAt: llmCallTable.createdAt,
      provider: llmCallTable.provider,
      model: llmCallTable.model,
      usage: llmCallTable.usage,
      cacheMetadata: llmCallTable.cacheMetadata,
    })
    .from(llmCallTable)
    .where(and(...conditions))
    .orderBy(desc(llmCallTable.createdAt), desc(llmCallTable.llmCallId))
    .limit(8);

  for (const row of rows) {
    if (!isCanonicalProviderId(row.provider)) {
      continue;
    }
    const usage = parseTokenUsage(row.usage);
    if (!usage) {
      continue;
    }
    const reasoning = parseReconstructionTargetReasoning(row.cacheMetadata);
    if (!reasoning || !sameReasoning(reasoning, args.targetReasoning)) {
      continue;
    }
    return {
      llmCallId: row.llmCallId,
      createdAt: row.createdAt,
      provider: row.provider,
      model: row.model,
      usage,
      reasoning,
    };
  }

  return null;
}

async function loadDeltaMessagesAfterUsageAnchor(
  threadId: string,
  anchor: ContextBudgetUsageAnchor,
): Promise<ContextBudgetDeltaMessage[]> {
  return db
    .select({
      role: messageTable.role,
      content: messageTable.content,
      metadata: messageTable.metadata,
    })
    .from(messageTable)
    .where(and(eq(messageTable.threadId, threadId), gt(messageTable.createdAt, anchor.createdAt)));
}

function llmCallAfterCheckpointBoundary(
  checkpoint: AgentContextCheckpoint | null,
): SQL<unknown> | undefined {
  if (
    !checkpoint?.compactedThroughLlmCallCreatedAt ||
    !checkpoint.compactedThroughLlmCallId
  ) {
    return undefined;
  }

  return or(
    gt(llmCallTable.createdAt, checkpoint.compactedThroughLlmCallCreatedAt),
    and(
      eq(llmCallTable.createdAt, checkpoint.compactedThroughLlmCallCreatedAt),
      gt(llmCallTable.llmCallId, checkpoint.compactedThroughLlmCallId),
    ),
  );
}

function parseCanonicalProviderId(value: string): CanonicalProviderId | null {
  return isCanonicalProviderId(value) ? value : null;
}

function isCanonicalProviderId(value: string): value is CanonicalProviderId {
  return value === "openai" || value === "anthropic";
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  const record = parseRecord(value);
  const inputTokens = parseNonNegativeInteger(record?.input_tokens);
  const outputTokens = parseNonNegativeInteger(record?.output_tokens);
  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  const reasoningTokens = parseNonNegativeInteger(record?.reasoning_tokens);
  if (reasoningTokens !== null) {
    usage.reasoning_tokens = reasoningTokens;
  }
  const cachedInputTokens = parseNonNegativeInteger(record?.cached_input_tokens);
  if (cachedInputTokens !== null) {
    usage.cached_input_tokens = cachedInputTokens;
  }
  const cacheCreationInputTokens = parseNonNegativeInteger(record?.cache_creation_input_tokens);
  if (cacheCreationInputTokens !== null) {
    usage.cache_creation_input_tokens = cacheCreationInputTokens;
  }
  const cacheReadInputTokens = parseNonNegativeInteger(record?.cache_read_input_tokens);
  if (cacheReadInputTokens !== null) {
    usage.cache_read_input_tokens = cacheReadInputTokens;
  }
  return usage;
}

function parseReconstructionTargetReasoning(value: unknown): ReasoningConfig | null {
  const record = parseRecord(value);
  const reasoning = parseRecord(record?.reconstruction_target_reasoning);
  if (!reasoning || typeof reasoning.enabled !== "boolean") {
    return null;
  }
  return {
    enabled: reasoning.enabled,
    ...(typeof reasoning.effort === "string"
      ? { effort: reasoning.effort as Exclude<ReasoningLevel, "none"> }
      : {}),
    ...(typeof reasoning.summaryLevel === "string" &&
    (reasoning.summaryLevel === "auto" ||
      reasoning.summaryLevel === "concise" ||
      reasoning.summaryLevel === "detailed")
      ? { summaryLevel: reasoning.summaryLevel }
      : {}),
    ...(typeof reasoning.interleaved === "boolean"
      ? { interleaved: reasoning.interleaved }
      : {}),
  };
}

function sameReasoning(left: ReasoningConfig, right: ReasoningConfig): boolean {
  return (
    left.enabled === right.enabled &&
    (left.effort ?? null) === (right.effort ?? null) &&
    (left.summaryLevel ?? null) === (right.summaryLevel ?? null) &&
    (left.interleaved ?? null) === (right.interleaved ?? null)
  );
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseToolCallId(content: string): string | null {
  try {
    const record = parseRecord(JSON.parse(content));
    return typeof record?.call_id === "string" && record.call_id
      ? record.call_id
      : null;
  } catch {
    return null;
  }
}
