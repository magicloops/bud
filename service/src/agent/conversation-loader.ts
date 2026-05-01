import { ulid } from "ulid";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageTable } from "../db/schema.js";
import {
  createCanonicalAssistantMessageFromLedger,
  loadProviderLedgerMessages,
  type CanonicalMessage,
  type CanonicalProviderId,
} from "../llm/index.js";
import type { TerminalObservationView } from "../terminal/types.js";
import {
  buildToolArgs,
  normalizeToolKeyInput,
  parseWaitForArg,
  toolNameForConversation,
  type AgentToolCallDirective,
} from "./contracts.js";

export const AGENT_SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.send","text":"pwd","submit":true}
- {"type":"tool_call","tool":"terminal.send","text":"python","submit":true}
- {"type":"tool_call","tool":"terminal.send","text":"q"}
- {"type":"tool_call","tool":"terminal.send","key":"ctrl+c"}
- {"type":"tool_call","tool":"terminal.observe","lines":-50,"wait_for":"settled"}

Tool Responses:
All terminal tools return a JSON result containing:
- kind: "interaction_ack" | "observation"
- readiness: { ready, confidence, trigger, hints }
- context_after: { mode: "shell"|"repl"|"unknown", program?, hints?, source? }
- terminal.send waits for a settled result by default and returns delta: { changed, text, truncated }
- terminal.send timeout still returns the latest visible delta and readiness; treat trigger:"timeout" as partial progress, not proof of completion
- terminal.observe defaults to view:"delta" and returns delta in output; use view:"screen" or view:"history" for broader context
- The service owns terminal wait timeout policy. Choose wait_for behavior, not timeout_ms values.

Guidelines:
- terminal.send is the primary terminal input tool for both shell commands and interactive programs.
- For normal shell commands, send the command text with submit:true instead of adding a trailing \\n yourself.
- Multiline shell input is allowed when you intentionally need it (for example heredocs or pasted scripts).
- terminal.send is also for interactive input, confirmations, single-key actions, and launching interactive programs from shell.
- terminal.send represents one gesture at a time: either text with optional submit, or one semantic key.
- Use backend-neutral key names in terminal.send.key, for example "ctrl+c" for Ctrl+C.
- Omit wait_for for ordinary terminal.send calls. The default behavior is to wait for the terminal to settle before returning.
- If delta.changed is false or delta.text is empty, do not assume the program accepted the input.
- terminal.observe is for explicit screen inspection, extra scrollback, or longer waits after timeout/ambiguity.
- terminal.observe defaults to a delta view. Use view:"screen" for the full current screen and view:"history" for recent scrollback/history.
- Use wait_for:"settled" with terminal.observe when you explicitly want to keep waiting longer after a timeout or ambiguous result.
- Use wait_for:"changed" only when you specifically need a quick reaction proof instead of the normal settled result.
- Use wait_for:"none" only when you deliberately want the fast path, such as a command expected to produce no immediate useful output before a later observe.
- Check readiness from tool results to decide your next action:
  - confidence >= 0.8: Terminal is ready, send next command
  - confidence 0.5-0.8: Probably ready, verify output makes sense before proceeding
  - confidence < 0.5: Likely still processing, use terminal.observe with wait_for:"settled"
- For terminal.send specifically:
  - If delta.changed is false, verify with terminal.observe before claiming the program accepted the input
  - If readiness hints suggest ongoing processing, use terminal.observe for progress
  - If context_after.mode is "repl" and the delta shows the UI is asking for more input, another terminal.send is reasonable
  - If context_after.mode is "shell", another terminal.send is the normal way to run the next shell command
- If you need to interrupt the foreground program, use terminal.send with key:"ctrl+c". Send it again if the program or TUI still has not exited.
- Use the hints object to understand terminal state:
  - looks_like_prompt: A shell/REPL prompt detected (safe to send commands)
  - looks_like_confirmation: Waiting for y/n or yes/no response
  - looks_like_password: Waiting for password input (won't echo)
  - looks_like_pager: In a pager like less/more (send 'q' to exit, space to continue)
  - may_still_be_processing: Output suggests command is still running

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
  * To exit, use terminal.send with text "exit" and submit true, or use terminal.send with key:"ctrl+c" if the TUI needs an interrupt
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

export function createCanonicalTextMessage(
  role: "system" | "user" | "assistant",
  text: string,
): CanonicalMessage {
  return {
    role,
    content: [{ type: "text", text }],
  };
}

export class AgentConversationLoader {
  async load(
    threadId: string,
    options?: { provider?: CanonicalProviderId | null },
  ): Promise<CanonicalMessage[]> {
    const messages: CanonicalMessage[] = [
      createCanonicalTextMessage("system", AGENT_SYSTEM_PROMPT),
    ];

    const rows = await db
      .select({
        messageId: messageTable.messageId,
        role: messageTable.role,
        content: messageTable.content,
        metadata: messageTable.metadata,
        createdAt: messageTable.createdAt,
      })
      .from(messageTable)
      .where(eq(messageTable.threadId, threadId))
      .orderBy(asc(messageTable.createdAt));

    if (!options?.provider) {
      for (const row of rows) {
        this.appendStoredMessage(messages, row, { toolUseFromProviderLedger: false });
      }
      return messages;
    }

    const ledgerMessages = await loadProviderLedgerMessages(threadId, options.provider);
    const ledgerCallIds = new Set(ledgerMessages.map((message) => message.llmCallId));
    const timeline = [
      ...rows.map((row) => ({ type: "message" as const, createdAt: row.createdAt, row })),
      ...ledgerMessages.map((ledger) => ({
        type: "ledger" as const,
        createdAt: ledger.createdAt,
        ledger,
      })),
    ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

    for (const item of timeline) {
      if (item.type === "ledger") {
        messages.push(createCanonicalAssistantMessageFromLedger(item.ledger.content));
        continue;
      }

      const metadata = (item.row.metadata ?? {}) as Record<string, unknown>;
      const llmCallId = typeof metadata.llm_call_id === "string" ? metadata.llm_call_id : null;
      if (item.row.role === "assistant" && llmCallId && ledgerCallIds.has(llmCallId)) {
        continue;
      }

      this.appendStoredMessage(messages, item.row, {
        toolUseFromProviderLedger: Boolean(llmCallId && ledgerCallIds.has(llmCallId)),
      });
    }

    return messages;
  }

  private appendStoredMessage(
    messages: CanonicalMessage[],
    row: {
      role: string;
      content: string;
      metadata: unknown;
    },
    options: { toolUseFromProviderLedger: boolean },
  ): void {
    if (row.role === "tool") {
      const directive = this.parseStoredToolDirective(row.content);
      if (!directive) {
        return;
      }

      if (!options.toolUseFromProviderLedger) {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: directive.callId,
              name: toolNameForConversation(directive.tool),
              input: buildToolArgs(directive),
            },
          ],
        });
      }

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: directive.callId,
            content: row.content,
          },
        ],
      });
      return;
    }

    if (row.role === "assistant") {
      messages.push(createCanonicalTextMessage("assistant", row.content));
      return;
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
      messages.push(createCanonicalTextMessage("user", content));
      return;
    }

    if (row.role === "system") {
      messages.push(createCanonicalTextMessage("system", row.content));
    }
  }

  private parseStoredToolDirective(raw: string): AgentToolCallDirective | null {
    try {
      const payload = JSON.parse(raw) as {
        call_id?: string;
        tool?: string;
        text?: string;
        submit?: boolean;
        key?: string;
        keys?: string[];
        observe_after_ms?: number;
        wait_for?: unknown;
        lines?: number;
        view?: string;
      };

      const callId =
        typeof payload.call_id === "string" && payload.call_id
          ? payload.call_id
          : `tool_${ulid()}`;

      switch (payload.tool) {
        case "terminal.send":
          return {
            type: "tool_call",
            tool: "terminal.send",
            text: typeof payload.text === "string" ? payload.text : undefined,
            submit: payload.submit === true,
            key: normalizeToolKeyInput(payload.key, payload.keys),
            observeAfterMs:
              typeof payload.observe_after_ms === "number"
                ? payload.observe_after_ms
                : undefined,
            waitFor: parseWaitForArg(payload.wait_for),
            callId,
          };
        case "terminal.observe":
          return {
            type: "tool_call",
            tool: "terminal.observe",
            lines: typeof payload.lines === "number" ? payload.lines : undefined,
            view: this.parseObservationView(payload.view),
            waitFor: parseWaitForArg(payload.wait_for),
            callId,
          };
        case "terminal.interrupt":
          return {
            type: "tool_call",
            tool: "terminal.send",
            key: "ctrl+c",
            callId,
          };
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private parseObservationView(value: unknown): TerminalObservationView | undefined {
    return value === "delta" || value === "screen" || value === "history"
      ? value
      : undefined;
  }
}
