import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { config, type ReasoningEffortSetting } from "../config.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import {
  providerRegistry,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalProviderId,
  type CanonicalReasoningBlock,
  type CanonicalResponse,
  type CanonicalStopReason,
  type CanonicalTool,
  type CanonicalToolCall,
  type ModelConfig,
  resolveModelReasoning,
  type ResolvedModelReasoning,
  type TokenUsage,
} from "../llm/index.js";
import {
  normalizeToolKeyInput,
  parseWaitForArg,
  type AgentFinalDirective,
  type AgentToolCallDirective,
} from "./contracts.js";
import {
  ASK_USER_QUESTIONS_TOOL,
  normalizeAskUserQuestionsRequest,
} from "./user-question-contracts.js";

type StreamedModelResponse = {
  response: CanonicalResponse;
  assistantClientId: string | null;
  provider: CanonicalProviderId;
  providerModel: string;
};

const MODEL_RESPONSE_TEXT_PREVIEW_CHARS = 4_000;
const MODEL_RESPONSE_JSON_PREVIEW_CHARS = 8_000;
const MODEL_RESPONSE_ERROR_MESSAGE_CHARS = 12_000;

type ModelResponseDiagnostic = {
  id: string;
  stopReason: CanonicalStopReason;
  usage?: TokenUsage;
  content: unknown[];
  toolCalls?: unknown[];
  providerData?: unknown;
};

export class AgentModelResponseError extends Error {
  readonly code: string;
  readonly modelResponse: ModelResponseDiagnostic;

  constructor(message: string, response: CanonicalResponse, code: string) {
    const modelResponse = buildModelResponseDiagnostic(response);
    super(
      `${message}; response=${truncateText(
        stringifyForDiagnostic(modelResponse),
        MODEL_RESPONSE_ERROR_MESSAGE_CHARS,
      )}`,
    );
    this.name = "AgentModelResponseError";
    this.code = code;
    this.modelResponse = modelResponse;
  }
}

// Canonical tool definitions using standard JSON Schema.
const CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_send",
    description:
      "Send input to the current terminal program. Use for shell commands, multiline shell input, REPL/TUI input, confirmations, launching interactive programs, and single-key actions.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Optional text to send literally to the terminal.",
        },
        submit: {
          type: "boolean",
          description: "When true, press Enter after sending the text.",
        },
        key: {
          type: "string",
          description:
            'Optional semantic key gesture. Use backend-neutral names such as "ctrl+c", "enter", or "escape".',
        },
        observe_after_ms: {
          type: "integer",
          description:
            'Optional delay before the final capture when wait_for:"none" is used. Defaults to 1000ms for that explicit fast path.',
        },
        wait_for: {
          type: "string",
          enum: ["none", "changed", "settled"],
          description:
            'Optional wait mode after sending input. Defaults to "settled" when omitted.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "terminal_observe",
    description:
      "Observe the rendered terminal screen or recent scrollback after interactive work or when more visibility is needed.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "integer",
          description: "Optional number of scrollback lines to include. Negative values mean recent history.",
        },
        wait_for: {
          type: "string",
          enum: ["none", "changed", "settled"],
          description: "Optional wait mode before observing.",
        },
        view: {
          type: "string",
          enum: ["delta", "screen", "history"],
          description: "Observation view. Defaults to delta. Use screen for the full current screen and history for recent scrollback.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_open",
    description:
      "Open or reuse a browser web view for an HTTP server running on the Bud host loopback interface, then attach it to the current thread.",
    parameters: {
      type: "object",
      properties: {
        target_port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Loopback port where the local web server is listening.",
        },
        target_host: {
          type: "string",
          enum: ["127.0.0.1", "localhost", "::1"],
          description:
            "Loopback host. Defaults to localhost when omitted. If the user names localhost, 127.0.0.1, or ::1 explicitly, preserve that exact host.",
        },
        path: {
          type: "string",
          description: "Absolute path to open on the local app. Defaults to /.",
        },
        title: {
          type: "string",
          description: "Short display name for the proxied site.",
        },
      },
      required: ["target_port"],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_close",
    description:
      "Detach the current thread web view. Optionally disable the proxied site when the user asked to stop exposing it.",
    parameters: {
      type: "object",
      properties: {
        proxied_site_id: {
          type: "string",
          description: "Optional proxied site id to close. Defaults to the current thread web view.",
        },
        disable: {
          type: "boolean",
          description: "When true, disable the proxied site in addition to detaching it.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "web_view_list",
    description:
      "List owned proxied web views for this Bud and identify the current thread attachment.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: ASK_USER_QUESTIONS_TOOL,
    description:
      "Ask the user one or more structured, skippable questions before continuing the current task. Use only when the answer is needed to proceed.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the question prompt.",
        },
        body: {
          type: "string",
          description: "Optional context explaining why this input is needed.",
        },
        submit_label: {
          type: "string",
          description: "Optional label for the form submit action.",
        },
        skip_all_label: {
          type: "string",
          description: "Optional label for skipping every question.",
        },
        questions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              question_id: {
                type: "string",
                description: "Stable snake_case or kebab-case id for the question.",
              },
              kind: {
                type: "string",
                enum: ["boolean", "single_choice", "multi_choice", "text", "number"],
              },
              label: {
                type: "string",
                description: "User-visible question text.",
              },
              help_text: {
                type: "string",
                description: "Optional helper text for the question.",
              },
              importance: {
                type: "string",
                enum: ["required", "important", "optional"],
                description: "Advisory importance only; users may still skip.",
              },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    choice_id: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["choice_id", "label"],
                  additionalProperties: false,
                },
              },
              default_answer: {
                type: "object",
                description: "Optional typed default answer matching the question kind.",
              },
              multiline: { type: "boolean" },
              placeholder: { type: "string" },
              min_length: { type: "integer", minimum: 0 },
              max_length: { type: "integer", minimum: 1 },
              min: { type: "number" },
              max: { type: "number" },
              step: { type: "number", minimum: 0 },
              unit: { type: "string" },
            },
            required: ["kind", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
];

export class AgentModelRunner {
  private readonly runtime: AgentRuntimeStateManager;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly defaultReasoningEffort: ReasoningEffortSetting;

  constructor(
    runtime: AgentRuntimeStateManager,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean,
    defaultReasoningEffort: ReasoningEffortSetting = config.agentReasoningEffortDefault,
  ) {
    this.runtime = runtime;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    this.defaultReasoningEffort = defaultReasoningEffort;
  }

  resolveReasoningEffort(
    model: string,
    requested?: ReasoningEffortSetting | null,
  ): ReasoningEffortSetting {
    return this.resolveModelReasoning(model, requested).reasoningLevel;
  }

  resolveModelReasoning(
    model: string,
    requested?: ReasoningEffortSetting | null,
  ): ResolvedModelReasoning {
    return resolveModelReasoning(model, requested, this.defaultReasoningEffort);
  }

  resolveProviderName(model: string): CanonicalProviderId {
    const provider = providerRegistry.getProviderForModel(model);
    return provider.name as CanonicalProviderId;
  }

  async invokeModel(
    threadId: string,
    turnId: string,
    messages: CanonicalMessage[],
    model: string,
    modelReasoning: ResolvedModelReasoning,
    signal?: AbortSignal,
  ): Promise<StreamedModelResponse> {
    const { providerModel, reasoning, reasoningLevel } = modelReasoning;
    const last = messages.at(-1);
    const lastRole = last?.role ?? "n/a";
    this.debug("Calling LLM via provider", {
      entries: messages.length,
      lastRole,
      reasoningEffort: reasoningLevel,
      model,
    });

    const provider = providerRegistry.getProviderForModel(model);
    const providerName = provider.name as CanonicalProviderId;

    const modelConfig: ModelConfig = {
      model: providerModel,
      maxOutputTokens: config.agentMaxOutputTokens,
      reasoning,
      responseFormat: "text",
    };

    const textBlocks = new Map<number, string>();
    const reasoningBlocks = new Map<number, CanonicalReasoningBlock>();
    const toolCallsByIndex = new Map<number, CanonicalToolCall>();
    const pendingTextPrefixes = new Map<number, string>();
    const seenTextIndexes = new Set<number>();

    let responseId: string | null = null;
    let stopReason: CanonicalStopReason = "end_turn";
    let usage: TokenUsage | undefined;
    let providerData: CanonicalResponse["providerData"] | undefined;
    let draftText = "";
    let hasDraftText = false;
    let textBlockCount = 0;
    let assistantClientId: string | null = null;

    const ensureAssistantClientId = () => {
      assistantClientId ??= generateMessageClientId();
      return assistantClientId;
    };

    const emitAssistantDraftStart = () => {
      if (hasDraftText) {
        return;
      }
      const clientId = ensureAssistantClientId();
      const cursor = this.runtime.emit(threadId, {
        event: "agent.message_start",
        data: {
          turn_id: turnId,
          client_id: clientId,
        },
      });
      this.runtime.setDraftAssistant(threadId, clientId, draftText, cursor);
      hasDraftText = true;
    };

    const emitAssistantDraftDelta = (delta: string) => {
      if (!delta) {
        return;
      }
      emitAssistantDraftStart();
      const clientId = ensureAssistantClientId();
      draftText += delta;
      const cursor = this.runtime.emit(threadId, {
        event: "agent.message_delta",
        data: {
          turn_id: turnId,
          client_id: clientId,
          delta,
        },
      });
      this.runtime.setDraftAssistant(threadId, clientId, draftText, cursor);
    };

    for await (const event of provider.invoke(messages, CANONICAL_TOOLS, modelConfig, signal)) {
      switch (event.type) {
        case "message_start":
          responseId = event.id;
          break;
        case "message_done":
          stopReason = event.stop_reason;
          usage = event.usage;
          providerData = event.providerData;
          break;
        case "content_start":
          if (event.content_type === "text") {
            if (!seenTextIndexes.has(event.index)) {
              pendingTextPrefixes.set(event.index, textBlockCount > 0 ? "\n" : "");
              seenTextIndexes.add(event.index);
              textBlockCount += 1;
            }
          }
          break;
        case "text_delta": {
          let prefix = pendingTextPrefixes.get(event.index);
          if (prefix === undefined && !seenTextIndexes.has(event.index)) {
            prefix = textBlockCount > 0 ? "\n" : "";
            seenTextIndexes.add(event.index);
            textBlockCount += 1;
          }
          if (prefix !== undefined) {
            pendingTextPrefixes.delete(event.index);
            emitAssistantDraftDelta(prefix);
          }
          textBlocks.set(event.index, `${textBlocks.get(event.index) ?? ""}${event.delta}`);
          emitAssistantDraftDelta(event.delta);
          break;
        }
        case "tool_use_done":
          toolCallsByIndex.set(event.index, {
            id: event.id,
            name: event.name,
            input: event.input,
          });
          break;
        case "reasoning_done":
        case "reasoning_redacted":
          reasoningBlocks.set(event.index, event.block);
          break;
        case "error":
          throw event.error;
      }
    }

    if (hasDraftText) {
      const clientId = ensureAssistantClientId();
      const cursor = this.runtime.emit(threadId, {
        event: "agent.message_done",
        data: {
          turn_id: turnId,
          client_id: clientId,
          text: draftText,
        },
      });
      this.runtime.setDraftAssistant(threadId, clientId, draftText, cursor);
    }

    const orderedIndexes = Array.from(
      new Set([
        ...textBlocks.keys(),
        ...reasoningBlocks.keys(),
        ...toolCallsByIndex.keys(),
      ]),
    ).sort((left, right) => left - right);

    const content: CanonicalContentBlock[] = [];
    for (const index of orderedIndexes) {
      const reasoningBlock = reasoningBlocks.get(index);
      if (reasoningBlock) {
        content.push(reasoningBlock);
      }

      const textBlock = textBlocks.get(index);
      if (textBlock !== undefined) {
        content.push({ type: "text", text: textBlock });
      }

      const toolCall = toolCallsByIndex.get(index);
      if (toolCall) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        });
      }
    }

    const response: CanonicalResponse = {
      id: responseId ?? ulid(),
      content,
      stopReason,
      usage,
      toolCalls: Array.from(toolCallsByIndex.entries())
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => toolCall),
      providerData,
    };

    this.debug("LLM response received", {
      responseId: response.id,
      stopReason: response.stopReason,
      toolCallCount: response.toolCalls?.length ?? 0,
    });
    this.debugCanonicalResponse(response);

    return {
      response,
      assistantClientId,
      provider: providerName,
      providerModel,
    };
  }

  parseFinalResponse(response: CanonicalResponse): AgentFinalDirective {
    if (response.stopReason === "max_tokens") {
      throw new AgentModelResponseError(
        "model response incomplete: max_tokens reached",
        response,
        "MODEL_MAX_TOKENS",
      );
    }

    const textBlocks = response.content.filter(
      (block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text",
    );
    const aggregated = textBlocks.map((block) => block.text).join("\n");

    const trimmed = aggregated.trim();
    if (!trimmed) {
      throw new AgentModelResponseError(
        "model returned no text or tool call",
        response,
        "MODEL_EMPTY_RESPONSE",
      );
    }

    return {
      type: "final",
      status: "succeeded",
      message: trimmed,
    };
  }

  extractToolCall(response: CanonicalResponse): AgentToolCallDirective | null {
    return this.extractToolCalls(response)[0] ?? null;
  }

  extractToolCalls(response: CanonicalResponse): AgentToolCallDirective[] {
    const toolCalls = response.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    return toolCalls
      .map((toolCall) => this.extractToolCallDirective(toolCall))
      .filter((directive): directive is AgentToolCallDirective => Boolean(directive));
  }

  private extractToolCallDirective(toolCall: CanonicalToolCall): AgentToolCallDirective | null {
    const args = toolCall.input;

    switch (toolCall.name) {
      case "terminal_send":
        return {
          type: "tool_call",
          tool: "terminal.send",
          text: typeof args.text === "string" ? args.text : undefined,
          submit: args.submit === true,
          key: normalizeToolKeyInput(args.key, args.keys),
          observeAfterMs:
            typeof args.observe_after_ms === "number" ? args.observe_after_ms : undefined,
          waitFor: parseWaitForArg(args.wait_for),
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          callId: toolCall.id,
        };
      case "terminal_observe":
        return {
          type: "tool_call",
          tool: "terminal.observe",
          lines: typeof args.lines === "number" ? args.lines : undefined,
          view:
            args.view === "delta" || args.view === "screen" || args.view === "history"
              ? args.view
              : undefined,
          waitFor: parseWaitForArg(args.wait_for),
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          callId: toolCall.id,
        };
      case "web_view_open":
        if (typeof args.target_port !== "number") {
          return null;
        }
        return {
          type: "tool_call",
          tool: "web_view.open",
          targetHost: parseWebViewTargetHost(args.target_host),
          targetPort: args.target_port,
          path: typeof args.path === "string" ? args.path : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
          callId: toolCall.id,
        };
      case "web_view_close":
        return {
          type: "tool_call",
          tool: "web_view.close",
          proxiedSiteId:
            typeof args.proxied_site_id === "string" ? args.proxied_site_id : undefined,
          disable: args.disable === true,
          callId: toolCall.id,
        };
      case "web_view_list":
        return {
          type: "tool_call",
          tool: "web_view.list",
          callId: toolCall.id,
        };
      case ASK_USER_QUESTIONS_TOOL:
        return {
          type: "tool_call",
          tool: ASK_USER_QUESTIONS_TOOL,
          request: normalizeAskUserQuestionsRequest(args),
          callId: toolCall.id,
        };
      default:
        return null;
    }
  }

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }

  private debugCanonicalResponse(response: CanonicalResponse): void {
    if (!this.openaiDebugEnabled) {
      return;
    }
    try {
      this.logger.info({ component: "agent", llm_response: response }, "LLM response payload");
    } catch (err) {
      this.logger.warn(
        { err, component: "agent" },
        "Failed to serialize LLM response for debug logging",
      );
    }
  }
}

function buildModelResponseDiagnostic(response: CanonicalResponse): ModelResponseDiagnostic {
  return {
    id: response.id,
    stopReason: response.stopReason,
    usage: response.usage,
    content: response.content.map((block) => diagnosticContentBlock(block)),
    toolCalls: response.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      input: boundedJsonValue(toolCall.input),
    })),
    providerData: diagnosticProviderData(response.providerData),
  };
}

function diagnosticContentBlock(block: CanonicalContentBlock): unknown {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        charCount: block.text.length,
        text: truncateText(block.text, MODEL_RESPONSE_TEXT_PREVIEW_CHARS),
      };
    case "image":
      return {
        type: "image",
        source: {
          type: block.source.type,
          media_type: block.source.media_type,
          data_char_count: block.source.data.length,
        },
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: boundedJsonValue(block.input),
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        is_error: block.is_error,
        content: typeof block.content === "string"
          ? {
              charCount: block.content.length,
              text: truncateText(block.content, MODEL_RESPONSE_TEXT_PREVIEW_CHARS),
            }
          : block.content.map((nested) => diagnosticContentBlock(nested)),
      };
    case "reasoning":
      return {
        type: "reasoning",
        charCount: block.text.length,
        text: truncateText(block.text, MODEL_RESPONSE_TEXT_PREVIEW_CHARS),
        providerData: diagnosticProviderData(block.providerData),
      };
    case "reasoning_redacted":
      return {
        type: "reasoning_redacted",
        providerData: diagnosticProviderData(block.providerData),
      };
  }
}

function diagnosticProviderData(providerData: CanonicalResponse["providerData"]): unknown {
  if (!providerData) {
    return undefined;
  }
  return {
    provider: providerData.provider,
    payload: boundedJsonValue(providerData.payload),
  };
}

function boundedJsonValue(value: unknown): unknown {
  const serialized = stringifyForDiagnostic(value);
  if (serialized.length <= MODEL_RESPONSE_JSON_PREVIEW_CHARS) {
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      return serialized;
    }
  }
  return {
    truncated: true,
    charCount: serialized.length,
    preview: serialized.slice(0, MODEL_RESPONSE_JSON_PREVIEW_CHARS),
  };
}

function stringifyForDiagnostic(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") {
        return nested.toString();
      }
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) {
          return "[Circular]";
        }
        seen.add(nested);
      }
      return nested;
    });
    return serialized ?? "undefined";
  } catch (err) {
    return JSON.stringify({
      unserializable: true,
      reason: err instanceof Error ? err.message : String(err),
    }) ?? "{\"unserializable\":true}";
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function parseWebViewTargetHost(value: unknown): "127.0.0.1" | "localhost" | "::1" | undefined {
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") {
    return value;
  }
  return undefined;
}
