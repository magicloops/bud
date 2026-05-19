/**
 * OpenAI Provider Implementation
 *
 * Implements the LLMProvider interface for OpenAI models,
 * including GPT-5 series with reasoning support.
 */

import OpenAI from "openai";
import type { LLMProvider } from "../provider.js";
import { getCatalogEntry } from "../model-catalog.js";
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
    // GPT-5.5
    "gpt-5.5",
    // GPT-5.4 series
    "gpt-5.4-2026-03-05",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano-2026-03-17",
    // GPT-5 series (with reasoning) - dated versions
    "gpt-5.2-2025-12-11",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano-2025-08-07",
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
    const catalogEntry = getCatalogEntry(model);
    if (catalogEntry?.provider === "openai") {
      return {
        supportsVision: catalogEntry.capabilities.vision,
        supportsTools: catalogEntry.capabilities.tools,
        supportsStreaming: catalogEntry.capabilities.streaming,
        supportsJsonMode: catalogEntry.capabilities.structuredOutputs,
        maxContextTokens: catalogEntry.capabilities.contextWindowTokens,
        maxOutputTokens: catalogEntry.capabilities.maxOutputTokens,
        supportsReasoning: catalogEntry.reasoning.kind === "openai_reasoning_effort",
        supportsThinking: false,
        supportsInterleavedThinking: false,
      };
    }

    const isReasoning = this.isReasoningModel(model);
    const limits = this.getFallbackModelLimits(model);
    return {
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      maxContextTokens: limits.contextTokens,
      maxOutputTokens: limits.outputTokens,
      supportsReasoning: isReasoning,
      supportsThinking: false,
      supportsInterleavedThinking: false,
    };
  }

  private getFallbackModelLimits(model: string): { contextTokens: number; outputTokens: number } {
    if (model.includes("gpt-5.5") || model.includes("gpt-5.4-2026")) {
      return { contextTokens: 1_050_000, outputTokens: 128_000 };
    }
    if (model.includes("gpt-5.4-mini") || model.includes("gpt-5.4-nano")) {
      return { contextTokens: 400_000, outputTokens: 128_000 };
    }
    return { contextTokens: 256_000, outputTokens: 32_768 };
  }

  private applyReasoningConfig(
    params: OpenAI.Responses.ResponseCreateParams,
    config: ModelConfig,
    isReasoningModel: boolean,
  ): void {
    if (!isReasoningModel || !config.reasoning?.enabled) {
      return;
    }

    (params as unknown as Record<string, unknown>).reasoning = {
      effort: config.reasoning.effort ?? "medium",
      summary: config.reasoning.summaryLevel ?? "auto",
    };
    (params as unknown as Record<string, unknown>).include = ["reasoning.encrypted_content"];
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
      parallel_tool_calls: false,
      max_output_tokens: config.maxOutputTokens,
      // GPT-5 series doesn't support temperature/top_p
      temperature: isReasoning ? undefined : config.temperature,
      top_p: isReasoning ? undefined : config.topP,
      stream: true,
    };

    // Add reasoning configuration for GPT-5 series.
    this.applyReasoningConfig(params, config, isReasoning);

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
      parallel_tool_calls: false,
      max_output_tokens: config.maxOutputTokens,
      temperature: isReasoning ? undefined : config.temperature,
      top_p: isReasoning ? undefined : config.topP,
      stream: false,
    };

    this.applyReasoningConfig(params, config, isReasoning);

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

        for (const block of blocks) {
          switch (block.type) {
            case "reasoning":
              if (block.providerData?.provider === "openai") {
                items.push(block.providerData.payload as OpenAIInputItem);
              }
              break;
            case "text":
              items.push({
                type: "message",
                role: "assistant",
                content: block.text,
              });
              break;
            case "tool_use":
              items.push({
                type: "function_call",
                call_id: block.id,
                name: block.name,
                arguments: JSON.stringify(block.input),
              });
              break;
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

  /**
   * Transform canonical tools to OpenAI strict mode format.
   *
   * OpenAI's strict mode requires:
   * - ALL properties must be in the `required` array
   * - Optional fields must use `type: ["type", "null"]` pattern
   * - `additionalProperties: false` on all objects
   *
   * This method transforms standard JSON Schema (where optional fields
   * are simply omitted from `required`) to OpenAI's strict format.
   */
  private transformTools(tools: CanonicalTool[]): OpenAITool[] {
    return tools.map(tool => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: this.transformSchemaForStrictMode(
        tool.parameters as unknown as Record<string, unknown>
      ),
      strict: true,
    }));
  }

  /**
   * Transform a JSON Schema to OpenAI strict mode format.
   * - Adds null to type for optional properties
   * - Adds all properties to required array
   * - Ensures additionalProperties is false
   */
  private transformSchemaForStrictMode(
    schema: Record<string, unknown>
  ): Record<string, unknown> {
    // Deep clone to avoid mutating original
    const result = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
    return this.transformSchemaNodeForStrictMode(result) as Record<string, unknown>;
  }

  private transformSchemaNodeForStrictMode(schema: unknown): unknown {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return schema;
    }

    const result = schema as Record<string, unknown>;

    if (result.items) {
      result.items = this.transformSchemaNodeForStrictMode(result.items);
    }

    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(result[key])) {
        result[key] = result[key].map((entry) => this.transformSchemaNodeForStrictMode(entry));
      }
    }

    if (this.isObjectSchema(result)) {
      const properties = isRecord(result.properties)
        ? result.properties as Record<string, Record<string, unknown>>
        : {};
      const required = new Set<string>(
        Array.isArray(result.required) ? result.required as string[] : []
      );
      const allPropertyNames = Object.keys(properties);

      for (const propName of allPropertyNames) {
        const transformed = this.transformSchemaNodeForStrictMode(properties[propName]);
        const prop = isRecord(transformed) ? transformed : properties[propName];
        if (!required.has(propName)) {
          this.addNullToOptionalSchema(prop);
        }
        properties[propName] = prop;
      }

      result.properties = properties;
      result.required = allPropertyNames;
      result.additionalProperties = false;
    }

    return result;
  }

  private isObjectSchema(schema: Record<string, unknown>): boolean {
    return schema.type === "object" ||
      (Array.isArray(schema.type) && schema.type.includes("object")) ||
      isRecord(schema.properties);
  }

  private addNullToOptionalSchema(schema: Record<string, unknown>): void {
    const currentType = schema.type;
    if (typeof currentType === "string") {
      schema.type = currentType === "null" ? currentType : [currentType, "null"];
      return;
    }
    if (Array.isArray(currentType)) {
      if (!currentType.includes("null")) {
        schema.type = [...currentType, "null"];
      }
      return;
    }
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.some((entry) => isRecord(entry) && entry.type === "null")) {
        schema.anyOf = [...schema.anyOf, { type: "null" }];
      }
    }
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
    let fallbackIndex = 0;
    let currentReasoning: {
      index: number;
      id?: string;
      summaryParts: string[];
    } | null = null;

    const toolCalls = new Map<string, {
      index: number;
      itemId?: string;
      id: string;
      name: string;
      args: string;
    }>();

    const nextFallbackIndex = () => {
      const index = 1_000_000 + fallbackIndex;
      fallbackIndex += 1;
      return index;
    };

    const eventRecord = (event: unknown): Record<string, unknown> =>
      event && typeof event === "object" ? event as Record<string, unknown> : {};

    const outputIndexFor = (event: unknown): number | undefined => {
      const record = eventRecord(event);
      return typeof record.output_index === "number" ? record.output_index : undefined;
    };

    const contentIndexFor = (event: unknown): number => {
      const record = eventRecord(event);
      return typeof record.content_index === "number" ? record.content_index : 0;
    };

    const orderedIndexFor = (event: unknown): number => {
      const outputIndex = outputIndexFor(event);
      if (typeof outputIndex === "number") {
        return outputIndex * 1000 + contentIndexFor(event);
      }
      return nextFallbackIndex();
    };

    const toolKeyFor = (event: unknown): string | null => {
      const record = eventRecord(event);
      if (typeof record.item_id === "string") {
        return record.item_id;
      }
      const outputIndex = outputIndexFor(event);
      return typeof outputIndex === "number" ? `output:${outputIndex}` : null;
    };

    const findToolCall = (event: unknown) => {
      const key = toolKeyFor(event);
      if (key && toolCalls.has(key)) {
        return toolCalls.get(key);
      }
      const outputIndex = outputIndexFor(event);
      if (typeof outputIndex === "number") {
        return toolCalls.get(`output:${outputIndex}`);
      }
      return undefined;
    };

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
            usage: this.transformUsage(event.response.usage),
            providerData: {
              provider: "openai",
              payload: event.response,
            },
          };
          break;

        case "response.failed": {
          const error = new Error((event.response as unknown as Record<string, unknown>).error
            ? ((event.response as unknown as Record<string, unknown>).error as Record<string, string>).message ?? "Request failed"
            : "Request failed") as Error & {
              provider?: string;
              providerResponse?: unknown;
            };
          error.provider = "openai";
          error.providerResponse = event.response;
          yield {
            type: "error",
            error,
          };
          break;
        }

        // Output item handling (including reasoning)
        case "response.output_item.added":
          if ((event.item as unknown as Record<string, unknown>).type === "reasoning") {
            const item = event.item as unknown as Record<string, unknown>;
            currentReasoning = {
              index: event.output_index * 1000,
              id: typeof item.id === "string" ? item.id : undefined,
              summaryParts: [],
            };
            yield {
              type: "reasoning_start",
              index: currentReasoning.index,
              id: currentReasoning.id,
            };
          } else if ((event.item as unknown as Record<string, unknown>).type === "function_call") {
            const item = event.item as unknown as Record<string, unknown>;
            const itemId = typeof item.id === "string" ? item.id : undefined;
            const callId = typeof item.call_id === "string" ? item.call_id : null;
            const name = typeof item.name === "string" ? item.name : null;
            if (!callId || !name) {
              break;
            }
            const toolCall = {
              index: event.output_index * 1000,
              itemId,
              id: callId,
              name,
              args: "",
            };
            toolCalls.set(`output:${event.output_index}`, toolCall);
            if (itemId) {
              toolCalls.set(itemId, toolCall);
            }
            yield {
              type: "tool_use_start",
              index: toolCall.index,
              id: toolCall.id,
              name: toolCall.name,
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
              index: currentReasoning.index,
              block,
            };
            currentReasoning = null;
          }
          break;

        // Content streaming
        case "response.content_part.added":
          yield {
            type: "content_start",
            index: orderedIndexFor(event),
            content_type:
              (event.part as unknown as Record<string, unknown>).type === "output_text"
                ? "text"
                : "tool_use",
          };
          break;

        case "response.output_text.delta":
          yield { type: "text_delta", index: orderedIndexFor(event), delta: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content_done", index: orderedIndexFor(event) };
          break;

        // Reasoning summary streaming
        case "response.reasoning_summary_text.delta":
          if (currentReasoning) {
            currentReasoning.summaryParts.push(event.delta);
            yield {
              type: "reasoning_delta",
              index: currentReasoning.index,
              delta: event.delta,
            };
          }
          break;

        // Tool call streaming
        case "response.function_call_arguments.delta": {
          const currentToolCall = findToolCall(event);
          if (currentToolCall) {
            currentToolCall.args += event.delta;
            yield {
              type: "tool_use_delta",
              index: currentToolCall.index,
              delta: event.delta,
            };
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const currentToolCall = findToolCall(event);
          if (currentToolCall) {
            const argumentsJson =
              typeof event.arguments === "string" ? event.arguments : currentToolCall.args;
            yield {
              type: "tool_use_done",
              index: currentToolCall.index,
              id: currentToolCall.id,
              name: currentToolCall.name,
              input: JSON.parse(argumentsJson),
            };
            if (currentToolCall.itemId) {
              toolCalls.delete(currentToolCall.itemId);
            }
            const outputIndex = outputIndexFor(event);
            if (typeof outputIndex === "number") {
              toolCalls.delete(`output:${outputIndex}`);
            }
          }
          break;
        }
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
      usage?: unknown;
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
      usage: this.transformUsage(resp.usage),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      providerData: {
        provider: "openai",
        payload: response,
      },
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

  private transformUsage(usage: unknown): CanonicalResponse["usage"] {
    if (!usage || typeof usage !== "object") {
      return undefined;
    }
    const record = usage as Record<string, unknown>;
    const outputDetails = record.output_tokens_details &&
      typeof record.output_tokens_details === "object"
      ? record.output_tokens_details as Record<string, unknown>
      : null;
    const inputDetails = record.input_tokens_details &&
      typeof record.input_tokens_details === "object"
      ? record.input_tokens_details as Record<string, unknown>
      : null;
    return {
      input_tokens: typeof record.input_tokens === "number" ? record.input_tokens : 0,
      output_tokens: typeof record.output_tokens === "number" ? record.output_tokens : 0,
      reasoning_tokens:
        typeof outputDetails?.reasoning_tokens === "number"
          ? outputDetails.reasoning_tokens
          : undefined,
      cached_input_tokens:
        typeof inputDetails?.cached_tokens === "number"
          ? inputDetails.cached_tokens
          : undefined,
    };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
