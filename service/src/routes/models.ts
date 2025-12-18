/**
 * Models API - Returns available LLM models and their capabilities.
 */

import type { FastifyInstance } from "fastify";
import { providerRegistry } from "../llm/index.js";
import { config } from "../config.js";

type ModelInfo = {
  id: string;
  provider: string;
  displayName: string;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    reasoning: boolean;
    thinking: boolean;
  };
  isAlias?: boolean;
  aliasTarget?: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  // OpenAI GPT-5 series (aliases - shown in UI)
  "gpt-5.2": "GPT-5.2",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5-nano": "GPT-5 Nano",
  // OpenAI GPT-5 series (dated versions - for model list)
  "gpt-5.2-2025-12-11": "GPT-5.2 (Dec 2025)",
  "gpt-5-mini-2025-08-07": "GPT-5 Mini (Aug 2025)",
  "gpt-5-nano-2025-08-07": "GPT-5 Nano (Aug 2025)",
  // Anthropic official aliases (point to latest versions)
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Anthropic versioned models
  "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet (Oct 2024)",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku (Oct 2024)",
  "claude-3-opus-20240229": "Claude 3 Opus (Feb 2024)",
  "claude-3-sonnet-20240229": "Claude 3 Sonnet (Feb 2024)",
  "claude-3-haiku-20240307": "Claude 3 Haiku (Mar 2024)",
  "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5 (Sep 2025)",
  "claude-opus-4-5-20251101": "Claude Opus 4.5 (Nov 2025)",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5 (Oct 2025)",
};

function getDisplayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] ?? modelId;
}

// Provider display order (lower = first)
const PROVIDER_ORDER: Record<string, number> = {
  anthropic: 0,
  openai: 1,
};

export async function registerModelsRoutes(server: FastifyInstance): Promise<void> {
  /**
   * GET /api/models
   * Returns available LLM models with their capabilities.
   */
  server.get("/api/models", async (_request, reply) => {
    const models: ModelInfo[] = [];

    // Get models from each registered provider
    for (const providerName of providerRegistry.listProviders()) {
      const provider = providerRegistry.getProvider(providerName);
      if (!provider) continue;

      for (const modelId of provider.supportedModels) {
        const capabilities = provider.getModelCapabilities(modelId);
        models.push({
          id: modelId,
          provider: providerName,
          displayName: getDisplayName(modelId),
          capabilities: {
            vision: capabilities.supportsVision,
            tools: capabilities.supportsTools,
            streaming: capabilities.supportsStreaming,
            reasoning: capabilities.supportsReasoning,
            thinking: capabilities.supportsThinking ?? false,
          },
        });
      }
    }

    // Add aliases
    const aliases = providerRegistry.listAliases();
    for (const [alias, target] of Object.entries(aliases)) {
      const targetModel = models.find((m) => m.id === target);
      if (targetModel) {
        models.push({
          ...targetModel,
          id: alias,
          displayName: getDisplayName(alias),
          isAlias: true,
          aliasTarget: target,
        });
      }
    }

    // Sort by provider order (Anthropic first, then OpenAI)
    models.sort((a, b) => {
      const orderA = PROVIDER_ORDER[a.provider] ?? 99;
      const orderB = PROVIDER_ORDER[b.provider] ?? 99;
      return orderA - orderB;
    });

    return reply.send({
      models,
      defaultModel: config.defaultModel,
    });
  });
}
