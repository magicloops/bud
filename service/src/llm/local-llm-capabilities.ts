import {
  getCatalogEntry,
  registerDynamicCatalogEntries,
  clearDynamicCatalogEntries,
  type ModelCatalogEntry,
} from "./model-catalog.js";

export const BUD_LOCAL_DS4_PRODUCT_MODEL_ID = "ds4-deepseek-v4-flash";
export const BUD_LOCAL_DS4_PROVIDER_MODEL = "deepseek-v4-flash";
export const BUD_LOCAL_DS4_REQUEST_MODE = "ds4_openai_responses";
export const BUD_LOCAL_DS4_COMPATIBILITY = ["openai_responses"] as const;

export type BudLocalDs4Model = {
  entry: ModelCatalogEntry;
  providerModel: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
};

export function isDs4ProductModel(model: string): boolean {
  return getCatalogEntry(model)?.provider === "ds4" || model === BUD_LOCAL_DS4_PRODUCT_MODEL_ID;
}

export function listHealthyBudLocalDs4Models(capabilities: unknown): BudLocalDs4Model[] {
  const server = getHealthyBudLocalDs4Server(capabilities);
  if (!server) {
    return [];
  }

  const entry = getCatalogEntry(BUD_LOCAL_DS4_PRODUCT_MODEL_ID);
  if (!entry) {
    return [];
  }

  const advertisedModels = Array.isArray(server.models) ? server.models : [];
  const advertised = advertisedModels.find(
    (model): model is Record<string, unknown> =>
      isRecord(model) && model.id === BUD_LOCAL_DS4_PROVIDER_MODEL,
  );
  const advertisedContextWindowTokens = positiveIntegerOrNull(
    advertised?.context_window_tokens,
  );
  const advertisedMaxOutputTokens = positiveIntegerOrNull(advertised?.max_output_tokens);
  const catalogMaxOutputTokens = entry.capabilities.maxOutputTokens;

  return [
    {
      entry,
      providerModel: BUD_LOCAL_DS4_PROVIDER_MODEL,
      displayName:
        typeof advertised?.display_name === "string" ? advertised.display_name : entry.displayName,
      contextWindowTokens:
        advertisedContextWindowTokens !== null
          ? advertisedContextWindowTokens
          : entry.capabilities.contextWindowTokens,
      maxOutputTokens:
        advertisedMaxOutputTokens !== null
          ? Math.min(advertisedMaxOutputTokens, catalogMaxOutputTokens)
          : catalogMaxOutputTokens,
    },
  ];
}

export function hasHealthyBudLocalDs4Capability(capabilities: unknown): boolean {
  return getHealthyBudLocalDs4Server(capabilities) !== null;
}

function getHealthyBudLocalDs4Server(capabilities: unknown): Record<string, unknown> | null {
  if (!isRecord(capabilities) || !isRecord(capabilities.llm)) {
    return null;
  }
  const servers = capabilities.llm.servers;
  if (!Array.isArray(servers)) {
    return null;
  }
  for (const server of servers) {
    if (!isRecord(server)) {
      continue;
    }
    const compatibility = Array.isArray(server.compatibility) ? server.compatibility : [];
    if (
      server.id === "ds4" &&
      server.provider === "ds4" &&
      server.healthy === true &&
      server.request_mode === BUD_LOCAL_DS4_REQUEST_MODE &&
      server.generation_path === "/v1/responses" &&
      compatibility.includes("openai_responses")
    ) {
      return server;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic bud-local models (design/generic-local-llm-support.md)
// ═══════════════════════════════════════════════════════════════════════════

export const BUD_LOCAL_MODEL_ID_PREFIX = "bud-local:";
export const BUD_LOCAL_GENERIC_REQUEST_MODE = "openai_chat_completions";
const BUD_LOCAL_DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;
const BUD_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const BUD_LOCAL_MAX_CONTEXT_WINDOW_TOKENS = 1_048_576;

export type BudLocalModelId = { budId: string; servedModelId: string };

export function formatBudLocalModelId(budId: string, servedModelId: string): string {
  return `${BUD_LOCAL_MODEL_ID_PREFIX}${budId}:${servedModelId}`;
}

/** `bud-local:<bud_id>:<served id>` — served ids may contain colons. */
export function parseBudLocalModelId(modelId: string): BudLocalModelId | null {
  if (!modelId.startsWith(BUD_LOCAL_MODEL_ID_PREFIX)) {
    return null;
  }
  const rest = modelId.slice(BUD_LOCAL_MODEL_ID_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split === rest.length - 1) {
    return null;
  }
  return { budId: rest.slice(0, split), servedModelId: rest.slice(split + 1) };
}

export type BudLocalAdvertisedModel = {
  id: string;
  displayName: string;
  contextWindowTokens: number | null;
  validated: boolean;
};

/** The generic bud-local server entry (provider `bud_local`, id `local`). */
export function getHealthyBudLocalGenericServer(
  capabilities: unknown,
): Record<string, unknown> | null {
  if (!isRecord(capabilities) || !isRecord(capabilities.llm)) {
    return null;
  }
  const servers = capabilities.llm.servers;
  if (!Array.isArray(servers)) {
    return null;
  }
  for (const server of servers) {
    if (!isRecord(server)) {
      continue;
    }
    const compatibility = Array.isArray(server.compatibility) ? server.compatibility : [];
    if (
      server.id === "local" &&
      server.provider === "bud_local" &&
      server.healthy === true &&
      server.request_mode === BUD_LOCAL_GENERIC_REQUEST_MODE &&
      server.generation_path === "/v1/chat/completions" &&
      compatibility.includes(BUD_LOCAL_GENERIC_REQUEST_MODE)
    ) {
      return server;
    }
  }
  return null;
}

/**
 * Generic (experimental) models a bud advertises: everything on the generic
 * server EXCEPT validated families, which surface through their curated
 * catalog entries instead (ds4 today).
 */
export function listBudLocalGenericModels(
  capabilities: unknown,
): BudLocalAdvertisedModel[] {
  const server = getHealthyBudLocalGenericServer(capabilities);
  if (!server) {
    return [];
  }
  const models = Array.isArray(server.models) ? server.models : [];
  const out: BudLocalAdvertisedModel[] = [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== "string") {
      continue;
    }
    if (model.validated === true) {
      continue; // validated families surface via their curated entries
    }
    out.push({
      id: model.id,
      displayName:
        typeof model.display_name === "string" ? model.display_name : model.id,
      contextWindowTokens: positiveIntegerOrNull(model.context_window_tokens),
      validated: false,
    });
  }
  return out;
}

/** Synthesized (experimental) catalog entry for a generic bud-local model. */
export function synthesizeBudLocalCatalogEntry(
  budId: string,
  model: BudLocalAdvertisedModel,
): ModelCatalogEntry {
  const contextWindowTokens = Math.min(
    model.contextWindowTokens ?? BUD_LOCAL_DEFAULT_CONTEXT_WINDOW_TOKENS,
    BUD_LOCAL_MAX_CONTEXT_WINDOW_TOKENS,
  );
  const maxOutputTokens = Math.min(
    BUD_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
    Math.max(1_024, Math.floor(contextWindowTokens / 2)),
  );
  return {
    id: formatBudLocalModelId(budId, model.id),
    provider: "bud_local",
    providerModel: model.id,
    displayName: model.displayName,
    family: "local",
    tier: "local",
    sortOrder: 1_000,
    capabilities: {
      vision: false,
      // The agent requires tools; assumed until the validation gate exists.
      tools: true,
      streaming: true,
      structuredOutputs: false,
      contextWindowTokens,
      maxOutputTokens,
      reservedOutputTokens: maxOutputTokens,
    },
    reasoning: { kind: "none", levels: ["none"], defaultLevel: "none" },
  };
}

/**
 * Refresh the dynamic catalog for a bud from its capabilities. Called on
 * capability ingest (hello); entries persist across disconnects so threads
 * referencing them keep resolving (invocation fails cleanly while offline).
 */
export function registerBudLocalModelsFromCapabilities(
  budId: string,
  capabilities: unknown,
): void {
  const models = listBudLocalGenericModels(capabilities);
  if (models.length === 0) {
    clearDynamicCatalogEntries(budId);
    return;
  }
  registerDynamicCatalogEntries(
    budId,
    models.map((model) => synthesizeBudLocalCatalogEntry(budId, model)),
  );
}

export function isExperimentalBudLocalModel(modelId: string): boolean {
  return parseBudLocalModelId(modelId) !== null;
}
