/**
 * Models API - Returns catalog-backed LLM models and their capabilities.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
import {
  BUD_LOCAL_DS4_COMPATIBILITY,
  BUD_LOCAL_DS4_REQUEST_MODE,
  listHealthyBudLocalDs4Models,
} from "../llm/local-llm-capabilities.js";
import { getAuthorizedBud, requireViewer } from "../auth/session.js";
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
  request_mode?: string;
  compatibility?: string[];
  source?: {
    kind: "service_local_dev";
  } | {
    kind: "bud_local";
    bud_id: string;
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

const ModelsQuerySchema = z.object({
  bud_id: z.string().min(1).optional(),
});

function listGloballyVisibleProviders(): string[] {
  return providerRegistry
    .listProviders()
    .filter((providerName) => providerName !== "ds4" || Boolean(config.ds4DirectBaseUrl));
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

    const query = ModelsQuerySchema.parse(request.query ?? {});
    const providerNames = listGloballyVisibleProviders();
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
        ...(entry.provider === "ds4"
          ? {
              source: {
                kind: "service_local_dev" as const,
              },
              request_mode: BUD_LOCAL_DS4_REQUEST_MODE,
              compatibility: [...BUD_LOCAL_DS4_COMPATIBILITY],
            }
          : {}),
      };
    });

    if (query.bud_id) {
      const bud = await getAuthorizedBud(viewer, query.bud_id);
      if (!bud) {
        reply.code(404).send({ error: "bud_not_found" });
        return;
      }

      const existingIds = new Set(models.map((model) => model.id));
      const localModels =
        bud.status === "online" ? listHealthyBudLocalDs4Models(bud.capabilities) : [];
      for (const localModel of localModels) {
        if (existingIds.has(localModel.entry.id)) {
          continue;
        }
        const contextPolicy = resolveModelContextPolicy(localModel.entry);
        models.push({
          id: localModel.entry.id,
          provider: localModel.entry.provider,
          provider_model: localModel.providerModel,
          display_name: localModel.displayName,
          is_default: defaults.defaultModel === localModel.entry.id,
          capabilities: {
            vision: localModel.entry.capabilities.vision,
            tools: localModel.entry.capabilities.tools,
            streaming: localModel.entry.capabilities.streaming,
            structured_outputs: localModel.entry.capabilities.structuredOutputs,
            context_window_tokens:
              localModel.contextWindowTokens ?? localModel.entry.capabilities.contextWindowTokens,
            usable_context_window_tokens: contextPolicy.usableContextWindowTokens,
            reserved_output_tokens: contextPolicy.reservedOutputTokens,
            usable_input_window_tokens: contextPolicy.usableInputWindowTokens,
            max_output_tokens: localModel.maxOutputTokens ?? localModel.entry.capabilities.maxOutputTokens,
          },
          reasoning: {
            kind: localModel.entry.reasoning.kind,
            levels: getReasoningLevelOptions(localModel.entry),
            default_level: localModel.entry.reasoning.defaultLevel,
          },
          request_mode: BUD_LOCAL_DS4_REQUEST_MODE,
          compatibility: [...BUD_LOCAL_DS4_COMPATIBILITY],
          source: {
            kind: "bud_local",
            bud_id: bud.budId,
          },
        });
        existingIds.add(localModel.entry.id);
      }
    }

    return reply.send({
      models,
      service_default_model: defaults.serviceDefaultModel,
      default_model: defaults.defaultModel,
      default_reasoning_effort: defaults.defaultReasoningEffort,
    });
  });
}
