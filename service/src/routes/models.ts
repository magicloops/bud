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
import { resolveModelContextPolicy } from "../agent/context-budget.js";

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
    usable_context_window_tokens: number | null;
    reserved_output_tokens: number | null;
    usable_input_window_tokens: number | null;
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
    const models: ModelInfo[] = listCatalogEntriesForProviders(providerNames).map((entry) => {
      const contextPolicy = resolveModelContextPolicy(entry);
      return {
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
          usable_context_window_tokens: contextPolicy.usableContextWindowTokens,
          reserved_output_tokens: contextPolicy.reservedOutputTokens,
          usable_input_window_tokens: contextPolicy.usableInputWindowTokens,
          max_output_tokens: entry.capabilities.maxOutputTokens,
        },
        reasoning: {
          kind: entry.reasoning.kind,
          levels: getReasoningLevelOptions(entry),
          default_level: entry.reasoning.defaultLevel,
        },
      };
    });

    return reply.send({
      models,
      service_default_model: defaults.serviceDefaultModel,
      default_model: defaults.defaultModel,
      default_reasoning_effort: defaults.defaultReasoningEffort,
    });
  });
}
