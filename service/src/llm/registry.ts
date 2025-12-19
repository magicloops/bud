/**
 * Provider Registry for LLM providers.
 *
 * Maintains a registry of LLM providers and resolves models to providers.
 * Model→provider mapping is automatically derived from each provider's supportedModels.
 */

import type { LLMProvider } from "./provider.js";

/**
 * Model alias resolution.
 * Maps friendly names to specific model versions.
 */
const MODEL_ALIASES: Record<string, string> = {
  // OpenAI GPT-5 aliases
  "gpt-5.2": "gpt-5.2-2025-12-11",
  "gpt-5-mini": "gpt-5-mini-2025-08-07",
  "gpt-5-nano": "gpt-5-nano-2025-08-07",

  // Anthropic official aliases (point to latest dated version)
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private modelToProvider = new Map<string, string>();

  /**
   * Register a provider instance.
   * Automatically maps all supportedModels to this provider.
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);

    // Auto-populate model→provider mapping from supportedModels
    for (const model of provider.supportedModels) {
      this.modelToProvider.set(model, provider.name);
    }
  }

  /**
   * Unregister a provider by name.
   * Also removes all model mappings for this provider.
   */
  unregister(name: string): boolean {
    const provider = this.providers.get(name);
    if (provider) {
      // Remove model mappings for this provider
      for (const model of provider.supportedModels) {
        this.modelToProvider.delete(model);
      }
    }
    return this.providers.delete(name);
  }

  /**
   * Get the provider for a given model.
   * Handles alias resolution and falls back to supportsModel() check.
   */
  getProviderForModel(model: string): LLMProvider {
    // Resolve aliases first
    const resolvedModel = MODEL_ALIASES[model] ?? model;

    // Check exact match from registered providers' supportedModels
    const providerName = this.modelToProvider.get(resolvedModel);
    if (providerName) {
      const provider = this.providers.get(providerName);
      if (provider) return provider;
    }

    // Fallback: check each provider's supportsModel() method
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
   * List all known models (from registered providers).
   */
  listModels(): string[] {
    return [...this.modelToProvider.keys()];
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
