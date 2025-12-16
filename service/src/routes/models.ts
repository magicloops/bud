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
  // OpenAI
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4.1": "GPT-4.1",
  "gpt-4.1-mini": "GPT-4.1 Mini",
  "gpt-4.1-nano": "GPT-4.1 Nano",
  "gpt-5": "GPT-5",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
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

    return reply.send({
      models,
      defaultModel: config.defaultModel,
    });
  });
}
