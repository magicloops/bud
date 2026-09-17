import { config } from "../config.js";
import {
  resolveEffectiveModelSelection,
  type CanonicalMessage,
  type CanonicalProviderId,
  buildRequestMode,
  type CanonicalTool,
} from "../llm/index.js";
import type { AgentRuntimeSnapshot } from "../runtime/agent-runtime-state.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import {
  estimateCanonicalToolsTokens,
  type ContextBudget,
  resolveContextBudget,
} from "./context-budget.js";
import {
  buildContextBudgetStateFromConversation,
  type ContextBudgetSnapshot,
} from "./context-budget-state.js";
import {
  countCompletedContextCheckpoints,
  getLatestCompletedContextCheckpoint,
  type AgentContextCheckpoint,
} from "./context-checkpoint-repository.js";
import { loadLatestContextUsageAnchor } from "../llm/provider-ledger.js";
import type { ContextRequestIdentity, ContextUsageAnchor } from "./context-accounting.js";
import { applyRuntimeInstructions, type AgentEnvironmentSnapshot } from "./environment.js";

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
  usageAnchor?: ContextUsageAnchor | null;
  requestIdentity?: ContextRequestIdentity;
  toolSchemaTokens?: number;
  compactionCount?: number | null;
  stale?: boolean;
  now?: Date;
};

export async function getThreadContextBudgetSnapshot(args: {
  thread: ThreadContextBudgetRow;
  environment: AgentEnvironmentSnapshot;
  tools: CanonicalTool[];
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
    // Diagnostic only: a count failure must not turn the whole snapshot unknown.
    const compactionCount = checkpoint
      ? await countCompletedContextCheckpoints(args.thread.threadId).catch(() => null)
      : 0;
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

    const usageAnchor = await loadLatestContextUsageAnchor(args.thread.threadId);

    return buildContextBudgetSnapshot({
      model: selection.model,
      provider,
      budget,
      conversation: applyRuntimeInstructions(loadedConversation.messages, args.environment),
      checkpoint,
      usageAnchor,
      requestIdentity: providerId ? { provider, model: modelReasoning.providerModel,
        reasoning: modelReasoning.reasoning, requestMode: buildRequestMode(providerId),
        checkpointId: checkpoint?.checkpointId ?? null, tools: args.tools } : undefined,
      toolSchemaTokens: estimateCanonicalToolsTokens(args.tools),
      compactionCount,
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
    usageAnchor: args.usageAnchor,
    requestIdentity: args.requestIdentity,
    toolSchemaTokens: args.toolSchemaTokens ?? 0,
    compactionCount: args.compactionCount ?? null,
    stale: args.stale === true,
    now,
    checkedAt: now,
  });
}

export function parseCanonicalProviderId(value: string): CanonicalProviderId | null {
  return value === "openai" || value === "anthropic" || value === "ds4" ? value : null;
}
