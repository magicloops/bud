import { getCatalogEntry, type ModelCatalogEntry } from "./model-catalog.js";

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
