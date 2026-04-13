import { ulid } from "ulid";
import { asc, eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { messageTable, threadTable } from "../db/schema.js";
import type { TerminalSessionManager, TerminalSession } from "../runtime/terminal-session-manager.js";
import type { ReadinessHints, TerminalDelta, TerminalObservationView, TerminalWaitFor } from "../terminal/types.js";
import { isKnownReplProgram } from "../terminal/known-programs.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import {
  buildTerminalSendSummary,
} from "./terminal-send-outcome.js";
import {
  providerRegistry,
  type CanonicalMessage,
  type CanonicalTool,
  type CanonicalResponse,
  type CanonicalContentBlock,
  type CanonicalReasoningBlock,
  type CanonicalToolCall,
  type CanonicalStopReason,
  type TokenUsage,
  type ModelConfig,
} from "../llm/index.js";
import type { ContextSyncService } from "../terminal/context-sync-service.js";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";

type TerminalSendObserveDirective = {
  afterMs?: number;
  waitFor?: TerminalWaitFor;
  timeoutMs?: number;
};

type AgentDirective =
  | {
      type: "tool_call";
      tool: "terminal.send";
      text?: string;
      submit?: boolean;
      keys?: string[];
      observe?: TerminalSendObserveDirective | null;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "terminal.observe";
      lines?: number;
      view?: TerminalObservationView;
      waitFor?: TerminalWaitFor;
      timeoutMs?: number;
      callId: string;
    }
  | {
      type: "tool_call";
      tool: "terminal.interrupt";
      timeoutMs?: number;
      callId: string;
    }
  | {
      type: "final";
      status: "succeeded" | "failed";
      message: string;
    };

type TerminalCallResult = {
  kind: "interaction_ack" | "observation";
  output?: string;
  outputBytes?: number;
  readiness: Record<string, unknown>;
  truncated?: boolean;
  omittedLines?: number;
  submitted?: boolean;
  delta?: TerminalDelta | null;
  view?: TerminalObservationView;
  error?: string;
  contextAfter?: {
    mode: "shell" | "repl" | "unknown";
    program?: string;
    programDisplayName?: string;
    interactionStyle?: string;
    hints?: string[];
    source?: "observed" | "inferred";
  };
};

type PersistedAgentMessage = {
  messageId: string;
  clientId: string | null;
  role: string;
  displayRole: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type SerializedAgentMessage = {
  message_id: string;
  client_id: string | null;
  role: string;
  display_role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type StreamedModelResponse = {
  response: CanonicalResponse;
  draftText: string;
  hasDraftText: boolean;
  assistantClientId: string | null;
};

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.send","text":"pwd","submit":true,"observe":{}}
- {"type":"tool_call","tool":"terminal.send","text":"python","submit":true,"observe":{"wait_for":"changed"}}
- {"type":"tool_call","tool":"terminal.send","text":"q"}
- {"type":"tool_call","tool":"terminal.observe","lines":-50,"wait_for":"settled"}
- {"type":"tool_call","tool":"terminal.interrupt"}

Tool Responses:
All terminal tools return a JSON result containing:
- kind: "interaction_ack" | "observation"
- readiness: { ready, confidence, trigger, hints }
- context_after: { mode: "shell"|"repl"|"unknown", program?, hints?, source? }
- terminal.send returns delta: { changed, text, truncated } only when a post-send observation was requested
- terminal.observe defaults to view:"delta" and returns delta in output; use view:"screen" or view:"history" for broader context

Guidelines:
- terminal.send is the primary terminal input tool for both shell commands and interactive programs.
- For normal shell commands, send the command text with submit:true instead of adding a trailing \\n yourself.
- Multiline shell input is allowed when you intentionally need it (for example heredocs or pasted scripts).
- terminal.send is also for interactive input, confirmations, single-key actions, and launching interactive programs from shell.
- Add observe:{} when you want the default fast post-send delta after sending input.
- Add observe:{ wait_for:"changed" } when you only need to confirm that a TUI/REPL reacted.
- Add observe:{ wait_for:"settled" } when you need the screen to go quiet before deciding the next step.
- Omit observe when dispatch-only behavior is acceptable and you plan to inspect state separately later.
- terminal.observe is for explicit screen inspection or extra scrollback after interactive work.
- terminal.observe defaults to a delta view. Use view:"screen" for the full current screen and view:"history" for recent scrollback/history.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.observe with wait_for:"settled"
- For terminal.send specifically:
  - If you requested observe and delta.changed is false, verify with terminal.observe before claiming the program accepted the input
  - If you omitted observe, do not assume the program accepted the input until you observe or otherwise verify the state
  - If readiness hints suggest ongoing processing, use terminal.observe for progress
  - If context_after.mode is "repl" and the delta shows the UI is asking for more input, another terminal.send is reasonable
  - If context_after.mode is "shell", another terminal.send is the normal way to run the next shell command
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
- Use interrupt if a command hangs or you need to stop it.

CONTEXT AWARENESS (CRITICAL):
Tool results include a "context_after" field indicating what program is currently running in the terminal.
- When context.mode is "shell": You are at a shell prompt. Send shell commands.
- When context.mode is "repl": You are INSIDE an interactive program, NOT at a shell.
  * The context.program field tells you which program (e.g., "claude", "python", "node")
  * The context.hints array provides program-specific interaction guidance
  * DO NOT send shell commands - they will be interpreted as input to the REPL

IMPORTANT REPL-SPECIFIC BEHAVIOR:
- When context.program is "claude" (Claude Code):
  * You are inside an AI coding assistant
  * Use NATURAL LANGUAGE requests, not shell commands
  * Ask Claude to perform tasks: "Please review src/main.rs for bugs"
  * To run shell commands, ask Claude: "Run npm test"
  * Do NOT send raw shell syntax like "cat file.txt" - Claude will misinterpret it
  * To exit, use terminal.send with text "exit" and submit true, or use terminal.interrupt
- When context.program is "python" or "python3":
  * Send Python code, not shell commands
  * Use print() to display output
- When context.program is "node":
  * Send JavaScript code, not shell commands
  * Use console.log() for output
- When context.program is "psql", "mysql", or "sqlite3":
  * Send SQL commands, not shell commands
  * Commands typically end with semicolons

Always check context.hints for additional program-specific guidance.
If context_after.source is "inferred", treat it as a likely program hint rather than proof that the last send was accepted.

RESPONSE FORMAT:
- When you are ready to answer the user, respond directly in markdown text.
- Do NOT wrap final answers in JSON.
- If you need a tool, call it directly instead of narrating planned steps first.
- Use markdown for clarity:
  * **bold** for emphasis
  * \`code\` for commands, paths, and technical terms
  * Code blocks with language tags for multi-line code
  * Lists for multiple items or steps
`.trim();

const TOOL_RESULT_PREFIX = "TOOL_RESULT";

const DEFAULT_READINESS_HINTS: ReadinessHints = {
  looks_like_prompt: false,
  looks_like_confirmation: false,
  looks_like_password: false,
  looks_like_pager: false,
  looks_like_error: false,
  may_still_be_processing: false
};

// Canonical tool definitions using standard JSON Schema
// Optional fields are simply omitted from `required` - providers handle transformation
const CANONICAL_TOOLS: CanonicalTool[] = [
  {
    name: "terminal_interrupt",
    description: "Send Ctrl+C to the terminal to interrupt the current process.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "terminal_send",
    description:
      "Send input to the current terminal program. Use for shell commands, multiline shell input, REPL/TUI input, confirmations, launching interactive programs, and single-key actions.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Optional text to send literally to the terminal."
        },
        submit: {
          type: "boolean",
          description: "When true, press Enter after sending the text."
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Optional special keys or single-key actions, e.g. q, space, enter, tab, escape, up."
        },
        observe: {
          type: "object",
          description:
            "Optional post-send observation request. Use {} for the default fast post-send delta, or set after_ms / wait_for / timeout_ms to customize it.",
          properties: {
            after_ms: {
              type: "integer",
              description: "Optional delay before the post-send observation (ms). Defaults to 1000ms when observe is present."
            },
            wait_for: {
              type: "string",
              enum: ["none", "shell_ready", "changed", "settled"],
              description: "Optional wait mode after sending input."
            },
            timeout_ms: {
              type: "integer",
              description: "Optional max wait time in ms for the post-send observation. Defaults to 5000ms when observe is present."
            }
          },
          required: [],
          additionalProperties: false
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "terminal_observe",
    description: "Observe the rendered terminal screen or recent scrollback after interactive work or when more visibility is needed.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "integer",
          description: "Optional number of scrollback lines to include. Negative values mean recent history."
        },
        wait_for: {
          type: "string",
          enum: ["none", "shell_ready", "changed", "settled"],
          description: "Optional wait mode before observing."
        },
        view: {
          type: "string",
          enum: ["delta", "screen", "history"],
          description: "Observation view. Defaults to delta. Use screen for the full current screen and history for recent scrollback."
        },
        timeout_ms: {
          type: "integer",
          description: "Optional max wait time in ms."
        }
      },
      required: [],
      additionalProperties: false
    }
  }
];

export class AgentService {
  private readonly terminalSessionManager: TerminalSessionManager;
  private readonly contextSyncService: ContextSyncService | null;
  private readonly runtime: AgentRuntimeStateManager;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly defaultReasoningEffort: ReasoningEffortSetting;
  private readonly supportsReasoningNone: boolean;
  private readonly cancellations = new Map<string, AbortController>();

  constructor(
    terminalSessionManager: TerminalSessionManager,
    runtime: AgentRuntimeStateManager,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean,
    contextSyncService?: ContextSyncService
  ) {
    this.terminalSessionManager = terminalSessionManager;
    this.contextSyncService = contextSyncService ?? null;
    this.runtime = runtime;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    this.defaultReasoningEffort = config.agentReasoningEffortDefault;
    this.supportsReasoningNone = this.detectReasoningNoneSupport(config.defaultModel);
  }

  async startUserMessage(
    threadId: string,
    options?: {
      model?: string | null;
      reasoningEffort?: ReasoningEffortSetting | null;
      ownerUserId?: string | null;
    }
  ): Promise<{ sessionId: string }> {
    const requestedEffort = this.normalizeReasoningEffort(options?.reasoningEffort);
    const model = options?.model ?? config.defaultModel;
    const ownerUserId = options?.ownerUserId ?? (await this.resolveThreadOwnerUserId(threadId));
    const turnId = ulid();
    this.runtime.startTurn(threadId, turnId);

    try {
      const session = await this.getOrCreateSession(threadId, ownerUserId);
      const controller = new AbortController();
      this.cancellations.set(threadId, controller);
      void this.runAgentFlow({
        threadId,
        turnId,
        sessionId: session.sessionId,
        model,
        reasoningEffort: requestedEffort,
        ownerUserId,
        controller
      }).catch((err) => {
        this.logger.error(
          { err, sessionId: session.sessionId, threadId, component: "agent" },
          "Agent flow failed",
        );
      });
      return { sessionId: session.sessionId };
    } catch (err) {
      this.runtime.finishTurn(threadId);
      throw err;
    }
  }

  private async runAgentFlow({
    threadId,
    turnId,
    sessionId,
    model,
    reasoningEffort,
    ownerUserId,
    controller
  }: {
    threadId: string;
    turnId: string;
    sessionId: string;
    model: string;
    reasoningEffort: ReasoningEffortSetting;
    ownerUserId?: string | null;
    controller: AbortController;
  }): Promise<void> {
    const conversation = await this.buildConversation(threadId);
    this.debug("Starting agent run", { threadId, sessionId, model, entries: conversation.length, reasoningEffort });
    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        if (controller.signal.aborted) {
          throw new Error("agent_canceled");
        }
        this.runtime.markThinking(threadId);
        const { response, assistantClientId: streamedAssistantClientId } = await this.invokeModel(
          threadId,
          turnId,
          conversation,
          model,
          reasoningEffort,
          controller.signal
        );
        const toolCall = this.extractFunctionCall(response);
        if (toolCall) {
          const toolClientId = generateMessageClientId();
          const callMeta = this.buildToolArgs(toolCall);
          const toolCallCursor = this.runtime.emit(threadId, {
            event: "agent.tool_call",
            data: {
              turn_id: turnId,
              client_id: toolClientId,
              call_id: toolCall.callId,
              name: toolCall.tool,
              args: callMeta
            },
          });
          this.runtime.setPendingTool(
            threadId,
            {
              client_id: toolClientId,
              call_id: toolCall.callId,
              name: toolCall.tool,
              args: callMeta,
            },
            toolCallCursor,
          );
          this.debug("Dispatching tool call", {
            sessionId,
            threadId,
            tool: toolCall.tool,
            args: callMeta,
            callId: toolCall.callId
          });

          const reasoningBlocks = response.content.filter(
            (
              block,
            ): block is CanonicalReasoningBlock =>
              block.type === "reasoning" || block.type === "reasoning_redacted"
          );

          // Add assistant message with any provider reasoning plus the tool_use
          conversation.push({
            role: "assistant",
            content: [
              ...reasoningBlocks,
              {
                type: "tool_use",
                id: toolCall.callId,
                name: this.toolNameForConversation(toolCall.tool),
                input: callMeta
              }
            ]
          });

          const result = await this.executeTerminalCall(threadId, toolCall);
          const { payload: toolPayload, message: toolMessage } = await this.recordTerminalToolMessage(
            threadId,
            toolCall,
            result,
            toolClientId,
            ownerUserId,
          );

          // Refresh snapshot after state-changing terminal actions.
          if (toolCall.tool !== "terminal.observe" && this.contextSyncService) {
            await this.contextSyncService.refreshSnapshot(sessionId);
          }

          // Add user message with tool_result
          conversation.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: toolCall.callId,
              content: JSON.stringify(toolPayload)
            }]
          });
          const toolResultCursor = this.runtime.emit(threadId, {
            event: "agent.tool_result",
            data: {
              turn_id: turnId,
              client_id: toolClientId,
              call_id: toolCall.callId,
              message_id: toolMessage.message_id,
              name: toolCall.tool,
              summary: toolPayload.summary,
              output: result.output,
              output_bytes: result.outputBytes,
              readiness: result.readiness,
              truncated: result.truncated,
              output_truncation_reason: toolPayload.output_truncation_reason,
              omitted_lines: result.omittedLines,
              message: toolMessage,
            },
          });
          this.runtime.markThinking(threadId, toolResultCursor);

          steps += 1;
          continue;
        }

        const directive = this.parseResponse(response);
        const assistantClientId = streamedAssistantClientId ?? generateMessageClientId();
        const [assistantMessage] = await db.insert(messageTable).values({
          clientId: assistantClientId,
          threadId,
          role: "assistant",
          displayRole: "Bud Agent",
          content: directive.message,
          createdByUserId: ownerUserId ?? undefined,
          metadata: { status: directive.status }
        }).returning({
          messageId: messageTable.messageId,
          clientId: messageTable.clientId,
          role: messageTable.role,
          displayRole: messageTable.displayRole,
          content: messageTable.content,
          metadata: messageTable.metadata,
          createdAt: messageTable.createdAt,
        });
        await recordThreadMessageMetadata(threadId, directive.message);
        conversation.push(this.createMessageInput("assistant", directive.message));
        const serializedAssistantMessage = this.serializePersistedMessage(assistantMessage);

        const messageCursor = this.runtime.emit(threadId, {
          event: "agent.message",
          data: {
            turn_id: turnId,
            client_id: assistantClientId,
            message_id: serializedAssistantMessage.message_id,
            text: directive.message,
            message: serializedAssistantMessage,
          },
        });
        this.runtime.clearDraftAssistant(threadId, messageCursor);
        this.runtime.emit(threadId, {
          event: "final",
          data: {
            turn_id: turnId,
            status: directive.status,
            text: directive.message,
            message_id: serializedAssistantMessage.message_id,
          },
        });
        this.runtime.finishTurn(threadId);

        this.debug("Agent final response", {
          sessionId,
          status: directive.status,
          textLength: directive.message.length
        });
        this.cancellations.delete(threadId);
        return;
      }

      throw new Error("agent reached max steps");
    } catch (err) {
      const canceled = err instanceof Error && err.message === "agent_canceled";
      this.cancellations.delete(threadId);
      const abortLike =
        canceled ||
        (err instanceof Error && (err.name === "AbortError" || err.message === "The operation was aborted."));
      if (abortLike) {
        this.runtime.emit(threadId, {
          event: "final",
          data: {
            turn_id: turnId,
            status: "canceled",
            error: "Agent turn canceled"
          },
        });
        this.runtime.finishTurn(threadId);
        this.debug("Agent turn canceled", { threadId, sessionId });
        return;
      }
      this.runtime.emit(threadId, {
        event: "final",
        data: {
          turn_id: turnId,
          status: "failed",
          error: err instanceof Error ? err.message : "agent_failed"
        },
      });
      this.runtime.finishTurn(threadId);

      this.debug("Agent run failed", {
        sessionId,
        error: err instanceof Error ? err.message : err
      });
      throw err;
    }
  }

  private createMessageInput(
    role: "system" | "user" | "assistant",
    text: string
  ): CanonicalMessage {
    return {
      role,
      content: [{ type: "text", text }]
    };
  }

  private async buildConversation(threadId: string): Promise<CanonicalMessage[]> {
    const messages: CanonicalMessage[] = [this.createMessageInput("system", SYSTEM_PROMPT)];
    const rows = await db
      .select({
        role: messageTable.role,
        content: messageTable.content,
        metadata: messageTable.metadata
      })
      .from(messageTable)
      .where(eq(messageTable.threadId, threadId))
      .orderBy(asc(messageTable.createdAt));

    for (const row of rows) {
      if (row.role === "tool") {
        try {
          const raw = row.content;
          const payload = JSON.parse(raw) as {
            call_id?: string;
            tool?: string;
            text?: string;
            submit?: boolean;
            keys?: string[];
            observe?: Record<string, unknown> | null;
            lines?: number;
            view?: TerminalObservationView;
            wait_for?: TerminalWaitFor;
          };
          const callId =
            typeof payload.call_id === "string" && payload.call_id
              ? payload.call_id
              : `tool_${ulid()}`;
          const toolName = typeof payload.tool === "string" ? payload.tool : null;

          let toolInput: Record<string, unknown> = {};
          if (toolName === "terminal.send") {
            const observe = this.parseTerminalSendObserveArg(payload.observe);
            toolInput = {
              ...(typeof payload.text === "string" ? { text: payload.text } : {}),
              ...(payload.submit === true ? { submit: true } : {}),
              ...(Array.isArray(payload.keys) ? { keys: payload.keys } : {}),
              ...(observe !== null ? { observe: this.serializeTerminalSendObserveArg(observe) } : {})
            };
          } else if (toolName === "terminal.observe") {
            const waitFor = this.parseWaitForArg(payload.wait_for);
            toolInput = {
              ...(typeof payload.lines === "number" ? { lines: payload.lines } : {}),
              ...(typeof payload.view === "string" ? { view: payload.view } : {}),
              ...(waitFor ? { wait_for: waitFor } : {})
            };
          } else if (toolName === "terminal.interrupt") {
            toolInput = {};
          } else {
            // Skip unknown tools, including old local developer-only terminal rows.
            continue;
          }

          // Add assistant message with tool_use
          messages.push({
            role: "assistant",
            content: [{
              type: "tool_use",
              id: callId,
              name: this.toolNameForConversation(
                toolName as "terminal.send" | "terminal.observe" | "terminal.interrupt"
              ),
              input: toolInput
            }]
          });

          // Add user message with tool_result
          messages.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: callId,
              content: raw
            }]
          });
          continue;
        } catch {
          // Skip malformed tool messages
          continue;
        }
      }
      if (row.role === "assistant") {
        messages.push(this.createMessageInput(row.role, row.content));
        continue;
      }
      if (row.role === "user") {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        const preferredCwd =
          typeof metadata.preferred_cwd === "string" && metadata.preferred_cwd
            ? metadata.preferred_cwd
            : undefined;
        const content = preferredCwd
          ? `${row.content}\n\n[Preferred CWD: ${preferredCwd}]`
          : row.content;
        messages.push(this.createMessageInput("user", content));
      }
      // Handle context sync messages (stored as "system" role)
      if (row.role === "system") {
        // These are mid-conversation system messages from context sync
        // Provider transformation will handle conversion for Anthropic
        messages.push(this.createMessageInput("system", row.content));
      }
    }
    return messages;
  }

  private async invokeModel(
    threadId: string,
    turnId: string,
    messages: CanonicalMessage[],
    model: string,
    reasoningEffort: ReasoningEffortSetting,
    signal?: AbortSignal
  ): Promise<StreamedModelResponse> {
    const last = messages.at(-1);
    const lastRole = last?.role ?? "n/a";
    this.debug("Calling LLM via provider", {
      entries: messages.length,
      lastRole,
      reasoningEffort,
      model
    });

    const provider = providerRegistry.getProviderForModel(model);
    // Resolve alias to actual model ID (e.g., "claude-opus" -> "claude-opus-4-5-20251101")
    const resolvedModel = providerRegistry.resolveModelAlias(model);

    // Build reasoning config - "none" means disabled
    const reasoning = reasoningEffort === "none"
      ? { enabled: false }
      : { enabled: true, effort: reasoningEffort as "low" | "medium" | "high" };

    const modelConfig: ModelConfig = {
      model: resolvedModel,
      maxOutputTokens: config.agentMaxOutputTokens,
      reasoning,
      responseFormat: "text"
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
          textBlocks.set(
            event.index,
            `${textBlocks.get(event.index) ?? ""}${event.delta}`
          );
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
          reasoningBlocks.set(event.index, event.block);
          break;
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
      ])
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
      toolCallCount: response.toolCalls?.length ?? 0
    });
    this.debugCanonicalResponse(response);
    return {
      response,
      draftText,
      hasDraftText,
      assistantClientId,
    };
  }

  private parseResponse(response: CanonicalResponse): Extract<AgentDirective, { type: "final" }> {
    // Check for incomplete responses
    if (response.stopReason === "max_tokens") {
      throw new Error("model response incomplete: max_tokens reached");
    }

    // Extract text content from the response
    const textBlocks = response.content.filter(
      (block): block is Extract<CanonicalContentBlock, { type: "text" }> =>
        block.type === "text"
    );
    const aggregated = textBlocks.map((b) => b.text).join("\n");

    if (!aggregated) {
      throw new Error("model returned no text or tool call");
    }
    return {
      type: "final",
      status: "succeeded",
      message: aggregated.trim()
    };
  }

  private normalizeReasoningEffort(requested?: ReasoningEffortSetting | null): ReasoningEffortSetting {
    const desired = requested ?? this.defaultReasoningEffort;
    if (desired === "none" && !this.supportsReasoningNone) {
      return "low";
    }
    return desired;
  }

  private toolNameForConversation(
    tool: "terminal.send" | "terminal.observe" | "terminal.interrupt"
  ) {
    switch (tool) {
      case "terminal.send":
        return "terminal_send";
      case "terminal.interrupt":
        return "terminal_interrupt";
      case "terminal.observe":
        return "terminal_observe";
    }
  }

  private detectReasoningNoneSupport(model: string): boolean {
    const normalized = model.toLowerCase();
    // Models that REQUIRE reasoning effort (don't support "none"):
    // - gpt-5.1-codex, gpt-5o, o1, o3, etc.
    // These models only accept "low", "medium", "high"
    const requiresReasoning =
      normalized.includes("gpt-5.1") ||
      normalized.includes("gpt-5o") ||
      normalized.includes("o1") ||
      normalized.includes("o3") ||
      normalized.includes("codex");
    // Return true if model supports "none" (i.e., does NOT require reasoning)
    return !requiresReasoning;
  }

  private extractFunctionCall(response: CanonicalResponse): Extract<AgentDirective, { type: "tool_call" }> | null {
    const toolCalls = response.toolCalls;
    if (!toolCalls || toolCalls.length === 0) {
      return null;
    }

    // Process the first tool call
    const toolCall = toolCalls[0];
    const args = toolCall.input;
    const callId = toolCall.id;

    switch (toolCall.name) {
      case "terminal_send": {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((value): value is string => typeof value === "string")
          : undefined;
        return {
          type: "tool_call",
          tool: "terminal.send",
          text: typeof args.text === "string" ? args.text : undefined,
          submit: args.submit === true,
          keys: keys?.length ? keys : undefined,
          observe: this.parseTerminalSendObserveArg(args.observe),
          callId
        };
      }
      case "terminal_interrupt":
        return {
          type: "tool_call",
          tool: "terminal.interrupt",
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          callId
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
          waitFor: this.parseWaitForArg(args.wait_for),
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          callId
        };
      default:
        return null;
    }
  }

  private async executeTerminalCall(
    threadId: string,
    directive: Extract<AgentDirective, { type: "tool_call"; tool: string }>
  ): Promise<TerminalCallResult> {
    const session = await this.getOrCreateSession(threadId);
    const sessionId = session.sessionId;

    const getInferredContext = () => {
      const ctx = this.terminalSessionManager.getSessionContext(sessionId);
      return {
        mode: ctx.mode,
        program: ctx.program,
        programDisplayName: ctx.programDisplayName,
        interactionStyle: ctx.interactionStyle,
        hints: ctx.hints
      };
    };

    const buildContextAfter = (options?: {
      readiness?: Record<string, unknown>;
    }) => this.buildContextAfterSnapshot(getInferredContext(), options);

    const latestReadiness = (trigger: string, ready = true, confidence = 0.6) =>
      this.normalizeReadiness(this.terminalSessionManager.getLatestReadiness(sessionId), {
        ready,
        confidence,
        trigger,
        hints: DEFAULT_READINESS_HINTS
      });

    if (directive.tool === "terminal.interrupt") {
      await this.terminalSessionManager.sendInterrupt(sessionId);
      const readiness = await this.terminalSessionManager.waitForReadiness(
        sessionId,
        directive.timeoutMs ?? 5000
      );
      const tail = await this.terminalSessionManager.tailOutput(sessionId, config.terminalOutputBackfillBytes);
      const decoded = this.decodeTail(tail.data);
      const finalReadiness: Record<string, unknown> = this.normalizeReadiness(readiness, {
        ready: true,
        confidence: 0.6,
        trigger: "interrupt",
        hints: DEFAULT_READINESS_HINTS
      });
      this.logReadinessDecision(directive.tool, finalReadiness);
      return {
        kind: "interaction_ack",
        output: decoded,
        outputBytes: tail.totalBytes,
        readiness: finalReadiness,
        truncated: tail.data.length < tail.totalBytes,
        omittedLines: 0,
        submitted: true,
        contextAfter: buildContextAfter({ readiness: finalReadiness })
      };
    }

    if (directive.tool === "terminal.observe") {
      const lines = directive.lines ?? -50;
      const view = directive.view ?? "delta";
      const waitFor = directive.waitFor ?? "none";

      this.debug("terminal.observe", { sessionId, lines, view, waitFor });

      try {
        const capture = await this.terminalSessionManager.observeTerminal(
          sessionId,
          { lines, waitFor, view },
          directive.timeoutMs ?? 5000
        );
        const readiness = this.normalizeReadiness(capture.readiness, {
          ready: waitFor === "none",
          confidence: waitFor === "none" ? 0.7 : 0.5,
          trigger: waitFor === "none" ? "observe" : waitFor,
          hints: waitFor === "none"
            ? DEFAULT_READINESS_HINTS
            : { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true }
        });
        this.logReadinessDecision(directive.tool, readiness);
        this.logTerminalOutput(`terminal.observe (${capture.view})`, capture.output);

        return {
          kind: "observation",
          ...(capture.view === "delta"
            ? {
                delta: {
                  changed: capture.changed ?? capture.output.length > 0,
                  text: capture.output,
                  truncated: capture.truncated ?? false,
                },
              }
            : {
                output: capture.output,
                outputBytes: capture.outputBytes,
              }),
          readiness,
          truncated: capture.view === "delta" ? undefined : false,
          omittedLines: 0,
          view: capture.view,
          contextAfter: buildContextAfter({ readiness })
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { sessionId, error: message, component: "agent_terminal" },
          "terminal.observe failed"
        );
        throw err;
      }
    }

    if (directive.tool === "terminal.send") {
      const hasText = typeof directive.text === "string" && directive.text.length > 0;
      const hasKeys = (directive.keys?.length ?? 0) > 0;
      const hasAction = hasText || hasKeys || directive.submit === true;
      const contextBefore = getInferredContext();

      if (!hasAction) {
        return {
          kind: "interaction_ack",
          readiness: latestReadiness("invalid_send", false, 0.2),
          submitted: false,
          error: "empty_interaction",
          contextAfter: buildContextAfter()
        };
      }

      if (contextBefore.mode === "shell" && directive.submit === true && hasText) {
        const command = this.parseCommandFromText(directive.text ?? "");
        if (command && isKnownReplProgram(command)) {
          this.terminalSessionManager.setPendingCommand(sessionId, {
            input: directive.text ?? "",
            command,
            sentAt: Date.now(),
            source: "agent"
          });
        }
      }

      this.debug("terminal.send", {
        sessionId,
        hasText,
        submit: directive.submit === true,
        keyCount: directive.keys?.length ?? 0,
        observeRequested: directive.observe != null,
        waitFor: directive.observe?.waitFor ?? null,
        program: contextBefore.program
      });

      const result = await this.terminalSessionManager.sendInteraction(
        sessionId,
        {
          text: directive.text,
          submit: directive.submit,
          keys: directive.keys,
          observe: directive.observe ?? null,
        },
        { timeoutMs: directive.observe?.timeoutMs ?? 5000 }
      );

      const finalReadiness = this.normalizeReadiness(result.readiness, {
        ready: false,
        confidence: 0.0,
        trigger: "dispatch_only",
        hints: DEFAULT_READINESS_HINTS
      });
      this.logReadinessDecision(directive.tool, finalReadiness);
      const contextAfter = buildContextAfter({ readiness: finalReadiness });

      return {
        kind: "interaction_ack",
        readiness: finalReadiness,
        submitted: result.submitted,
        delta: result.delta,
        contextAfter
      };
    }

    throw new Error(`unsupported_terminal_tool:${directive.tool}`);
  }

  private logReadinessDecision(tool: string, readiness: Record<string, unknown>): void {
    const confidence = typeof readiness.confidence === "number" ? readiness.confidence : 0;
    const ready = readiness.ready === true;
    const trigger = typeof readiness.trigger === "string" ? readiness.trigger : "unknown";
    const hints = readiness.hints as Record<string, boolean> | undefined;

    const decision =
      confidence >= 0.8
        ? "ready_to_proceed"
        : confidence >= 0.5
          ? "probably_ready"
          : "should_observe";

    this.debug("Terminal readiness assessment", {
      tool,
      ready,
      confidence,
      trigger,
      decision,
      hints: hints
        ? Object.entries(hints)
            .filter(([, v]) => v)
            .map(([k]) => k)
        : []
    });
  }

  /**
   * Pretty print terminal output for debugging.
   * Only outputs when openaiDebugEnabled is true.
   */
  private logTerminalOutput(tool: string, output: string): void {
    if (!this.openaiDebugEnabled) return;

    const lines = output.split("\n");
    const maxLines = 30;

    console.log(`\n┌─ ${tool} output (${lines.length} lines) ─────────────────────`);

    for (const line of lines.slice(0, maxLines)) {
      console.log(`│ ${line}`);
    }

    if (lines.length > maxLines) {
      console.log(`│ ... (${lines.length - maxLines} more lines)`);
    }

    console.log(`└${"─".repeat(50)}\n`);
  }

  private normalizeReadiness(
    readiness: unknown,
    fallback: Record<string, unknown>
  ): Record<string, unknown> {
    // Use fallback if readiness is null, undefined, or doesn't look like a valid assessment
    if (!readiness || typeof readiness !== "object") {
      return fallback;
    }
    const obj = readiness as Record<string, unknown>;
    // Check if it has the minimum expected fields
    if (typeof obj.ready !== "boolean" || typeof obj.confidence !== "number") {
      return fallback;
    }
    // Ensure hints exist (add default if missing)
    if (!obj.hints || typeof obj.hints !== "object") {
      return { ...obj, hints: DEFAULT_READINESS_HINTS };
    }
    return obj;
  }

  private buildContextAfterSnapshot(
    inferredContext: NonNullable<TerminalCallResult["contextAfter"]>,
    options?: {
      readiness?: Record<string, unknown>;
    }
  ): NonNullable<TerminalCallResult["contextAfter"]> {
    const source = this.readinessLooksLikeObservedShell(options?.readiness)
      ? "observed"
      : "inferred";

    if (source === "observed") {
      return {
        mode: "shell",
        source,
      };
    }

    return {
      ...inferredContext,
      hints: inferredContext.hints,
      source,
    };
  }

  private readinessLooksLikeObservedShell(readiness?: Record<string, unknown>): boolean {
    if (!readiness) {
      return false;
    }

    const hints = readiness.hints as Record<string, unknown> | undefined;
    return (
      readiness.prompt_type === "shell" &&
      typeof readiness.confidence === "number" &&
      readiness.confidence >= 0.8 &&
      hints?.looks_like_prompt === true
    );
  }

  private async recordTerminalToolMessage(
    threadId: string,
    directive: Extract<AgentDirective, { type: "tool_call" }>,
    result: TerminalCallResult,
    clientId: string,
    ownerUserId?: string | null,
  ): Promise<{ payload: Record<string, unknown>; message: SerializedAgentMessage }> {
    const summary = this.buildToolSummary(directive, result);
    const outputTruncationReason = this.getToolOutputTruncationReason(directive, result);
    const payload = {
      tool: directive.tool,
      call_id: directive.callId,
      ...this.buildToolArgs(directive),
      summary,
      kind: result.kind,
      output: result.output,
      output_bytes: result.outputBytes,
      readiness: result.readiness,
      truncated: result.truncated,
      output_truncation_reason: outputTruncationReason,
      omitted_lines: result.omittedLines,
      submitted: result.submitted,
      delta: this.serializeTerminalDelta(result.delta),
      view: result.view,
      error: result.error,
      context_after: result.contextAfter
    };
    const [toolMessage] = await db.insert(messageTable).values({
      clientId,
      threadId,
      role: "tool",
      displayRole: "Tool",
      content: JSON.stringify(payload),
      createdByUserId: ownerUserId ?? undefined,
      metadata: payload
    }).returning({
      messageId: messageTable.messageId,
      clientId: messageTable.clientId,
      role: messageTable.role,
      displayRole: messageTable.displayRole,
      content: messageTable.content,
      metadata: messageTable.metadata,
      createdAt: messageTable.createdAt,
    });
    await recordThreadMessageMetadata(threadId, summary);
    return {
      payload,
      message: this.serializePersistedMessage(toolMessage),
    };
  }

  private buildToolSummary(
    directive: Extract<AgentDirective, { type: "tool_call" }>,
    result: TerminalCallResult
  ): string {
    switch (directive.tool) {
      case "terminal.send":
        return this.summarizeInteractiveSend(directive, result);
      case "terminal.observe": {
        const view = directive.view ?? "delta";
        if (view === "delta") {
          if (directive.waitFor && directive.waitFor !== "none") {
            return `Observed terminal delta after waiting for ${directive.waitFor}`;
          }
          return "Observed terminal delta";
        }
        if (directive.waitFor && directive.waitFor !== "none") {
          return `Observed terminal ${view} after waiting for ${directive.waitFor}`;
        }
        if (typeof directive.lines === "number") {
          return `Observed terminal ${view} (${directive.lines} lines)`;
        }
        return `Observed terminal ${view}`;
      }
      case "terminal.interrupt":
        return "Sent Ctrl+C";
    }
  }

  private summarizeInteractiveSend(
    directive: Extract<AgentDirective, { type: "tool_call"; tool: "terminal.send" }>,
    result: TerminalCallResult,
  ): string {
    return buildTerminalSendSummary(
      {
        text: directive.text,
        submit: directive.submit,
        keys: directive.keys
      },
      result.delta,
      null,
      (result.readiness.hints as ReadinessHints | undefined) ?? DEFAULT_READINESS_HINTS,
    );
  }

  private getToolOutputTruncationReason(
    directive: Extract<AgentDirective, { type: "tool_call" }>,
    result: TerminalCallResult
  ): "bud_runtime_limit" | "service_backfill_limit" | null {
    if (!result.truncated) {
      return null;
    }

    switch (directive.tool) {
      case "terminal.send":
        return null;
      case "terminal.interrupt":
        return "service_backfill_limit";
      case "terminal.observe":
        return null;
    }
  }

  private buildToolArgs(
    directive: Extract<AgentDirective, { type: "tool_call" }>
  ): Record<string, unknown> {
    switch (directive.tool) {
      case "terminal.send": {
        const observe = this.serializeTerminalSendObserveArg(directive.observe);
        return {
          ...(typeof directive.text === "string" ? { text: directive.text } : {}),
          ...(directive.submit === true ? { submit: true } : {}),
          ...(directive.keys?.length ? { keys: directive.keys } : {}),
          ...(observe !== undefined ? { observe } : {})
        };
      }
      case "terminal.observe":
        return {
          ...(typeof directive.lines === "number" ? { lines: directive.lines } : {}),
          ...(directive.view ? { view: directive.view } : {}),
          ...(directive.waitFor ? { wait_for: directive.waitFor } : {}),
        };
      case "terminal.interrupt":
        return {};
    }
  }

  private parseWaitForArg(value: unknown): TerminalWaitFor | undefined {
    if (
      value === "none" ||
      value === "shell_ready" ||
      value === "changed" ||
      value === "settled"
    ) {
      return value;
    }
    return undefined;
  }

  private parseTerminalSendObserveArg(
    value: unknown,
  ): TerminalSendObserveDirective | null {
    if (value === null) {
      return null;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const waitFor = this.parseWaitForArg(record.wait_for);
      return {
        ...(typeof record.after_ms === "number" ? { afterMs: record.after_ms } : {}),
        ...(waitFor ? { waitFor } : {}),
        ...(typeof record.timeout_ms === "number" ? { timeoutMs: record.timeout_ms } : {}),
      };
    }

    return null;
  }

  private serializeTerminalSendObserveArg(
    observe?: TerminalSendObserveDirective | null,
  ): Record<string, unknown> | undefined {
    if (observe === null || observe === undefined) {
      return undefined;
    }

    return {
      ...(typeof observe.afterMs === "number" ? { after_ms: observe.afterMs } : {}),
      ...(observe.waitFor ? { wait_for: observe.waitFor } : {}),
      ...(typeof observe.timeoutMs === "number" ? { timeout_ms: observe.timeoutMs } : {}),
    };
  }

  private serializeTerminalDelta(
    delta?: TerminalDelta | null,
  ): Record<string, unknown> | null {
    if (!delta) {
      return null;
    }

    return {
      changed: delta.changed,
      text: delta.text,
      truncated: delta.truncated,
    };
  }

  private serializePersistedMessage(message: PersistedAgentMessage): SerializedAgentMessage {
    return {
      message_id: message.messageId,
      client_id: message.clientId,
      role: message.role,
      display_role: message.displayRole ?? message.role,
      content: message.content,
      metadata: message.metadata ?? {},
      created_at: message.createdAt.toISOString(),
    };
  }

  // TODO: capturePane (used for REPL mode) follows a different code path - it asks
  // the bud daemon to strip escape sequences before returning. Consider unifying
  // the output cleaning logic between tailOutput and capturePane paths.
  private decodeTail(data: Buffer): string {
    const text = data.toString("utf-8");

    // Strip ANSI escape codes FIRST, before binary detection.
    // Raw terminal output contains ESC (0x1b) characters which would otherwise
    // trigger false positives in the binary check.
    const stripped = this.stripAnsi(text);

    // Check for binary content on the cleaned text.
    // If more than 8 non-printable characters remain after ANSI stripping,
    // this is likely actual binary data (e.g., cat /bin/ls).
    const nonPrintable = [...stripped].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x09 || (code > 0x0d && code < 0x20);
    }).length;
    if (nonPrintable > 8) {
      return "[binary output omitted]";
    }

    // Normalize CRLF to LF for consistent parsing
    return this.normalizeCRLF(stripped);
  }

  /**
   * Strip ANSI escape codes from terminal output.
   * Handles:
   * - CSI sequences: \x1b[...X (colors, cursor movement, etc.)
   * - OSC sequences: \x1b]...(\x07|\x1b\\) (window titles, hyperlinks)
   * - Simple escapes: \x1b[A-Z] (cursor keys, etc.)
   */
  private stripAnsi(text: string): string {
    // CSI sequences: ESC [ followed by params and a final letter
    // OSC sequences: ESC ] followed by text and terminated by BEL or ST
    // Simple escapes: ESC followed by a single char
    return text
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")      // CSI sequences
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
      .replace(/\x1b[A-Z]/g, "");                   // Simple escapes
  }

  /**
   * Normalize line endings to LF for consistent parsing.
   * Handles CRLF (Windows) and standalone CR (old Mac).
   */
  private normalizeCRLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  private async fetchBudForThread(threadId: string): Promise<{ budId: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId),
      columns: { budId: true }
    });
    if (!thread) {
      throw new Error("thread not found");
    }
    this.logger.info({ threadId, budId: thread.budId }, "Resolved budId for thread");
    return { budId: thread.budId };
  }

  private async resolveThreadOwnerUserId(threadId: string): Promise<string | null> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId),
      columns: { createdByUserId: true },
    });

    return thread?.createdByUserId ?? null;
  }

  /**
   * Get or create the terminal session for a thread.
   * Creates session on first terminal tool use.
   */
  private async getOrCreateSession(
    threadId: string,
    ownerUserId?: string | null,
  ): Promise<TerminalSession> {
    // Check for existing session
    let session = await this.terminalSessionManager.getSessionForThread(threadId);

    if (!session) {
      // Create new session
      const bud = await this.fetchBudForThread(threadId);
      await this.terminalSessionManager.createSessionForThread(threadId, bud.budId, ownerUserId);
      session = await this.terminalSessionManager.getSessionForThread(threadId);

      if (!session) {
        throw new Error("Failed to create terminal session for thread");
      }

      this.logger.info(
        { threadId, sessionId: session.sessionId, budId: bud.budId, component: "agent" },
        "Created new terminal session for thread"
      );
    }

    // Ensure session is running on Bud
    const { ok, resumed, error } = await this.terminalSessionManager.ensureSession(session.sessionId);
    if (!ok) {
      throw new Error(error ?? "Failed to ensure terminal session");
    }

    if (resumed) {
      this.logger.info(
        { sessionId: session.sessionId, component: "agent" },
        "Resumed existing terminal session"
      );
    }

    return session;
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }

  private debugCanonicalResponse(response: CanonicalResponse) {
    if (!this.openaiDebugEnabled) {
      return;
    }
    try {
      const serialized = JSON.stringify(response, null, 2);
      this.logger.info({ component: "agent", llm_response: serialized }, "LLM response payload");
    } catch (err) {
      this.logger.warn(
        { err, component: "agent" },
        "Failed to serialize LLM response for debug logging"
      );
    }
  }

  cancelThread(threadId: string): void {
    const controller = this.cancellations.get(threadId);
    if (controller) {
      controller.abort();
      this.cancellations.delete(threadId);
    }
  }

  /**
   * Check if a thread has an active agent run.
   * Used by ContextSyncService to skip sync if agent is streaming.
   */
  isThreadActive(threadId: string): boolean {
    return this.cancellations.has(threadId);
  }

  /**
   * Parse the command name from shell-entered text.
   */
  private parseCommandFromText(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) return null;
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) return null;
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }
}
