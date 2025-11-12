import OpenAI from "openai";
import { ulid } from "ulid";
import { asc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { messageTable, runTable } from "../db/schema.js";
import { RunManager, RunStepResult } from "../runtime/run-manager.js";
import { RunEventBus } from "../runtime/event-bus.js";

type AgentDirective =
  | {
      type: "tool_call";
      tool: "shell.run";
      command: string;
      cwd?: string;
    }
  | {
      type: "final";
      status: "succeeded" | "failed";
      message: string;
    };

type ConversationMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const SYSTEM_PROMPT = `
You are Bud Agent, coordinating shell access to a user's machine. Always produce STRICT JSON.
Use schema:
{"type":"tool_call","tool":"shell.run","command":"...","cwd":"~/project"} to run shell commands.
Only run commands when necessary, use short commands, prefer cwd from user context (default "~").
After receiving tool results (prefixed with TOOL_RESULT), reason about next steps.
When you are done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
`.trim();

const TOOL_RESULT_PREFIX = "TOOL_RESULT";

export class AgentService {
  private readonly client: OpenAI;
  private readonly runManager: RunManager;
  private readonly events: RunEventBus;

  constructor(client: OpenAI, runManager: RunManager, events: RunEventBus) {
    this.client = client;
    this.runManager = runManager;
    this.events = events;
    if (!config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required to run the agent");
    }
  }

  async handleUserMessage(threadId: string): Promise<{ runId: string }> {
    const { runId, budId } = await this.runManager.createRunRecord(threadId, { status: "planning" });
    try {
      const history = await this.fetchHistory(threadId);
      const messages: ConversationMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history
      ];

      let steps = 0;
      while (steps < config.agentMaxSteps) {
        const directive = await this.invokeModel(messages);
        if (directive.type === "tool_call") {
          this.events.emit(runId, {
            event: "agent.tool_call",
            data: {
              id: ulid(),
              name: directive.tool,
              args: { command: directive.command, cwd: directive.cwd ?? "~" }
            },
            id: ulid()
          });

          const dispatch = await this.runManager.dispatchShellCommand({
            runId,
            budId,
            command: directive.command,
            cwd: directive.cwd ?? "~",
            mode: "agent"
          });
          const result = await dispatch.promise;
          await this.recordToolMessage(threadId, directive, result);
          this.events.emit(runId, {
            event: "agent.tool_result",
            data: {
              name: directive.tool,
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr
            },
            id: ulid()
          });
          messages.push({
            role: "user",
            content: `${TOOL_RESULT_PREFIX}\n${JSON.stringify({
              tool: directive.tool,
              command: directive.command,
              cwd: directive.cwd ?? "~",
              exit_code: result.exitCode,
              signal: result.signal,
              stdout_tail: result.stdout,
              stderr_tail: result.stderr,
              bytes: result.bytes
            })}`
          });
          steps += 1;
          continue;
        }

        await db.insert(messageTable).values({
          threadId,
          role: "assistant",
          content: directive.message
        });
        await db
          .update(runTable)
          .set({
            status: directive.status,
            finishedAt: new Date(),
            error: directive.status === "failed" ? directive.message : null
          })
          .where(eq(runTable.runId, runId));

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

      this.events.emit(runId, {
        event: "final",
        data: {
          status: "failed",
          error: err instanceof Error ? err.message : "agent_failed"
        },
        id: ulid()
      });

      throw err;
    }
  }

  private async fetchHistory(threadId: string): Promise<ConversationMessage[]> {
    const rows = await db
      .select({
        role: messageTable.role,
        content: messageTable.content
      })
      .from(messageTable)
      .where(eq(messageTable.threadId, threadId))
      .orderBy(asc(messageTable.createdAt));

    return rows.map((row) => {
      if (row.role === "assistant") {
        return { role: "assistant" as const, content: row.content };
      }
      if (row.role === "tool") {
        return {
          role: "user" as const,
          content: `${TOOL_RESULT_PREFIX}\n${row.content}`
        };
      }
      return { role: "user" as const, content: row.content };
    });
  }

  private async invokeModel(messages: ConversationMessage[]): Promise<AgentDirective> {
    const input = messages.map((msg) => ({
      role: msg.role,
      type: "message",
      content: [{ type: "text", text: msg.content }]
    }));

    const response = await this.client.responses.create({
      model: config.openaiModel,
      input,
      temperature: 0.2,
      max_output_tokens: 800
    });

    return this.parseDirective(response.output_text);
  }

  private parseDirective(rawText: string): AgentDirective {
    const trimmed = rawText.trim();
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
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("tool_call requires non-empty command");
      }
      const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      return {
        type: "tool_call",
        tool: "shell.run",
        command: command.trim(),
        cwd
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
    await db.insert(messageTable).values({
      threadId,
      role: "tool",
      content: JSON.stringify({
        tool: directive.tool,
        command: directive.command,
        cwd: directive.cwd ?? "~",
        exit_code: result.exitCode,
        signal: result.signal,
        stdout_tail: result.stdout,
        stderr_tail: result.stderr,
        bytes: result.bytes
      })
    });
  }
}
