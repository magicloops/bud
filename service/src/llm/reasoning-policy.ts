import type { ReasoningConfig } from "./types.js";
import {
  getCatalogEntry,
  type ModelCatalogEntry,
  type ReasoningLevel,
} from "./model-catalog.js";
import { providerRegistry } from "./registry.js";

export class InvalidModelSelectionError extends Error {
  readonly code = "invalid_model";
  readonly model: string;

  constructor(model: string, message = `Model is not available: ${model}`) {
    super(message);
    this.name = "InvalidModelSelectionError";
    this.model = model;
  }
}

export class InvalidReasoningEffortError extends Error {
  readonly code = "invalid_reasoning_effort";
  readonly model: string;
  readonly requested: string;
  readonly supportedValues: ReasoningLevel[];

  constructor(model: string, requested: string, supportedValues: readonly ReasoningLevel[]) {
    super(`Reasoning effort ${requested} is not supported by ${model}`);
    this.name = "InvalidReasoningEffortError";
    this.model = model;
    this.requested = requested;
    this.supportedValues = [...supportedValues];
  }
}

export type ResolvedModelReasoning = {
  requestedModel: string;
  entry: ModelCatalogEntry | null;
  providerName: string;
  providerModel: string;
  reasoningLevel: ReasoningLevel;
  reasoning: ReasoningConfig;
};

export type ModelSelectionSource = "explicit_request" | "thread" | "service_default";

export type EffectiveModelSelection = {
  model: string;
  reasoningEffort: ReasoningLevel;
  source: ModelSelectionSource;
  modelReasoning: ResolvedModelReasoning;
  storedModelValid: boolean;
};

export type ResolveEffectiveModelSelectionInput = {
  requestedModel?: string | null;
  requestedReasoning?: string | null;
  threadModel?: string | null;
  threadReasoning?: string | null;
  serviceDefaultModel: string;
  serviceDefaultReasoning?: ReasoningLevel;
  validateAvailability?: boolean;
};

const REASONING_LEVELS = new Set<ReasoningLevel>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ALL_REASONING_LEVELS = [...REASONING_LEVELS];

type ParsedReasoningLevel =
  | { kind: "level"; value: ReasoningLevel }
  | { kind: "omitted" }
  | { kind: "invalid"; value: string };

export function isModelSelectionError(
  error: unknown,
): error is InvalidModelSelectionError | InvalidReasoningEffortError {
  return error instanceof InvalidModelSelectionError || error instanceof InvalidReasoningEffortError;
}

export function resolveModelReasoning(
  model: string,
  requested?: ReasoningLevel | null,
  defaultReasoning: ReasoningLevel = "none",
): ResolvedModelReasoning {
  const entry = getCatalogEntry(model);
  const providerModel = providerRegistry.resolveModelAlias(model);
  let providerName: string;

  try {
    providerName = providerRegistry.getProviderForModel(model).name;
  } catch (error) {
    throw new InvalidModelSelectionError(
      model,
      error instanceof Error ? error.message : `Model is not available: ${model}`,
    );
  }

  if (!entry) {
    const level = requested ?? defaultReasoning;
    return {
      requestedModel: model,
      entry,
      providerName,
      providerModel,
      reasoningLevel: level,
      reasoning: buildReasoningConfig(level),
    };
  }

  const level = requested ?? entry.reasoning.defaultLevel;
  const supportedLevels: readonly ReasoningLevel[] = entry.reasoning.levels;
  if (!supportedLevels.includes(level)) {
    throw new InvalidReasoningEffortError(entry.id, level, supportedLevels);
  }

  return {
    requestedModel: model,
    entry,
    providerName,
    providerModel: entry.providerModel,
    reasoningLevel: level,
    reasoning: buildReasoningConfig(level),
  };
}

export function resolveEffectiveModelSelection(
  input: ResolveEffectiveModelSelectionInput,
): EffectiveModelSelection {
  const validateAvailability = input.validateAvailability ?? true;
  const defaultReasoning = input.serviceDefaultReasoning ?? "low";

  if (input.requestedModel !== undefined) {
    const requestedModel = normalizeModelId(input.requestedModel);
    if (!requestedModel) {
      throw new InvalidModelSelectionError("null", "Model is required");
    }

    const requestedReasoning = parseReasoningLevel(input.requestedReasoning);
    const modelReasoning = resolveCandidateOrThrow(
      requestedModel,
      requestedReasoning,
      defaultReasoning,
      validateAvailability,
    );

    return {
      model: modelReasoning.entry?.id ?? requestedModel,
      reasoningEffort: modelReasoning.reasoningLevel,
      source: "explicit_request",
      modelReasoning,
      storedModelValid: true,
    };
  }

  const threadModel = normalizeModelId(input.threadModel);
  if (threadModel) {
    const threadReasoning = parseReasoningLevel(input.threadReasoning);
    const modelReasoning = resolveCandidateOrNull(
      threadModel,
      threadReasoning,
      defaultReasoning,
      validateAvailability,
    );

    if (modelReasoning) {
      return {
        model: modelReasoning.entry?.id ?? threadModel,
        reasoningEffort: modelReasoning.reasoningLevel,
        source: "thread",
        modelReasoning,
        storedModelValid: true,
      };
    }
  }

  const modelReasoning = resolveCandidateOrThrow(
    input.serviceDefaultModel,
    { kind: "level", value: defaultReasoning },
    defaultReasoning,
    validateAvailability,
  );

  return {
    model: modelReasoning.entry?.id ?? input.serviceDefaultModel,
    reasoningEffort: modelReasoning.reasoningLevel,
    source: "service_default",
    modelReasoning,
    storedModelValid: !threadModel,
  };
}

function normalizeModelId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseReasoningLevel(value: string | null | undefined): ParsedReasoningLevel {
  if (value === null || value === undefined || value.trim() === "") {
    return { kind: "omitted" };
  }
  const normalized = value.toLowerCase() as ReasoningLevel;
  return REASONING_LEVELS.has(normalized)
    ? { kind: "level", value: normalized }
    : { kind: "invalid", value };
}

function reasoningLevelOrNull(reasoning: ParsedReasoningLevel): ReasoningLevel | null {
  return reasoning.kind === "level" ? reasoning.value : null;
}

function throwInvalidReasoning(model: string, requested: string): never {
  const entry = getCatalogEntry(model);
  throw new InvalidReasoningEffortError(
    entry?.id ?? model,
    requested,
    entry?.reasoning.levels ?? ALL_REASONING_LEVELS,
  );
}

function resolveCandidateOrThrow(
  model: string,
  reasoning: ParsedReasoningLevel,
  defaultReasoning: ReasoningLevel,
  validateAvailability: boolean,
): ResolvedModelReasoning {
  if (reasoning.kind === "invalid") {
    throwInvalidReasoning(model, reasoning.value);
  }

  const requestedReasoning = reasoningLevelOrNull(reasoning);
  const resolved = validateAvailability
    ? resolveModelReasoning(model, requestedReasoning, defaultReasoning)
    : resolveCatalogModelReasoningOrThrow(model, requestedReasoning);

  if (!resolved) {
    throw new InvalidModelSelectionError(model);
  }

  return resolved;
}

function resolveCandidateOrNull(
  model: string,
  reasoning: ParsedReasoningLevel,
  defaultReasoning: ReasoningLevel,
  validateAvailability: boolean,
): ResolvedModelReasoning | null {
  if (reasoning.kind === "invalid") {
    return null;
  }

  const requestedReasoning = reasoningLevelOrNull(reasoning);
  try {
    return validateAvailability
      ? resolveModelReasoning(model, requestedReasoning, defaultReasoning)
      : resolveCatalogModelReasoning(model, requestedReasoning);
  } catch (error) {
    if (isModelSelectionError(error)) {
      return null;
    }
    throw error;
  }
}

function resolveCatalogModelReasoning(
  model: string,
  requested: ReasoningLevel | null,
): ResolvedModelReasoning | null {
  const entry = getCatalogEntry(model);
  if (!entry) {
    return null;
  }

  const level = requested ?? entry.reasoning.defaultLevel;
  const supportedLevels: readonly ReasoningLevel[] = entry.reasoning.levels;
  if (!supportedLevels.includes(level)) {
    return null;
  }

  return {
    requestedModel: model,
    entry,
    providerName: entry.provider,
    providerModel: entry.providerModel,
    reasoningLevel: level,
    reasoning: buildReasoningConfig(level),
  };
}

function resolveCatalogModelReasoningOrThrow(
  model: string,
  requested: ReasoningLevel | null,
): ResolvedModelReasoning | null {
  const entry = getCatalogEntry(model);
  if (!entry) {
    return null;
  }

  const level = requested ?? entry.reasoning.defaultLevel;
  const supportedLevels: readonly ReasoningLevel[] = entry.reasoning.levels;
  if (!supportedLevels.includes(level)) {
    throw new InvalidReasoningEffortError(entry.id, level, supportedLevels);
  }

  return {
    requestedModel: model,
    entry,
    providerName: entry.provider,
    providerModel: entry.providerModel,
    reasoningLevel: level,
    reasoning: buildReasoningConfig(level),
  };
}

function buildReasoningConfig(level: ReasoningLevel): ReasoningConfig {
  if (level === "none") {
    return { enabled: false };
  }

  return {
    enabled: true,
    effort: level,
    summaryLevel: "auto",
  };
}
