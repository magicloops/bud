/**
 * Canonical types for the LLM provider abstraction layer.
 *
 * These types provide a provider-agnostic format for messages, tools,
 * and streaming events that can be transformed to/from any LLM provider.
 */

import type { JSONSchema7 } from "json-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Canonical Roles & Content Types
// ═══════════════════════════════════════════════════════════════════════════

export type CanonicalRole = "system" | "user" | "assistant";

/**
 * Content blocks that can appear in messages.
 */
export type CanonicalContentBlock =
  // Text content
  | { type: "text"; text: string }

  // Image content (vision)
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }

  // Tool use (assistant wants to call a tool)
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }

  // Tool result (response to a tool call)
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | CanonicalContentBlock[];
      is_error?: boolean;
    }

  // Reasoning/thinking content
  | CanonicalReasoningBlock;

/**
 * A canonical message that can be stored in the database and
 * transformed to any provider's format.
 */
export type CanonicalMessage = {
  role: CanonicalRole;
  content: string | CanonicalContentBlock[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Reasoning/Thinking Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical reasoning block.
 *
 * Normalizes:
 * - OpenAI: reasoning output items with summary (GPT-5 series)
 * - Anthropic: thinking content blocks
 */
export type CanonicalReasoningBlock =
  | {
      type: "reasoning";
      /** Visible reasoning summary text */
      text: string;
      /**
       * Provider-specific data for multi-turn persistence.
       * MUST be passed back during tool call loops.
       */
      providerData?: {
        provider: "openai" | "anthropic";
        /** Opaque payload - provider knows how to use it */
        payload: unknown;
      };
    }
  | {
      type: "reasoning_redacted";
      /** Anthropic-only: safety-filtered thinking */
      providerData?: {
        provider: "anthropic";
        payload: unknown;
      };
    };

/**
 * Reasoning configuration for model invocation.
 */
export type ReasoningConfig = {
  /** Enable reasoning/thinking */
  enabled: boolean;
  /** Effort level: low/medium/high */
  effort?: "low" | "medium" | "high";
  /** Summary verbosity (OpenAI only) */
  summaryLevel?: "auto" | "concise" | "detailed";
  /** Interleaved thinking (Anthropic Claude 4 only) */
  interleaved?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
// Tool Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical tool definition.
 * Both OpenAI and Anthropic use JSON Schema for parameters.
 */
export type CanonicalTool = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

/**
 * Canonical tool call extracted from model response.
 */
export type CanonicalToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/**
 * Tool choice configuration.
 */
export type ToolChoice =
  | "auto"      // Model decides whether to use tools
  | "required"  // Model must use a tool
  | "none"      // Model cannot use tools
  | { type: "tool"; name: string };  // Force specific tool

// ═══════════════════════════════════════════════════════════════════════════
// Streaming Event Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Content type indicator for streaming events.
 */
export type ContentType = "text" | "tool_use" | "reasoning";

/**
 * Unified streaming events emitted by all providers.
 */
export type CanonicalStreamEvent =
  // Message lifecycle
  | { type: "message_start"; id: string }
  | { type: "message_done"; stop_reason: CanonicalStopReason; usage?: TokenUsage }

  // Text content
  | { type: "content_start"; index: number; content_type: ContentType }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "content_done"; index: number }

  // Tool use
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; delta: string }
  | { type: "tool_use_done"; index: number; id: string; name: string; input: Record<string, unknown> }

  // Reasoning/thinking
  | { type: "reasoning_start"; index: number; id?: string }
  | { type: "reasoning_delta"; index: number; delta: string }
  | { type: "reasoning_done"; index: number; block: CanonicalReasoningBlock }
  | { type: "reasoning_redacted"; index: number; block: CanonicalReasoningBlock & { type: "reasoning_redacted" } }

  // Error
  | { type: "error"; error: Error };

export type CanonicalStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Reasoning/thinking tokens (if applicable) */
  reasoning_tokens?: number;
  /** Cache-related token counts (Anthropic) */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for a model invocation.
 * Provider adapters transform this to provider-specific formats.
 */
export type ModelConfig = {
  /** Model identifier (e.g., "gpt-4o", "claude-sonnet-4-5-20250929") */
  model: string;

  /** Maximum output tokens (required for Anthropic, optional for OpenAI) */
  maxOutputTokens?: number;

  /** Sampling temperature (0-2 for OpenAI, 0-1 for Anthropic) */
  temperature?: number;

  /** Nucleus sampling parameter */
  topP?: number;

  /** Top-K sampling (Anthropic only) */
  topK?: number;

  /** Tool choice configuration */
  toolChoice?: ToolChoice;

  /** Response format preference */
  responseFormat?: "text" | "json";

  /** Reasoning/thinking configuration */
  reasoning?: ReasoningConfig;
};

/**
 * Model capabilities reported by providers.
 */
export type ModelCapabilities = {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;

  /** Whether model supports reasoning (OpenAI GPT-5 series) */
  supportsReasoning: boolean;

  /** Whether model supports extended thinking (Anthropic) */
  supportsThinking: boolean;

  /** Whether model supports interleaved thinking (Anthropic Claude 4) */
  supportsInterleavedThinking: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════
// Response Types (for non-streaming)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical response from a non-streaming invocation.
 */
export type CanonicalResponse = {
  id: string;
  content: CanonicalContentBlock[];
  stopReason: CanonicalStopReason;
  usage?: TokenUsage;
  /** Extracted tool calls for convenience */
  toolCalls?: CanonicalToolCall[];
};
