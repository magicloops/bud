/**
 * LLM Provider interface.
 *
 * All LLM providers (OpenAI, Anthropic, etc.) implement this interface
 * to provide a unified way to invoke models.
 */

import type {
  CanonicalProviderId,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalResponse,
  ModelConfig,
  ModelCapabilities,
} from "./types.js";

export type ProviderInvocationContext = {
  threadId: string;
  budId: string;
  ownerUserId: string | null;
};

export class ProviderContextWindowError extends Error {
  readonly provider: CanonicalProviderId;
  readonly model: string;
  readonly providerCode?: string;
  readonly retryable = true;

  constructor(args: {
    provider: CanonicalProviderId;
    model: string;
    message: string;
    providerCode?: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "ProviderContextWindowError";
    this.provider = args.provider;
    this.model = args.model;
    this.providerCode = args.providerCode;
  }
}

export function isProviderContextWindowError(
  error: unknown,
): error is ProviderContextWindowError {
  return error instanceof ProviderContextWindowError;
}

/**
 * Interface that all LLM providers must implement.
 */
export interface LLMProvider {
  /** Provider identifier (e.g., "openai", "anthropic") */
  readonly name: string;

  /** List of supported model identifiers */
  readonly supportedModels: readonly string[];

  /**
   * Invoke the model with streaming.
   *
   * The provider is responsible for:
   * 1. Transforming canonical messages to provider format
   * 2. Transforming canonical tools to provider format
   * 3. Handling reasoning/thinking configuration
   * 4. Yielding canonical stream events
   * 5. Preserving provider-specific data for multi-turn reasoning
   *
   * @param messages - Conversation history in canonical format
   * @param tools - Available tools in canonical format
   * @param config - Model configuration
   * @param signal - Optional abort signal for cancellation
   * @returns Async iterable of canonical stream events
   */
  invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal,
    context?: ProviderInvocationContext
  ): AsyncIterable<CanonicalStreamEvent>;

  /**
   * Build a provider-specific request snapshot for local diagnostics.
   *
   * This must not include credentials or transport-only headers. It is intended
   * for debug artifact capture and should match the provider request body as
   * closely as practical.
   */
  buildDebugRequestSnapshot?(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    context?: ProviderInvocationContext
  ): unknown;

  /**
   * Invoke the model without streaming (optional).
   * Default implementation collects stream events.
   *
   * @param messages - Conversation history in canonical format
   * @param tools - Available tools in canonical format
   * @param config - Model configuration
   * @param signal - Optional abort signal for cancellation
   * @returns Complete response
   */
  invokeSync?(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): Promise<CanonicalResponse>;

  /**
   * Check if this provider supports a given model.
   */
  supportsModel(model: string): boolean;

  /**
   * Get capabilities for a specific model.
   */
  getModelCapabilities(model: string): ModelCapabilities;
}
