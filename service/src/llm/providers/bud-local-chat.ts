/**
 * Generic bud-local provider speaking the OpenAI Chat Completions API
 * (design/generic-local-llm-support.md §3.3).
 *
 * Serves dynamically synthesized product models (`bud-local:<bud_id>:<served
 * model id>`) over the Bud local-LLM data plane. Reasoning normalization
 * follows the settled industry conventions: structured `reasoning_content`
 * (DeepSeek API convention, emitted by vllm/SGLang) and `reasoning`
 * (OpenRouter style) deltas map into the canonical reasoning stream, with
 * inline `<think>…</think>` extraction as a fallback for servers that do not
 * split reasoning. Replay is turn-scoped: the in-flight turn's reasoning is
 * replayed through its own tool loop (KV prefix-cache continuity on vllm);
 * completed turns drop it (templates strip prior-turn thinking anyway).
 */

import { Buffer } from "node:buffer";
import type {
  LLMProvider,
  ProviderInvocationContext,
} from "../provider.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalStreamEvent,
  CanonicalStopReason,
  CanonicalTool,
  ModelCapabilities,
  ModelConfig,
  TokenUsage,
  ToolChoice,
} from "../types.js";
import { getCatalogEntry } from "../model-catalog.js";
import {
  openBudLocalLlmHttp,
  LOCAL_LLM_GENERIC_SERVER_ID,
} from "../local-llm-data-plane.js";
import { parseBudLocalModelId } from "../local-llm-capabilities.js";
import { readSseData } from "./ds4.js";

export const BUD_LOCAL_PROVIDER_ID = "bud_local";

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }>;
  tool_choice?:
    | "auto"
    | "required"
    | "none"
    | { type: "function"; function: { name: string } };
};

export class BudLocalChatCompletionsProvider implements LLMProvider {
  readonly name = BUD_LOCAL_PROVIDER_ID;
  // Models are dynamic (per-bud); resolution is catalog-first via the
  // dynamic registry, so this static list stays empty.
  readonly supportedModels: readonly string[] = [];

  supportsModel(model: string): boolean {
    return parseBudLocalModelId(model) !== null;
  }

  getModelCapabilities(model: string): ModelCapabilities {
    const entry = getCatalogEntry(model);
    return {
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      maxContextTokens:
        entry?.capabilities.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: entry?.capabilities.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
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
    context?: ProviderInvocationContext,
  ): AsyncIterable<CanonicalStreamEvent> {
    if (!context?.budId) {
      throw new Error("Bud-local provider requires Bud invocation context");
    }
    const parsed = parseBudLocalModelId(modelConfig.model);
    if (!parsed) {
      throw new Error(`Not a bud-local model id: ${modelConfig.model}`);
    }
    if (parsed.budId !== context.budId) {
      // Security-relevant: a thread on Bud A must not invoke Bud B's model.
      throw new Error(
        `Model ${modelConfig.model} belongs to a different Bud than this thread`,
      );
    }

    const request = this.buildRequest(messages, tools, modelConfig);
    const response = await openBudLocalLlmHttp({
      budId: context.budId,
      threadId: context.threadId,
      ownerUserId: context.ownerUserId,
      localLlmServerId: LOCAL_LLM_GENERIC_SERVER_ID,
      provider: BUD_LOCAL_PROVIDER_ID,
      model: parsed.servedModelId,
      requestMode: "openai_chat_completions",
      method: "POST",
      path: "/v1/chat/completions",
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
      const text = await httpResponse.text().catch(() => "");
      throw new Error(
        text
          ? `bud-local chat completions failed with ${httpResponse.status}: ${text}`
          : `bud-local chat completions failed with ${httpResponse.status}`,
      );
    }
    if (!httpResponse.body) {
      throw new Error("bud-local chat completions response did not include a body");
    }

    yield* transformChatCompletionsStream(readSseData(httpResponse.body));
  }

  buildDebugRequestSnapshot(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
  ): unknown {
    return this.buildRequest(messages, tools, modelConfig);
  }

  buildRequest(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    modelConfig: ModelConfig,
  ): ChatCompletionsRequest {
    const parsed = parseBudLocalModelId(modelConfig.model);
    const request: ChatCompletionsRequest = {
      model: parsed?.servedModelId ?? modelConfig.model,
      messages: toChatMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: modelConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
    if (typeof modelConfig.temperature === "number") {
      request.temperature = modelConfig.temperature;
    }
    if (typeof modelConfig.topP === "number") {
      request.top_p = modelConfig.topP;
    }
    if (tools.length > 0) {
      request.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      request.tool_choice = toChatToolChoice(modelConfig.toolChoice);
    } else if (modelConfig.toolChoice === "none") {
      request.tool_choice = "none";
    }
    return request;
  }
}

function toChatToolChoice(
  choice: ToolChoice | undefined,
): ChatCompletionsRequest["tool_choice"] {
  if (!choice || choice === "auto") {
    return "auto";
  }
  if (choice === "required" || choice === "none") {
    return choice;
  }
  return { type: "function", function: { name: choice.name } };
}

/**
 * Canonical → chat messages. Turn-scoped reasoning replay: assistant
 * messages AFTER the last user-role message form the in-flight turn's tool
 * loop; only their reasoning blocks are sent (as `reasoning_content`).
 * Earlier turns drop reasoning entirely.
 */
export function toChatMessages(messages: CanonicalMessage[]): ChatMessage[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && !containsToolResult(messages[i])) {
      lastUserIndex = i;
      break;
    }
  }

  const out: ChatMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === "system") {
      out.push({ role: "system", content: canonicalText(message.content) });
      return;
    }
    if (message.role === "user") {
      const blocks = Array.isArray(message.content) ? message.content : null;
      const toolResults = blocks?.filter(
        (block): block is Extract<CanonicalContentBlock, { type: "tool_result" }> =>
          block.type === "tool_result",
      );
      if (toolResults && toolResults.length > 0) {
        for (const result of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content:
              typeof result.content === "string"
                ? result.content
                : result.content
                    .map((block) => (block.type === "text" ? block.text : ""))
                    .join(""),
          });
        }
        const remainder = blocks?.filter((block) => block.type === "text") ?? [];
        if (remainder.length > 0) {
          out.push({
            role: "user",
            content: remainder
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
          });
        }
        return;
      }
      out.push({ role: "user", content: canonicalText(message.content) });
      return;
    }

    // Assistant: text + tool calls; reasoning only for the in-flight turn.
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    const text = blocks
      .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> =>
        block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    const toolCalls = blocks
      .filter((block): block is Extract<CanonicalContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
      )
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
    const chatMessage: ChatMessage = {
      role: "assistant",
      content: text.length > 0 ? text : null,
    };
    if (toolCalls.length > 0) {
      chatMessage.tool_calls = toolCalls;
    }
    if (index > lastUserIndex) {
      const reasoning = blocks
        .filter((block) => block.type === "reasoning")
        .map((block) => ("text" in block ? block.text : ""))
        .join("\n");
      if (reasoning.length > 0) {
        chatMessage.reasoning_content = reasoning;
      }
    }
    out.push(chatMessage);
  });
  return out;
}

function containsToolResult(message: CanonicalMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

function canonicalText(content: CanonicalMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

type ToolCallAccumulator = {
  id: string;
  name: string;
  argumentsJson: string;
  eventIndex: number;
  started: boolean;
};

/**
 * Chat-completions SSE → canonical events. Handles `reasoning_content` /
 * `reasoning` deltas, inline `<think>` extraction, incremental tool-call
 * argument assembly, and the trailing usage chunk.
 */
export async function* transformChatCompletionsStream(
  stream: AsyncIterable<string>,
): AsyncIterable<CanonicalStreamEvent> {
  let messageStarted = false;
  let nextIndex = 0;

  let textIndex: number | null = null;
  let reasoningIndex: number | null = null;
  let reasoningText = "";
  const toolCalls = new Map<number, ToolCallAccumulator>();

  // <think> fallback state: buffers content until the tag question resolves.
  let thinkMode: "undecided" | "inside" | "after" = "undecided";
  let thinkBuffer = "";

  let stopReason: CanonicalStopReason = "end_turn";
  let usage: TokenUsage | undefined;

  const ensureMessageStart = function* (
    id?: string,
  ): Iterable<CanonicalStreamEvent> {
    if (!messageStarted) {
      messageStarted = true;
      yield { type: "message_start", id: id ?? "bud-local" };
    }
  };
  const ensureReasoningStart = function* (): Iterable<CanonicalStreamEvent> {
    if (reasoningIndex === null) {
      reasoningIndex = nextIndex;
      nextIndex += 1;
      yield { type: "reasoning_start", index: reasoningIndex };
    }
  };
  const emitReasoningDelta = function* (
    delta: string,
  ): Iterable<CanonicalStreamEvent> {
    if (delta.length === 0) {
      return;
    }
    yield* ensureReasoningStart();
    reasoningText += delta;
    yield { type: "reasoning_delta", index: reasoningIndex as number, delta };
  };
  const finishReasoning = function* (): Iterable<CanonicalStreamEvent> {
    if (reasoningIndex !== null) {
      yield {
        type: "reasoning_done",
        index: reasoningIndex,
        block: { type: "reasoning", text: reasoningText },
      };
      reasoningIndex = null;
    }
  };
  const emitTextDelta = function* (
    delta: string,
  ): Iterable<CanonicalStreamEvent> {
    if (delta.length === 0) {
      return;
    }
    yield* finishReasoning();
    if (textIndex === null) {
      textIndex = nextIndex;
      nextIndex += 1;
      yield { type: "content_start", index: textIndex, content_type: "text" };
    }
    yield { type: "text_delta", index: textIndex, delta };
  };

  // Routes raw content through the <think>-tag state machine.
  const emitContent = function* (raw: string): Iterable<CanonicalStreamEvent> {
    let chunk = raw;
    while (chunk.length > 0) {
      if (thinkMode === "undecided") {
        thinkBuffer += chunk;
        chunk = "";
        const trimmed = thinkBuffer.trimStart();
        if (trimmed.length === 0) {
          return; // still whitespace-only; keep buffering
        }
        if (trimmed.startsWith("<think>")) {
          thinkMode = "inside";
          chunk = trimmed.slice("<think>".length);
          thinkBuffer = "";
        } else if ("<think>".startsWith(trimmed)) {
          return; // possible partial opening tag; keep buffering
        } else {
          thinkMode = "after";
          chunk = thinkBuffer;
          thinkBuffer = "";
        }
        continue;
      }
      if (thinkMode === "inside") {
        thinkBuffer += chunk;
        chunk = "";
        const closeAt = thinkBuffer.indexOf("</think>");
        if (closeAt >= 0) {
          yield* emitReasoningDelta(thinkBuffer.slice(0, closeAt));
          const rest = thinkBuffer.slice(closeAt + "</think>".length);
          thinkBuffer = "";
          thinkMode = "after";
          yield* finishReasoning();
          chunk = rest.replace(/^\s+/, "");
        } else {
          // Emit all but a potential partial closing tag.
          const safe = Math.max(0, thinkBuffer.length - ("</think>".length - 1));
          if (safe > 0) {
            yield* emitReasoningDelta(thinkBuffer.slice(0, safe));
            thinkBuffer = thinkBuffer.slice(safe);
          }
        }
        continue;
      }
      yield* emitTextDelta(chunk);
      chunk = "";
    }
  };

  for await (const data of stream) {
    if (data === "[DONE]") {
      break;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    yield* ensureMessageStart(
      typeof payload.id === "string" ? payload.id : undefined,
    );

    const usagePayload = payload.usage as
      | { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } }
      | null
      | undefined;
    if (usagePayload && typeof usagePayload === "object") {
      usage = {
        input_tokens: usagePayload.prompt_tokens ?? 0,
        output_tokens: usagePayload.completion_tokens ?? 0,
        ...(usagePayload.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoning_tokens: usagePayload.completion_tokens_details.reasoning_tokens }
          : {}),
        ...(usagePayload.prompt_tokens_details?.cached_tokens !== undefined
          ? { cached_input_tokens: usagePayload.prompt_tokens_details.cached_tokens }
          : {}),
      };
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices[0] as
      | {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }
      | undefined;
    if (!choice) {
      continue;
    }

    const delta = choice.delta ?? {};
    const structuredReasoning =
      (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") +
      (typeof delta.reasoning === "string" ? delta.reasoning : "");
    if (structuredReasoning.length > 0) {
      yield* emitReasoningDelta(structuredReasoning);
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield* emitContent(delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      const slot = call.index ?? 0;
      let acc = toolCalls.get(slot);
      if (!acc) {
        acc = {
          id: call.id ?? `call_${slot}`,
          name: call.function?.name ?? "",
          argumentsJson: "",
          eventIndex: nextIndex,
          started: false,
        };
        nextIndex += 1;
        toolCalls.set(slot, acc);
      }
      if (call.id) {
        acc.id = call.id;
      }
      if (call.function?.name) {
        acc.name = acc.started ? acc.name : call.function.name;
      }
      if (!acc.started && acc.name) {
        acc.started = true;
        yield* finishReasoning();
        yield {
          type: "tool_use_start",
          index: acc.eventIndex,
          id: acc.id,
          name: acc.name,
        };
      }
      if (call.function?.arguments) {
        acc.argumentsJson += call.function.arguments;
        if (acc.started) {
          yield {
            type: "tool_use_delta",
            index: acc.eventIndex,
            delta: call.function.arguments,
          };
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  // Flush any buffered undecided content as plain text. (Widen the mode:
  // TS control-flow analysis cannot see the generator closures mutate it.)
  const finalThinkMode: string = thinkMode;
  if (finalThinkMode === "undecided" && thinkBuffer.trim().length > 0) {
    yield* emitTextDelta(thinkBuffer);
    thinkBuffer = "";
  } else if (finalThinkMode === "inside" && thinkBuffer.length > 0) {
    yield* emitReasoningDelta(thinkBuffer);
  }
  yield* finishReasoning();
  if (textIndex !== null) {
    yield { type: "content_done", index: textIndex };
  }
  for (const acc of toolCalls.values()) {
    if (!acc.started) {
      continue;
    }
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(acc.argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    yield {
      type: "tool_use_done",
      index: acc.eventIndex,
      id: acc.id,
      name: acc.name,
      input,
    };
  }
  if (toolCalls.size > 0 && stopReason === "end_turn") {
    stopReason = "tool_use";
  }
  yield* ensureMessageStart();
  yield {
    type: "message_done",
    stop_reason: stopReason,
    ...(usage ? { usage } : {}),
  };
}

function mapFinishReason(reason: string): CanonicalStopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function createBudLocalChatCompletionsProvider(): BudLocalChatCompletionsProvider {
  return new BudLocalChatCompletionsProvider();
}
