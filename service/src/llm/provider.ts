/**
 * LLM Provider interface.
 *
 * All LLM providers (OpenAI, Anthropic, etc.) implement this interface
 * to provide a unified way to invoke models.
 */

import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalResponse,
  ModelConfig,
  ModelCapabilities,
} from "./types.js";

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
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent>;

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
