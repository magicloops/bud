import { Buffer } from "node:buffer";
import { ulid } from "ulid";

import { config } from "../../config.js";
import {
  ProviderContextWindowError,
  type LLMProvider,
  type ProviderInvocationContext,
} from "../provider.js";
import { getCatalogEntry } from "../model-catalog.js";
import {
  LOCAL_LLM_DS4_SERVER_ID,
  openBudLocalLlmHttp,
} from "../local-llm-data-plane.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalProviderId,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalTool,
  ModelCapabilities,
  ModelConfig,
  TokenUsage,
  ToolChoice,
} from "../types.js";

type FetchLike = typeof fetch;

type Ds4ProviderConfig = {
  baseURL: string;
  model?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  fetch?: FetchLike;
};

type ResponsesInputItem = Record<string, unknown>;

type ResponsesMessageContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
      detail: "auto";
    };

type ResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      name: string;
    };

type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  stream: true;
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  text?: {
    format: {
      type: "json_object";
    };
  };
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: false;
  reasoning?: {
    effort?: string;
    summary?: string;
  };
};

type ResponsesStreamEvent = Record<string, unknown> & {
  type?: string;
};

type Ds4ResponsesStreamDiagnostics = {
  eventCount: number;
  parseErrorCount: number;
  textDeltaCount: number;
  textCharCount: number;
  reasoningDeltaCount: number;
  reasoningCharCount: number;
  toolCallDeltaCount: number;
  toolCallArgumentCharCount: number;
  eventTypes: string[];
};

type MutableDs4ResponsesStreamDiagnostics = Omit<
  Ds4ResponsesStreamDiagnostics,
  "eventTypes"
> & {
  eventTypes: Set<string>;
};

type PendingToolCall = {
  id: string;
  name: string;
  argumentsText: string;
  sourceIndex: number;
  eventIndex: number;
  itemId?: string;
  started: boolean;
  done: boolean;
};

type PendingReasoning = {
  id?: string;
  index: number;
  text: string;
  payload?: Record<string, unknown>;
  started: boolean;
  done: boolean;
};

type ToolUseDoneEvent = Extract<
  CanonicalStreamEvent,
  { type: "tool_use_done" }
>;

const PROVIDER_ID = "ds4" satisfies CanonicalProviderId;
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

export class Ds4ResponsesProvider implements LLMProvider {
  readonly name = PROVIDER_ID;
  readonly supportedModels: string[];

  protected readonly baseURL: string;
  protected readonly model: string;
  protected readonly contextWindowTokens: number;
  protected readonly maxOutputTokens: number;
  protected readonly fetchImpl: FetchLike;

  constructor(providerConfig: Ds4ProviderConfig) {
    if (!providerConfig.baseURL.trim()) {
      throw new Error("ds4 provider requires a baseURL");
    }

    this.baseURL = normalizeDs4BaseUrl(providerConfig.baseURL);
    this.model = providerConfig.model ?? DEFAULT_MODEL;
    this.contextWindowTokens =
      providerConfig.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.maxOutputTokens =
      providerConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.fetchImpl = providerConfig.fetch ?? fetch;
    this.supportedModels = Array.from(new Set([DEFAULT_MODEL, this.model]));
  }

  supportsModel(model: string): boolean {
    return this.supportedModels.includes(model);
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const catalogEntry = getCatalogEntry(model);
    if (catalogEntry?.provider === PROVIDER_ID) {
      return {
        supportsVision: catalogEntry.capabilities.vision,
        supportsTools: catalogEntry.capabilities.tools,
        supportsStreaming: catalogEntry.capabilities.streaming,
        supportsJsonMode: catalogEntry.capabilities.structuredOutputs,
        maxContextTokens: catalogEntry.capabilities.contextWindowTokens,
        maxOutputTokens: catalogEntry.capabilities.maxOutputTokens,
        supportsReasoning: false,
        supportsThinking: false,
        supportsInterleavedThinking: false,
      };
    }

    return {
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      maxContextTokens: this.contextWindowTokens,
      maxOutputTokens: this.maxOutputTokens,
      supportsReasoning: false,
      supportsThinking: false,
      supportsInterleavedThinking: false,
    };
  }

  async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalStreamEvent> {
    const response = await this.fetchImpl(`${this.baseURL}/responses`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.buildRequest(messages, tools, modelConfig)),
      signal,
    });

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    if (!response.body) {
      throw new Error("ds4 responses response did not include a body");
    }

    yield* this.transformStream(readSseData(response.body));
  }

  buildDebugRequestSnapshot(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
  ): unknown {
    return this.buildRequest(messages, tools, modelConfig);
  }

  protected buildRequest(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
  ): ResponsesRequest {
    const { input, instructions } = toResponsesInput(messages);
    const request: ResponsesRequest = {
      model: this.model,
      input,
      ...(instructions ? { instructions } : {}),
      stream: true,
      max_output_tokens: modelConfig.maxOutputTokens ?? this.maxOutputTokens,
      parallel_tool_calls: false,
    };

    if (typeof modelConfig.temperature === "number") {
      request.temperature = modelConfig.temperature;
    }
    if (typeof modelConfig.topP === "number") {
      request.top_p = modelConfig.topP;
    }
    if (modelConfig.responseFormat === "json") {
      request.text = { format: { type: "json_object" } };
    }
    if (modelConfig.reasoning?.enabled) {
      request.reasoning = {
        effort: modelConfig.reasoning.effort,
        summary: modelConfig.reasoning.summaryLevel ?? "auto",
      };
    }

    const responseTools = toResponsesTools(tools);
    if (responseTools.length > 0) {
      request.tools = responseTools;
      request.tool_choice = toResponsesToolChoice(modelConfig.toolChoice);
    } else if (modelConfig.toolChoice === "none") {
      request.tool_choice = "none";
    }

    return request;
  }

  protected async toProviderError(response: Response): Promise<Error> {
    const text = await response.text().catch(() => "");
    const message = text
      ? `ds4 responses request failed with ${response.status}: ${text}`
      : `ds4 responses request failed with ${response.status}`;

    if (isContextWindowError(response.status, text)) {
      return new ProviderContextWindowError({
        provider: PROVIDER_ID,
        model: this.model,
        message,
      });
    }

    return new Error(message);
  }

  protected async *transformStream(
    stream: AsyncIterable<string>,
  ): AsyncIterable<CanonicalStreamEvent> {
    let fallbackIndex = 0;
    let messageStarted = false;
    let responseId = `ds4-${ulid()}`;
    let stopReason: CanonicalStopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let finalPayload: Record<string, unknown> | { done: true } | undefined;
    let currentReasoning: PendingReasoning | null = null;
    const textStarted = new Set<number>();
    const textDone = new Set<number>();
    const reasoningByKey = new Map<string, PendingReasoning>();
    const toolCalls = new Map<string, PendingToolCall>();
    const diagnostics = createResponsesStreamDiagnostics();

    const ensureMessageStarted = function* (id?: string): Iterable<CanonicalStreamEvent> {
      if (id) {
        responseId = id;
      }
      if (!messageStarted) {
        messageStarted = true;
        yield { type: "message_start", id: responseId };
      }
    };

    const nextFallbackIndex = () => {
      const index = 1_000_000 + fallbackIndex;
      fallbackIndex += 1;
      return index;
    };

    const orderedIndexFor = (event: ResponsesStreamEvent): number => {
      const outputIndex = numberField(event, "output_index");
      const contentIndex = numberField(event, "content_index") ?? 0;
      return typeof outputIndex === "number"
        ? outputIndex * 1000 + contentIndex
        : nextFallbackIndex();
    };

    const outputKeyFor = (event: ResponsesStreamEvent): string | null => {
      const itemId = stringField(event, "item_id");
      if (itemId) {
        return itemId;
      }
      const outputIndex = numberField(event, "output_index");
      return typeof outputIndex === "number" ? `output:${outputIndex}` : null;
    };

    const reasoningFor = (
      event: ResponsesStreamEvent,
      create = true,
    ): PendingReasoning | null => {
      const key = outputKeyFor(event);
      if (key && reasoningByKey.has(key)) {
        return reasoningByKey.get(key) ?? null;
      }
      if (!create) {
        return currentReasoning;
      }

      const reasoning: PendingReasoning = {
        index: orderedIndexFor(event),
        text: "",
        started: false,
        done: false,
      };
      if (key) {
        reasoningByKey.set(key, reasoning);
      }
      currentReasoning = reasoning;
      return reasoning;
    };

    const ensureTextStarted = function* (
      index: number,
    ): Iterable<CanonicalStreamEvent> {
      if (!textStarted.has(index)) {
        textStarted.add(index);
        yield {
          type: "content_start",
          index,
          content_type: "text",
        };
      }
    };

    const ensureReasoningStarted = function* (
      reasoning: PendingReasoning,
    ): Iterable<CanonicalStreamEvent> {
      if (!reasoning.started) {
        reasoning.started = true;
        yield {
          type: "reasoning_start",
          index: reasoning.index,
          ...(reasoning.id ? { id: reasoning.id } : {}),
        };
      }
    };

    const toolCallFor = (
      event: ResponsesStreamEvent,
      create = false,
    ): PendingToolCall | null => {
      const itemId = stringField(event, "item_id");
      if (itemId && toolCalls.has(itemId)) {
        return toolCalls.get(itemId) ?? null;
      }
      const outputIndex = numberField(event, "output_index");
      const outputKey = typeof outputIndex === "number" ? `output:${outputIndex}` : null;
      if (outputKey && toolCalls.has(outputKey)) {
        return toolCalls.get(outputKey) ?? null;
      }
      if (!create) {
        return null;
      }

      const sourceIndex = outputIndex ?? toolCalls.size;
      const pending = createPendingToolCall(sourceIndex, toolCalls.size);
      pending.eventIndex = typeof outputIndex === "number" ? outputIndex * 1000 : pending.eventIndex;
      if (itemId) {
        pending.itemId = itemId;
        toolCalls.set(itemId, pending);
      }
      if (outputKey) {
        toolCalls.set(outputKey, pending);
      }
      return pending;
    };

    const doneReasoning = function* (
      reasoning: PendingReasoning,
      payload?: Record<string, unknown>,
    ): Iterable<CanonicalStreamEvent> {
      if (reasoning.done) {
        return;
      }
      reasoning.done = true;
      yield {
        type: "reasoning_done",
        index: reasoning.index,
        block: {
          type: "reasoning",
          text: reasoning.text,
          providerData: {
            provider: PROVIDER_ID,
            payload: payload ?? reasoning.payload ?? {
              type: "reasoning",
              ...(reasoning.id ? { id: reasoning.id } : {}),
              summary: reasoning.text
                ? [{ type: "summary_text", text: reasoning.text }]
                : [],
            },
          },
        },
      };
    };

    for await (const data of stream) {
      if (data === "[DONE]") {
        finalPayload ??= { done: true };
        break;
      }

      const event = parseResponsesEvent(data);
      if (!event) {
        diagnostics.parseErrorCount += 1;
        continue;
      }

      recordResponsesStreamDiagnostics(diagnostics, event);
      finalPayload = event;

      switch (event.type) {
        case "response.created": {
          const response = recordField(event, "response");
          yield* ensureMessageStarted(stringField(response, "id"));
          break;
        }

        case "response.output_item.added": {
          yield* ensureMessageStarted();
          const item = recordField(event, "item");
          if (item.type === "reasoning") {
            const reasoning = reasoningFor(event);
            if (!reasoning) {
              break;
            }
            reasoning.id = stringField(item, "id") ?? reasoning.id;
            reasoning.payload = item;
            currentReasoning = reasoning;
            yield* ensureReasoningStarted(reasoning);
          } else if (item.type === "function_call") {
            const callId = stringField(item, "call_id");
            const name = stringField(item, "name");
            if (!callId || !name) {
              break;
            }
            const pending = toolCallFor(event, true);
            if (!pending) {
              break;
            }
            pending.id = callId;
            pending.name = name;
            pending.itemId = stringField(item, "id") ?? pending.itemId;
            const itemId = pending.itemId;
            if (itemId) {
              toolCalls.set(itemId, pending);
            }
            if (!pending.started) {
              pending.started = true;
              yield {
                type: "tool_use_start",
                index: pending.eventIndex,
                id: pending.id,
                name: pending.name,
              };
            }
          }
          break;
        }

        case "response.output_item.done": {
          const item = recordField(event, "item");
          if (item.type === "reasoning") {
            const reasoning = reasoningFor(event, false);
            if (reasoning) {
              reasoning.id = stringField(item, "id") ?? reasoning.id;
              reasoning.payload = item;
              if (!reasoning.text) {
                reasoning.text = reasoningTextFromItem(item);
              }
              yield* ensureReasoningStarted(reasoning);
              yield* doneReasoning(reasoning, item);
            }
          } else if (item.type === "function_call") {
            const pending = toolCallFor(event, false);
            if (pending && !pending.done) {
              const argumentsText = stringField(item, "arguments");
              if (argumentsText && !pending.argumentsText) {
                pending.argumentsText = argumentsText;
              }
              yield* doneResponseToolCall(pending);
            }
          }
          break;
        }

        case "response.content_part.added": {
          const part = recordField(event, "part");
          if (part.type === "output_text") {
            yield* ensureMessageStarted();
            yield* ensureTextStarted(orderedIndexFor(event));
          }
          break;
        }

        case "response.output_text.delta": {
          const delta = stringField(event, "delta");
          if (!delta) {
            break;
          }
          yield* ensureMessageStarted();
          const index = orderedIndexFor(event);
          yield* ensureTextStarted(index);
          yield { type: "text_delta", index, delta };
          break;
        }

        case "response.output_text.done": {
          const index = orderedIndexFor(event);
          if (textStarted.has(index) && !textDone.has(index)) {
            textDone.add(index);
            yield { type: "content_done", index };
          }
          break;
        }

        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
        case "response.reasoning.delta": {
          const delta = stringField(event, "delta") ?? stringField(event, "text");
          if (!delta) {
            break;
          }
          yield* ensureMessageStarted();
          const reasoning = reasoningFor(event);
          if (!reasoning) {
            break;
          }
          reasoning.text += delta;
          currentReasoning = reasoning;
          yield* ensureReasoningStarted(reasoning);
          yield {
            type: "reasoning_delta",
            index: reasoning.index,
            delta,
          };
          break;
        }

        case "response.function_call_arguments.delta": {
          const delta = stringField(event, "delta");
          if (!delta) {
            break;
          }
          yield* ensureMessageStarted();
          const pending = toolCallFor(event, false);
          if (!pending || !pending.started) {
            break;
          }
          pending.argumentsText += delta;
          yield {
            type: "tool_use_delta",
            index: pending.eventIndex,
            delta,
          };
          break;
        }

        case "response.function_call_arguments.done": {
          yield* ensureMessageStarted();
          const pending = toolCallFor(event, false);
          if (!pending) {
            break;
          }
          const argumentsText = stringField(event, "arguments");
          if (argumentsText) {
            pending.argumentsText = argumentsText;
          }
          yield* doneResponseToolCall(pending);
          break;
        }

        case "response.completed":
        case "response.incomplete": {
          const response = recordField(event, "response");
          yield* ensureMessageStarted(stringField(response, "id"));
          usage = toResponsesUsage(response.usage);
          stopReason = mapResponsesStopReason(
            typeof response.status === "string" ? response.status : event.type,
          );
          for (const event of doneAllResponseToolCalls(toolCalls)) {
            yield event;
          }
          for (const reasoning of uniqueReasoning(reasoningByKey, currentReasoning)) {
            yield* ensureReasoningStarted(reasoning);
            yield* doneReasoning(reasoning);
          }
          for (const index of textStarted) {
            if (!textDone.has(index)) {
              textDone.add(index);
              yield { type: "content_done", index };
            }
          }
          yield {
            type: "message_done",
            stop_reason: stopReason,
            usage,
            providerData: {
              provider: PROVIDER_ID,
              payload: {
                streamDiagnostics: finalizeResponsesStreamDiagnostics(diagnostics),
                finalEvent: finalPayload ?? event,
                response,
              },
            },
          };
          return;
        }

        case "response.failed": {
          const response = recordField(event, "response");
          const error = recordField(response, "error");
          const message = stringField(error, "message") ?? "ds4 responses request failed";
          const code = stringField(error, "code");
          if (isContextWindowError(400, `${code ?? ""} ${message}`)) {
            yield {
              type: "error",
              error: new ProviderContextWindowError({
                provider: PROVIDER_ID,
                model: this.model,
                message,
                providerCode: code,
              }),
            };
            return;
          }
          const providerError = new Error(message) as Error & {
            provider?: string;
            providerResponse?: unknown;
          };
          providerError.provider = PROVIDER_ID;
          providerError.providerResponse = response;
          yield { type: "error", error: providerError };
          return;
        }
      }
    }

    yield* ensureMessageStarted();
    for (const event of doneAllResponseToolCalls(toolCalls)) {
      yield event;
    }
    for (const reasoning of uniqueReasoning(reasoningByKey, currentReasoning)) {
      yield* ensureReasoningStarted(reasoning);
      yield* doneReasoning(reasoning);
    }
    for (const index of textStarted) {
      if (!textDone.has(index)) {
        yield { type: "content_done", index };
      }
    }
    yield {
      type: "message_done",
      stop_reason: stopReason,
      usage,
      providerData: {
        provider: PROVIDER_ID,
        payload: {
          streamDiagnostics: finalizeResponsesStreamDiagnostics(diagnostics),
          finalEvent: finalPayload ?? { done: true },
        },
      },
    };
  }
}

export class BudLocalDs4Provider extends Ds4ResponsesProvider {
  constructor() {
    super({
      baseURL: "http://bud-local-ds4.invalid/v1",
      model: config.ds4DirectModel,
      contextWindowTokens: config.ds4DirectContextTokens,
      maxOutputTokens: config.ds4DirectMaxOutputTokens,
    });
  }

  override async *invoke(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
    signal?: AbortSignal,
    context?: ProviderInvocationContext,
  ): AsyncIterable<CanonicalStreamEvent> {
    if (!context?.budId) {
      throw new Error("Bud-local ds4 provider requires Bud invocation context");
    }

    const request = this.buildRequest(messages, tools, modelConfig);
    const response = await openBudLocalLlmHttp({
      budId: context.budId,
      threadId: context.threadId,
      ownerUserId: context.ownerUserId,
      localLlmServerId: LOCAL_LLM_DS4_SERVER_ID,
      provider: PROVIDER_ID,
      model: this.model,
      requestMode: "ds4_openai_responses",
      method: "POST",
      path: "/v1/responses",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: Buffer.from(JSON.stringify(request), "utf-8"),
      signal,
    });

    const httpResponse = new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
    if (!httpResponse.ok) {
      throw await this.toProviderError(httpResponse);
    }
    if (!httpResponse.body) {
      throw new Error("Bud-local ds4 response did not include a body");
    }

    yield* this.transformStream(readSseData(httpResponse.body));
  }
}

export function createDs4ProviderFromConfig(): Ds4ResponsesProvider | null {
  if (!config.ds4DirectBaseUrl) {
    return null;
  }

  return new Ds4ResponsesProvider({
    baseURL: config.ds4DirectBaseUrl,
    model: config.ds4DirectModel,
    contextWindowTokens: config.ds4DirectContextTokens,
    maxOutputTokens: config.ds4DirectMaxOutputTokens,
  });
}

export function createBudLocalDs4Provider(): BudLocalDs4Provider {
  return new BudLocalDs4Provider();
}

function normalizeDs4BaseUrl(baseURL: string): string {
  const trimmed = baseURL.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let parsed: URL;

  try {
    parsed = new URL(withScheme);
  } catch (error) {
    throw new Error(
      `Invalid DS4_DIRECT_BASE_URL: ${baseURL}. Expected a local HTTP URL such as http://127.0.0.1:8000/v1`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid DS4_DIRECT_BASE_URL protocol: ${parsed.protocol}. Expected http:// or https://`,
    );
  }

  if (parsed.hostname === "127.0.0.0") {
    throw new Error(
      "Invalid DS4_DIRECT_BASE_URL host: 127.0.0.0. Use 127.0.0.1 or localhost for the local ds4 server.",
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}

function toResponsesInput(messages: CanonicalMessage[]): {
  input: ResponsesInputItem[];
  instructions?: string;
} {
  const input: ResponsesInputItem[] = [];
  const leadingInstructions: string[] = [];
  let seenNonSystem = false;

  for (const message of messages) {
    const blocks = normalizeContent(message.content);

    if (message.role === "system") {
      const text = textContent(blocks);
      if (!seenNonSystem) {
        if (text.trim()) {
          leadingInstructions.push(text);
        }
      } else {
        input.push({
          type: "message",
          role: "system",
          content: [{ type: "input_text", text }],
        });
      }
      continue;
    }

    seenNonSystem = true;

    if (message.role === "user") {
      appendResponsesUserInput(input, blocks);
      continue;
    }

    appendResponsesAssistantInput(input, blocks);
  }

  return {
    input,
    ...(leadingInstructions.length > 0
      ? { instructions: leadingInstructions.join("\n\n") }
      : {}),
  };
}

function appendResponsesUserInput(
  input: ResponsesInputItem[],
  blocks: CanonicalContentBlock[],
): void {
  let contentParts: ResponsesMessageContent[] = [];

  const flushUserContent = () => {
    if (contentParts.length === 0) {
      return;
    }
    input.push({
      type: "message",
      role: "user",
      content: contentParts,
    });
    contentParts = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      contentParts.push({
        type: "input_text",
        text: block.text,
      });
      continue;
    }

    if (block.type === "image") {
      contentParts.push({
        type: "input_text",
        text: "[Image input omitted: ds4 direct provider is text-only]",
      });
      continue;
    }

    if (block.type === "tool_result") {
      flushUserContent();
      input.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: serializeToolResult(block.content),
      });
    }
  }

  flushUserContent();
}

function appendResponsesAssistantInput(
  input: ResponsesInputItem[],
  blocks: CanonicalContentBlock[],
): void {
  for (const block of blocks) {
    if (block.type === "reasoning") {
      const payload = block.providerData?.provider === PROVIDER_ID &&
        isRecord(block.providerData.payload)
        ? block.providerData.payload
        : null;
      if (payload) {
        input.push(payload);
      }
      continue;
    }

    if (block.type === "text") {
      input.push({
        type: "message",
        role: "assistant",
        content: block.text,
        ...(block.assistantPhase ? { phase: block.assistantPhase } : {}),
      });
      continue;
    }

    if (block.type === "tool_use") {
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }
}

function toResponsesTools(tools: CanonicalTool[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
  }));
}

function toResponsesToolChoice(toolChoice: ToolChoice | undefined): ResponsesToolChoice {
  if (!toolChoice || toolChoice === "auto") {
    return "auto";
  }
  if (toolChoice === "none") {
    return "none";
  }
  if (toolChoice === "required") {
    return "required";
  }

  return {
    type: "function",
    name: toolChoice.name,
  };
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let dataLines: string[] = [];

  const processLine = function* (line: string): Iterable<string> {
    if (line === "") {
      if (dataLines.length > 0) {
        yield dataLines.join("\n");
        dataLines = [];
      }
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        for (const data of processLine(line)) {
          yield data;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const data of processLine(buffer)) {
        yield data;
      }
    }
    for (const data of processLine("")) {
      yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseResponsesEvent(data: string): ResponsesStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createResponsesStreamDiagnostics(): MutableDs4ResponsesStreamDiagnostics {
  return {
    eventCount: 0,
    parseErrorCount: 0,
    textDeltaCount: 0,
    textCharCount: 0,
    reasoningDeltaCount: 0,
    reasoningCharCount: 0,
    toolCallDeltaCount: 0,
    toolCallArgumentCharCount: 0,
    eventTypes: new Set(),
  };
}

function recordResponsesStreamDiagnostics(
  diagnostics: MutableDs4ResponsesStreamDiagnostics,
  event: ResponsesStreamEvent,
): void {
  diagnostics.eventCount += 1;
  if (event.type) {
    diagnostics.eventTypes.add(event.type);
  }

  if (event.type === "response.output_text.delta") {
    const delta = stringField(event, "delta");
    if (delta) {
      diagnostics.textDeltaCount += 1;
      diagnostics.textCharCount += delta.length;
    }
  }

  if (
    event.type === "response.reasoning_summary_text.delta" ||
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.reasoning.delta"
  ) {
    const delta = stringField(event, "delta") ?? stringField(event, "text");
    if (delta) {
      diagnostics.reasoningDeltaCount += 1;
      diagnostics.reasoningCharCount += delta.length;
    }
  }

  if (event.type === "response.function_call_arguments.delta") {
    const delta = stringField(event, "delta");
    if (delta) {
      diagnostics.toolCallDeltaCount += 1;
      diagnostics.toolCallArgumentCharCount += delta.length;
    }
  }
}

function finalizeResponsesStreamDiagnostics(
  diagnostics: MutableDs4ResponsesStreamDiagnostics,
): Ds4ResponsesStreamDiagnostics {
  return {
    ...diagnostics,
    eventTypes: [...diagnostics.eventTypes].sort(),
  };
}

function createPendingToolCall(
  sourceIndex: number,
  ordinal: number,
): PendingToolCall {
  return {
    id: "",
    name: "",
    argumentsText: "",
    sourceIndex,
    eventIndex: 1000 + ordinal,
    started: false,
    done: false,
  };
}

function* doneResponseToolCall(
  call: PendingToolCall,
): Iterable<ToolUseDoneEvent> {
  if (call.done || !call.started) {
    return;
  }

  call.done = true;
  yield {
    type: "tool_use_done",
    index: call.eventIndex,
    id: call.id,
    name: call.name,
    input: parseToolArguments(call.argumentsText),
  };
}

function* doneAllResponseToolCalls(
  toolCalls: Map<string, PendingToolCall>,
): Iterable<ToolUseDoneEvent> {
  const seen = new Set<PendingToolCall>();
  const calls: PendingToolCall[] = [];
  for (const call of toolCalls.values()) {
    if (seen.has(call)) {
      continue;
    }
    seen.add(call);
    calls.push(call);
  }

  calls.sort((left, right) => left.sourceIndex - right.sourceIndex);
  for (const call of calls) {
    yield* doneResponseToolCall(call);
  }
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve the raw payload for diagnostics when ds4 streams malformed JSON.
  }

  return { raw_arguments: argumentsText };
}

function uniqueReasoning(
  reasoningByKey: Map<string, PendingReasoning>,
  currentReasoning: PendingReasoning | null,
): PendingReasoning[] {
  const seen = new Set<PendingReasoning>();
  const reasoningBlocks: PendingReasoning[] = [];
  for (const reasoning of reasoningByKey.values()) {
    if (seen.has(reasoning)) {
      continue;
    }
    seen.add(reasoning);
    reasoningBlocks.push(reasoning);
  }
  if (currentReasoning && !seen.has(currentReasoning)) {
    reasoningBlocks.push(currentReasoning);
  }
  return reasoningBlocks.sort((left, right) => left.index - right.index);
}

function reasoningTextFromItem(item: Record<string, unknown>): string {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((entry) => {
        if (!isRecord(entry)) {
          return "";
        }
        return typeof entry.text === "string" ? entry.text : "";
      })
      .join("");
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!isRecord(entry)) {
          return "";
        }
        return typeof entry.text === "string" ? entry.text : "";
      })
      .join("");
  }

  return "";
}

function toResponsesUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};

  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cached_input_tokens:
      typeof inputDetails.cached_tokens === "number"
        ? inputDetails.cached_tokens
        : undefined,
    reasoning_tokens:
      typeof outputDetails.reasoning_tokens === "number"
        ? outputDetails.reasoning_tokens
        : undefined,
  };
}

function mapResponsesStopReason(status: string): CanonicalStopReason {
  if (status === "response.incomplete" || status === "incomplete") {
    return "max_tokens";
  }
  if (status === "response.failed" || status === "failed") {
    return "error";
  }
  return "end_turn";
}

function normalizeContent(
  content: string | CanonicalContentBlock[],
): CanonicalContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

function textContent(blocks: CanonicalContentBlock[]): string {
  return blocks
    .filter((block): block is CanonicalContentBlock & { type: "text" } => {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join("\n");
}

function serializeToolResult(
  content: string | CanonicalContentBlock[],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

function isContextWindowError(status: number, text: string): boolean {
  const lower = text.toLowerCase();
  return (
    status === 413 ||
    lower.includes("context") ||
    lower.includes("token limit") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
