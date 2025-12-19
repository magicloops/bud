/**
 * Anthropic Provider Implementation
 *
 * Provides Claude model support via the Anthropic Messages API.
 * Supports extended thinking for reasoning capabilities.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { LLMProvider } from "../provider.js";
import type {
  CanonicalMessage,
  CanonicalTool,
  CanonicalStreamEvent,
  CanonicalResponse,
  CanonicalContentBlock,
  CanonicalReasoningBlock,
  CanonicalToolCall,
  ModelConfig,
  ModelCapabilities,
  CanonicalStopReason,
} from "../types.js";

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;
type AnthropicContentBlock = Anthropic.ContentBlockParam;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly supportedModels = [
    // Claude 3.5
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    // Claude 3
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
    // Claude 4.5
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5-20251001",
  ] as const;

  private client: Anthropic;
  private timeout: number;

  constructor(apiKey: string, options?: { timeout?: number }) {
    this.client = new Anthropic({ apiKey });
    this.timeout = options?.timeout ?? 120000;
  }

  supportsModel(model: string): boolean {
    return model.startsWith("claude-");
  }

  private isClaude4(model: string): boolean {
    return model.includes("4-5") || model.includes("4.5");
  }

  /**
   * Get the maximum output tokens allowed for a specific model.
   */
  private getMaxOutputTokensForModel(model: string): number {
    // Claude 4.5 models have higher limits
    if (model.includes("opus-4-5") || model.includes("opus-4.5")) {
      return 64000;
    }
    if (model.includes("sonnet-4-5") || model.includes("sonnet-4.5")) {
      return 64000;
    }
    if (model.includes("haiku-4-5") || model.includes("haiku-4.5")) {
      return 64000;
    }
    // Claude 3.5 and 3 models
    if (model.includes("3-5") || model.includes("3.5")) {
      return 8192;
    }
    // Default for older Claude 3 models
    return 4096;
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isClaude4 = this.isClaude4(model);

    return {
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false, // Use tool_use for structured output
      maxContextTokens: 200000,
      maxOutputTokens: this.getMaxOutputTokensForModel(model),
      supportsReasoning: false, // Different concept from OpenAI
      supportsThinking: true,
      supportsInterleavedThinking: isClaude4,
    };
  }

  /**
   * Calculate thinking budget from effort level.
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
  // Main Invocation Methods
  // ═══════════════════════════════════════════════════════════════════════════

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const { systemPrompt, anthropicMessages } = this.transformMessages(messages);
    const anthropicTools = this.transformTools(tools);

    // Cap max_tokens to model's limit
    const modelMaxTokens = this.getMaxOutputTokensForModel(config.model);
    const requestedMaxTokens = config.maxOutputTokens ?? 4096;
    const maxTokens = Math.min(requestedMaxTokens, modelMaxTokens);

    // Build request params
    const params: Anthropic.MessageCreateParams = {
      model: config.model,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_tokens: maxTokens,
      temperature: config.temperature,
      top_p: config.topP,
      stream: true,
    };

    // Extended thinking configuration
    if (config.reasoning?.enabled) {
      const budgetTokens = this.calculateThinkingBudget(config.reasoning.effort);
      (params as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    // Beta headers for interleaved thinking (Claude 4)
    const headers: Record<string, string> = {};
    if (config.reasoning?.interleaved && this.isClaude4(config.model)) {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    const stream = this.client.messages.stream(params, {
      signal,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });

    yield* this.transformStream(stream);
  }

  async invokeSync(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): Promise<CanonicalResponse> {
    const { systemPrompt, anthropicMessages } = this.transformMessages(messages);
    const anthropicTools = this.transformTools(tools);

    // Cap max_tokens to model's limit
    const modelMaxTokens = this.getMaxOutputTokensForModel(config.model);
    const requestedMaxTokens = config.maxOutputTokens ?? 4096;
    const maxTokens = Math.min(requestedMaxTokens, modelMaxTokens);

    // Build request params - always use streaming for Anthropic
    // The SDK requires streaming for extended thinking operations
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: config.model,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_tokens: maxTokens,
      temperature: config.temperature,
      top_p: config.topP,
      stream: true,
    };

    // Extended thinking configuration
    if (config.reasoning?.enabled) {
      const budgetTokens = this.calculateThinkingBudget(config.reasoning.effort);
      (params as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
    }

    // Use streaming but collect into final response
    const stream = this.client.messages.stream(params, { signal });

    // Collect the full response from the stream
    const finalMessage = await stream.finalMessage();
    return this.parseResponse(finalMessage);
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
    let isFirstSystemMessage = true;

    for (const msg of messages) {
      if (msg.role === "system") {
        const text = this.getTextContent(msg.content);
        if (isFirstSystemMessage) {
          // First system message becomes the Anthropic system parameter
          systemPrompt += text + "\n";
          isFirstSystemMessage = false;
        } else {
          // Mid-conversation system messages (e.g., context sync)
          // Transform to user message with [System Note] prefix
          anthropicMessages.push({
            role: "user",
            content: [{ type: "text", text: `[System Note] ${text}` }],
          });
        }
        continue;
      }

      // After any non-system message, subsequent system messages are mid-conversation
      isFirstSystemMessage = false;

      if (msg.role === "user") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: AnthropicContentBlock[] = [];

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
                  media_type: block.source.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: block.source.data,
                },
              });
              break;

            case "tool_result":
              // Anthropic: tool_result is a content block in user message
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

        if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: "user", content: anthropicContent });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const anthropicContent: AnthropicContentBlock[] = [];

        for (const block of blocks) {
          switch (block.type) {
            case "text":
              anthropicContent.push({ type: "text", text: block.text });
              break;

            case "tool_use":
              // Anthropic: tool_use is a content block
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
                anthropicContent.push(
                  block.providerData.payload as AnthropicContentBlock
                );
              }
              break;

            case "reasoning_redacted":
              // Pass back redacted thinking
              if (block.providerData?.provider === "anthropic") {
                anthropicContent.push(
                  block.providerData.payload as AnthropicContentBlock
                );
              }
              break;
          }
        }

        if (anthropicContent.length > 0) {
          anthropicMessages.push({ role: "assistant", content: anthropicContent });
        }
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
    stream: MessageStream
  ): AsyncIterable<CanonicalStreamEvent> {
    // Track current blocks
    let currentThinking: {
      index: number;
      text: string;
      signature?: string;
    } | null = null;

    let currentToolUse: {
      index: number;
      id: string;
      name: string;
      input: string;
    } | null = null;

    for await (const event of stream) {
      switch (event.type) {
        // Message lifecycle
        case "message_start":
          yield { type: "message_start", id: event.message.id };
          break;

        case "message_stop": {
          const finalMessage = await stream.finalMessage();
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(finalMessage.stop_reason),
            usage: {
              input_tokens: finalMessage.usage.input_tokens,
              output_tokens: finalMessage.usage.output_tokens,
            },
          };
          break;
        }

        // Content blocks
        case "content_block_start": {
          const blockType = event.content_block.type;

          if (blockType === "thinking") {
            currentThinking = {
              index: event.index,
              text: "",
            };
            yield {
              type: "reasoning_start",
              index: event.index,
            };
          } else if (blockType === "text") {
            yield {
              type: "content_start",
              index: event.index,
              content_type: "text",
            };
          } else if (blockType === "tool_use") {
            const toolBlock = event.content_block as { id: string; name: string };
            currentToolUse = {
              index: event.index,
              id: toolBlock.id,
              name: toolBlock.name,
              input: "",
            };
            yield {
              type: "tool_use_start",
              index: event.index,
              id: toolBlock.id,
              name: toolBlock.name,
            };
          }
          break;
        }

        case "content_block_delta": {
          const deltaType = event.delta.type;

          if (deltaType === "thinking_delta") {
            const thinkingDelta = event.delta as { thinking: string };
            if (currentThinking) {
              currentThinking.text += thinkingDelta.thinking;
              yield {
                type: "reasoning_delta",
                index: event.index,
                delta: thinkingDelta.thinking,
              };
            }
          } else if (deltaType === "signature_delta") {
            // Capture signature for multi-turn
            const sigDelta = event.delta as { signature: string };
            if (currentThinking) {
              currentThinking.signature =
                (currentThinking.signature ?? "") + sigDelta.signature;
            }
          } else if (deltaType === "text_delta") {
            const textDelta = event.delta as { text: string };
            yield {
              type: "text_delta",
              index: event.index,
              delta: textDelta.text,
            };
          } else if (deltaType === "input_json_delta") {
            const jsonDelta = event.delta as { partial_json: string };
            if (currentToolUse) {
              currentToolUse.input += jsonDelta.partial_json;
              yield {
                type: "tool_use_delta",
                index: event.index,
                delta: jsonDelta.partial_json,
              };
            }
          }
          break;
        }

        case "content_block_stop":
          if (currentThinking && currentThinking.index === event.index) {
            // Complete thinking block with signature
            const thinkingBlock: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentThinking.text,
              providerData: {
                provider: "anthropic",
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
  // Response Parsing (non-streaming)
  // ═══════════════════════════════════════════════════════════════════════════

  private parseResponse(response: Anthropic.Message): CanonicalResponse {
    const content: CanonicalContentBlock[] = [];
    const toolCalls: CanonicalToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        const toolCall: CanonicalToolCall = {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
        toolCalls.push(toolCall);
        content.push({
          type: "tool_use",
          ...toolCall,
        });
      } else if (block.type === "thinking") {
        const thinkingBlock = block as { type: "thinking"; thinking: string; signature?: string };
        content.push({
          type: "reasoning",
          text: thinkingBlock.thinking,
          providerData: {
            provider: "anthropic",
            payload: block,
          },
        });
      }
    }

    return {
      id: response.id,
      content,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private mapStopReason(
    reason: Anthropic.Message["stop_reason"] | null
  ): CanonicalStopReason {
    switch (reason) {
      case "end_turn": return "end_turn";
      case "tool_use": return "tool_use";
      case "max_tokens": return "max_tokens";
      case "stop_sequence": return "stop_sequence";
      default: return "end_turn";
    }
  }

  private normalizeContent(
    content: string | CanonicalContentBlock[]
  ): CanonicalContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content;
  }

  private getTextContent(content: string | CanonicalContentBlock[]): string {
    if (typeof content === "string") return content;
    const textBlock = content.find(c => c.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text : "";
  }

  /**
   * Extract tool calls from a response.
   */
  extractToolCalls(response: CanonicalResponse): CanonicalToolCall[] {
    return response.toolCalls ?? [];
  }

  /**
   * Extract text content from a response.
   */
  extractText(response: CanonicalResponse): string {
    return response.content
      .filter((b): b is CanonicalContentBlock & { type: "text" } => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }
}
