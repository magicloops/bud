/**
 * Models API - Returns catalog-backed LLM models and their capabilities.
 */

import type { FastifyInstance } from "fastify";
import {
  getDefaultModelEntryForProviders,
  getReasoningLevelOptions,
  listCatalogEntriesForProviders,
  providerRegistry,
  type ModelCatalogEntry,
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
    const defaultEntry = getDefaultModelEntryForProviders(providerNames);
    const models: ModelInfo[] = listCatalogEntriesForProviders(providerNames).map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      provider_model: entry.providerModel,
      display_name: entry.displayName,
      is_default: defaultEntry?.id === entry.id,
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
      default_model: defaultEntry?.id ?? null,
    });
  });
}
