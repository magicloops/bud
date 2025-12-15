/**
 * Provider Registry for LLM providers.
 *
 * Maintains a registry of LLM providers and resolves models to providers.
 */

import type { LLMProvider } from "./provider.js";

/**
 * Model to provider mapping.
 * Maps model identifiers (or prefixes) to provider names.
 */
const MODEL_PROVIDER_MAP: Record<string, string> = {
  // OpenAI standard models
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",

  // OpenAI GPT-5 series (with reasoning)
  "gpt-5": "openai",
  "gpt-5.1": "openai",
  "gpt-5.2": "openai",

  // Anthropic Claude 3.5 models
  "claude-3-5-sonnet-20241022": "anthropic",
  "claude-3-5-haiku-20241022": "anthropic",

  // Anthropic Claude 3 models
  "claude-3-opus-20240229": "anthropic",
  "claude-3-sonnet-20240229": "anthropic",
  "claude-3-haiku-20240307": "anthropic",

  // Anthropic Claude 4 models
  "claude-sonnet-4-5-20250929": "anthropic",
  "claude-opus-4-5-20251101": "anthropic",
};

/**
 * Model alias resolution.
 * Maps friendly names to specific model versions.
 */
const MODEL_ALIASES: Record<string, string> = {
  // OpenAI aliases
  "gpt-4o-latest": "gpt-4o",
  "gpt-5-latest": "gpt-5.2",

  // Anthropic aliases
  "claude-sonnet": "claude-sonnet-4-5-20250929",
  "claude-opus": "claude-opus-4-5-20251101",
  "claude-haiku": "claude-3-5-haiku-20241022",
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /**
   * Register a provider instance.
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Unregister a provider by name.
   */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /**
   * Get the provider for a given model.
   * Handles alias resolution and prefix matching.
   */
  getProviderForModel(model: string): LLMProvider {
    // Resolve aliases first
    const resolvedModel = MODEL_ALIASES[model] ?? model;

    // Check exact match
    const providerName = MODEL_PROVIDER_MAP[resolvedModel];
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (provider) return provider;
    }

    // Check prefix match (e.g., "gpt-4o-2024-08-06" -> "openai")
    for (const [prefix, name] of Object.entries(MODEL_PROVIDER_MAP)) {
      if (resolvedModel.startsWith(prefix)) {
        const provider = this.providers.get(name);
        if (provider) return provider;
      }
    }

    // Fallback: check each provider's supportsModel
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(resolvedModel)) {
        return provider;
      }
    }

    throw new Error(`No provider found for model: ${model}`);
  }

  /**
   * Resolve a model alias to its full identifier.
   */
  resolveModelAlias(model: string): string {
    return MODEL_ALIASES[model] ?? model;
  }

  /**
   * Get a provider by name.
   */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * List registered provider names.
   */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * List all known models.
   */
  listModels(): string[] {
    return Object.keys(MODEL_PROVIDER_MAP);
  }

  /**
   * List model aliases.
   */
  listAliases(): Record<string, string> {
    return { ...MODEL_ALIASES };
  }

  /**
   * Check if any providers are registered.
   */
  hasProviders(): boolean {
    return this.providers.size > 0;
  }
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
