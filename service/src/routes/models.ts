/**
 * Models API - Returns catalog-backed LLM models and their capabilities.
 */

import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  getDefaultModelEntryForProviders,
  getReasoningLevelOptions,
  listCatalogEntriesForProviders,
  providerRegistry,
  resolveEffectiveModelSelection,
  type ModelCatalogEntry,
  type ReasoningLevel,
} from "../llm/index.js";
import { requireViewer } from "../auth/session.js";

type ModelInfo = {
  id: string;
  provider: string;
  provider_model: string;
  display_name: string;
  is_default: boolean;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    structured_outputs: boolean;
    context_window_tokens: number;
    max_output_tokens: number;
  };
  reasoning: {
    kind: ModelCatalogEntry["reasoning"]["kind"];
    levels: Array<{
      value: string;
      label: string;
    }>;
    default_level: string;
  };
};

type ModelsResponseDefaults = {
  serviceDefaultModel: string | null;
  defaultModel: string | null;
  defaultReasoningEffort: ReasoningLevel | null;
};

function resolveModelsResponseDefaults(providerNames: string[]): ModelsResponseDefaults {
  try {
    const serviceDefault = resolveEffectiveModelSelection({
      serviceDefaultModel: config.defaultModel,
      validateAvailability: false,
    });

    return {
      serviceDefaultModel: serviceDefault.model,
      defaultModel: serviceDefault.model,
      defaultReasoningEffort: serviceDefault.reasoningEffort,
    };
  } catch {
    const fallback = getDefaultModelEntryForProviders(providerNames);
    return {
      serviceDefaultModel: null,
      defaultModel: fallback?.id ?? null,
      defaultReasoningEffort: fallback?.reasoning.defaultLevel ?? null,
    };
  }
}

export async function registerModelsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/models
   * Returns catalog-backed LLM models with their capabilities.
   */
  server.get("/api/models", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const providerNames = providerRegistry.listProviders();
    const defaults = resolveModelsResponseDefaults(providerNames);
    const models: ModelInfo[] = listCatalogEntriesForProviders(providerNames).map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      provider_model: entry.providerModel,
      display_name: entry.displayName,
      is_default: defaults.defaultModel === entry.id,
      capabilities: {
        vision: entry.capabilities.vision,
        tools: entry.capabilities.tools,
        streaming: entry.capabilities.streaming,
        structured_outputs: entry.capabilities.structuredOutputs,
        context_window_tokens: entry.capabilities.contextWindowTokens,
        max_output_tokens: entry.capabilities.maxOutputTokens,
      },
      reasoning: {
        kind: entry.reasoning.kind,
        levels: getReasoningLevelOptions(entry),
        default_level: entry.reasoning.defaultLevel,
      },
    }));

    return reply.send({
      models,
      service_default_model: defaults.serviceDefaultModel,
      default_model: defaults.defaultModel,
      default_reasoning_effort: defaults.defaultReasoningEffort,
    });
  });
}
