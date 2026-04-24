import { ulid } from "ulid";
import type { FastifyBaseLogger } from "fastify";
import { config, type ReasoningEffortSetting } from "../config.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import {
  providerRegistry,
  type CanonicalContentBlock,
  type CanonicalMessage,
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

type StreamedModelResponse = {
  response: CanonicalResponse;
  assistantClientId: string | null;
};

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
          enum: ["none", "shell_ready", "changed", "settled"],
          description:
            'Optional wait mode after sending input. Defaults to "settled" when omitted.',
        },
        timeout_ms: {
          type: "integer",
          description: "Optional max wait time in ms. Defaults to 30000ms for terminal.send.",
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
          enum: ["none", "shell_ready", "changed", "settled"],
          description: "Optional wait mode before observing.",
        },
        view: {
          type: "string",
          enum: ["delta", "screen", "history"],
          description: "Observation view. Defaults to delta. Use screen for the full current screen and history for recent scrollback.",
        },
        timeout_ms: {
          type: "integer",
          description: "Optional max wait time in ms. Defaults to 30000ms when omitted.",
        },
      },
      required: [],
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

    let responseId: string | null = null;
    let stopReason: CanonicalStopReason = "end_turn";
    let usage: TokenUsage | undefined;
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
          break;
        case "content_start":
          if (event.content_type === "text") {
            pendingTextPrefixes.set(event.index, textBlockCount > 0 ? "\n" : "");
            textBlockCount += 1;
          }
          break;
        case "text_delta": {
          const prefix = pendingTextPrefixes.get(event.index);
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
    };
  }

  parseFinalResponse(response: CanonicalResponse): AgentFinalDirective {
    if (response.stopReason === "max_tokens") {
      throw new Error("model response incomplete: max_tokens reached");
    }

    const textBlocks = response.content.filter(
      (block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text",
    );
    const aggregated = textBlocks.map((block) => block.text).join("\n");

    if (!aggregated) {
      throw new Error("model returned no text or tool call");
    }

    return {
      type: "final",
      status: "succeeded",
      message: aggregated.trim(),
    };
  }

  extractToolCall(response: CanonicalResponse): AgentToolCallDirective | null {
    const toolCalls = response.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      return null;
    }

    const toolCall = toolCalls[0];
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
      const serialized = JSON.stringify(response, null, 2);
      this.logger.info({ component: "agent", llm_response: serialized }, "LLM response payload");
    } catch (err) {
      this.logger.warn(
        { err, component: "agent" },
        "Failed to serialize LLM response for debug logging",
      );
    }
  }
}
