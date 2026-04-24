export type ProviderId = "anthropic" | "openai";

export type ReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningControl =
  | {
      kind: "openai_reasoning_effort";
      levels: readonly ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      requestField: "reasoning.effort";
    }
  | {
      kind: "anthropic_output_effort";
      levels: readonly ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      requestField: "output_config.effort";
      thinking: "adaptive";
      thinkingDisplay: "summarized" | "omitted";
    }
  | {
      kind: "anthropic_thinking_budget";
      levels: readonly ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      budgets: Partial<Record<ReasoningLevel, number>>;
      thinking: "manual";
    }
  | {
      kind: "none";
      levels: readonly ["none"];
      defaultLevel: "none";
    };

export type ModelCatalogEntry = {
  id: string;
  provider: ProviderId;
  providerModel: string;
  displayName: string;
  family: "claude" | "gpt";
  tier: "frontier" | "balanced" | "fast";
  sortOrder: number;
  defaultForProvider?: boolean;
  globalDefault?: boolean;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    structuredOutputs: boolean;
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  reasoning: ReasoningControl;
};

export type ReasoningLevelOption = {
  value: ReasoningLevel;
  label: string;
};

const OPENAI_GPT_5_4_REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh"] as const;
const CLAUDE_4_6_REASONING_LEVELS = ["low", "medium", "high", "max"] as const;
const CLAUDE_OPUS_4_7_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_HAIKU_4_5_REASONING_LEVELS = ["none", "low", "medium", "high"] as const;

export const MODEL_CATALOG = [
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    providerModel: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    family: "claude",
    tier: "frontier",
    sortOrder: 10,
    defaultForProvider: true,
    globalDefault: true,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: false,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "anthropic_output_effort",
      levels: CLAUDE_4_6_REASONING_LEVELS,
      defaultLevel: "high",
      requestField: "output_config.effort",
      thinking: "adaptive",
      thinkingDisplay: "summarized",
    },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    providerModel: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    family: "claude",
    tier: "balanced",
    sortOrder: 20,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: false,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "anthropic_output_effort",
      levels: CLAUDE_4_6_REASONING_LEVELS,
      defaultLevel: "medium",
      requestField: "output_config.effort",
      thinking: "adaptive",
      thinkingDisplay: "summarized",
    },
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    providerModel: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    family: "claude",
    tier: "fast",
    sortOrder: 30,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: false,
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
    },
    reasoning: {
      kind: "anthropic_thinking_budget",
      levels: CLAUDE_HAIKU_4_5_REASONING_LEVELS,
      defaultLevel: "none",
      thinking: "manual",
      budgets: {
        low: 1_024,
        medium: 4_096,
        high: 16_384,
      },
    },
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    providerModel: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    family: "claude",
    tier: "frontier",
    sortOrder: 40,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: false,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "anthropic_output_effort",
      levels: CLAUDE_OPUS_4_7_REASONING_LEVELS,
      defaultLevel: "xhigh",
      requestField: "output_config.effort",
      thinking: "adaptive",
      thinkingDisplay: "omitted",
    },
  },
  {
    id: "gpt-5.4",
    provider: "openai",
    providerModel: "gpt-5.4-2026-03-05",
    displayName: "GPT-5.4",
    family: "gpt",
    tier: "frontier",
    sortOrder: 110,
    defaultForProvider: true,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "openai_reasoning_effort",
      levels: OPENAI_GPT_5_4_REASONING_LEVELS,
      defaultLevel: "none",
      requestField: "reasoning.effort",
    },
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    providerModel: "gpt-5.4-mini-2026-03-17",
    displayName: "GPT-5.4 Mini",
    family: "gpt",
    tier: "balanced",
    sortOrder: 120,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "openai_reasoning_effort",
      levels: OPENAI_GPT_5_4_REASONING_LEVELS,
      defaultLevel: "none",
      requestField: "reasoning.effort",
    },
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    providerModel: "gpt-5.4-nano-2026-03-17",
    displayName: "GPT-5.4 Nano",
    family: "gpt",
    tier: "fast",
    sortOrder: 130,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "openai_reasoning_effort",
      levels: OPENAI_GPT_5_4_REASONING_LEVELS,
      defaultLevel: "none",
      requestField: "reasoning.effort",
    },
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    providerModel: "gpt-5.5",
    displayName: "GPT-5.5",
    family: "gpt",
    tier: "frontier",
    sortOrder: 140,
    capabilities: {
      vision: true,
      tools: true,
      streaming: true,
      structuredOutputs: true,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    },
    reasoning: {
      kind: "openai_reasoning_effort",
      levels: OPENAI_GPT_5_4_REASONING_LEVELS,
      defaultLevel: "none",
      requestField: "reasoning.effort",
    },
  },
] as const satisfies readonly ModelCatalogEntry[];

const MODEL_CATALOG_BY_ID = new Map<string, ModelCatalogEntry>(
  MODEL_CATALOG.map((entry): [string, ModelCatalogEntry] => [entry.id, entry]),
);
const MODEL_CATALOG_BY_PROVIDER_MODEL = new Map<string, ModelCatalogEntry>(
  MODEL_CATALOG.map((entry): [string, ModelCatalogEntry] => [entry.providerModel, entry]),
);

export function listCatalogEntries(): ModelCatalogEntry[] {
  return [...MODEL_CATALOG].sort((left, right) => left.sortOrder - right.sortOrder);
}

export function listCatalogEntriesForProviders(providers: Iterable<string>): ModelCatalogEntry[] {
  const providerSet = new Set(providers);
  return listCatalogEntries().filter((entry) => providerSet.has(entry.provider));
}

export function getCatalogEntry(modelId: string): ModelCatalogEntry | null {
  return MODEL_CATALOG_BY_ID.get(modelId) ?? MODEL_CATALOG_BY_PROVIDER_MODEL.get(modelId) ?? null;
}

export function resolveProviderModel(modelId: string): string {
  return getCatalogEntry(modelId)?.providerModel ?? modelId;
}

export function getGlobalDefaultModelEntry(): ModelCatalogEntry {
  const globalDefaults = listCatalogEntries().filter((entry) => entry.globalDefault);
  if (globalDefaults.length !== 1) {
    throw new Error(`Expected exactly one global default model, found ${globalDefaults.length}`);
  }
  return globalDefaults[0];
}

export function getDefaultModelEntryForProviders(providers: Iterable<string>): ModelCatalogEntry | null {
  const entries = listCatalogEntriesForProviders(providers);
  const globalDefault = entries.find((entry) => entry.globalDefault);
  if (globalDefault) {
    return globalDefault;
  }
  return entries.find((entry) => entry.defaultForProvider) ?? entries[0] ?? null;
}

export function formatReasoningLevel(level: ReasoningLevel): string {
  switch (level) {
    case "none":
      return "Fast";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
  }
}

export function getReasoningLevelOptions(entry: ModelCatalogEntry): ReasoningLevelOption[] {
  return entry.reasoning.levels.map((level) => ({
    value: level,
    label: formatReasoningLevel(level),
  }));
}
