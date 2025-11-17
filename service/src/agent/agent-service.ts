import OpenAI from "openai";
import { ulid } from "ulid";
import { asc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, runTable } from "../db/schema.js";
import { RunManager, RunStepResult } from "../runtime/run-manager.js";
import { RunEventBus } from "../runtime/event-bus.js";
import type { FastifyBaseLogger } from "fastify";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { upsertRunSummary } from "../db/run-summary.js";

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
  private readonly runManager: RunManager;
  private readonly events: RunEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;
  private readonly openaiDebugEnabled: boolean;

  constructor(
    client: OpenAI,
    runManager: RunManager,
    events: RunEventBus,
    logger: FastifyBaseLogger,
    debugEnabled: boolean,
    openaiDebugEnabled: boolean
  ) {
    this.client = client;
    this.runManager = runManager;
    this.events = events;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
    this.openaiDebugEnabled = openaiDebugEnabled;
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required to run the agent");
    }
  }

  async handleUserMessage(threadId: string): Promise<{ runId: string }> {
    const { runId, budId } = await this.runManager.createRunRecord(threadId, { status: "planning" });
    const conversation = await this.buildConversation(threadId);
    this.debug("Starting agent run", { threadId, runId, entries: conversation.length });
    const aggregateBytes = { stdout: 0, stderr: 0 };
    try {
      let steps = 0;
      while (steps < config.agentMaxSteps) {
        const response = await this.invokeModel(conversation);
        const toolCall = this.extractFunctionCall(response);
        if (toolCall) {
          this.events.emit(runId, {
            event: "agent.tool_call",
            data: {
              id: ulid(),
              name: toolCall.tool,
              args: { command: toolCall.command, cwd: toolCall.cwd ?? "~" }
            },
            id: ulid()
          });
          this.debug("Dispatching tool call", {
            runId,
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

          const dispatch = await this.runManager.dispatchShellCommand({
            runId,
            budId,
            command: toolCall.command,
            cwd: toolCall.cwd ?? "~",
            mode: "agent"
          });
          const result = await dispatch.promise;
          const toolPayload = await this.recordToolMessage(threadId, toolCall, result);
          conversation.push({
            type: "function_call_output",
            call_id: toolCall.callId,
            output: JSON.stringify(toolPayload)
          });
          this.debug("Bud execution completed", {
            runId,
            callId: toolCall.callId,
            exitCode: result.exitCode,
            stdoutBytes: result.bytes.stdout,
            stderrBytes: result.bytes.stderr
          });

          this.events.emit(runId, {
            event: "agent.tool_result",
            data: {
              name: toolCall.tool,
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr
            },
            id: ulid()
          });

          aggregateBytes.stdout += result.bytes.stdout;
          aggregateBytes.stderr += result.bytes.stderr;
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
        await db
          .update(runTable)
          .set({
            status: directive.status,
            finishedAt: new Date(),
            error: directive.status === "failed" ? directive.message : null
          })
          .where(eq(runTable.runId, runId));
        await upsertRunSummary({
          runId,
          status: directive.status,
          exitCode: directive.status === "succeeded" ? 0 : null,
          stdoutBytes: aggregateBytes.stdout,
          stderrBytes: aggregateBytes.stderr,
          finishedAt: new Date()
        });

        this.events.emit(runId, {
          event: "agent.message",
          data: { text: directive.message },
          id: ulid()
        });
        this.events.emit(runId, {
          event: "final",
          data: { status: directive.status, text: directive.message },
          id: ulid()
        });

        this.debug("Agent final response", {
          runId,
          status: directive.status,
          textLength: directive.message.length
        });
        return { runId };
      }

      throw new Error("agent reached max steps");
    } catch (err) {
      await db
        .update(runTable)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: err instanceof Error ? err.message : "agent_failed"
        })
        .where(eq(runTable.runId, runId));
      await upsertRunSummary({
        runId,
        status: "failed",
        exitCode: null,
        stdoutBytes: aggregateBytes.stdout,
        stderrBytes: aggregateBytes.stderr,
        finishedAt: new Date()
      });

      this.events.emit(runId, {
        event: "final",
        data: {
          status: "failed",
          error: err instanceof Error ? err.message : "agent_failed"
        },
        id: ulid()
      });

      this.debug("Agent run failed", {
        runId,
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

  private async invokeModel(input: InputItem[]): Promise<OpenAIResponse> {
    const last = input.at(-1);
    const lastRole = last && "type" in last && last?.type === "message" ? last.role : "n/a";
    this.debug("Calling OpenAI Responses", {
      entries: input.length,
      lastRole
    });
    const response = await this.client.responses.create({
      model: config.openaiModel,
      input,
      tools: [SHELL_TOOL],
      tool_choice: "auto",
      max_output_tokens: config.agentMaxOutputTokens
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
      throw new Error(`failed to parse agent response as JSON: ${(err as Error).message}`);
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
    result: RunStepResult
  ) {
    const payload = {
      tool: directive.tool,
      call_id: directive.callId,
      command: directive.command,
      cwd: directive.cwd ?? "~",
      exit_code: result.exitCode,
      signal: result.signal,
      stdout_tail: result.stdout,
      stderr_tail: result.stderr,
      bytes: result.bytes
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
