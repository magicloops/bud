import { config } from "../config.js";
import {
  getCatalogEntry,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalTool,
  type ModelCatalogEntry,
  type ResolvedModelReasoning,
} from "../llm/index.js";

// Codex parity (90% of the active window). Also the clamp: our trigger is a
// chars/4 estimate of the next request, and code tokenizes closer to 3
// chars/token, so the 10% margin absorbs estimate error.
const DEFAULT_AUTO_COMPACTION_RATIO = 0.9;
const MESSAGE_TOKEN_OVERHEAD = 8;
const CONTENT_BLOCK_TOKEN_OVERHEAD = 4;
const TOOL_SCHEMA_TOKEN_OVERHEAD = 8;

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

  // The output reserve protects the HARD window only (input + output must fit
  // the provider's advertised context). The usable cap (e.g. the 272K
  // pricing knee on GPT-5.6) is a limit on input usage in its own right, so
  // it is applied directly, never reduced by the reserve — subtracting the
  // reserve from it halved the GPT-5.6 budget to 144K
  // (design/context-window-output-reserve-correction.md).
  const hardInputWindowTokens = contextWindowTokens - reservedOutputTokens;
  const usableInputWindowTokens = Math.min(usableContextWindowTokens, hardInputWindowTokens);
  if (hardInputWindowTokens <= 0 || usableInputWindowTokens <= 0) {
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

/**
 * Markers the compactor writes into replacement history. They live here (not
 * in context-compactor.ts) so the breakdown estimator can recognise checkpoint
 * rows without importing the compactor.
 */
export const CHECKPOINT_SUMMARY_PREFIX = `
Another Bud Agent model compacted earlier context for this thread. Use this checkpoint to continue the task without repeating completed work. The visible transcript still exists in the product, but your model-visible context has been shortened. Summary:
`.trim();
export const COMPACTION_TERMINAL_CONTEXT_PREFIX = "Current terminal context at compaction time:";

/** Where the estimated input tokens go — the popover's "what is using the space" categories. */
export type ContextBreakdownKind =
  | "system_prompt"
  | "runtime_instructions"
  | "compaction_summary"
  | "user_messages"
  | "assistant_text"
  | "reasoning"
  | "tool_calls"
  | "tool_output"
  | "images"
  | "tool_schemas";

export const CONTEXT_BREAKDOWN_KINDS: readonly ContextBreakdownKind[] = [
  "system_prompt",
  "runtime_instructions",
  "compaction_summary",
  "user_messages",
  "assistant_text",
  "reasoning",
  "tool_calls",
  "tool_output",
  "images",
  "tool_schemas",
];

export type ContextBreakdownTokens = Record<ContextBreakdownKind, number>;

export function emptyContextBreakdown(): ContextBreakdownTokens {
  return {
    system_prompt: 0,
    runtime_instructions: 0,
    compaction_summary: 0,
    user_messages: 0,
    assistant_text: 0,
    reasoning: 0,
    tool_calls: 0,
    tool_output: 0,
    images: 0,
    tool_schemas: 0,
  };
}

/**
 * Per-category token estimate over the model-visible conversation, using the
 * same estimators (and the same per-message / per-block overheads) as the
 * compaction trigger, so the categories sum exactly to
 * estimateCanonicalMessagesTokens(messages). Tool schemas are not part of
 * the conversation and are added by the caller.
 */
export function estimateCanonicalMessagesBreakdown(messages: CanonicalMessage[]): ContextBreakdownTokens {
  const breakdown = emptyContextBreakdown();
  let systemPromptSeen = false;
  for (const message of messages) {
    let messageKind: ContextBreakdownKind;
    if (message.role === "system") {
      messageKind = systemPromptSeen ? "runtime_instructions" : "system_prompt";
      systemPromptSeen = true;
    } else if (message.role === "user") {
      messageKind = isCompactionReplacementMessage(message) ? "compaction_summary" : "user_messages";
    } else if (message.role === "assistant") {
      messageKind = "assistant_text";
    } else {
      messageKind = "tool_output";
    }
    breakdown[messageKind] += MESSAGE_TOKEN_OVERHEAD;

    if (typeof message.content === "string") {
      breakdown[messageKind] += estimateTextTokens(message.content);
      continue;
    }
    for (const block of message.content) {
      breakdown[blockBreakdownKind(block, messageKind)] += CONTENT_BLOCK_TOKEN_OVERHEAD + estimateBlockTokens(block);
    }
  }
  return breakdown;
}

export function estimateCanonicalMessagesTokens(messages: CanonicalMessage[]): number {
  const breakdown = estimateCanonicalMessagesBreakdown(messages);
  return CONTEXT_BREAKDOWN_KINDS.reduce((total, kind) => total + breakdown[kind], 0);
}

function blockBreakdownKind(block: CanonicalContentBlock, messageKind: ContextBreakdownKind): ContextBreakdownKind {
  switch (block.type) {
    case "text":
      return messageKind;
    case "tool_use":
      return "tool_calls";
    case "tool_result":
      return "tool_output";
    case "reasoning":
    case "reasoning_redacted":
      return "reasoning";
    case "image":
      return "images";
  }
}

function isCompactionReplacementMessage(message: CanonicalMessage): boolean {
  const text = typeof message.content === "string"
    ? message.content
    : message.content.find((block) => block.type === "text")?.text ?? "";
  const trimmed = text.trimStart();
  return trimmed.startsWith(CHECKPOINT_SUMMARY_PREFIX) || trimmed.startsWith(COMPACTION_TERMINAL_CONTEXT_PREFIX);
}

export function estimateCanonicalToolsTokens(tools: CanonicalTool[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return estimateTextTokens(JSON.stringify(tools)) + tools.length * TOOL_SCHEMA_TOKEN_OVERHEAD;
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
