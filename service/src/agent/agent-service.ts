import { ulid } from "ulid";
import { asc, desc, eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, threadTable } from "../db/schema.js";
import type { TerminalSessionManager, TerminalSession } from "../runtime/terminal-session-manager.js";
import { AgentEventBus } from "../runtime/event-bus.js";
import type { ReadinessHints, PendingCommand } from "../terminal/types.js";
import { isKnownReplProgram } from "../terminal/known-programs.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import {
  providerRegistry,
  OpenAIProvider,
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

type AgentDirective =
  | {
      type: "tool_call";
      tool: "terminal.run" | "terminal.interrupt" | "terminal.capture";
      input?: string;
      timeoutMs?: number;
      lines?: number;  // For terminal.capture: scrollback lines
      wait?: boolean;  // For terminal.capture: wait for readiness first
      callId: string;
    }
  | {
      type: "final";
      status: "succeeded" | "failed";
      message: string;
    };

type TerminalCallResult = {
  output: string;
  outputBytes: number;
  readiness: Record<string, unknown>;
  truncated: boolean;
  omittedLines: number;
  context?: {
    mode: "shell" | "repl" | "unknown";
    program?: string;
    programDisplayName?: string;
    interactionStyle?: string;
    hints?: string[];
  };
};

type PersistedAgentMessage = {
  messageId: string;
  role: string;
  displayRole: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

type SerializedAgentMessage = {
  message_id: string;
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
};

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.capture"}
- {"type":"tool_call","tool":"terminal.capture","wait":true}
- {"type":"tool_call","tool":"terminal.interrupt"}

Tool Responses:
All terminal tools return a JSON result containing:
- output: Terminal output text (already included - no need to capture separately)
- readiness: { ready, confidence, trigger, hints }
- context: { mode: "shell"|"repl", program?, hints? }

IMPORTANT: You do NOT need to call terminal.capture after terminal.run. The output is already in the response.
Only use terminal.capture for: TUI apps (rendered screen), scrollback history (lines: -200), or low confidence waits (wait: true).

Guidelines:
- Include \\n to press Enter. For confirmations, send "y\\n". For single-key prompts (like q to exit pager), send just the key.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.capture with wait:true
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
- Use interrupt if a command hangs or you need to stop it.
- terminal.capture is NOT needed after terminal.run (output is already included). Use it only for:
  - TUI apps: Get the rendered screen layout (visual representation)
  - Scrollback: Retrieve more history with lines:-200 or lines:-500
  - Low confidence: If terminal.run returns confidence < 0.5, use terminal.capture with wait:true

CONTEXT AWARENESS (CRITICAL):
Tool results include a "context" field indicating what program is currently running in the terminal.
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
  * To exit, send "exit\\n" or use terminal.interrupt
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
    name: "terminal_run",
    description: "Send input to the terminal and receive output. Returns: terminal output, readiness assessment, and context. Include \\n to press Enter.",
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Exact input to send (include \\n for Enter)."
        },
        timeout_ms: {
          type: "integer",
          description: "Optional max wait for readiness (ms)."
        }
      },
      required: ["input"],
      additionalProperties: false
    }
  },
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
    name: "terminal_capture",
    description:
      "Capture terminal screen (for TUI apps, scrollback history, or waiting). " +
      "NOT needed after terminal.run - output is already included. Use for: " +
      "TUI apps (rendered screen), scrollback (lines: -200), or low confidence waits (wait: true).",
    parameters: {
      type: "object",
      properties: {
        wait: {
          type: "boolean",
          description:
            "Wait for terminal to become ready before capturing. " +
            "Use after terminal.run returns low confidence. Default: false."
        },
        lines: {
          type: "integer",
          description:
            "Lines of scrollback history. Negative = from current position. " +
            "Default: -50. Use -200 or -500 for more history."
        },
        timeout_ms: {
          type: "integer",
          description: "Max wait time in ms (only applies if wait=true). Default: 5000."
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
  private readonly events: AgentEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly defaultReasoningEffort: ReasoningEffortSetting;
  private readonly supportsReasoningNone: boolean;
  private readonly cancellations = new Map<string, AbortController>();

  constructor(
    terminalSessionManager: TerminalSessionManager,
    events: AgentEventBus,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean,
    contextSyncService?: ContextSyncService
  ) {
    this.terminalSessionManager = terminalSessionManager;
    this.contextSyncService = contextSyncService ?? null;
    this.events = events;
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

    // Clear old agent events (especially `final`) so new SSE connections
    // don't receive stale events from previous runs
    this.events.clearBuffer(threadId);

    // Get or create terminal session for this thread
    const session = await this.getOrCreateSession(threadId, ownerUserId);
    const controller = new AbortController();
    this.cancellations.set(threadId, controller);
    void this.runAgentFlow({
      threadId,
      sessionId: session.sessionId,
      model,
      reasoningEffort: requestedEffort,
      ownerUserId,
      controller
    }).catch((err) => {
      this.logger.error({ err, sessionId: session.sessionId, threadId, component: "agent" }, "Agent flow failed");
    });
    return { sessionId: session.sessionId };
  }

  private async runAgentFlow({
    threadId,
    sessionId,
    model,
    reasoningEffort,
    ownerUserId,
    controller
  }: {
    threadId: string;
    sessionId: string;
    model: string;
    reasoningEffort: ReasoningEffortSetting;
    ownerUserId?: string | null;
    controller: AbortController;
  }): Promise<void> {
    const conversation = await this.buildConversation(threadId);
    const turnId = ulid();
    this.debug("Starting agent run", { threadId, sessionId, model, entries: conversation.length, reasoningEffort });
    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        if (controller.signal.aborted) {
          throw new Error("agent_canceled");
        }
        const { response } = await this.invokeModel(
          threadId,
          turnId,
          conversation,
          model,
          reasoningEffort,
          controller.signal
        );
        const toolCall = this.extractFunctionCall(response);
        if (toolCall) {
          const callMeta = { input: toolCall.input ?? "" };
          this.events.emit(threadId, {
            event: "agent.tool_call",
            data: {
              turn_id: turnId,
              call_id: toolCall.callId,
              name: toolCall.tool,
              args: callMeta
            },
            id: ulid()
          });
          this.debug("Dispatching tool call", {
            sessionId,
            threadId,
            tool: toolCall.tool,
            input: toolCall.input ?? "",
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
            ownerUserId,
          );

          // Refresh snapshot after terminal.run so context sync has accurate state
          if (toolCall.tool === "terminal.run" && this.contextSyncService) {
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
          this.events.emit(threadId, {
            event: "agent.tool_result",
            data: {
              turn_id: turnId,
              call_id: toolCall.callId,
              message_id: toolMessage.message_id,
              name: toolCall.tool,
              output: result.output,
              output_bytes: result.outputBytes,
              readiness: result.readiness,
              truncated: result.truncated,
              omitted_lines: result.omittedLines,
              message: toolMessage,
            },
            id: ulid()
          });

          steps += 1;
          continue;
        }

        const directive = this.parseResponse(response);
        const [assistantMessage] = await db.insert(messageTable).values({
          threadId,
          role: "assistant",
          displayRole: "Bud Agent",
          content: directive.message,
          createdByUserId: ownerUserId ?? undefined,
          metadata: { status: directive.status }
        }).returning({
          messageId: messageTable.messageId,
          role: messageTable.role,
          displayRole: messageTable.displayRole,
          content: messageTable.content,
          metadata: messageTable.metadata,
          createdAt: messageTable.createdAt,
        });
        await recordThreadMessageMetadata(threadId, directive.message);
        conversation.push(this.createMessageInput("assistant", directive.message));
        const serializedAssistantMessage = this.serializePersistedMessage(assistantMessage);

        this.events.emit(threadId, {
          event: "agent.message",
          data: {
            turn_id: turnId,
            message_id: serializedAssistantMessage.message_id,
            text: directive.message,
            message: serializedAssistantMessage,
          },
          id: ulid()
        });
        this.events.emit(threadId, {
          event: "final",
          data: {
            turn_id: turnId,
            status: directive.status,
            text: directive.message,
            message_id: serializedAssistantMessage.message_id,
          },
          id: ulid()
        });

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
        this.events.emit(threadId, {
          event: "final",
          data: {
            turn_id: turnId,
            status: "canceled",
            error: "Agent turn canceled"
          },
          id: ulid()
        });
        this.debug("Agent turn canceled", { threadId, sessionId });
        return;
      }
      this.events.emit(threadId, {
        event: "final",
        data: {
          turn_id: turnId,
          status: "failed",
          error: err instanceof Error ? err.message : "agent_failed"
        },
        id: ulid()
      });

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
            input?: string;
          };
          const callId =
            typeof payload.call_id === "string" && payload.call_id
              ? payload.call_id
              : `tool_${ulid()}`;
          const toolName = typeof payload.tool === "string" ? payload.tool : null;

          let toolInput: Record<string, unknown> = {};
          if (toolName === "terminal.run") {
            const input = typeof payload.input === "string" ? payload.input : null;
            if (!input) {
              throw new Error("tool payload missing input");
            }
            toolInput = { input };
          } else if (toolName === "terminal.capture" || toolName === "terminal.interrupt") {
            toolInput = {};
          } else {
            // Skip unknown tools (legacy shell.run messages)
            continue;
          }

          // Add assistant message with tool_use
          messages.push({
            role: "assistant",
            content: [{
              type: "tool_use",
              id: callId,
              name: this.toolNameForConversation(toolName as "terminal.run" | "terminal.capture" | "terminal.interrupt"),
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

    const emitAssistantDraftStart = () => {
      if (hasDraftText) {
        return;
      }
      this.events.emit(threadId, {
        event: "agent.message_start",
        data: {
          turn_id: turnId,
        },
        id: ulid(),
      });
      hasDraftText = true;
    };

    const emitAssistantDraftDelta = (delta: string) => {
      if (!delta) {
        return;
      }
      emitAssistantDraftStart();
      draftText += delta;
      this.events.emit(threadId, {
        event: "agent.message_delta",
        data: {
          turn_id: turnId,
          delta,
        },
        id: ulid(),
      });
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
      this.events.emit(threadId, {
        event: "agent.message_done",
        data: {
          turn_id: turnId,
          text: draftText,
        },
        id: ulid(),
      });
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

  private toolNameForConversation(tool: "terminal.run" | "terminal.interrupt" | "terminal.capture") {
    switch (tool) {
      case "terminal.run":
        return "terminal_run";
      case "terminal.interrupt":
        return "terminal_interrupt";
      case "terminal.capture":
        return "terminal_capture";
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
      case "terminal_run":
        if (!args.input || typeof args.input !== "string") {
          throw new Error("function_call missing input argument");
        }
        return {
          type: "tool_call",
          tool: "terminal.run",
          input: args.input,
          timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          callId
        };
      case "terminal_interrupt":
        return {
          type: "tool_call",
          tool: "terminal.interrupt",
          callId
        };
      case "terminal_capture":
        return {
          type: "tool_call",
          tool: "terminal.capture",
          wait: args.wait === true,
          lines: typeof args.lines === "number" ? args.lines : undefined,
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

    // Helper to get context for tool results
    const getContext = () => {
      const ctx = this.terminalSessionManager.getSessionContext(sessionId);
      return {
        mode: ctx.mode,
        program: ctx.program,
        programDisplayName: ctx.programDisplayName,
        interactionStyle: ctx.interactionStyle,
        hints: ctx.hints
      };
    };

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
        output: decoded,
        outputBytes: tail.totalBytes,
        readiness: finalReadiness,
        truncated: tail.data.length < tail.totalBytes,
        omittedLines: 0,
        context: getContext()
      };
    }

    // terminal.capture - uses tmux capture-pane for TUI/REPL visibility
    if (directive.tool === "terminal.capture") {
      const lines = directive.lines ?? -50;
      const shouldWait = directive.wait === true;

      this.debug("terminal.capture", { sessionId, lines, wait: shouldWait });

      let readiness: Record<string, unknown>;

      if (shouldWait) {
        const sessionReadiness = await this.terminalSessionManager.waitForReadiness(
          sessionId,
          directive.timeoutMs ?? 5000
        );
        readiness = this.normalizeReadiness(sessionReadiness, {
          ready: false,
          confidence: 0.3,
          trigger: "wait_timeout",
          hints: { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true }
        });
        this.logReadinessDecision(directive.tool, readiness);
      } else {
        readiness = { ready: true, confidence: 1.0, trigger: "capture" };
      }

      try {
        const capture = await this.terminalSessionManager.capturePane(
          sessionId,
          { startLine: lines, joinLines: true },
          directive.timeoutMs ?? 5000
        );
        if (capture.error) {
          throw new Error(capture.error);
        }

        this.logTerminalOutput("terminal.capture", capture.output);

        return {
          output: capture.output,
          outputBytes: capture.outputBytes,
          readiness,
          truncated: false,
          omittedLines: 0,
          context: getContext()
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { sessionId, error: message, component: "agent_terminal" },
          "capture-pane failed"
        );
        throw err;
      }
    }

    // terminal.run - use new request-response pattern
    const input = directive.input ?? "";

    // Track command if launching a known REPL
    if (input.includes("\n")) {
      const command = this.parseCommandFromInput(input);
      if (command && isKnownReplProgram(command)) {
        this.terminalSessionManager.setPendingCommand(sessionId, {
          input,
          command,
          sentAt: Date.now(),
          source: "agent"
        });
      }
    }

    // Determine mode based on current context
    const context = getContext();
    const mode = context.mode === "repl" ? "repl" : "shell";

    this.debug("terminal.run using request-response", {
      sessionId,
      mode,
      inputLength: input.length,
      program: context.program
    });

    try {
      // Single request-response call - output comes directly from Bud
      const result = await this.terminalSessionManager.runCommand(
        sessionId,
        Buffer.from(input, "utf-8"),
        { mode, timeoutMs: directive.timeoutMs ?? 30000 }
      );

      // Strip ANSI and normalize
      const cleanOutput = this.stripAnsi(result.output);
      const normalizedOutput = this.normalizeCRLF(cleanOutput);

      this.logTerminalOutput("terminal.run", normalizedOutput);

      const finalReadiness: Record<string, unknown> = this.normalizeReadiness(result.readiness, {
        ready: true,
        confidence: 0.5,
        trigger: "quiescence",
        hints: DEFAULT_READINESS_HINTS
      });
      this.logReadinessDecision(directive.tool, finalReadiness);

      return {
        output: normalizedOutput,
        outputBytes: result.outputBytes,
        readiness: finalReadiness,
        truncated: result.truncated,
        omittedLines: 0,
        context: getContext() // Refresh context after command
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { sessionId, error: message, component: "agent_terminal" },
        "terminal.run failed"
      );
      throw err;
    }
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

  private async recordTerminalToolMessage(
    threadId: string,
    directive: Extract<AgentDirective, { type: "tool_call" }>,
    result: TerminalCallResult,
    ownerUserId?: string | null,
  ): Promise<{ payload: Record<string, unknown>; message: SerializedAgentMessage }> {
    const payload = {
      tool: directive.tool,
      call_id: directive.callId,
      input: directive.input ?? null,
      output: result.output,
      output_bytes: result.outputBytes,
      readiness: result.readiness,
      truncated: result.truncated,
      omitted_lines: result.omittedLines,
      context: result.context
    };
    const [toolMessage] = await db.insert(messageTable).values({
      threadId,
      role: "tool",
      displayRole: "Tool",
      content: JSON.stringify(payload),
      createdByUserId: ownerUserId ?? undefined,
      metadata: payload
    }).returning({
      messageId: messageTable.messageId,
      role: messageTable.role,
      displayRole: messageTable.displayRole,
      content: messageTable.content,
      metadata: messageTable.metadata,
      createdAt: messageTable.createdAt,
    });
    const contextInfo = result.context?.mode === "repl" ? ` [${result.context.program}]` : "";
    const preview = `${directive.tool} ready=${(result.readiness as { ready?: boolean }).ready ?? false}${contextInfo}`;
    await recordThreadMessageMetadata(threadId, preview);
    return {
      payload,
      message: this.serializePersistedMessage(toolMessage),
    };
  }

  private serializePersistedMessage(message: PersistedAgentMessage): SerializedAgentMessage {
    return {
      message_id: message.messageId,
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
   * Parse the command name from terminal input.
   */
  private parseCommandFromInput(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) return null;
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) return null;
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }
}
