/**
 * LLM Provider Abstraction Layer
 *
 * Provides a unified interface for multiple LLM providers (OpenAI, Anthropic, ds4).
 */

import { config } from "../config.js";
import { providerRegistry } from "./registry.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { createDs4ProviderFromConfig } from "./providers/ds4.js";

// Types
export type {
  AssistantMessagePhase,
  CanonicalRole,
  CanonicalProviderData,
  CanonicalProviderId,
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalReasoningBlock,
  ReasoningConfig,
  CanonicalTool,
  CanonicalToolCall,
  ToolChoice,
  ContentType,
  CanonicalStreamEvent,
  CanonicalStopReason,
  TokenUsage,
  ModelConfig,
  ModelCapabilities,
  CanonicalResponse,
} from "./types.js";

export type {
  ModelCatalogEntry,
  ProviderId,
  ReasoningControl,
  ReasoningLevel,
  ReasoningLevelOption,
} from "./model-catalog.js";
export {
  MODEL_CATALOG,
  formatReasoningLevel,
  getCatalogEntry,
  getDefaultModelEntryForProviders,
  getGlobalDefaultModelEntry,
  getReasoningLevelOptions,
  listCatalogEntries,
  listCatalogEntriesForProviders,
  resolveProviderModel,
} from "./model-catalog.js";
export {
  InvalidModelSelectionError,
  InvalidReasoningEffortError,
  isModelSelectionError,
  resolveEffectiveModelSelection,
  resolveModelReasoning,
  type EffectiveModelSelection,
  type ModelSelectionSource,
  type ResolvedModelReasoning,
} from "./reasoning-policy.js";
export {
  buildRequestMode,
  canonicalBlockFromLedgerItem,
  createCanonicalAssistantMessageFromLedger,
  createLlmCallId,
  loadProviderLedgerMessages,
  loadProviderLedgerThreadDiagnostics,
  recordLlmCall,
  recordLlmToolResultItem,
  type LlmCallRequestMode,
  type LlmReconstructionDiagnostics,
  type LlmReconstructionMode,
  type ProviderLedgerBoundary,
  type ProviderLedgerMessage,
  type ProviderLedgerThreadDiagnostics,
} from "./provider-ledger.js";

// Provider interface
export type { LLMProvider } from "./provider.js";
export {
  ProviderContextWindowError,
  isProviderContextWindowError,
} from "./provider.js";

// Registry
export { ProviderRegistry, providerRegistry } from "./registry.js";

// Providers
export { OpenAIProvider } from "./providers/openai.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export {
  Ds4ResponsesProvider,
  createDs4ProviderFromConfig,
} from "./providers/ds4.js";

/**
 * Initialize LLM providers based on configuration.
 * Called once at application startup.
 */
export function initializeProviders(): void {
  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.unregister("ds4");

  // Register OpenAI provider if API key is configured
  if (config.openaiApiKey) {
    const openai = new OpenAIProvider(config.openaiApiKey, {
      timeout: config.openaiTimeout,
    });
    providerRegistry.register(openai);
  }

  // Register Anthropic provider if API key is configured
  if (config.anthropicApiKey) {
    const anthropic = new AnthropicProvider(config.anthropicApiKey, {
      timeout: config.anthropicTimeout,
    });
    providerRegistry.register(anthropic);
  }

  // Register direct local-dev ds4 provider when an OpenAI-compatible Responses endpoint is configured.
  const ds4 = createDs4ProviderFromConfig();
  if (ds4) {
    providerRegistry.register(ds4);
  }

  // Provider-less startup is valid for local development and non-LLM flows.
}
