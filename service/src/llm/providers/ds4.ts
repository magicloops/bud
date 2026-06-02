import { ulid } from "ulid";

import { config } from "../../config.js";
import { ProviderContextWindowError, type LLMProvider } from "../provider.js";
import { getCatalogEntry } from "../model-catalog.js";
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

type ChatMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type ChatCompletionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: {
    include_usage: true;
  };
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  response_format?: {
    type: "json_object";
  };
  tools?: ChatCompletionTool[];
  tool_choice?: ChatToolChoice;
};

type ChatCompletionChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;
};

type PendingToolCall = {
  id: string;
  name: string;
  argumentsText: string;
  sourceIndex: number;
  eventIndex: number;
  started: boolean;
  done: boolean;
};

type ToolUseDoneEvent = Extract<
  CanonicalStreamEvent,
  { type: "tool_use_done" }
>;

const PROVIDER_ID: CanonicalProviderId = "ds4";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_CONTEXT_WINDOW_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

export class Ds4ChatCompletionsProvider implements LLMProvider {
  readonly name = PROVIDER_ID;
  readonly supportedModels: string[];

  private readonly baseURL: string;
  private readonly model: string;
  private readonly contextWindowTokens: number;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: FetchLike;

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
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
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
      throw new Error("ds4 chat completions response did not include a body");
    }

    yield* this.transformStream(readSseData(response.body));
  }

  private buildRequest(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
  ): ChatCompletionRequest {
    const request: ChatCompletionRequest = {
      model: this.model,
      messages: toChatMessages(messages),
      stream: true,
      stream_options: {
        include_usage: true,
      },
      max_tokens: modelConfig.maxOutputTokens ?? this.maxOutputTokens,
    };

    if (typeof modelConfig.temperature === "number") {
      request.temperature = modelConfig.temperature;
    }
    if (typeof modelConfig.topP === "number") {
      request.top_p = modelConfig.topP;
    }
    if (modelConfig.responseFormat === "json") {
      request.response_format = { type: "json_object" };
    }

    const chatTools = toChatTools(tools);
    if (chatTools.length > 0) {
      request.tools = chatTools;
      request.tool_choice = toChatToolChoice(modelConfig.toolChoice);
    } else if (modelConfig.toolChoice === "none") {
      request.tool_choice = "none";
    }

    return request;
  }

  private async toProviderError(response: Response): Promise<Error> {
    const text = await response.text().catch(() => "");
    const message = text
      ? `ds4 chat completions request failed with ${response.status}: ${text}`
      : `ds4 chat completions request failed with ${response.status}`;

    if (isContextWindowError(response.status, text)) {
      return new ProviderContextWindowError({
        provider: PROVIDER_ID,
        model: this.model,
        message,
      });
    }

    return new Error(message);
  }

  private async *transformStream(
    stream: AsyncIterable<string>,
  ): AsyncIterable<CanonicalStreamEvent> {
    let messageStarted = false;
    let textStarted = false;
    let responseId = `ds4-${ulid()}`;
    let stopReason: CanonicalStopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let finalPayload: ChatCompletionChunk | { done: true } | undefined;
    const pendingTools = new Map<number, PendingToolCall>();

    for await (const data of stream) {
      if (data === "[DONE]") {
        finalPayload ??= { done: true };
        break;
      }

      const chunk = parseChunk(data);
      if (!chunk) {
        continue;
      }

      finalPayload = chunk;
      if (chunk.id) {
        responseId = chunk.id;
      }

      if (!messageStarted) {
        messageStarted = true;
        yield { type: "message_start", id: responseId };
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        if (!textStarted) {
          textStarted = true;
          yield {
            type: "content_start",
            index: 0,
            content_type: "text",
          };
        }
        yield {
          type: "text_delta",
          index: 0,
          delta: delta.content,
        };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        const toolIndex = toolCall.index ?? pendingTools.size;
        const pending =
          pendingTools.get(toolIndex) ??
          createPendingToolCall(toolIndex, pendingTools.size);

        if (toolCall.id) {
          pending.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          pending.name = toolCall.function.name;
        }
        if (typeof toolCall.function?.arguments === "string") {
          pending.argumentsText += toolCall.function.arguments;
        }

        pendingTools.set(toolIndex, pending);

        if (!pending.started && pending.id && pending.name) {
          pending.started = true;
          yield {
            type: "tool_use_start",
            index: pending.eventIndex,
            id: pending.id,
            name: pending.name,
          };
        }

        if (pending.started && toolCall.function?.arguments) {
          yield {
            type: "tool_use_delta",
            index: pending.eventIndex,
            delta: toolCall.function.arguments,
          };
        }
      }

      if (choice?.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
      }
      if (chunk.usage) {
        usage = toUsage(chunk.usage);
      }

      if (choice?.finish_reason === "tool_calls") {
        for (const event of doneToolCalls(pendingTools)) {
          yield event;
        }
      }
    }

    if (!messageStarted) {
      messageStarted = true;
      yield { type: "message_start", id: responseId };
    }

    for (const event of doneToolCalls(pendingTools)) {
      yield event;
    }

    if (textStarted) {
      yield { type: "content_done", index: 0 };
    }

    yield {
      type: "message_done",
      stop_reason: stopReason,
      usage,
      providerData: {
        provider: PROVIDER_ID,
        payload: finalPayload ?? { done: true },
      },
    };
  }
}

export function createDs4ProviderFromConfig(): Ds4ChatCompletionsProvider | null {
  if (!config.ds4DirectBaseUrl) {
    return null;
  }

  return new Ds4ChatCompletionsProvider({
    baseURL: config.ds4DirectBaseUrl,
    model: config.ds4DirectModel,
    contextWindowTokens: config.ds4DirectContextTokens,
    maxOutputTokens: config.ds4DirectMaxOutputTokens,
  });
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

function toChatMessages(messages: CanonicalMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];

  for (const message of messages) {
    const blocks = normalizeContent(message.content);

    if (message.role === "system") {
      chatMessages.push({
        role: "system",
        content: textContent(blocks),
      });
      continue;
    }

    if (message.role === "user") {
      let textParts: string[] = [];
      const flushUserText = () => {
        if (textParts.length === 0) {
          return;
        }
        chatMessages.push({
          role: "user",
          content: textParts.join("\n"),
        });
        textParts = [];
      };

      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
          continue;
        }

        if (block.type === "image") {
          textParts.push("[Image input omitted: ds4 direct provider is text-only]");
          continue;
        }

        if (block.type === "tool_result") {
          flushUserText();
          chatMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: serializeToolResult(block.content),
          });
        }
      }

      flushUserText();
      continue;
    }

    const assistantText: string[] = [];
    const toolCalls: ChatToolCall[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        assistantText.push(block.text);
        continue;
      }

      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    if (assistantText.length > 0 || toolCalls.length > 0) {
      chatMessages.push({
        role: "assistant",
        content: assistantText.length > 0 ? assistantText.join("\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return chatMessages;
}

function toChatTools(tools: CanonicalTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

function toChatToolChoice(toolChoice: ToolChoice | undefined): ChatToolChoice {
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
    function: {
      name: toolChoice.name,
    },
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

function parseChunk(data: string): ChatCompletionChunk | null {
  try {
    return JSON.parse(data) as ChatCompletionChunk;
  } catch {
    return null;
  }
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

function* doneToolCalls(
  pendingTools: Map<number, PendingToolCall>,
): Iterable<ToolUseDoneEvent> {
  const calls = [...pendingTools.values()].sort(
    (a, b) => a.sourceIndex - b.sourceIndex,
  );

  for (const call of calls) {
    if (call.done || !call.started) {
      continue;
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

function toUsage(
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): TokenUsage {
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cached_input_tokens: usage.prompt_tokens_details?.cached_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function mapStopReason(reason: string): CanonicalStopReason {
  if (reason === "tool_calls") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "content_filter") {
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
