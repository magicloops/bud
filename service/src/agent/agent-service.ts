import { ulid } from "ulid";
import { asc, desc, eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, threadTable } from "../db/schema.js";
import type { TerminalSessionManager, TerminalSession } from "../runtime/terminal-session-manager.js";
import { AgentEventBus } from "../runtime/event-bus.js";
import type { ReadinessHints } from "../terminal/types.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import {
  providerRegistry,
  OpenAIProvider,
  type CanonicalMessage,
  type CanonicalTool,
  type CanonicalResponse,
  type CanonicalContentBlock,
  type ModelConfig,
} from "../llm/index.js";

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
  lastLine: string;
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

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.capture"}
- {"type":"tool_call","tool":"terminal.capture","wait":true}
- {"type":"tool_call","tool":"terminal.interrupt"}

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
- Use terminal.capture to get terminal screen output:
  - Add wait:true if a command might still be running (waits for readiness first)
  - Add lines:-200 or lines:-500 for more scrollback history
  - Works well for TUI apps (rendered screen instead of raw byte stream)

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

OUTPUT FORMAT:
- When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
- The "message" field supports markdown formatting. Use it for clarity:
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
    description: "Send input to the persistent terminal (include \\n to press Enter).",
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
      "Get terminal screen output. Use to see TUI app content, scroll through history, " +
      "or wait for a command to finish. Returns the rendered screen (what you would see visually).",
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
    openaiDebugEnabled: boolean
  ) {
    this.terminalSessionManager = terminalSessionManager;
    this.events = events;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    this.defaultReasoningEffort = config.agentReasoningEffortDefault;
    this.supportsReasoningNone = this.detectReasoningNoneSupport(config.openaiModel);
  }

  async startUserMessage(
    threadId: string,
    options?: { reasoningEffort?: ReasoningEffortSetting | null }
  ): Promise<{ sessionId: string }> {
    const requestedEffort = this.normalizeReasoningEffort(options?.reasoningEffort);
    // Get or create terminal session for this thread
    const session = await this.getOrCreateSession(threadId);
    const controller = new AbortController();
    this.cancellations.set(threadId, controller);
    void this.runAgentFlow({
      threadId,
      sessionId: session.sessionId,
      reasoningEffort: requestedEffort,
      controller
    }).catch((err) => {
      this.logger.error({ err, sessionId: session.sessionId, threadId, component: "agent" }, "Agent flow failed");
    });
    return { sessionId: session.sessionId };
  }

  private async runAgentFlow({
    threadId,
    sessionId,
    reasoningEffort,
    controller
  }: {
    threadId: string;
    sessionId: string;
    reasoningEffort: ReasoningEffortSetting;
    controller: AbortController;
  }): Promise<void> {
    const conversation = await this.buildConversation(threadId);
    this.debug("Starting agent run", { threadId, sessionId, entries: conversation.length, reasoningEffort });
    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        if (controller.signal.aborted) {
          throw new Error("agent_canceled");
        }
        const response = await this.invokeModel(conversation, reasoningEffort, controller.signal);
        const toolCall = this.extractFunctionCall(response);
        if (toolCall) {
          const callMeta = { input: toolCall.input ?? "" };
          this.events.emit(threadId, {
            event: "agent.tool_call",
            data: {
              id: ulid(),
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

          // Add assistant message with tool_use
          conversation.push({
            role: "assistant",
            content: [{
              type: "tool_use",
              id: toolCall.callId,
              name: this.toolNameForConversation(toolCall.tool),
              input: callMeta
            }]
          });

          const result = await this.executeTerminalCall(threadId, toolCall);
          const toolPayload = await this.recordTerminalToolMessage(threadId, toolCall, result);

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
              name: toolCall.tool,
              output: result.output,
              output_bytes: result.outputBytes,
              readiness: result.readiness,
              last_line: result.lastLine,
              truncated: result.truncated,
              omitted_lines: result.omittedLines
            },
            id: ulid()
          });

          steps += 1;
          continue;
        }

        const directive = this.parseResponse(response);
        await db.insert(messageTable).values({
          threadId,
          role: "assistant",
          displayRole: "Bud Agent",
          content: directive.message,
          metadata: { status: directive.status }
        });
        await recordThreadMessageMetadata(threadId, directive.message);
        conversation.push(this.createMessageInput("assistant", directive.message));

        this.events.emit(threadId, {
          event: "agent.message",
          data: { text: directive.message },
          id: ulid()
        });
        this.events.emit(threadId, {
          event: "final",
          data: { status: directive.status, text: directive.message },
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
    }
    return messages;
  }

  private async invokeModel(
    messages: CanonicalMessage[],
    reasoningEffort: ReasoningEffortSetting,
    signal?: AbortSignal
  ): Promise<CanonicalResponse> {
    const last = messages.at(-1);
    const lastRole = last?.role ?? "n/a";
    this.debug("Calling LLM via provider", {
      entries: messages.length,
      lastRole,
      reasoningEffort,
      model: config.openaiModel
    });

    const provider = providerRegistry.getProviderForModel(config.openaiModel);

    // Build reasoning config - "none" means disabled
    const reasoning = reasoningEffort === "none"
      ? { enabled: false }
      : { enabled: true, effort: reasoningEffort as "low" | "medium" | "high" };

    const modelConfig: ModelConfig = {
      model: config.openaiModel,
      maxOutputTokens: config.agentMaxOutputTokens,
      reasoning,
      responseFormat: "json"
    };

    const response = await provider.invokeSync!(
      messages,
      CANONICAL_TOOLS,
      modelConfig,
      signal
    );

    this.debug("LLM response received", {
      responseId: response.id,
      stopReason: response.stopReason,
      toolCallCount: response.toolCalls?.length ?? 0
    });
    this.debugCanonicalResponse(response);
    return response;
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
    const trimmed = aggregated.trim();
    const jsonText = this.stripCodeFence(trimmed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      this.logger.warn(
        {
          err,
          responseId: response.id,
          component: "agent",
          rawText: trimmed.slice(0, 500)
        },
        "Agent response was not JSON; falling back to plain text"
      );
      return {
        type: "final",
        status: "succeeded",
        message: trimmed
      };
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("agent response must be an object");
    }
    const payload = parsed as Record<string, unknown>;
    const type = payload.type;
    if (type === "final") {
      const message = typeof payload.message === "string" ? payload.message : "";
      const status = payload.status === "failed" ? "failed" : "succeeded";
      return {
        type: "final",
        status,
        message: message || (status === "failed" ? "Agent failed" : "Done.")
      };
    }
    // Model should use function calling API for tool calls, not raw JSON
    throw new Error(`unknown agent directive type: ${type}`);
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

  private stripCodeFence(text: string) {
    if (text.startsWith("```")) {
      const lines = text.split("\n");
      if (lines.length >= 2) {
        lines.shift();
        if (lines[lines.length - 1].trim() === "```") {
          lines.pop();
        }
        return lines.join("\n");
      }
    }
    return text;
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
        lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
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
          lastLine: capture.output.trim().split(/\r?\n/).pop() ?? "",
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

    // terminal.run
    const offsetBeforeInput = this.terminalSessionManager.getLastOffset(sessionId);
    this.debug("terminal.run capturing offset before input", { sessionId, offsetBeforeInput });

    const input = directive.input ?? "";
    const sent = await this.terminalSessionManager.sendInput(
      sessionId,
      Buffer.from(input, "utf-8"),
      { source: "agent" }
    );
    if (!sent.ok) {
      throw new Error(sent.error ?? "terminal_input_failed");
    }

    const readiness = await this.terminalSessionManager.waitForReadiness(
      sessionId,
      directive.timeoutMs ?? 5000
    );
    const offsetAfterReadiness = this.terminalSessionManager.getLastOffset(sessionId);

    this.debug("terminal.run after readiness", {
      sessionId,
      offsetBeforeInput,
      offsetAfterReadiness,
      offsetDelta: offsetAfterReadiness - offsetBeforeInput
    });

    // Get output based on context mode
    const context = getContext();
    let decoded: string;
    let outputBytes: number;
    let truncated: boolean;

    if (context.mode === "repl") {
      this.debug("terminal.run using capture-pane for REPL context", {
        sessionId,
        program: context.program
      });

      try {
        const capture = await this.terminalSessionManager.capturePane(sessionId, {
          startLine: -50,
          joinLines: true
        });
        this.logTerminalOutput("terminal.run (REPL)", capture.output);
        decoded = capture.output;
        outputBytes = capture.outputBytes;
        truncated = false;
      } catch (err) {
        this.logger.warn(
          { sessionId, err, component: "agent_terminal" },
          "capture-pane failed, falling back to pipe-pane"
        );
        const tail = await this.terminalSessionManager.tailOutput(
          sessionId,
          config.terminalOutputBackfillBytes,
          { sinceOffset: offsetBeforeInput }
        );
        decoded = this.decodeTail(tail.data);
        outputBytes = tail.totalBytes;
        truncated = tail.data.length < tail.totalBytes;
      }
    } else {
      const tail = await this.terminalSessionManager.tailOutput(
        sessionId,
        config.terminalOutputBackfillBytes,
        { sinceOffset: offsetBeforeInput }
      );
      decoded = this.decodeTail(tail.data);
      outputBytes = tail.totalBytes;
      truncated = tail.data.length < tail.totalBytes;
    }

    this.debug("terminal.run received output", {
      sessionId,
      offsetBeforeInput,
      mode: context.mode,
      program: context.program,
      outputBytes,
      decodedLength: decoded.length,
      decodedPreview: decoded.slice(0, 300).replace(/\n/g, "\\n")
    });

    const finalReadiness: Record<string, unknown> = this.normalizeReadiness(readiness, {
      ready: true,
      confidence: 0.5,
      trigger: "quiescence",
      hints: DEFAULT_READINESS_HINTS
    });
    this.logReadinessDecision(directive.tool, finalReadiness);

    return {
      output: decoded,
      outputBytes,
      readiness: finalReadiness,
      lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
      truncated,
      omittedLines: 0,
      context
    };
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
    result: TerminalCallResult
  ) {
    const payload = {
      tool: directive.tool,
      call_id: directive.callId,
      input: directive.input ?? null,
      output: result.output,
      output_bytes: result.outputBytes,
      readiness: result.readiness,
      last_line: result.lastLine,
      truncated: result.truncated,
      omitted_lines: result.omittedLines,
      context: result.context
    };
    await db.insert(messageTable).values({
      threadId,
      role: "tool",
      displayRole: "Tool",
      content: JSON.stringify(payload),
      metadata: payload
    });
    const contextInfo = result.context?.mode === "repl" ? ` [${result.context.program}]` : "";
    const preview = `${directive.tool} ready=${(result.readiness as { ready?: boolean }).ready ?? false}${contextInfo}`;
    await recordThreadMessageMetadata(threadId, preview);
    return payload;
  }

  private decodeTail(data: Buffer): string {
    // If looks binary, return notice instead of raw binary.
    const text = data.toString("utf-8");
    const nonPrintable = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x09 || (code > 0x0d && code < 0x20);
    }).length;
    if (nonPrintable > 8) {
      return "[binary output omitted]";
    }
    // Strip ANSI escape codes for agent consumption (UI gets raw via SSE)
    const stripped = this.stripAnsi(text);
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

  /**
   * Get or create the terminal session for a thread.
   * Creates session on first terminal tool use.
   */
  private async getOrCreateSession(threadId: string): Promise<TerminalSession> {
    // Check for existing session
    let session = await this.terminalSessionManager.getSessionForThread(threadId);

    if (!session) {
      // Create new session
      const bud = await this.fetchBudForThread(threadId);
      await this.terminalSessionManager.createSessionForThread(threadId, bud.budId);
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
}
