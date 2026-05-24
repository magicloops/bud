import { config } from "../config.js";
import {
  getCatalogEntry,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type ResolvedModelReasoning,
} from "../llm/index.js";

const DEFAULT_AUTO_COMPACTION_RATIO = 0.9;
const MESSAGE_TOKEN_OVERHEAD = 8;
const CONTENT_BLOCK_TOKEN_OVERHEAD = 4;

export type ContextBudget = {
  enabled: boolean;
  contextWindowTokens: number | null;
  thresholdRatio: number;
  thresholdTokens: number | null;
};

export function resolveContextBudget(args: {
  model: string;
  modelReasoning: ResolvedModelReasoning;
}): ContextBudget {
  const contextWindowTokens =
    getCatalogEntry(args.model)?.capabilities.contextWindowTokens ??
    getCatalogEntry(args.modelReasoning.providerModel)?.capabilities.contextWindowTokens ??
    null;
  const thresholdRatio = normalizeAutoCompactionRatio(config.agentAutoCompactionRatio);
  return {
    enabled: config.agentAutoCompactionEnabled,
    contextWindowTokens,
    thresholdRatio,
    thresholdTokens: contextWindowTokens
      ? Math.floor(contextWindowTokens * thresholdRatio)
      : null,
  };
}

export function shouldCompactContext(args: {
  estimatedTokens: number;
  budget: ContextBudget;
}): boolean {
  return Boolean(
    args.budget.enabled &&
    args.budget.thresholdTokens &&
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
