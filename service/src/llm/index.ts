/**
 * LLM Provider Abstraction Layer
 *
 * Provides a unified interface for multiple LLM providers (OpenAI, Anthropic).
 */

import { config } from "../config.js";
import { providerRegistry } from "./registry.js";
import { OpenAIProvider } from "./providers/openai.js";

// Types
export type {
  CanonicalRole,
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

// Provider interface
export type { LLMProvider } from "./provider.js";

// Registry
export { ProviderRegistry, providerRegistry } from "./registry.js";

// Providers
export { OpenAIProvider } from "./providers/openai.js";

/**
 * Initialize LLM providers based on configuration.
 * Called once at application startup.
 */
export function initializeProviders(): void {
  // Register OpenAI provider if API key is configured
  if (config.openaiApiKey) {
    const openai = new OpenAIProvider(config.openaiApiKey, {
      timeout: config.openaiTimeout,
    });
    providerRegistry.register(openai);
  }

  // Validate at least one provider is available
  if (!providerRegistry.hasProviders()) {
    throw new Error(
      "No LLM providers configured. Set OPENAI_API_KEY environment variable."
    );
  }
}
