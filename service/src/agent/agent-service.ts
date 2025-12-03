import OpenAI from "openai";
import { ulid } from "ulid";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, sessionLogTable, threadTable } from "../db/schema.js";
import { SessionManager } from "../runtime/session-manager.js";
import { TerminalManager } from "../runtime/terminal-manager.js";
import { SessionEventBus } from "../runtime/event-bus.js";
import type { ReadinessHints } from "../terminal/types.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";

type OpenAIResponse = Awaited<ReturnType<OpenAI["responses"]["create"]>>;
type InputItem = OpenAI.Responses.CreateParams["input"][number];

type AgentDirective =
  | {
      type: "tool_call";
      tool: "shell.run" | "terminal.run" | "terminal.observe" | "terminal.interrupt";
      command?: string;
      cwd?: string;
      input?: string;
      timeoutMs?: number;
      callId: string;
    }
  | {
      type: "final";
      status: "succeeded" | "failed";
      message: string;
    };

type SessionCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  omittedLines: number;
  bytes: {
    stdout: number;
    stderr: number;
  };
};

type TerminalCallResult = {
  output: string;
  outputBytes: number;
  readiness: Record<string, unknown>;
  lastLine: string;
  truncated: boolean;
  omittedLines: number;
};

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.run","input":"ls -la\\n","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.observe","timeout_ms":30000}
- {"type":"tool_call","tool":"terminal.interrupt"}

Guidelines:
- Include \\n to press Enter. For confirmations, send "y\\n". For single-key prompts (like q to exit pager), send just the key.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.observe to wait
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running
- Use interrupt if a command hangs or you need to stop it.
- When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
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

const TERMINAL_RUN_TOOL = {
  type: "function" as const,
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
        description: "Optional max wait for readiness (ms).",
        nullable: true
      }
    },
    required: ["input", "timeout_ms"],
    additionalProperties: false
  },
  strict: true
};

const TERMINAL_OBSERVE_TOOL = {
  type: "function" as const,
  name: "terminal_observe",
  description: "Wait for more terminal output without sending input.",
  parameters: {
    type: "object",
    properties: {
      timeout_ms: {
        type: "integer",
        description: "Optional max wait for readiness (ms).",
        nullable: true
      }
    },
    required: ["timeout_ms"],
    additionalProperties: false
  },
  strict: true
};

const TERMINAL_INTERRUPT_TOOL = {
  type: "function" as const,
  name: "terminal_interrupt",
  description: "Send Ctrl+C to the terminal to interrupt the current process.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false
  },
  strict: true
};

export class AgentService {
  private readonly client: OpenAI;
  private readonly sessionManager: SessionManager;
  private readonly terminalManager: TerminalManager;
  private readonly events: SessionEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly defaultReasoningEffort: ReasoningEffortSetting;
  private readonly supportsReasoningNone: boolean;
  private readonly cancellations = new Map<string, AbortController>();

  constructor(
    client: OpenAI,
    sessionManager: SessionManager,
    terminalManager: TerminalManager,
    events: SessionEventBus,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean
  ) {
    this.client = client;
    this.sessionManager = sessionManager;
    this.terminalManager = terminalManager;
    this.events = events;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    this.defaultReasoningEffort = config.agentReasoningEffortDefault;
    this.supportsReasoningNone = this.detectReasoningNoneSupport(config.openaiModel);
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required to run the agent");
    }
  }

  async startUserMessage(
    threadId: string,
    options?: { reasoningEffort?: ReasoningEffortSetting | null }
  ): Promise<{ sessionId: string }> {
    const requestedEffort = this.normalizeReasoningEffort(options?.reasoningEffort);
    const ensured = await this.sessionManager.ensureThreadSession(threadId);
    const controller = new AbortController();
    this.cancellations.set(threadId, controller);
    void this.runAgentFlow({
      threadId,
      sessionId: ensured.sessionId,
      reasoningEffort: requestedEffort,
      controller
    }).catch((err) => {
      this.logger.error({ err, sessionId: ensured.sessionId, threadId, component: "agent" }, "Agent flow failed");
    });
    return { sessionId: ensured.sessionId };
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
          const callMeta =
            toolCall.tool === "terminal.run" || toolCall.tool === "terminal.observe" || toolCall.tool === "terminal.interrupt"
              ? { input: toolCall.input ?? toolCall.command ?? "", cwd: toolCall.cwd ?? null }
              : { command: toolCall.command, cwd: toolCall.cwd ?? null };
          this.events.emit(sessionId, {
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
            command: toolCall.command ?? toolCall.input ?? "",
            cwd: toolCall.cwd ?? "~",
            callId: toolCall.callId
          });

          conversation.push({
            type: "function_call",
            call_id: toolCall.callId,
            name: this.toolNameForConversation(toolCall.tool),
            arguments: JSON.stringify(callMeta)
          });

          if (toolCall.tool.startsWith("terminal.")) {
            const result = await this.executeTerminalCall(threadId, toolCall);
            const toolPayload = await this.recordTerminalToolMessage(threadId, toolCall, result);
            conversation.push({
              type: "function_call_output",
              call_id: toolCall.callId,
              output: JSON.stringify(toolPayload)
            });
            this.events.emit(sessionId, {
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
          } else {
            const result = await this.executeCommandInSession(sessionId, toolCall.command ?? "", toolCall.cwd);
            const toolPayload = await this.recordToolMessage(threadId, toolCall, result);
            conversation.push({
              type: "function_call_output",
              call_id: toolCall.callId,
              output: JSON.stringify(toolPayload)
            });
            this.debug("Bud execution completed", {
              sessionId,
              callId: toolCall.callId,
              exitCode: result.exitCode,
              stdoutBytes: result.bytes.stdout,
              stderrBytes: result.bytes.stderr
            });

            this.events.emit(sessionId, {
              event: "agent.tool_result",
              data: {
                name: toolCall.tool,
                exit_code: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                truncated: result.truncated,
                omitted_lines: result.omittedLines
              },
              id: ulid()
            });
          }

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

        this.events.emit(sessionId, {
          event: "agent.message",
          data: { text: directive.message },
          id: ulid()
        });
        this.events.emit(sessionId, {
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
        this.events.emit(sessionId, {
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
      this.events.emit(sessionId, {
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
    role: "system" | "user" | "assistant" | "developer",
    text: string
  ): InputItem {
    const content =
      role === "assistant"
        ? [{ type: "output_text", text }]
        : [{ type: "input_text", text }];
    return {
      type: "message",
      role,
      content
    };
  }

  private async buildConversation(threadId: string): Promise<InputItem[]> {
    const items: InputItem[] = [this.createMessageInput("system", SYSTEM_PROMPT)];
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
            command?: string;
            cwd?: string;
            tool?: string;
            input?: string;
          };
          const callId =
            typeof payload.call_id === "string" && payload.call_id
              ? payload.call_id
              : `tool_${ulid()}`;
          const toolName = typeof payload.tool === "string" ? payload.tool : "shell.run";
          if (toolName === "terminal.run") {
            const input =
              typeof payload.input === "string" && payload.input
                ? payload.input
                : typeof payload.command === "string"
                  ? payload.command
                  : null;
            if (!input) {
              throw new Error("tool payload missing input");
            }
            items.push({
              type: "function_call",
              call_id: callId,
              name: this.toolNameForConversation("terminal.run"),
              arguments: JSON.stringify({ input })
            });
          } else if (toolName === "terminal.observe") {
            items.push({
              type: "function_call",
              call_id: callId,
              name: this.toolNameForConversation("terminal.observe"),
              arguments: JSON.stringify({})
            });
          } else if (toolName === "terminal.interrupt") {
            items.push({
              type: "function_call",
              call_id: callId,
              name: this.toolNameForConversation("terminal.interrupt"),
              arguments: JSON.stringify({})
            });
          } else {
            const command =
              typeof payload.command === "string" && payload.command
                ? payload.command
                : null;
            const cwd =
              typeof payload.cwd === "string" && payload.cwd ? payload.cwd : "~";
            if (!command) {
              throw new Error("tool payload missing command");
            }
            items.push({
              type: "function_call",
              call_id: callId,
              name: this.toolNameForConversation("shell.run"),
              arguments: JSON.stringify({
                command,
                cwd
              })
            });
          }
          items.push({
            type: "function_call_output",
            call_id: callId,
            output: raw
          });
          continue;
        } catch {
          items.push(this.createMessageInput("assistant", `${TOOL_RESULT_PREFIX}\n${row.content}`));
          continue;
        }
      }
      if (row.role === "assistant") {
        items.push(this.createMessageInput(row.role, row.content));
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
        items.push(this.createMessageInput("user", content));
      }
    }
    return items;
  }

  private async invokeModel(
    input: InputItem[],
    reasoningEffort: ReasoningEffortSetting,
    signal?: AbortSignal
  ): Promise<OpenAIResponse> {
    const last = input.at(-1);
    const lastRole = last && "type" in last && last?.type === "message" ? last.role : "n/a";
    this.debug("Calling OpenAI Responses", {
      entries: input.length,
      lastRole,
      reasoningEffort
    });
    const response = await this.client.responses.create(
      {
        model: config.openaiModel,
        input,
        tools: [TERMINAL_RUN_TOOL, TERMINAL_OBSERVE_TOOL, TERMINAL_INTERRUPT_TOOL],
        tool_choice: "auto",
        max_output_tokens: config.agentMaxOutputTokens,
        reasoning: { effort: reasoningEffort }
      },
      signal ? { signal } : undefined
    );
    const outputItems =
      (response as { output?: Array<{ type?: string }> }).output ?? [];
    this.debug("OpenAI response received", {
      responseId: response.id,
      outputTypes: outputItems.map((item) => item.type ?? "unknown")
    });
    this.debugOpenAIResponse(response);
    return response;
  }

  private parseResponse(response: OpenAIResponse): AgentDirective {
    const status = (response as { status?: string }).status;
    const incompleteReason = (response as { incomplete_details?: { reason?: string } }).incomplete_details
      ?.reason;
    if (status === "incomplete") {
      throw new Error(
        `model response incomplete: ${incompleteReason ?? "unknown reason"}`
      );
    }

    const aggregated = Array.isArray(response.output_text)
      ? response.output_text.join("\n")
      : typeof response.output_text === "string"
        ? response.output_text
        : "";
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
    if (type === "tool_call") {
      const command = payload.command;
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("tool_call requires non-empty command");
      }
      const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      return {
        type: "tool_call",
        tool: "shell.run",
        command: command.trim(),
        cwd,
        callId: `txt_${ulid()}`
      };
    }
    if (type === "final") {
      const message = typeof payload.message === "string" ? payload.message : "";
      const status = payload.status === "failed" ? "failed" : "succeeded";
      return {
        type: "final",
        status,
        message: message || (status === "failed" ? "Agent failed" : "Done.")
      };
    }
    throw new Error("unknown agent directive");
  }

  private normalizeReasoningEffort(requested?: ReasoningEffortSetting | null): ReasoningEffortSetting {
    const desired = requested ?? this.defaultReasoningEffort;
    if (desired === "none" && !this.supportsReasoningNone) {
      return "low";
    }
    return desired;
  }

  private toolNameForConversation(tool: AgentDirective["tool"]) {
    switch (tool) {
      case "terminal.run":
        return "terminal_run";
      case "terminal.observe":
        return "terminal_observe";
      case "terminal.interrupt":
        return "terminal_interrupt";
      case "shell.run":
      default:
        return "shell_run";
    }
  }

  private detectReasoningNoneSupport(model: string): boolean {
    const normalized = model.toLowerCase();
    return normalized.includes("gpt-5.1") || normalized.includes("gpt-5o") || normalized.includes("o1");
  }

  private extractFunctionCall(response: OpenAIResponse): AgentDirective | null {
    const items = (response as { output?: Array<Record<string, unknown>> }).output;
    if (!Array.isArray(items)) {
      return null;
    }
    for (const item of items) {
      const toolItem = item as {
        type?: string;
        name?: string;
        arguments?: string;
        call_id?: string;
        id?: string;
      };
      if (toolItem?.type === "function_call") {
        const args = this.safeParseArgs(toolItem.arguments);
        const callId = typeof toolItem.call_id === "string" ? toolItem.call_id : toolItem.id ?? ulid();
        switch (toolItem.name) {
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
          case "terminal_observe":
            return {
              type: "tool_call",
              tool: "terminal.observe",
              timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
              callId
            };
          case "terminal_interrupt":
            return {
              type: "tool_call",
              tool: "terminal.interrupt",
              callId
            };
          case "shell_run": {
            if (!args.command || typeof args.command !== "string") {
              throw new Error("function_call missing command argument");
            }
            return {
              type: "tool_call",
              tool: "shell.run",
              command: args.command,
              cwd: typeof args.cwd === "string" ? args.cwd : undefined,
              callId
            };
          }
          default:
            break;
        }
      }
    }
    return null;
  }

  private safeParseArgs(raw?: string) {
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("failed to parse tool call arguments");
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

  private async recordToolMessage(
    threadId: string,
    directive: Extract<AgentDirective, { type: "tool_call" }>,
    result: SessionCommandResult
  ) {
    const payload = {
      tool: directive.tool,
      call_id: directive.callId,
      command: directive.command,
      cwd: directive.cwd ?? null,
      exit_code: result.exitCode,
      stdout_tail: result.stdout,
      stderr_tail: result.stderr,
      bytes: result.bytes,
      truncated: result.truncated,
      omitted_lines: result.omittedLines
    };
    await db.insert(messageTable).values({
      threadId,
      role: "tool",
      displayRole: "Tool",
      content: JSON.stringify(payload),
      metadata: payload
    });
    const preview = `${directive.tool} exit ${payload.exit_code ?? "?"}`;
    await recordThreadMessageMetadata(threadId, preview);
    return payload;
  }

  private async executeCommandInSession(
    sessionId: string,
    command: string,
    cwd?: string
  ): Promise<SessionCommandResult> {
    const marker = `cmd_${ulid()}`;
    const startMarker = `__BUD_CMD_START__ ${marker}`;
    const donePrefix = `__BUD_CMD_DONE__ ${marker} `;
    const script = this.buildCommandScript(command, cwd, marker);
    const encoded = Buffer.from(script, "utf-8").toString("base64");
    this.debug("Agent session command dispatch", {
      sessionId,
      marker,
      command,
      cwd: cwd ?? "~",
      script_bytes: Buffer.byteLength(script, "utf-8"),
      encoded_bytes: Buffer.byteLength(encoded, "utf-8")
    });
    const sent = this.sessionManager.sendInputDirect(sessionId, encoded);
    if (!sent.ok) {
      throw new Error(sent.error ?? "failed to send session input");
    }

    let lastSeq = await this.latestSessionSeq(sessionId);
    const deadline = Date.now() + 5 * 60 * 1000;
    let buffer = "";
    let exitCode: number | null = null;

    while (Date.now() < deadline) {
      const rows = await db
        .select({
          seq: sessionLogTable.seq,
          data: sessionLogTable.data
        })
        .from(sessionLogTable)
        .where(and(eq(sessionLogTable.sessionId, sessionId), gt(sessionLogTable.seq, lastSeq)))
        .orderBy(asc(sessionLogTable.seq))
        .limit(200);

      if (rows.length === 0) {
        await this.delay(150);
        continue;
      }

      for (const row of rows) {
        buffer += Buffer.from(row.data).toString("utf-8");
        lastSeq = row.seq;
      }

      const doneIdx = buffer.indexOf(donePrefix);
      if (doneIdx !== -1) {
        const doneLine = buffer.slice(doneIdx).split("\n")[0] ?? "";
        const exitMatch = doneLine.match(new RegExp(`${donePrefix}(-?\\d+)`));
        exitCode = exitMatch ? Number.parseInt(exitMatch[1] ?? "", 10) : null;
        break;
      }
    }

    if (exitCode === null) {
      throw new Error("command did not complete before timeout");
    }

    const outputStartIdx = buffer.indexOf(startMarker);
    const doneIdx = buffer.indexOf(donePrefix);
    const contentStart = outputStartIdx !== -1 ? outputStartIdx + startMarker.length : 0;
    const contentEnd = doneIdx !== -1 ? doneIdx : buffer.length;
    const rawOutput = buffer.slice(contentStart, contentEnd);
    const cleanedOutput = rawOutput.replace(/^\s*\n?/, "");
    const tail = this.tailLines(cleanedOutput, 200);
    this.debug("Agent session command completed", {
      sessionId,
      marker,
      exitCode,
      bytes: {
        total: Buffer.byteLength(cleanedOutput, "utf-8"),
        tail: Buffer.byteLength(tail.text, "utf-8")
      },
      omitted_lines: tail.omitted
    });

    return {
      exitCode,
      stdout: tail.text,
      stderr: "",
      truncated: tail.omitted > 0,
      omittedLines: tail.omitted,
      bytes: {
        stdout: Buffer.byteLength(cleanedOutput, "utf-8"),
        stderr: 0
      }
    };
  }

  private async executeTerminalCall(
    threadId: string,
    directive: Extract<AgentDirective, { type: "tool_call"; tool: string }>
  ): Promise<TerminalCallResult> {
    const bud = await this.fetchBudForThread(threadId);
    await this.terminalManager.ensureTerminal(bud.budId);
    if (directive.tool === "terminal.interrupt") {
      await this.terminalManager.sendInterrupt(bud.budId);
      const readiness = await this.terminalManager.waitForReadiness(
        bud.budId,
        directive.timeoutMs ?? 5000
      );
      const tail = await this.terminalManager.tailOutput(bud.budId, config.terminalOutputBackfillBytes);
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
        omittedLines: 0
      };
    }
    if (directive.tool === "terminal.observe") {
      const readiness = await this.terminalManager.waitForReadiness(
        bud.budId,
        directive.timeoutMs ?? 5000
      );
      const tail = await this.terminalManager.tailOutput(bud.budId, config.terminalOutputBackfillBytes);
      const decoded = this.decodeTail(tail.data);
      const finalReadiness: Record<string, unknown> = this.normalizeReadiness(readiness, {
        ready: false,
        confidence: 0.3,
        trigger: "observe",
        hints: { ...DEFAULT_READINESS_HINTS, may_still_be_processing: true }
      });
      this.logReadinessDecision(directive.tool, finalReadiness);
      return {
        output: decoded,
        outputBytes: tail.totalBytes,
        readiness: finalReadiness,
        lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
        truncated: tail.data.length < tail.totalBytes,
        omittedLines: 0
      };
    }
    // terminal.run
    const input = directive.input ?? directive.command ?? "";
    const sent = await this.terminalManager.sendInput(
      bud.budId,
      Buffer.from(input, "utf-8"),
      { source: "agent" }
    );
    if (!sent.ok) {
      throw new Error(sent.error ?? "terminal_input_failed");
    }
    const readiness = await this.terminalManager.waitForReadiness(
      bud.budId,
      directive.timeoutMs ?? 5000
    );
    const tail = await this.terminalManager.tailOutput(bud.budId, config.terminalOutputBackfillBytes);
    const decoded = this.decodeTail(tail.data);
    const finalReadiness: Record<string, unknown> = this.normalizeReadiness(readiness, {
      ready: true,
      confidence: 0.5,
      trigger: "quiescence",
      hints: DEFAULT_READINESS_HINTS
    });
    this.logReadinessDecision(directive.tool, finalReadiness);
    return {
      output: decoded,
      outputBytes: tail.totalBytes,
      readiness: finalReadiness,
      lastLine: decoded.trim().split(/\r?\n/).pop() ?? "",
      truncated: tail.data.length < tail.totalBytes,
      omittedLines: 0
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
      input: directive.input ?? directive.command ?? null,
      output: result.output,
      output_bytes: result.outputBytes,
      readiness: result.readiness,
      last_line: result.lastLine,
      truncated: result.truncated,
      omitted_lines: result.omittedLines
    };
    await db.insert(messageTable).values({
      threadId,
      role: "tool",
      displayRole: "Tool",
      content: JSON.stringify(payload),
      metadata: payload
    });
      const preview = `${directive.tool} ready=${(result.readiness as { ready?: boolean }).ready ?? false}`;
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

  private buildCommandScript(command: string, cwd: string | undefined, marker: string): string {
    const lines: string[] = [];
    lines.push(`printf '\\n__BUD_CMD_START__ ${marker}\\n'`);
    const trimmedCwd = cwd?.trim();
    if (trimmedCwd && trimmedCwd.length > 0) {
      lines.push(`cd ${this.shellEscapeForTilde(trimmedCwd)}`);
    }
    lines.push(command);
    lines.push("__BUD_EXIT=$?");
    lines.push(`printf '\\n__BUD_CMD_DONE__ ${marker} %s\\n' "$__BUD_EXIT"`);
    return `${lines.join("\n")}\n`;
  }

  private shellEscapeForTilde(value: string): string {
    // Avoid single quotes so ~ expands; wrap in double quotes and escape inner quotes.
    const escaped = value.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  private async latestSessionSeq(sessionId: string): Promise<number> {
    const row = await db
      .select({ seq: sessionLogTable.seq })
      .from(sessionLogTable)
      .where(eq(sessionLogTable.sessionId, sessionId))
      .orderBy(desc(sessionLogTable.seq))
      .limit(1);
    return row[0]?.seq ?? -1;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private tailLines(text: string, maxLines: number): { text: string; omitted: number } {
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) {
      return { text, omitted: 0 };
    }
    const omitted = lines.length - maxLines;
    const tail = lines.slice(-maxLines).join("\n");
    return { text: `${omitted} lines omitted...\n${tail}`, omitted };
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent" }, message);
  }

  private debugOpenAIResponse(response: OpenAIResponse) {
    if (!this.openaiDebugEnabled) {
      return;
    }
    try {
      const serialized = JSON.stringify(response, null, 2);
      this.logger.info({ component: "agent", openai_response: serialized }, "OpenAI response payload");
    } catch (err) {
      this.logger.warn(
        { err, component: "agent" },
        "Failed to serialize OpenAI response for debug logging"
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
