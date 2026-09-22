import { createHash } from "node:crypto";
import type { CanonicalMessage, CanonicalTool, ReasoningConfig } from "../llm/types.js";
import { estimateCanonicalMessagesTokens } from "./context-budget.js";
import { hydratedImageIds } from "../browser/image-references.js";
import type { ContextBudgetProviderUsageEstimate } from "./context-budget-state.js";

/** Small request-boundary record; no prompt text or image bytes are persisted. */
export type ContextRequestBaseline = {
  version: 1;
  identity: string;
  prefix_hash: string;
  message_count: number;
  /** Screenshot artifacts hydrated into the measured request, in order. */
  image_ids?: string[];
};
export type ContextUsageAnchor = {
  llmCallId: string;
  baseline: unknown;
  usage: unknown;
};
export type ContextRequestIdentity = {
  provider: string;
  model: string;
  reasoning: ReasoningConfig;
  requestMode: string;
  checkpointId: string | null;
  tools: CanonicalTool[];
};

// Stable key ordering survives JSONB persistence. Array order is meaningful.
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item)).digest("hex");
}

export function captureContextBaseline(
  messages: CanonicalMessage[], identity: ContextRequestIdentity,
): ContextRequestBaseline {
  return { version: 1, identity: digest(identity), prefix_hash: digest(messages), message_count: messages.length,
    image_ids: hydratedImageIds(messages) };
}

export function resolveContextAccounting(args: {
  conversation: CanonicalMessage[];
  identity?: ContextRequestIdentity;
  anchor?: ContextUsageAnchor | null;
  fallbackTokens: number;
}): { tokens: number; providerUsage: ContextBudgetProviderUsageEstimate | null; fallbackReason: string | null } {
  const fallback = (fallbackReason: string) => ({ tokens: args.fallbackTokens, providerUsage: null, fallbackReason });
  if (!args.anchor || !args.identity) return fallback("no_anchor");
  const baseline = args.anchor.baseline as Partial<ContextRequestBaseline> | null;
  if (!baseline || baseline.version !== 1 || !Number.isSafeInteger(baseline.message_count) ||
      baseline.message_count! < 0 || baseline.message_count! > args.conversation.length ||
      typeof baseline.prefix_hash !== "string") return fallback("invalid_baseline");
  if (baseline.identity !== digest(args.identity)) return fallback("request_changed");
  if (baseline.prefix_hash !== digest(args.conversation.slice(0, baseline.message_count))) return fallback("prefix_changed");
  // The measured request carried a specific set of hydrated screenshots. Newer
  // references push older ones out of the eight-image window, so the anchor
  // only stands while the prefix still hydrates exactly the images it measured;
  // new references in the suffix are estimated at the per-image constant.
  const anchored = Array.isArray(baseline.image_ids) ? baseline.image_ids : null;
  const current = hydratedImageIds(args.conversation, baseline.message_count!);
  if (anchored === null ? current.length > 0 : digest(anchored) !== digest(current)) return fallback("image_hydration");
  const usage = args.anchor.usage as Record<string, unknown> | null;
  const input = contextInputTokens(args.identity.provider, usage);
  if (input === null) return fallback("usage_unavailable");
  const delta = estimateCanonicalMessagesTokens(args.conversation.slice(baseline.message_count));
  const tokens = input + delta;
  return { tokens, fallbackReason: null, providerUsage: {
    estimated_input_tokens: tokens, input_tokens: input,
    output_tokens: nonNegative(usage?.output_tokens) ?? 0,
    ...(nonNegative(usage?.reasoning_tokens) !== null ? { reasoning_tokens: usage!.reasoning_tokens as number } : {}),
    delta_tokens: delta, llm_call_id: args.anchor.llmCallId,
    confidence: delta === 0 ? "high" : "medium",
  } };
}

/** Canonical Anthropic input excludes cache reads/writes; Responses includes cached input. */
export function contextInputTokens(provider: string, usage: Record<string, unknown> | null): number | null {
  const input = nonNegative(usage?.input_tokens);
  if (input === null) return null;
  let total = input;
  if (provider === "anthropic") {
    for (const key of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
      const value = usage?.[key];
      const count = value === undefined ? 0 : nonNegative(value);
      if (count === null) return null;
      total += count;
    }
  } else if (!["openai", "ds4"].includes(provider)) return null;
  // Adapters sometimes synthesize zero when the endpoint omitted usage.
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}
function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
