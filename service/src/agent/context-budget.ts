import { config } from "../config.js";
import {
  getCatalogEntry,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type ModelCatalogEntry,
  type ResolvedModelReasoning,
} from "../llm/index.js";

const DEFAULT_AUTO_COMPACTION_RATIO = 0.95;
const MESSAGE_TOKEN_OVERHEAD = 8;
const CONTENT_BLOCK_TOKEN_OVERHEAD = 4;

export type ContextBudgetRequestKind = "agent_turn" | "compaction_summary";

export type ContextBudgetInvalidReason =
  | "unknown_model_context_window"
  | "invalid_context_policy";

export type ModelContextPolicy = {
  contextWindowTokens: number | null;
  usableContextWindowTokens: number | null;
  reservedOutputTokens: number | null;
  usableInputWindowTokens: number | null;
  invalidReason: ContextBudgetInvalidReason | null;
};

export type ContextBudget = {
  enabled: boolean;
  requestKind: ContextBudgetRequestKind;
  contextWindowTokens: number | null;
  usableContextWindowTokens: number | null;
  reservedOutputTokens: number | null;
  usableInputWindowTokens: number | null;
  thresholdRatio: number;
  thresholdTokens: number | null;
  effectiveInputBudgetTokens: number | null;
  invalidReason: ContextBudgetInvalidReason | null;
};

export function resolveModelContextPolicy(
  entry: ModelCatalogEntry | null,
): ModelContextPolicy {
  if (!entry) {
    return {
      contextWindowTokens: null,
      usableContextWindowTokens: null,
      reservedOutputTokens: null,
      usableInputWindowTokens: null,
      invalidReason: "unknown_model_context_window",
    };
  }

  const contextWindowTokens = positiveIntegerOrNull(entry.capabilities.contextWindowTokens);
  const usableContextWindowTokens = positiveIntegerOrNull(
    entry.capabilities.usableContextWindowTokens ?? entry.capabilities.contextWindowTokens,
  );
  const reservedOutputTokens = nonNegativeIntegerOrNull(
    entry.capabilities.reservedOutputTokens ?? entry.capabilities.maxOutputTokens,
  );

  if (
    contextWindowTokens === null ||
    usableContextWindowTokens === null ||
    reservedOutputTokens === null
  ) {
    return {
      contextWindowTokens,
      usableContextWindowTokens,
      reservedOutputTokens,
      usableInputWindowTokens: null,
      invalidReason: contextWindowTokens === null
        ? "unknown_model_context_window"
        : "invalid_context_policy",
    };
  }

  const usableInputWindowTokens = usableContextWindowTokens - reservedOutputTokens;
  if (usableInputWindowTokens <= 0) {
    return {
      contextWindowTokens,
      usableContextWindowTokens,
      reservedOutputTokens,
      usableInputWindowTokens: null,
      invalidReason: "invalid_context_policy",
    };
  }

  return {
    contextWindowTokens,
    usableContextWindowTokens,
    reservedOutputTokens,
    usableInputWindowTokens,
    invalidReason: null,
  };
}

export function resolveContextBudget(args: {
  model: string;
  modelReasoning: ResolvedModelReasoning;
  requestKind?: ContextBudgetRequestKind;
}): ContextBudget {
  const entry = getCatalogEntry(args.model) ?? getCatalogEntry(args.modelReasoning.providerModel);
  const policy = resolveModelContextPolicy(entry);
  const thresholdRatio = normalizeAutoCompactionRatio(config.agentAutoCompactionRatio);
  const thresholdTokens = policy.usableInputWindowTokens !== null
    ? Math.floor(policy.usableInputWindowTokens * thresholdRatio)
    : null;
  const requestKind = args.requestKind ?? "agent_turn";
  const effectiveInputBudgetTokens = resolveEffectiveInputBudgetTokens({
    enabled: config.agentAutoCompactionEnabled,
    requestKind,
    thresholdTokens,
    usableInputWindowTokens: policy.usableInputWindowTokens,
  });

  return {
    enabled: config.agentAutoCompactionEnabled,
    requestKind,
    contextWindowTokens: policy.contextWindowTokens,
    usableContextWindowTokens: policy.usableContextWindowTokens,
    reservedOutputTokens: policy.reservedOutputTokens,
    usableInputWindowTokens: policy.usableInputWindowTokens,
    thresholdRatio,
    thresholdTokens,
    effectiveInputBudgetTokens,
    invalidReason: policy.invalidReason,
  };
}

export function shouldCompactContext(args: {
  estimatedTokens: number;
  budget: ContextBudget;
}): boolean {
  return Boolean(
    args.budget.enabled &&
    args.budget.thresholdTokens !== null &&
    args.estimatedTokens >= args.budget.thresholdTokens,
  );
}

export function estimateCanonicalMessagesTokens(messages: CanonicalMessage[]): number {
  return messages.reduce(
    (total, message) => total + MESSAGE_TOKEN_OVERHEAD + estimateContentTokens(message.content),
    0,
  );
}

export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateContentTokens(content: string | CanonicalContentBlock[]): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  return content.reduce(
    (total, block) => total + CONTENT_BLOCK_TOKEN_OVERHEAD + estimateBlockTokens(block),
    0,
  );
}

function estimateBlockTokens(block: CanonicalContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTextTokens(block.text);
    case "tool_result":
      return typeof block.content === "string"
        ? estimateTextTokens(block.content)
        : estimateContentTokens(block.content);
    case "tool_use":
      return estimateTextTokens(JSON.stringify(block.input)) + estimateTextTokens(block.name);
    case "reasoning":
      return estimateTextTokens(block.text);
    case "reasoning_redacted":
      return estimateTextTokens(JSON.stringify(block.providerData ?? {}));
    case "image":
      return estimateTextTokens(block.source.data);
  }
}

function normalizeAutoCompactionRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_AUTO_COMPACTION_RATIO;
  }
  return Math.min(value, DEFAULT_AUTO_COMPACTION_RATIO);
}

function resolveEffectiveInputBudgetTokens(args: {
  enabled: boolean;
  requestKind: ContextBudgetRequestKind;
  thresholdTokens: number | null;
  usableInputWindowTokens: number | null;
}): number | null {
  if (args.usableInputWindowTokens === null) {
    return null;
  }
  if (args.requestKind === "compaction_summary") {
    return args.usableInputWindowTokens;
  }
  if (args.enabled && args.thresholdTokens !== null) {
    return args.thresholdTokens;
  }
  return args.usableInputWindowTokens;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
