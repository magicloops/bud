# LLM Provider Adapter Implementation Design

> Detailed implementation design for Approach A (Adapter Pattern) with comprehensive reasoning/thinking support.

**Status**: Draft
**Parent Doc**: [multi-provider-llm-abstraction.md](./multi-provider-llm-abstraction.md)
**Last Updated**: 2025-12-14

---

## 1. Overview

This document specifies the implementation of the LLM Provider Adapter pattern for Bud, enabling:

1. **Multi-provider support** (OpenAI, Anthropic, future providers)
2. **Model-agnostic threads** with seamless mid-thread switching
3. **Reasoning/thinking support** for both OpenAI reasoning models and Anthropic extended thinking
4. **Unified streaming** with provider-specific event normalization
5. **Multi-turn reasoning persistence** during tool call loops

---

## 2. Canonical Types

### 2.1 Core Message Types

```typescript
// service/src/llm/types.ts

// ═══════════════════════════════════════════════════════════════════════════
// Canonical Roles & Content Types
// ═══════════════════════════════════════════════════════════════════════════

export type CanonicalRole = "system" | "user" | "assistant";

/**
 * Content blocks that can appear in messages.
 * The canonical format normalizes OpenAI and Anthropic differences.
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

  // Reasoning/thinking content (see Section 2.2)
  | CanonicalReasoningBlock;

/**
 * A canonical message that can be stored in the database and
 * transformed to any provider's format.
 */
export type CanonicalMessage = {
  role: CanonicalRole;
  content: string | CanonicalContentBlock[];
};
```

### 2.2 Reasoning/Thinking Types

The reasoning/thinking system normalizes two fundamentally different approaches:

- **OpenAI**: Reasoning is a separate output item type with optional encrypted content for stateless mode
- **Anthropic**: Thinking is an inline content block with cryptographic signatures for verification

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// Reasoning/Thinking Content Blocks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical reasoning block - normalized from OpenAI reasoning or Anthropic thinking.
 *
 * Design decisions:
 * - We store the SUMMARY (visible content), not full reasoning traces
 * - Provider-specific opaque data is preserved for multi-turn continuity
 * - Redacted content is explicitly marked
 */
export type CanonicalReasoningBlock =
  | {
      type: "reasoning";
      /**
       * Visible reasoning summary text.
       * - OpenAI: From reasoning.summary array joined
       * - Anthropic: From thinking block content
       */
      text: string;

      /**
       * Provider-specific opaque data that MUST be passed back for multi-turn.
       * - OpenAI: The full reasoning output item (with optional encrypted_content)
       * - Anthropic: The thinking block with signature
       */
      providerData?: {
        provider: "openai" | "anthropic";
        /** Opaque data to pass back - provider adapter knows how to use it */
        payload: unknown;
      };
    }
  | {
      type: "reasoning_redacted";
      /**
       * Indicates reasoning was redacted for safety.
       * - OpenAI: N/A (doesn't have this concept)
       * - Anthropic: redacted_thinking block
       */
      providerData?: {
        provider: "anthropic";
        payload: unknown;
      };
    };

/**
 * Reasoning configuration for model invocation.
 */
export type ReasoningConfig = {
  /**
   * Whether reasoning/thinking is enabled.
   * - OpenAI: Maps to reasoning.effort != "none"
   * - Anthropic: Maps to thinking.type = "enabled"
   */
  enabled: boolean;

  /**
   * Effort/budget level for reasoning.
   * - OpenAI: Maps to reasoning.effort ("low" | "medium" | "high")
   * - Anthropic: Maps to thinking.budget_tokens (we calculate from effort)
   */
  effort?: "low" | "medium" | "high";

  /**
   * Summary verbosity preference.
   * - OpenAI: Maps to reasoning.summary ("auto" | "concise" | "detailed")
   * - Anthropic: N/A (controlled via budget_tokens for Claude 4 summarization)
   */
  summaryLevel?: "auto" | "concise" | "detailed";

  /**
   * Enable interleaved thinking (Anthropic Claude 4 only).
   * Allows model to think between tool calls without explicit prompting.
   */
  interleaved?: boolean;
};
```

### 2.3 Tool Types

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// Tool Definition & Call Types
// ═══════════════════════════════════════════════════════════════════════════

import type { JSONSchema7 } from "json-schema";

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
  | "required"  // Model must use a tool (OpenAI: "required", Anthropic: "any")
  | "none"      // Model cannot use tools
  | { type: "tool"; name: string };  // Force specific tool
```

### 2.4 Streaming Event Types

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// Canonical Streaming Events
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unified streaming events emitted by all providers.
 * The adapter transforms provider-specific events to these canonical events.
 */
export type CanonicalStreamEvent =
  // ─────────────────────────────────────────────────────────────────────────
  // Message lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  | { type: "message_start"; id: string }
  | {
      type: "message_done";
      stop_reason: CanonicalStopReason;
      usage?: TokenUsage;
    }

  // ─────────────────────────────────────────────────────────────────────────
  // Text content streaming
  // ─────────────────────────────────────────────────────────────────────────
  | { type: "content_start"; index: number; content_type: "text" | "tool_use" | "reasoning" }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "content_done"; index: number }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool use streaming
  // ─────────────────────────────────────────────────────────────────────────
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; delta: string }
  | {
      type: "tool_use_done";
      index: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
    }

  // ─────────────────────────────────────────────────────────────────────────
  // Reasoning/thinking streaming
  // ─────────────────────────────────────────────────────────────────────────
  | {
      type: "reasoning_start";
      index: number;
      /**
       * For OpenAI: the reasoning output item ID
       * For Anthropic: the thinking block index
       */
      id?: string;
    }
  | {
      type: "reasoning_delta";
      index: number;
      /** The visible reasoning summary text delta */
      delta: string;
    }
  | {
      type: "reasoning_done";
      index: number;
      /** Complete reasoning block for storage */
      block: CanonicalReasoningBlock;
    }
  | {
      type: "reasoning_redacted";
      index: number;
      /** Redacted reasoning block */
      block: CanonicalReasoningBlock & { type: "reasoning_redacted" };
    }

  // ─────────────────────────────────────────────────────────────────────────
  // Error handling
  // ─────────────────────────────────────────────────────────────────────────
  | { type: "error"; error: Error };

export type CanonicalStopReason =
  | "end_turn"      // Normal completion
  | "tool_use"      // Stopped to call tools
  | "max_tokens"    // Hit token limit
  | "stop_sequence" // Hit stop sequence
  | "error";        // Error occurred

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Reasoning/thinking tokens (if applicable) */
  reasoning_tokens?: number;
  /** Cache-related token counts (Anthropic) */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
```

### 2.5 Configuration Types

```typescript
// ═══════════════════════════════════════════════════════════════════════════
// Model Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for a model invocation.
 * Provider adapters transform this to provider-specific formats.
 */
export type ModelConfig = {
  /** Model identifier (e.g., "gpt-4o", "claude-sonnet-4-5-20250929") */
  model: string;

  /** Maximum output tokens (required for Anthropic, optional for OpenAI) */
  maxTokens?: number;

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
 * Model capabilities (returned by provider.getModelCapabilities)
 */
export type ModelCapabilities = {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;

  /** Whether model supports reasoning (OpenAI o-series) */
  supportsReasoning: boolean;

  /** Whether model supports extended thinking (Anthropic) */
  supportsThinking: boolean;

  /** Whether model supports interleaved thinking (Anthropic Claude 4) */
  supportsInterleavedThinking: boolean;

  /** Whether model supports thinking summarization (Anthropic Claude 4) */
  supportsThinkingSummarization: boolean;
};
```

---

## 3. Provider Interface

```typescript
// service/src/llm/provider.ts

import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  ModelConfig,
  ModelCapabilities,
} from "./types.js";

/**
 * Interface that all LLM providers must implement.
 * Handles transformation between canonical and provider-specific formats.
 */
export interface LLMProvider {
  /** Provider identifier */
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
   */
  invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent>;

  /**
   * Check if this provider supports a given model.
   */
  supportsModel(model: string): boolean;

  /**
   * Get capabilities for a specific model.
   */
  getModelCapabilities(model: string): ModelCapabilities;
}
```

---

## 4. OpenAI Provider Implementation

### 4.1 Reasoning Support

OpenAI's reasoning models (o1, o3, etc.) use a unique approach:

1. **Reasoning effort** controls compute: `reasoning.effort: "low" | "medium" | "high"`
2. **Reasoning summary** controls visibility: `reasoning.summary: "auto" | "concise" | "detailed"`
3. **Reasoning output items** are emitted with `type: "reasoning"` containing `summary` array
4. **Encrypted content** (`encrypted_content`) is provided for stateless/ZDR mode
5. **Multi-turn**: Reasoning items MUST be passed back during tool call loops

```typescript
// service/src/llm/providers/openai.ts

import OpenAI from "openai";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalReasoningBlock,
  CanonicalContentBlock,
  ModelConfig,
  ModelCapabilities,
} from "../types.js";

// OpenAI-specific types
type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIOutputItem = OpenAI.Responses.ResponseOutputItem;
type OpenAITool = OpenAI.Responses.Tool;

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly supportedModels = [
    // Standard models
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    // Reasoning models
    "o1",
    "o1-mini",
    "o1-pro",
    "o3",
    "o3-mini",
    "o4-mini",
  ] as const;

  private client: OpenAI;

  constructor(apiKey: string, options?: { baseURL?: string }) {
    this.client = new OpenAI({ apiKey, ...options });
  }

  supportsModel(model: string): boolean {
    return (
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4")
    );
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isReasoning = this.isReasoningModel(model);
    return {
      supportsVision: model.includes("4o") || model.includes("4.1") || model.includes("o1") || model.includes("o3"),
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: !isReasoning, // Reasoning models have different JSON handling
      maxContextTokens: 128000,
      maxOutputTokens: isReasoning ? 100000 : 16384,
      supportsReasoning: isReasoning,
      supportsThinking: false,
      supportsInterleavedThinking: false,
      supportsThinkingSummarization: false,
    };
  }

  private isReasoningModel(model: string): boolean {
    return model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const input = this.transformMessages(messages);
    const openaiTools = this.transformTools(tools);

    // Build request parameters
    const params: OpenAI.Responses.ResponseCreateParams = {
      model: config.model,
      input,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_output_tokens: config.maxTokens,
      temperature: this.isReasoningModel(config.model) ? undefined : config.temperature,
      top_p: this.isReasoningModel(config.model) ? undefined : config.topP,
      stream: true,
    };

    // Add reasoning configuration for reasoning models
    if (this.isReasoningModel(config.model) && config.reasoning?.enabled) {
      params.reasoning = {
        effort: config.reasoning.effort ?? "medium",
        summary: config.reasoning.summaryLevel ?? "auto",
      };
    }

    // Add JSON response format if requested (non-reasoning models only)
    if (config.responseFormat === "json" && !this.isReasoningModel(config.model)) {
      params.text = { format: { type: "json_object" } };
    }

    const stream = await this.client.responses.create(params, signal ? { signal } : undefined);

    yield* this.transformStream(stream);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Message Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private transformMessages(messages: CanonicalMessage[]): OpenAIInputItem[] {
    const items: OpenAIInputItem[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        items.push({
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: this.getTextContent(msg.content) }],
        });
        continue;
      }

      if (msg.role === "user") {
        const blocks = this.normalizeContent(msg.content);

        // Handle tool results separately (they're top-level items in OpenAI)
        const toolResults = blocks.filter(b => b.type === "tool_result");
        const otherContent = blocks.filter(b => b.type !== "tool_result");

        // Add tool results as function_call_output items
        for (const result of toolResults) {
          if (result.type === "tool_result") {
            items.push({
              type: "function_call_output",
              call_id: result.tool_use_id,
              output: typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
            });
          }
        }

        // Add regular user content
        if (otherContent.length > 0) {
          items.push({
            type: "message",
            role: "user",
            content: this.transformContentBlocks(otherContent, "input"),
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);

        // Separate different block types
        const textBlocks = blocks.filter(b => b.type === "text");
        const toolUses = blocks.filter(b => b.type === "tool_use");
        const reasoningBlocks = blocks.filter(b => b.type === "reasoning" || b.type === "reasoning_redacted");

        // Add reasoning items first (they come before text/tool in OpenAI)
        for (const reasoning of reasoningBlocks) {
          if (reasoning.type === "reasoning" && reasoning.providerData?.provider === "openai") {
            // Pass back the original OpenAI reasoning item
            items.push(reasoning.providerData.payload as OpenAIInputItem);
          }
        }

        // Add text content
        if (textBlocks.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textBlocks.map(b => ({
              type: "output_text" as const,
              text: (b as { type: "text"; text: string }).text,
            })),
          });
        }

        // Add function calls
        for (const tool of toolUses) {
          if (tool.type === "tool_use") {
            items.push({
              type: "function_call",
              call_id: tool.id,
              name: tool.name,
              arguments: JSON.stringify(tool.input),
            });
          }
        }
      }
    }

    return items;
  }

  private transformContentBlocks(
    blocks: CanonicalContentBlock[],
    direction: "input" | "output"
  ): OpenAI.Responses.ResponseInputMessageContentList {
    return blocks.map(block => {
      switch (block.type) {
        case "text":
          return direction === "input"
            ? { type: "input_text" as const, text: block.text }
            : { type: "output_text" as const, text: block.text };
        case "image":
          return {
            type: "input_image" as const,
            image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          };
        default:
          throw new Error(`Unsupported content block type: ${(block as any).type}`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private transformTools(tools: CanonicalTool[]): OpenAITool[] {
    return tools.map(tool => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));
  }

  private transformToolChoice(
    choice?: ModelConfig["toolChoice"]
  ): OpenAI.Responses.ResponseCreateParams["tool_choice"] {
    if (!choice) return "auto";
    if (choice === "auto" || choice === "none") return choice;
    if (choice === "required") return "required";
    return { type: "function", name: choice.name };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stream Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private async *transformStream(
    stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>
  ): AsyncIterable<CanonicalStreamEvent> {
    let contentIndex = 0;
    let currentReasoningItem: {
      id: string;
      summaryParts: string[];
      rawItem: unknown;
    } | null = null;
    let currentToolCall: {
      index: number;
      id: string;
      name: string;
      args: string;
    } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────────────
        // Message lifecycle
        // ─────────────────────────────────────────────────────────────────────
        case "response.created":
          yield { type: "message_start", id: event.response.id };
          break;

        case "response.completed":
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(event.response.status),
            usage: event.response.usage ? {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
              reasoning_tokens: event.response.usage.output_tokens_details?.reasoning_tokens,
            } : undefined,
          };
          break;

        case "response.failed":
          yield {
            type: "error",
            error: new Error(event.response.error?.message ?? "Request failed"),
          };
          break;

        // ─────────────────────────────────────────────────────────────────────
        // Output item handling (including reasoning)
        // ─────────────────────────────────────────────────────────────────────
        case "response.output_item.added":
          if (event.item.type === "reasoning") {
            // Reasoning item starting
            currentReasoningItem = {
              id: event.item.id,
              summaryParts: [],
              rawItem: event.item,
            };
            yield {
              type: "reasoning_start",
              index: event.output_index,
              id: event.item.id,
            };
          } else if (event.item.type === "function_call") {
            // Tool call starting - we'll get details in arguments events
            currentToolCall = {
              index: event.output_index,
              id: event.item.call_id,
              name: event.item.name,
              args: "",
            };
            yield {
              type: "tool_use_start",
              index: event.output_index,
              id: event.item.call_id,
              name: event.item.name,
            };
          }
          break;

        case "response.output_item.done":
          if (event.item.type === "reasoning" && currentReasoningItem) {
            // Reasoning complete - emit with provider data for multi-turn
            const reasoningBlock: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentReasoningItem.summaryParts.join(""),
              providerData: {
                provider: "openai",
                // Store the full reasoning item for multi-turn
                payload: event.item,
              },
            };
            yield {
              type: "reasoning_done",
              index: event.output_index,
              block: reasoningBlock,
            };
            currentReasoningItem = null;
          }
          break;

        // ─────────────────────────────────────────────────────────────────────
        // Content streaming
        // ─────────────────────────────────────────────────────────────────────
        case "response.content_part.added":
          yield {
            type: "content_start",
            index: contentIndex,
            content_type: event.part.type === "output_text" ? "text" : "tool_use",
          };
          break;

        case "response.output_text.delta":
          yield { type: "text_delta", index: contentIndex, delta: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content_done", index: contentIndex };
          contentIndex++;
          break;

        // ─────────────────────────────────────────────────────────────────────
        // Reasoning summary streaming
        // ─────────────────────────────────────────────────────────────────────
        case "response.reasoning_summary_part.added":
          // New summary part starting (OpenAI can emit multiple summary parts)
          break;

        case "response.reasoning_summary_text.delta":
          if (currentReasoningItem) {
            currentReasoningItem.summaryParts.push(event.delta);
            yield {
              type: "reasoning_delta",
              index: event.output_index,
              delta: event.delta,
            };
          }
          break;

        case "response.reasoning_summary_text.done":
          // Summary part complete - we'll emit the full block in output_item.done
          break;

        // ─────────────────────────────────────────────────────────────────────
        // Tool call streaming
        // ─────────────────────────────────────────────────────────────────────
        case "response.function_call_arguments.delta":
          if (currentToolCall) {
            currentToolCall.args += event.delta;
            yield {
              type: "tool_use_delta",
              index: currentToolCall.index,
              delta: event.delta,
            };
          }
          break;

        case "response.function_call_arguments.done":
          if (currentToolCall) {
            yield {
              type: "tool_use_done",
              index: currentToolCall.index,
              id: event.item_id,
              name: event.name,
              input: JSON.parse(event.arguments),
            };
            currentToolCall = null;
          }
          break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private mapStopReason(status: string): CanonicalStreamEvent["type"] extends "message_done"
    ? (CanonicalStreamEvent & { type: "message_done" })["stop_reason"]
    : never {
    switch (status) {
      case "completed": return "end_turn";
      case "incomplete": return "max_tokens";
      case "failed": return "error";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalMessage["content"]): CanonicalContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content as CanonicalContentBlock[];
  }

  private getTextContent(content: string | CanonicalMessage["content"]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}
```

---

## 5. Anthropic Provider Implementation

### 5.1 Extended Thinking Support

Anthropic's extended thinking uses a different paradigm:

1. **Budget-based**: `thinking.budget_tokens` controls thinking depth
2. **Thinking blocks**: Content blocks with `type: "thinking"` containing visible thinking
3. **Signatures**: Each thinking block has a `signature` for verification
4. **Redacted thinking**: Safety-filtered content appears as `redacted_thinking` blocks
5. **Interleaved thinking**: Claude 4 can think between tool calls (beta feature)
6. **Multi-turn**: Thinking blocks MUST be passed back unmodified (with signature)

```typescript
// service/src/llm/providers/anthropic.ts

import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalReasoningBlock,
  CanonicalContentBlock,
  ModelConfig,
  ModelCapabilities,
} from "../types.js";

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;
type AnthropicContentBlock = Anthropic.ContentBlock;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly supportedModels = [
    // Claude 3.5 models
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    // Claude 3 models
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
    // Claude 4 models (with interleaved thinking)
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
  ] as const;

  private client: Anthropic;

  constructor(apiKey: string, options?: { baseURL?: string }) {
    this.client = new Anthropic({ apiKey, ...options });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isClaude4 = model.includes("4-5") || model.includes("4.5");
    const isOpus = model.includes("opus");

    return {
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false, // Anthropic uses tool_use for structured output
      maxContextTokens: 200000,
      maxOutputTokens: isOpus || isClaude4 ? 32768 : 8192,
      supportsReasoning: false, // Different from OpenAI reasoning
      supportsThinking: true, // All Claude models support extended thinking
      supportsInterleavedThinking: isClaude4,
      supportsThinkingSummarization: isClaude4,
    };
  }

  private isClaude4(model: string): boolean {
    return model.includes("4-5") || model.includes("4.5");
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const { systemPrompt, anthropicMessages } = this.transformMessages(messages);
    const anthropicTools = this.transformTools(tools);

    // Build base request parameters
    const params: Anthropic.MessageCreateParams = {
      model: config.model,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_tokens: config.maxTokens ?? 4096, // Required for Anthropic
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      stream: true,
    };

    // Add extended thinking configuration
    if (config.reasoning?.enabled) {
      const budgetTokens = this.calculateThinkingBudget(config.reasoning.effort);
      (params as any).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    // Build headers for beta features
    const headers: Record<string, string> = {};

    // Enable interleaved thinking for Claude 4 if requested
    if (config.reasoning?.interleaved && this.isClaude4(config.model)) {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    const stream = this.client.messages.stream(
      params,
      {
        signal,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      }
    );

    yield* this.transformStream(stream, config.model);
  }

  /**
   * Calculate thinking budget tokens from effort level.
   * These are rough mappings - can be tuned based on experience.
   */
  private calculateThinkingBudget(effort?: "low" | "medium" | "high"): number {
    switch (effort) {
      case "low": return 1024;
      case "medium": return 4096;
      case "high": return 16384;
      default: return 4096;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Message Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private transformMessages(messages: CanonicalMessage[]): {
    systemPrompt: string;
    anthropicMessages: AnthropicMessage[];
  } {
    let systemPrompt = "";
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += this.getTextContent(msg.content) + "\n";
        continue;
      }

      if (msg.role === "user") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of blocks) {
          switch (block.type) {
            case "text":
              anthropicContent.push({ type: "text", text: block.text });
              break;
            case "image":
              anthropicContent.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: block.source.media_type,
                  data: block.source.data,
                },
              });
              break;
            case "tool_result":
              anthropicContent.push({
                type: "tool_result",
                tool_use_id: block.tool_use_id,
                content: typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
                is_error: block.is_error,
              });
              break;
          }
        }

        anthropicMessages.push({ role: "user", content: anthropicContent });
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: Anthropic.ContentBlockParam[] = [];

        for (const block of blocks) {
          switch (block.type) {
            case "text":
              anthropicContent.push({ type: "text", text: block.text });
              break;
            case "tool_use":
              anthropicContent.push({
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input,
              });
              break;
            case "reasoning":
              // Pass back thinking block with signature for multi-turn
              if (block.providerData?.provider === "anthropic") {
                anthropicContent.push(block.providerData.payload as Anthropic.ContentBlockParam);
              }
              break;
            case "reasoning_redacted":
              // Pass back redacted thinking block
              if (block.providerData?.provider === "anthropic") {
                anthropicContent.push(block.providerData.payload as Anthropic.ContentBlockParam);
              }
              break;
          }
        }

        anthropicMessages.push({ role: "assistant", content: anthropicContent });
      }
    }

    return { systemPrompt: systemPrompt.trim(), anthropicMessages };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private transformTools(tools: CanonicalTool[]): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool["input_schema"],
    }));
  }

  private transformToolChoice(
    choice?: ModelConfig["toolChoice"]
  ): Anthropic.MessageCreateParams["tool_choice"] {
    if (!choice || choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "auto" }; // Anthropic doesn't have "none"
    if (choice === "required") return { type: "any" };
    return { type: "tool", name: choice.name };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stream Transformation
  // ═══════════════════════════════════════════════════════════════════════════

  private async *transformStream(
    stream: Anthropic.MessageStream,
    model: string
  ): AsyncIterable<CanonicalStreamEvent> {
    let currentThinking: {
      index: number;
      text: string;
      signature?: string;
      rawBlock?: unknown;
    } | null = null;

    let currentToolUse: {
      index: number;
      id: string;
      name: string;
      input: string;
    } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        // ─────────────────────────────────────────────────────────────────────
        // Message lifecycle
        // ─────────────────────────────────────────────────────────────────────
        case "message_start":
          yield { type: "message_start", id: event.message.id };
          break;

        case "message_stop":
          const finalMessage = await stream.finalMessage();
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(finalMessage.stop_reason),
            usage: {
              input_tokens: finalMessage.usage.input_tokens,
              output_tokens: finalMessage.usage.output_tokens,
              cache_creation_input_tokens: (finalMessage.usage as any).cache_creation_input_tokens,
              cache_read_input_tokens: (finalMessage.usage as any).cache_read_input_tokens,
            },
          };
          break;

        // ─────────────────────────────────────────────────────────────────────
        // Content block handling
        // ─────────────────────────────────────────────────────────────────────
        case "content_block_start":
          if (event.content_block.type === "thinking") {
            // Extended thinking block starting
            currentThinking = {
              index: event.index,
              text: "",
              rawBlock: event.content_block,
            };
            yield {
              type: "reasoning_start",
              index: event.index,
            };
          } else if (event.content_block.type === "redacted_thinking") {
            // Redacted thinking - emit immediately
            const redactedBlock: CanonicalReasoningBlock = {
              type: "reasoning_redacted",
              providerData: {
                provider: "anthropic",
                payload: event.content_block,
              },
            };
            yield {
              type: "reasoning_redacted",
              index: event.index,
              block: redactedBlock,
            };
          } else if (event.content_block.type === "text") {
            yield {
              type: "content_start",
              index: event.index,
              content_type: "text",
            };
          } else if (event.content_block.type === "tool_use") {
            currentToolUse = {
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
              input: "",
            };
            yield {
              type: "tool_use_start",
              index: event.index,
              id: event.content_block.id,
              name: event.content_block.name,
            };
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "thinking_delta") {
            // Thinking content streaming
            if (currentThinking) {
              currentThinking.text += event.delta.thinking;
              yield {
                type: "reasoning_delta",
                index: event.index,
                delta: event.delta.thinking,
              };
            }
          } else if (event.delta.type === "text_delta") {
            yield {
              type: "text_delta",
              index: event.index,
              delta: event.delta.text,
            };
          } else if (event.delta.type === "input_json_delta") {
            if (currentToolUse) {
              currentToolUse.input += event.delta.partial_json;
              yield {
                type: "tool_use_delta",
                index: event.index,
                delta: event.delta.partial_json,
              };
            }
          } else if (event.delta.type === "signature_delta") {
            // Capture signature for thinking block
            if (currentThinking) {
              currentThinking.signature = (currentThinking.signature ?? "") + event.delta.signature;
            }
          }
          break;

        case "content_block_stop":
          if (currentThinking && currentThinking.index === event.index) {
            // Thinking block complete - emit with provider data
            const thinkingBlock: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentThinking.text,
              providerData: {
                provider: "anthropic",
                // Store the complete thinking block for multi-turn
                payload: {
                  type: "thinking",
                  thinking: currentThinking.text,
                  signature: currentThinking.signature,
                },
              },
            };
            yield {
              type: "reasoning_done",
              index: event.index,
              block: thinkingBlock,
            };
            currentThinking = null;
          } else if (currentToolUse && currentToolUse.index === event.index) {
            yield {
              type: "tool_use_done",
              index: event.index,
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: JSON.parse(currentToolUse.input || "{}"),
            };
            currentToolUse = null;
          } else {
            yield { type: "content_done", index: event.index };
          }
          break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  private mapStopReason(reason: Anthropic.Message["stop_reason"]):
    "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (reason) {
      case "end_turn": return "end_turn";
      case "tool_use": return "tool_use";
      case "max_tokens": return "max_tokens";
      case "stop_sequence": return "stop_sequence";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalMessage["content"]): CanonicalContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content as CanonicalContentBlock[];
  }

  private getTextContent(content: string | CanonicalMessage["content"]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }
}
```

---

## 6. Provider Registry

```typescript
// service/src/llm/registry.ts

import type { LLMProvider } from "./types.js";

/**
 * Model to provider mapping.
 * Supports exact matches and prefix matching.
 */
const MODEL_PROVIDER_MAP: Record<string, string> = {
  // OpenAI standard models
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4.1-nano": "openai",

  // OpenAI reasoning models
  "o1": "openai",
  "o1-mini": "openai",
  "o1-pro": "openai",
  "o3": "openai",
  "o3-mini": "openai",
  "o4-mini": "openai",

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

  // Aliases (user-friendly names)
  "claude-sonnet": "anthropic",
  "claude-opus": "anthropic",
  "claude-haiku": "anthropic",
};

/**
 * Alias resolution - maps friendly names to specific model versions.
 */
const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet": "claude-sonnet-4-5-20250929",
  "claude-opus": "claude-opus-4-5-20251101",
  "claude-haiku": "claude-3-5-haiku-20241022",
  "gpt-4o-latest": "gpt-4o",
  "o1-latest": "o1",
  "o3-latest": "o3",
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
}

// Singleton instance
export const providerRegistry = new ProviderRegistry();
```

---

## 7. Multi-Turn Reasoning Persistence

### 7.1 The Challenge

Both OpenAI and Anthropic require that reasoning/thinking content be passed back during multi-turn tool call loops. This ensures the model can:

1. Reference its previous reasoning when deciding next actions
2. Maintain coherent chains of thought across tool calls
3. Verify authenticity (Anthropic's signatures)

### 7.2 Solution: Provider Data Preservation

The canonical format includes `providerData` in reasoning blocks that stores the original provider-specific data needed for multi-turn:

```typescript
// Example: OpenAI reasoning in multi-turn
const assistantMessage: CanonicalMessage = {
  role: "assistant",
  content: [
    {
      type: "reasoning",
      text: "I need to check the file system to understand the project structure...",
      providerData: {
        provider: "openai",
        payload: {
          // Full OpenAI reasoning item (may include encrypted_content for ZDR)
          type: "reasoning",
          id: "rs_abc123",
          summary: [{ type: "summary_text", text: "I need to check the file system..." }],
          encrypted_content: "...", // Only present in stateless/ZDR mode
        },
      },
    },
    {
      type: "tool_use",
      id: "call_xyz",
      name: "terminal_run",
      input: { input: "ls -la\n" },
    },
  ],
};

// Example: Anthropic thinking in multi-turn
const assistantMessage: CanonicalMessage = {
  role: "assistant",
  content: [
    {
      type: "reasoning",
      text: "Let me analyze the directory structure to find the configuration files...",
      providerData: {
        provider: "anthropic",
        payload: {
          // Full Anthropic thinking block with signature
          type: "thinking",
          thinking: "Let me analyze the directory structure...",
          signature: "WJhc2U2NCBzaWduYXR1cmUgaGVyZQ==",
        },
      },
    },
    {
      type: "tool_use",
      id: "toolu_abc",
      name: "terminal_run",
      input: { input: "ls -la\n" },
    },
  ],
};
```

### 7.3 Cross-Provider Switching

When switching providers mid-thread with reasoning content:

1. **Same provider**: `providerData` is passed through unchanged
2. **Different provider**: `providerData` is dropped (only visible `text` is preserved)

This means switching providers mid-reasoning-loop may lose some context, but the visible reasoning text is always preserved for the user's benefit.

---

## 8. Streaming Event Flow

### 8.1 OpenAI Reasoning Flow

```
response.created
  └── message_start { id }

response.output_item.added (type: "reasoning")
  └── reasoning_start { index, id }

response.reasoning_summary_text.delta (repeated)
  └── reasoning_delta { index, delta }

response.output_item.done (type: "reasoning")
  └── reasoning_done { index, block }

response.output_item.added (type: "function_call")
  └── tool_use_start { index, id, name }

response.function_call_arguments.delta (repeated)
  └── tool_use_delta { index, delta }

response.function_call_arguments.done
  └── tool_use_done { index, id, name, input }

response.completed
  └── message_done { stop_reason, usage }
```

### 8.2 Anthropic Thinking Flow

```
message_start
  └── message_start { id }

content_block_start (type: "thinking")
  └── reasoning_start { index }

content_block_delta (type: "thinking_delta") (repeated)
  └── reasoning_delta { index, delta }

content_block_delta (type: "signature_delta") (captured internally)

content_block_stop
  └── reasoning_done { index, block }

content_block_start (type: "tool_use")
  └── tool_use_start { index, id, name }

content_block_delta (type: "input_json_delta") (repeated)
  └── tool_use_delta { index, delta }

content_block_stop
  └── tool_use_done { index, id, name, input }

message_stop
  └── message_done { stop_reason, usage }
```

---

## 9. Integration with AgentService

### 9.1 Updated Agent Flow

```typescript
// service/src/agent/agent-service.ts (key changes)

import { providerRegistry } from "../llm/registry.js";
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalToolCall,
  CanonicalReasoningBlock,
  ModelConfig,
} from "../llm/types.js";

export class AgentService {
  private async runAgentFlow(params: {
    threadId: string;
    sessionId: string;
    model: string;
    config: ModelConfig;
    controller: AbortController;
  }): Promise<void> {
    const { threadId, model, config, controller } = params;
    const provider = providerRegistry.getProviderForModel(model);
    const conversation = await this.buildCanonicalConversation(threadId);

    let steps = 0;
    while (steps < this.config.agentMaxSteps) {
      if (controller.signal.aborted) {
        throw new Error("agent_canceled");
      }

      // Invoke provider with streaming
      const stream = provider.invoke(
        conversation,
        CANONICAL_TOOLS,
        config,
        controller.signal
      );

      // Process stream and extract results
      const result = await this.processStream(stream, threadId);

      // Build assistant message with all content (text, reasoning, tool calls)
      const assistantContent: CanonicalContentBlock[] = [];

      // Add reasoning blocks (if any)
      for (const reasoning of result.reasoningBlocks) {
        assistantContent.push(reasoning);
      }

      // Add text content (if any)
      if (result.text) {
        assistantContent.push({ type: "text", text: result.text });
      }

      // Add tool calls (if any)
      for (const toolCall of result.toolCalls) {
        assistantContent.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }

      // Add assistant message to conversation
      if (assistantContent.length > 0) {
        conversation.push({
          role: "assistant",
          content: assistantContent,
        });
      }

      // Execute tool calls if any
      if (result.toolCalls.length > 0) {
        const toolResults: CanonicalContentBlock[] = [];

        for (const toolCall of result.toolCalls) {
          const toolResult = await this.executeToolCall(threadId, toolCall);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: JSON.stringify(toolResult),
            is_error: toolResult.error !== undefined,
          });
        }

        // Add tool results as user message
        conversation.push({
          role: "user",
          content: toolResults,
        });

        steps += result.toolCalls.length;
        continue;
      }

      // Final response - save and return
      if (result.text) {
        await this.saveFinalResponse(threadId, result.text, result.reasoningBlocks);
        return;
      }

      // No text or tool calls - should not happen
      throw new Error("Agent produced no output");
    }

    throw new Error("Agent reached max steps");
  }

  private async processStream(
    stream: AsyncIterable<CanonicalStreamEvent>,
    threadId: string
  ): Promise<{
    text: string;
    toolCalls: CanonicalToolCall[];
    reasoningBlocks: CanonicalReasoningBlock[];
  }> {
    let text = "";
    const toolCalls: CanonicalToolCall[] = [];
    const reasoningBlocks: CanonicalReasoningBlock[] = [];

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          text += event.delta;
          this.emitEvent(threadId, "agent.text_delta", { delta: event.delta });
          break;

        case "reasoning_start":
          this.emitEvent(threadId, "agent.reasoning_start", { index: event.index });
          break;

        case "reasoning_delta":
          this.emitEvent(threadId, "agent.reasoning_delta", {
            index: event.index,
            delta: event.delta,
          });
          break;

        case "reasoning_done":
          reasoningBlocks.push(event.block);
          this.emitEvent(threadId, "agent.reasoning_done", {
            index: event.index,
            text: event.block.text,
          });
          break;

        case "reasoning_redacted":
          reasoningBlocks.push(event.block);
          this.emitEvent(threadId, "agent.reasoning_redacted", { index: event.index });
          break;

        case "tool_use_start":
          this.emitEvent(threadId, "agent.tool_call_start", {
            id: event.id,
            name: event.name,
          });
          break;

        case "tool_use_done":
          toolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
          this.emitEvent(threadId, "agent.tool_call", {
            id: event.id,
            name: event.name,
            args: event.input,
          });
          break;

        case "message_done":
          this.emitEvent(threadId, "agent.message_done", {
            stop_reason: event.stop_reason,
            usage: event.usage,
          });
          break;

        case "error":
          throw event.error;
      }
    }

    return { text, toolCalls, reasoningBlocks };
  }
}
```

---

## 10. Database Storage

### 10.1 Message Content Storage

Messages are stored with their full canonical content, including reasoning blocks:

```typescript
// Example stored message content (JSON in database)
{
  "role": "assistant",
  "content": [
    {
      "type": "reasoning",
      "text": "I should first check what files exist in the current directory...",
      "providerData": {
        "provider": "openai",
        "payload": { /* OpenAI reasoning item */ }
      }
    },
    {
      "type": "text",
      "text": "Let me check the project structure."
    },
    {
      "type": "tool_use",
      "id": "call_abc123",
      "name": "terminal_run",
      "input": { "input": "ls -la\n" }
    }
  ]
}
```

### 10.2 Schema Considerations

The existing message schema stores `content` as text (JSON stringified). This approach continues to work since canonical content is JSON-serializable. No schema changes required.

---

## 11. SSE Event Updates

### 11.1 New Reasoning Events

```typescript
// New SSE events for reasoning/thinking

// Reasoning started
{
  "event": "agent.reasoning_start",
  "data": { "index": 0 }
}

// Reasoning content streaming
{
  "event": "agent.reasoning_delta",
  "data": { "index": 0, "delta": "I need to " }
}

// Reasoning complete
{
  "event": "agent.reasoning_done",
  "data": { "index": 0, "text": "I need to check the file system..." }
}

// Reasoning redacted (Anthropic safety filter)
{
  "event": "agent.reasoning_redacted",
  "data": { "index": 0 }
}
```

### 11.2 Updated Event Enum

```typescript
// service/src/agent/event-bus.ts

export type AgentEventType =
  | "agent.started"
  | "agent.text_delta"
  | "agent.reasoning_start"    // NEW
  | "agent.reasoning_delta"    // NEW
  | "agent.reasoning_done"     // NEW
  | "agent.reasoning_redacted" // NEW
  | "agent.tool_call_start"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.message_done"
  | "agent.error"
  | "agent.completed";
```

---

## 12. Configuration

### 12.1 Environment Variables

```bash
# Provider API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom base URLs (for proxies, Azure, etc.)
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com

# Default model (can be overridden per-request)
DEFAULT_MODEL=gpt-4o

# Reasoning defaults
DEFAULT_REASONING_EFFORT=medium
DEFAULT_REASONING_SUMMARY=auto
```

### 12.2 Runtime Configuration

```typescript
// service/src/config.ts additions

export const config = {
  // ... existing config

  // LLM Provider settings
  llm: {
    defaultModel: process.env.DEFAULT_MODEL ?? "gpt-4o",
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? "",
      baseURL: process.env.OPENAI_BASE_URL,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      baseURL: process.env.ANTHROPIC_BASE_URL,
    },
    reasoning: {
      defaultEffort: (process.env.DEFAULT_REASONING_EFFORT ?? "medium") as "low" | "medium" | "high",
      defaultSummary: (process.env.DEFAULT_REASONING_SUMMARY ?? "auto") as "auto" | "concise" | "detailed",
    },
  },
};
```

---

## 13. File Structure

```
service/src/llm/
├── index.ts              # Provider initialization and exports
├── types.ts              # Canonical type definitions (Section 2)
├── provider.ts           # LLMProvider interface (Section 3)
├── registry.ts           # ProviderRegistry (Section 6)
└── providers/
    ├── openai.ts         # OpenAI provider (Section 4)
    └── anthropic.ts      # Anthropic provider (Section 5)
```

---

## 14. Testing Strategy

### 14.1 Unit Tests

```typescript
// test/llm/types.test.ts
describe("Canonical Types", () => {
  it("serializes reasoning blocks correctly", () => { ... });
  it("preserves provider data through serialization", () => { ... });
});

// test/llm/providers/openai.test.ts
describe("OpenAIProvider", () => {
  describe("transformMessages", () => {
    it("converts canonical messages with reasoning to OpenAI format", () => { ... });
    it("preserves reasoning provider data for multi-turn", () => { ... });
  });
  describe("transformStream", () => {
    it("emits reasoning events from OpenAI stream", () => { ... });
  });
});

// test/llm/providers/anthropic.test.ts
describe("AnthropicProvider", () => {
  describe("transformMessages", () => {
    it("converts canonical messages with thinking to Anthropic format", () => { ... });
    it("preserves thinking signatures for multi-turn", () => { ... });
  });
  describe("transformStream", () => {
    it("emits reasoning events from Anthropic thinking stream", () => { ... });
    it("handles redacted thinking blocks", () => { ... });
  });
});
```

### 14.2 Integration Tests

```typescript
// test/llm/integration.test.ts
describe("Provider Integration", () => {
  it("completes multi-turn reasoning loop with OpenAI", async () => { ... });
  it("completes multi-turn thinking loop with Anthropic", async () => { ... });
  it("handles provider switch mid-thread", async () => { ... });
});
```

---

## 15. Open Questions

1. **Token counting**: Should we implement provider-specific token counters, or rely on provider-reported usage?

2. **Reasoning visibility**: Should reasoning content be shown to end users by default, or hidden behind a toggle?

3. **Cost tracking**: How should we attribute costs when reasoning tokens are significantly more expensive?

4. **Cache strategy**: Should we implement response caching at the canonical level?

5. **Fallback behavior**: If a provider fails mid-stream, should we retry with another provider?

---

## 16. References

- [OpenAI Responses API Documentation](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI Reasoning Guide](https://platform.openai.com/docs/guides/reasoning)
- [Anthropic Messages API Documentation](https://docs.anthropic.com/en/api/messages)
- [Anthropic Extended Thinking Documentation](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)

---

*Document Version: 1.0*
*Last Updated: 2025-12-14*
*Author: Bud Development Team*
