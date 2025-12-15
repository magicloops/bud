/**
 * OpenAI Provider Implementation
 *
 * Implements the LLMProvider interface for OpenAI models,
 * including GPT-5 series with reasoning support.
 */

import OpenAI from "openai";
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

// OpenAI-specific types
type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAITool = OpenAI.Responses.Tool;
type OpenAIResponse = Awaited<ReturnType<OpenAI["responses"]["create"]>>;

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly supportedModels = [
    // Standard models
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    // GPT-5 series (with reasoning)
    "gpt-5",
    "gpt-5.1",
    "gpt-5.2",
  ] as const;

  private client: OpenAI;

  constructor(apiKey: string, options?: { baseURL?: string; timeout?: number }) {
    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseURL,
      timeout: options?.timeout,
    });
  }

  supportsModel(model: string): boolean {
    return model.startsWith("gpt-");
  }

  /**
   * Check if model is a reasoning model (GPT-5 series).
   */
  private isReasoningModel(model: string): boolean {
    return model.startsWith("gpt-5");
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const isReasoning = this.isReasoningModel(model);
    return {
      supportsVision: model.includes("4o") || model.includes("4.1") || model.startsWith("gpt-5"),
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      maxContextTokens: model.startsWith("gpt-5") ? 256000 : 128000,
      maxOutputTokens: model.startsWith("gpt-5") ? 32768 : 16384,
      supportsReasoning: isReasoning,
      supportsThinking: false,
      supportsInterleavedThinking: false,
    };
  }

  /**
   * Invoke the model with streaming.
   */
  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): AsyncIterable<CanonicalStreamEvent> {
    const input = this.transformMessages(messages);
    const openaiTools = this.transformTools(tools);
    const isReasoning = this.isReasoningModel(config.model);

    const params: OpenAI.Responses.ResponseCreateParams = {
      model: config.model,
      input,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_output_tokens: config.maxOutputTokens,
      // GPT-5 series doesn't support temperature/top_p
      temperature: isReasoning ? undefined : config.temperature,
      top_p: isReasoning ? undefined : config.topP,
      stream: true,
    };

    // Add reasoning configuration for GPT-5 series
    if (isReasoning && config.reasoning?.enabled) {
      params.reasoning = {
        effort: config.reasoning.effort ?? "medium",
        summary: config.reasoning.summaryLevel ?? "auto",
      };
    }

    // Add JSON response format if requested
    if (config.responseFormat === "json") {
      params.text = { format: { type: "json_object" } };
    }

    const stream = await this.client.responses.create(
      params,
      signal ? { signal } : undefined
    );

    yield* this.transformStream(stream);
  }

  /**
   * Invoke the model without streaming.
   * Collects the full response before returning.
   */
  async invokeSync(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    config: ModelConfig,
    signal?: AbortSignal
  ): Promise<CanonicalResponse> {
    const input = this.transformMessages(messages);
    const openaiTools = this.transformTools(tools);
    const isReasoning = this.isReasoningModel(config.model);

    const params: OpenAI.Responses.ResponseCreateParams = {
      model: config.model,
      input,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: this.transformToolChoice(config.toolChoice),
      max_output_tokens: config.maxOutputTokens,
      temperature: isReasoning ? undefined : config.temperature,
      top_p: isReasoning ? undefined : config.topP,
      stream: false,
    };

    if (isReasoning && config.reasoning?.enabled) {
      params.reasoning = {
        effort: config.reasoning.effort ?? "medium",
        summary: config.reasoning.summaryLevel ?? "auto",
      };
    }

    if (config.responseFormat === "json") {
      params.text = { format: { type: "json_object" } };
    }

    const response = await this.client.responses.create(
      params,
      signal ? { signal } : undefined
    ) as OpenAIResponse;

    return this.parseResponse(response);
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
        const toolResults = blocks.filter(b => b.type === "tool_result");
        const otherContent = blocks.filter(b => b.type !== "tool_result");

        // Tool results become function_call_output items
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

        // Regular content becomes a message
        if (otherContent.length > 0) {
          items.push({
            type: "message",
            role: "user",
            content: this.transformContentToOpenAI(otherContent),
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        const blocks = this.normalizeContent(msg.content);
        const textBlocks = blocks.filter(b => b.type === "text");
        const toolUses = blocks.filter(b => b.type === "tool_use");
        const reasoningBlocks = blocks.filter(
          b => b.type === "reasoning" || b.type === "reasoning_redacted"
        );

        // Pass back reasoning items for multi-turn (GPT-5)
        for (const reasoning of reasoningBlocks) {
          if (
            reasoning.type === "reasoning" &&
            reasoning.providerData?.provider === "openai"
          ) {
            items.push(reasoning.providerData.payload as OpenAIInputItem);
          }
        }

        // Text content - for assistant messages, use simple string content
        // The OpenAI Responses API input format differs from output format
        if (textBlocks.length > 0) {
          const text = textBlocks
            .map(b => (b as { type: "text"; text: string }).text)
            .join("\n");
          items.push({
            type: "message",
            role: "assistant",
            content: text,
          });
        }

        // Tool calls
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

  private transformContentToOpenAI(
    blocks: CanonicalContentBlock[]
  ): OpenAI.Responses.ResponseInputMessageContentList {
    return blocks.map(block => {
      if (block.type === "text") {
        return { type: "input_text" as const, text: block.text };
      }
      if (block.type === "image") {
        return {
          type: "input_image" as const,
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
          detail: "auto" as const,
        };
      }
      throw new Error(`Cannot transform ${block.type} to OpenAI input`);
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
      // Cast through unknown since JSONSchema7 doesn't have index signature
      parameters: tool.parameters as unknown as Record<string, unknown>,
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
    let currentReasoning: {
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
        // Message lifecycle
        case "response.created":
          yield { type: "message_start", id: event.response.id };
          break;

        case "response.completed":
          yield {
            type: "message_done",
            stop_reason: this.mapStopReason(event.response.status ?? "completed"),
            usage: event.response.usage ? {
              input_tokens: event.response.usage.input_tokens,
              output_tokens: event.response.usage.output_tokens,
              reasoning_tokens: (event.response.usage as unknown as Record<string, unknown>).output_tokens_details
                ? ((event.response.usage as unknown as Record<string, unknown>).output_tokens_details as Record<string, number>).reasoning_tokens
                : undefined,
            } : undefined,
          };
          break;

        case "response.failed":
          yield {
            type: "error",
            error: new Error((event.response as unknown as Record<string, unknown>).error
              ? ((event.response as unknown as Record<string, unknown>).error as Record<string, string>).message ?? "Request failed"
              : "Request failed"),
          };
          break;

        // Output item handling (including reasoning)
        case "response.output_item.added":
          if ((event.item as unknown as Record<string, unknown>).type === "reasoning") {
            currentReasoning = {
              id: (event.item as unknown as Record<string, string>).id,
              summaryParts: [],
              rawItem: event.item,
            };
            yield {
              type: "reasoning_start",
              index: event.output_index,
              id: (event.item as unknown as Record<string, string>).id,
            };
          } else if ((event.item as unknown as Record<string, unknown>).type === "function_call") {
            const item = event.item as unknown as Record<string, string>;
            currentToolCall = {
              index: event.output_index,
              id: item.call_id,
              name: item.name,
              args: "",
            };
            yield {
              type: "tool_use_start",
              index: event.output_index,
              id: item.call_id,
              name: item.name,
            };
          }
          break;

        case "response.output_item.done":
          if ((event.item as unknown as Record<string, unknown>).type === "reasoning" && currentReasoning) {
            const block: CanonicalReasoningBlock = {
              type: "reasoning",
              text: currentReasoning.summaryParts.join(""),
              providerData: {
                provider: "openai",
                payload: event.item,
              },
            };
            yield {
              type: "reasoning_done",
              index: event.output_index,
              block,
            };
            currentReasoning = null;
          }
          break;

        // Content streaming
        case "response.content_part.added":
          yield {
            type: "content_start",
            index: contentIndex,
            content_type: (event.part as unknown as Record<string, unknown>).type === "output_text" ? "text" : "tool_use",
          };
          break;

        case "response.output_text.delta":
          yield { type: "text_delta", index: contentIndex, delta: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content_done", index: contentIndex };
          contentIndex++;
          break;

        // Reasoning summary streaming
        case "response.reasoning_summary_text.delta":
          if (currentReasoning) {
            currentReasoning.summaryParts.push(event.delta);
            yield {
              type: "reasoning_delta",
              index: event.output_index,
              delta: event.delta,
            };
          }
          break;

        // Tool call streaming
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
  // Response Parsing (non-streaming)
  // ═══════════════════════════════════════════════════════════════════════════

  private parseResponse(response: OpenAIResponse): CanonicalResponse {
    // Cast through unknown to handle OpenAI's union types
    const resp = response as unknown as {
      id: string;
      output?: unknown[];
      output_text?: string | string[];
      status?: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const content: CanonicalContentBlock[] = [];
    const toolCalls: CanonicalToolCall[] = [];
    const items = resp.output;

    if (Array.isArray(items)) {
      for (const item of items) {
        const typedItem = item as Record<string, unknown>;

        if (typedItem.type === "reasoning") {
          // Extract reasoning summary
          const summary = typedItem.summary as Array<{ type: string; text: string }> | undefined;
          const text = summary
            ?.filter(s => s.type === "summary_text")
            .map(s => s.text)
            .join("") ?? "";

          content.push({
            type: "reasoning",
            text,
            providerData: {
              provider: "openai",
              payload: item,
            },
          });
        } else if (typedItem.type === "message") {
          // Extract text content
          const msgContent = typedItem.content as Array<{ type: string; text: string }> | undefined;
          if (msgContent) {
            for (const block of msgContent) {
              if (block.type === "output_text") {
                content.push({ type: "text", text: block.text });
              }
            }
          }
        } else if (typedItem.type === "function_call") {
          const toolCall: CanonicalToolCall = {
            id: typedItem.call_id as string,
            name: typedItem.name as string,
            input: JSON.parse(typedItem.arguments as string),
          };
          toolCalls.push(toolCall);
          content.push({
            type: "tool_use",
            ...toolCall,
          });
        }
      }
    }

    // Also check output_text for simple text responses
    if (content.length === 0 && resp.output_text) {
      const text = Array.isArray(resp.output_text)
        ? resp.output_text.join("\n")
        : resp.output_text;
      if (text) {
        content.push({ type: "text", text });
      }
    }

    return {
      id: resp.id,
      content,
      stopReason: this.mapStopReason(resp.status ?? "completed"),
      usage: resp.usage ? {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
      } : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Extract tool calls from a non-streaming response.
   * Utility method for the agent service.
   */
  extractToolCalls(response: CanonicalResponse): CanonicalToolCall[] {
    return response.content
      .filter((b): b is CanonicalContentBlock & { type: "tool_use" } => b.type === "tool_use")
      .map(b => ({
        id: b.id,
        name: b.name,
        input: b.input,
      }));
  }

  /**
   * Extract text content from a non-streaming response.
   * Utility method for the agent service.
   */
  extractText(response: CanonicalResponse): string {
    return response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private mapStopReason(status: string): CanonicalStopReason {
    switch (status) {
      case "completed": return "end_turn";
      case "incomplete": return "max_tokens";
      case "failed": return "error";
      default: return "end_turn";
    }
  }

  private normalizeContent(content: string | CanonicalContentBlock[]): CanonicalContentBlock[] {
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
}
