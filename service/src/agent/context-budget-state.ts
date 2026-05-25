import type { CanonicalMessage } from "../llm/index.js";
import {
  estimateCanonicalMessagesTokens,
  shouldCompactContext,
  type ContextBudget,
  type ContextBudgetInvalidReason,
} from "./context-budget.js";
import type {
  AgentContextCheckpoint,
  AgentContextCheckpointPhase,
  AgentContextCheckpointReason,
} from "./context-checkpoint-repository.js";

export type ContextBudgetEstimateBasis =
  | "model_agnostic_estimate"
  | "provider_usage_trigger"
  | "provider_token_count";

export type ContextBudgetConfidence = "low" | "medium" | "high";

export type ContextBudgetSnapshotSource =
  | "durable_reconstruction"
  | "active_agent_decision"
  | "compaction_event"
  | "unknown";

export type ContextBudgetSnapshotPhase = "idle" | AgentContextCheckpointPhase;

export type ContextBudgetSnapshotReason = AgentContextCheckpointReason;

export type ContextBudgetProviderUsageEstimate = {
  estimated_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  delta_tokens: number;
  llm_call_id: string;
  confidence: Extract<ContextBudgetConfidence, "medium" | "high">;
};

export type ContextBudgetUnknownReason =
  | ContextBudgetInvalidReason
  | "conversation_unavailable"
  | "count_failed";

export type ContextBudgetSnapshot =
  | {
      status: "available";
      model: string;
      provider: string;
      context_window_tokens: number;
      usable_context_window_tokens: number;
      reserved_output_tokens: number;
      usable_input_window_tokens: number;
      compaction_enabled: boolean;
      compaction_threshold_ratio: number;
      compaction_threshold_tokens: number;
      effective_budget_tokens: number;
      message_estimated_tokens: number;
      tool_schema_tokens: number;
      estimated_input_tokens: number;
      remaining_context_tokens: number;
      percent_of_context_budget: number;
      percent_of_model_window: number;
      basis: ContextBudgetEstimateBasis;
      confidence: ContextBudgetConfidence;
      source: ContextBudgetSnapshotSource;
      phase: ContextBudgetSnapshotPhase | null;
      reason: ContextBudgetSnapshotReason | null;
      turn_id: string | null;
      checked_at: string | null;
      stale: boolean;
      updated_at: string;
      latest_checkpoint_id: string | null;
      compacted_through_message_id: string | null;
      compacted_through_llm_call_id: string | null;
      provider_usage_estimate?: ContextBudgetProviderUsageEstimate | null;
    }
  | {
      status: "unknown";
      model: string;
      provider: string | null;
      reason: ContextBudgetUnknownReason;
      source: ContextBudgetSnapshotSource;
      phase: ContextBudgetSnapshotPhase | null;
      turn_id: string | null;
      checked_at: string | null;
      stale: boolean;
      updated_at: string;
    };

export function buildContextBudgetStateFromConversation(args: {
  model: string;
  provider: string;
  budget: ContextBudget;
  conversation: CanonicalMessage[];
  checkpoint?: AgentContextCheckpoint | null;
  source: ContextBudgetSnapshotSource;
  phase?: ContextBudgetSnapshotPhase | null;
  reason?: ContextBudgetSnapshotReason | null;
  turnId?: string | null;
  providerUsageEstimate?: ContextBudgetProviderUsageEstimate | null;
  toolSchemaTokens?: number;
  stale?: boolean;
  now?: Date;
  checkedAt?: Date | null;
}): ContextBudgetSnapshot {
  const now = args.now ?? new Date();
  const checkedAt = args.checkedAt === undefined ? now : args.checkedAt;
  const common = {
    source: args.source,
    phase: args.phase ?? null,
    turn_id: args.turnId ?? null,
    checked_at: checkedAt ? checkedAt.toISOString() : null,
    stale: args.stale === true,
    updated_at: now.toISOString(),
  };
  const messageEstimatedTokens = Math.max(0, estimateCanonicalMessagesTokens(args.conversation));
  const toolSchemaTokens = Math.max(0, Math.floor(args.toolSchemaTokens ?? 0));
  const estimatedInputTokens = messageEstimatedTokens + toolSchemaTokens;

  if (args.budget.contextWindowTokens === null) {
    return {
      status: "unknown",
      model: args.model,
      provider: args.provider,
      reason: "unknown_model_context_window",
      ...common,
    };
  }

  if (
    args.budget.usableContextWindowTokens === null ||
    args.budget.reservedOutputTokens === null ||
    args.budget.usableInputWindowTokens === null ||
    args.budget.thresholdTokens === null ||
    args.budget.effectiveInputBudgetTokens === null
  ) {
    return {
      status: "unknown",
      model: args.model,
      provider: args.provider,
      reason: args.budget.invalidReason ?? "invalid_context_policy",
      ...common,
    };
  }

  const effectiveBudgetTokens = args.budget.effectiveInputBudgetTokens;
  const remainingContextTokens = Math.max(0, effectiveBudgetTokens - estimatedInputTokens);

  return {
    status: "available",
    model: args.model,
    provider: args.provider,
    context_window_tokens: args.budget.contextWindowTokens,
    usable_context_window_tokens: args.budget.usableContextWindowTokens,
    reserved_output_tokens: args.budget.reservedOutputTokens,
    usable_input_window_tokens: args.budget.usableInputWindowTokens,
    compaction_enabled: args.budget.enabled,
    compaction_threshold_ratio: args.budget.thresholdRatio,
    compaction_threshold_tokens: args.budget.thresholdTokens,
    effective_budget_tokens: effectiveBudgetTokens,
    message_estimated_tokens: messageEstimatedTokens,
    tool_schema_tokens: toolSchemaTokens,
    estimated_input_tokens: estimatedInputTokens,
    remaining_context_tokens: remainingContextTokens,
    percent_of_context_budget: safeRatio(estimatedInputTokens, effectiveBudgetTokens),
    percent_of_model_window: safeRatio(estimatedInputTokens, args.budget.contextWindowTokens),
    basis: "model_agnostic_estimate",
    confidence: "medium",
    ...common,
    reason: args.reason ?? null,
    latest_checkpoint_id: args.checkpoint?.checkpointId ?? null,
    compacted_through_message_id: args.checkpoint?.compactedThroughMessageId ?? null,
    compacted_through_llm_call_id: args.checkpoint?.compactedThroughLlmCallId ?? null,
    provider_usage_estimate: args.providerUsageEstimate ?? null,
  };
}

export function buildContextBudgetDecision(args: Parameters<typeof buildContextBudgetStateFromConversation>[0]): {
  snapshot: ContextBudgetSnapshot;
  estimatedTokens: number;
  shouldCompact: boolean;
} {
  const snapshot = buildContextBudgetStateFromConversation(args);
  const estimatedTokens = snapshot.status === "available"
    ? snapshot.estimated_input_tokens
    : estimateCanonicalMessagesTokens(args.conversation) + Math.max(0, Math.floor(args.toolSchemaTokens ?? 0));
  return {
    snapshot,
    estimatedTokens,
    shouldCompact: snapshot.status === "available"
      ? shouldCompactContext({
          estimatedTokens,
          budget: args.budget,
        })
      : false,
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
