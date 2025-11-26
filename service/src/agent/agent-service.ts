import OpenAI from "openai";
import { ulid } from "ulid";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { config, type ReasoningEffortSetting } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, sessionLogTable } from "../db/schema.js";
import { SessionManager } from "../runtime/session-manager.js";
import { SessionEventBus } from "../runtime/event-bus.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";

type OpenAIResponse = Awaited<ReturnType<OpenAI["responses"]["create"]>>;
type InputItem = OpenAI.Responses.CreateParams["input"][number];

type AgentDirective =
  | {
      type: "tool_call";
      tool: "shell.run";
      command: string;
      cwd?: string;
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

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating shell access to a user's machine. Always produce STRICT JSON.
Use schema:
{"type":"tool_call","tool":"shell.run","command":"...","cwd":"~/project"} to run shell commands.
Only run commands when necessary, use short commands, prefer cwd from user context (default "~").
After receiving tool results, immediately reason about next steps. When you are done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
`.trim();

const TOOL_RESULT_PREFIX = "TOOL_RESULT";

const SHELL_TOOL = {
  type: "function" as const,
  name: "shell_run",
  description: "Execute a shell command on the user's Bud device.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Command to execute (non-interactive)."
      },
      cwd: {
        type: "string",
        description: "Working directory (default ~)."
      }
    },
    required: ["command", "cwd"],
    additionalProperties: false
  },
  strict: true
};

export class AgentService {
  private readonly client: OpenAI;
  private readonly sessionManager: SessionManager;
  private readonly events: SessionEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;
  private readonly defaultReasoningEffort: ReasoningEffortSetting;
  private readonly supportsReasoningNone: boolean;

  constructor(
    client: OpenAI,
    sessionManager: SessionManager,
    events: SessionEventBus,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean
  ) {
    this.client = client;
    this.sessionManager = sessionManager;
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
    void this.runAgentFlow({ threadId, sessionId: ensured.sessionId, reasoningEffort: requestedEffort }).catch((err) => {
      this.logger.error({ err, sessionId: ensured.sessionId, threadId, component: "agent" }, "Agent flow failed");
    });
    return { sessionId: ensured.sessionId };
  }

  private async runAgentFlow({
    threadId,
    sessionId,
    reasoningEffort
  }: {
    threadId: string;
    sessionId: string;
    reasoningEffort: ReasoningEffortSetting;
  }): Promise<void> {
    const conversation = await this.buildConversation(threadId);
    this.debug("Starting agent run", { threadId, sessionId, entries: conversation.length, reasoningEffort });
    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        const response = await this.invokeModel(conversation, reasoningEffort);
        const toolCall = this.extractFunctionCall(response);
        if (toolCall) {
          this.events.emit(sessionId, {
            event: "agent.tool_call",
            data: {
              id: ulid(),
              name: toolCall.tool,
              args: { command: toolCall.command, cwd: toolCall.cwd ?? null }
            },
            id: ulid()
          });
          this.debug("Dispatching tool call", {
            sessionId,
            threadId,
            command: toolCall.command,
            cwd: toolCall.cwd ?? "~",
            callId: toolCall.callId
          });

          conversation.push({
            type: "function_call",
            call_id: toolCall.callId,
            name: SHELL_TOOL.name,
            arguments: JSON.stringify({
              command: toolCall.command,
              cwd: toolCall.cwd ?? "~"
            })
          });

          const result = await this.executeCommandInSession(sessionId, toolCall.command, toolCall.cwd);
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
        return;
      }

      throw new Error("agent reached max steps");
    } catch (err) {
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
          };
          const callId =
            typeof payload.call_id === "string" && payload.call_id
              ? payload.call_id
              : `tool_${ulid()}`;
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
            name: SHELL_TOOL.name,
            arguments: JSON.stringify({
              command,
              cwd
            })
          });
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
    reasoningEffort: ReasoningEffortSetting
  ): Promise<OpenAIResponse> {
    const last = input.at(-1);
    const lastRole = last && "type" in last && last?.type === "message" ? last.role : "n/a";
    this.debug("Calling OpenAI Responses", {
      entries: input.length,
      lastRole,
      reasoningEffort
    });
    const response = await this.client.responses.create({
      model: config.openaiModel,
      input,
      tools: [SHELL_TOOL],
      tool_choice: "auto",
      max_output_tokens: config.agentMaxOutputTokens,
      reasoning: { effort: reasoningEffort }
    });
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
      if (toolItem?.type === "function_call" && toolItem?.name === "shell_run") {
        const args = this.safeParseArgs(toolItem.arguments);
        if (!args.command || typeof args.command !== "string") {
          throw new Error("function_call missing command argument");
        }
        const callId = typeof toolItem.call_id === "string" ? toolItem.call_id : toolItem.id ?? ulid();
        return {
          type: "tool_call",
          tool: "shell.run",
          command: args.command,
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          callId
        };
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

  private buildCommandScript(command: string, cwd: string | undefined, marker: string): string {
    const lines: string[] = [];
    lines.push(`printf '\\n__BUD_CMD_START__ ${marker}\\n'`);
    if (cwd && cwd.trim().length > 0) {
      lines.push(`cd ${this.shellEscape(cwd.trim())}`);
    }
    lines.push(command);
    lines.push("__BUD_EXIT=$?");
    lines.push(`printf '\\n__BUD_CMD_DONE__ ${marker} %s\\n' \"$__BUD_EXIT\"`);
    return `${lines.join("\n")}\n`;
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
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
}
