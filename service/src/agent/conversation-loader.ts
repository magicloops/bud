import { ulid } from "ulid";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageTable } from "../db/schema.js";
import {
  createCanonicalAssistantMessageFromLedger,
  getCatalogEntry,
  loadProviderLedgerMessages,
  loadProviderLedgerThreadDiagnostics,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalProviderId,
  type LlmCallRequestMode,
  type LlmReconstructionDiagnostics,
  type ProviderLedgerMessage,
  type ProviderLedgerThreadDiagnostics,
  type ReasoningConfig,
} from "../llm/index.js";
import type { TerminalObservationView } from "../terminal/types.js";
import {
  buildToolArgs,
  normalizeToolKeyInput,
  parseWaitForArg,
  toolNameForConversation,
  type AgentToolCallDirective,
} from "./contracts.js";
import {
  ASK_USER_QUESTIONS_TOOL,
  normalizeAskUserQuestionsRequest,
  parseStoredAskUserQuestionsRequest,
} from "./user-question-contracts.js";

type StoredMessageRow = {
  messageId: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
};

type ConversationLoadOptions = {
  provider?: CanonicalProviderId | null;
  targetModel?: string | null;
  targetReasoning?: ReasoningConfig | null;
};

export type LoadedConversation = {
  messages: CanonicalMessage[];
  reconstruction: LlmReconstructionDiagnostics;
};

export const AGENT_SYSTEM_PROMPT = `
You are Bud Agent, coordinating terminal access to a user's machine.
You have a persistent terminal; state (cwd, env, running processes) persists across turns.

Tools:
- {"type":"tool_call","tool":"terminal.send","text":"pwd","submit":true}
- {"type":"tool_call","tool":"terminal.send","text":"python","submit":true}
- {"type":"tool_call","tool":"terminal.send","text":"q"}
- {"type":"tool_call","tool":"terminal.send","key":"ctrl+c"}
- {"type":"tool_call","tool":"terminal.observe","lines":-50,"wait_for":"settled"}
- {"type":"tool_call","tool":"web_view.open","target_host":"localhost","target_port":5173,"path":"/"}
- {"type":"tool_call","tool":"web_view.close"}
- {"type":"tool_call","tool":"web_view.list"}
- {"type":"tool_call","tool":"ask_user_questions","title":"Deployment details","questions":[{"question_id":"target","kind":"single_choice","label":"Which environment should I deploy to?","choices":[{"choice_id":"staging","label":"Staging"},{"choice_id":"production","label":"Production"}]}]}

Tool Responses:
All terminal tools return a JSON result containing:
- kind: "interaction_ack" | "observation"
- readiness: { ready, confidence, trigger, hints }
- context_after: { mode: "shell"|"repl"|"unknown", program?, hints?, source? }
- terminal.send waits for a settled result by default and returns delta: { changed, text, truncated }
- terminal.send timeout still returns the latest visible delta and readiness; treat trigger:"timeout" as partial progress, not proof of completion
- terminal.observe defaults to view:"delta" and returns delta in output; use view:"screen" or view:"history" for broader context
- The service owns terminal wait timeout policy. Choose wait_for behavior, not timeout_ms values.
Web view tools return JSON with kind:"web_view", the proxied site metadata, current thread attachment, and proxy transport status.
ask_user_questions returns JSON with kind:"user_questions", the original questions, and a response for each question. Each response repeats the question before the answer. Users may skip any question.

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
- Use web_view.open when a local web server is already running or you have just started one and the user would benefit from viewing it.
- For web_view.open, preserve the user's loopback host exactly when they name one: use target_host:"localhost" for localhost, target_host:"127.0.0.1" for 127.0.0.1, and target_host:"::1" for ::1. Do not substitute 127.0.0.1 for localhost.
- If the user gives only a port for web_view.open, omit target_host; the service defaults to localhost.
- Use web_view.list before opening a duplicate if you are unsure whether the current Bud already has a matching web view.
- Use web_view.close to detach the current thread web view. Only set disable:true when the user explicitly wants the proxied site stopped.
- Use ask_user_questions when you cannot proceed safely without one or more user decisions. Keep prompts short, ask at most five questions, use structured choices when possible, and continue from skipped answers when a reasonable fallback exists.
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
    options?: ConversationLoadOptions,
  ): Promise<CanonicalMessage[]> {
    return (await this.loadInternal(threadId, options, false)).messages;
  }

  async loadWithDiagnostics(
    threadId: string,
    options?: ConversationLoadOptions,
  ): Promise<LoadedConversation> {
    return this.loadInternal(threadId, options, true);
  }

  private async loadInternal(
    threadId: string,
    options: ConversationLoadOptions | undefined,
    includeDiagnostics: boolean,
  ): Promise<LoadedConversation> {
    const messages: CanonicalMessage[] = [
      createCanonicalTextMessage("system", AGENT_SYSTEM_PROMPT),
    ];

    const rows = await this.loadStoredRows(threadId);

    if (!options?.provider) {
      for (const row of rows) {
        this.appendStoredMessage(messages, row, { toolUseFromProviderLedger: false });
      }
      return {
        messages,
        reconstruction: buildReconstructionDiagnostics({
          targetProvider: null,
          rows,
          ledgerMessages: [],
          ledgerSummary: emptyProviderLedgerThreadDiagnostics(),
          canonicalFallbackMessageCount: countModelTranscriptRows(rows),
        }),
      };
    }

    const ledgerSummary = includeDiagnostics
      ? await loadProviderLedgerThreadDiagnostics(threadId)
      : emptyProviderLedgerThreadDiagnostics();
    const loadedLedgerMessages = await loadProviderLedgerMessages(threadId, options.provider);
    const compatibility = splitCompatibleLedgerMessages(loadedLedgerMessages, options);
    const ledgerMessages = compatibility.compatibleMessages;
    const ledgerCallIds = new Set(ledgerMessages.map((message) => message.llmCallId));
    const timeline = [
      ...rows.map((row) => ({ type: "message" as const, createdAt: row.createdAt, row })),
      ...ledgerMessages.map((ledger) => ({
        type: "ledger" as const,
        createdAt: ledger.createdAt,
        ledger,
      })),
    ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

    let canonicalFallbackMessageCount = 0;
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

      const toolUseFromProviderLedger = Boolean(llmCallId && ledgerCallIds.has(llmCallId));
      if (isModelTranscriptRow(item.row) && !toolUseFromProviderLedger) {
        canonicalFallbackMessageCount += 1;
      }

      this.appendStoredMessage(messages, item.row, {
        toolUseFromProviderLedger,
      });
    }

    return {
      messages,
      reconstruction: buildReconstructionDiagnostics({
        targetProvider: options.provider,
        targetModel: options.targetModel,
        targetReasoning: options.targetReasoning,
        rows,
        ledgerMessages,
        ledgerSummary,
        canonicalFallbackMessageCount,
        sameProviderIncompatibleCallCount: compatibility.incompatibleMessages.length,
        sameProviderIncompatibleOutputItemCount:
          compatibility.incompatibleOutputItemCount,
        sameProviderIncompatibleProviderOnlyItemCount:
          compatibility.incompatibleProviderOnlyItemCount,
      }),
    };
  }

  private async loadStoredRows(threadId: string): Promise<StoredMessageRow[]> {
    return db
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
        target_host?: string;
        target_port?: number;
        path?: string;
        title?: string;
        proxied_site_id?: string;
        disable?: boolean;
        schema?: string;
        request_id?: string;
        questions?: unknown;
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
        case "web_view.open":
          if (typeof payload.target_port !== "number") {
            return null;
          }
          return {
            type: "tool_call",
            tool: "web_view.open",
            targetHost: this.parseWebViewTargetHost(payload.target_host),
            targetPort: payload.target_port,
            path: typeof payload.path === "string" ? payload.path : undefined,
            title: typeof payload.title === "string" ? payload.title : undefined,
            callId,
          };
        case "web_view.close":
          return {
            type: "tool_call",
            tool: "web_view.close",
            proxiedSiteId:
              typeof payload.proxied_site_id === "string" ? payload.proxied_site_id : undefined,
            disable: payload.disable === true,
            callId,
          };
        case "web_view.list":
          return {
            type: "tool_call",
            tool: "web_view.list",
            callId,
          };
        case ASK_USER_QUESTIONS_TOOL:
          return {
            type: "tool_call",
            tool: ASK_USER_QUESTIONS_TOOL,
            request:
              payload.schema === "ask_user_questions_request_v1"
                ? parseStoredAskUserQuestionsRequest(payload)
                : normalizeAskUserQuestionsRequest(payload),
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

  private parseWebViewTargetHost(value: unknown): "127.0.0.1" | "localhost" | "::1" | undefined {
    return value === "127.0.0.1" || value === "localhost" || value === "::1"
      ? value
      : undefined;
  }
}

function buildReconstructionDiagnostics(args: {
  targetProvider: CanonicalProviderId | null;
  targetModel?: string | null;
  targetReasoning?: ReasoningConfig | null;
  rows: StoredMessageRow[];
  ledgerMessages: Array<{ content: unknown[] }>;
  ledgerSummary: ProviderLedgerThreadDiagnostics;
  canonicalFallbackMessageCount: number;
  sameProviderIncompatibleCallCount?: number;
  sameProviderIncompatibleOutputItemCount?: number;
  sameProviderIncompatibleProviderOnlyItemCount?: number;
}): LlmReconstructionDiagnostics {
  const sourceProviders = sortedProviders(args.ledgerSummary.providerCallCounts);
  const providerNativeCallCount = args.ledgerMessages.length;
  const providerNativeOutputItemCount = args.ledgerMessages.reduce(
    (count, message) => count + message.content.length,
    0,
  );
  const targetProvider = args.targetProvider;
  const targetProviderCallCount = targetProvider
    ? args.ledgerSummary.providerCallCounts[targetProvider] ?? 0
    : 0;
  const switchedFromProviders = targetProvider
    ? sourceProviders.filter((provider) => provider !== targetProvider)
    : [];
  const omittedProviderOnlyItemCount = switchedFromProviders.reduce(
    (count, provider) =>
      count + (args.ledgerSummary.providerOnlyOutputItemCounts[provider] ?? 0),
    0,
  ) + (args.sameProviderIncompatibleProviderOnlyItemCount ?? 0);
  const hasPriorModelRows = countModelTranscriptRows(args.rows) > 0;
  const degradedReasons: string[] = [];

  if (targetProvider && switchedFromProviders.length > 0) {
    degradedReasons.push("provider_switch_canonical_fallback");
  }
  if ((args.sameProviderIncompatibleCallCount ?? 0) > 0) {
    degradedReasons.push("same_provider_incompatible_reasoning");
  }
  if (targetProvider && targetProviderCallCount === 0 && hasPriorModelRows) {
    degradedReasons.push("missing_provider_ledger");
  }
  if (args.canonicalFallbackMessageCount > 0) {
    degradedReasons.push("canonical_fallback_messages");
  }
  if (omittedProviderOnlyItemCount > 0) {
    degradedReasons.push("provider_only_items_omitted");
  }

  const mode = reconstructionMode({
    targetProvider,
    providerNativeCallCount,
    hasPriorModelRows,
    degradedReasons,
  });

  return {
    mode,
    targetProvider,
    ...(args.targetModel !== undefined ? { targetModel: args.targetModel } : {}),
    ...(args.targetReasoning !== undefined
      ? { targetReasoning: args.targetReasoning }
      : {}),
    degraded: degradedReasons.length > 0,
    degradedReasons,
    sourceProviders,
    providerNativeCallCount,
    providerNativeOutputItemCount,
    canonicalFallbackMessageCount: args.canonicalFallbackMessageCount,
    omittedProviderOnlyItemCount,
    providerCallCounts: args.ledgerSummary.providerCallCounts,
    providerOnlyOutputItemCounts: args.ledgerSummary.providerOnlyOutputItemCounts,
    ...((args.sameProviderIncompatibleCallCount ?? 0) > 0
      ? {
          sameProviderIncompatibleCallCount: args.sameProviderIncompatibleCallCount,
          sameProviderIncompatibleOutputItemCount:
            args.sameProviderIncompatibleOutputItemCount ?? 0,
        }
      : {}),
    ...(args.ledgerSummary.itemlessCompletedCallCounts
      ? { itemlessCompletedCallCounts: args.ledgerSummary.itemlessCompletedCallCounts }
      : {}),
    ...(args.ledgerSummary.outputlessCompletedCallCounts
      ? { outputlessCompletedCallCounts: args.ledgerSummary.outputlessCompletedCallCounts }
      : {}),
  };
}

function reconstructionMode(args: {
  targetProvider: CanonicalProviderId | null;
  providerNativeCallCount: number;
  hasPriorModelRows: boolean;
  degradedReasons: string[];
}): LlmReconstructionDiagnostics["mode"] {
  if (!args.targetProvider || (!args.hasPriorModelRows && args.providerNativeCallCount === 0)) {
    return "canonical_only";
  }
  if (args.providerNativeCallCount > 0) {
    return args.degradedReasons.length > 0 ? "mixed_degraded" : "provider_native";
  }
  return "canonical_fallback";
}

function emptyProviderLedgerThreadDiagnostics(): ProviderLedgerThreadDiagnostics {
  return {
    providerCallCounts: {},
    outputItemCounts: {},
    providerOnlyOutputItemCounts: {},
  };
}

function sortedProviders(
  counts: Partial<Record<CanonicalProviderId, number>>,
): CanonicalProviderId[] {
  return (["openai", "anthropic"] as const).filter((provider) => (counts[provider] ?? 0) > 0);
}

function countModelTranscriptRows(rows: StoredMessageRow[]): number {
  return rows.filter(isModelTranscriptRow).length;
}

function isModelTranscriptRow(row: StoredMessageRow): boolean {
  return row.role === "assistant" || row.role === "tool";
}

function splitCompatibleLedgerMessages(
  ledgerMessages: ProviderLedgerMessage[],
  options: ConversationLoadOptions,
): {
  compatibleMessages: ProviderLedgerMessage[];
  incompatibleMessages: ProviderLedgerMessage[];
  incompatibleOutputItemCount: number;
  incompatibleProviderOnlyItemCount: number;
} {
  const compatibleMessages: ProviderLedgerMessage[] = [];
  const incompatibleMessages: ProviderLedgerMessage[] = [];
  let incompatibleOutputItemCount = 0;
  let incompatibleProviderOnlyItemCount = 0;

  for (const message of ledgerMessages) {
    if (isProviderLedgerMessageCompatible(message, options)) {
      compatibleMessages.push(message);
      continue;
    }

    incompatibleMessages.push(message);
    incompatibleOutputItemCount += message.content.length;
    incompatibleProviderOnlyItemCount += message.content.filter(isProviderOnlyBlock).length;
  }

  return {
    compatibleMessages,
    incompatibleMessages,
    incompatibleOutputItemCount,
    incompatibleProviderOnlyItemCount,
  };
}

function isProviderLedgerMessageCompatible(
  message: ProviderLedgerMessage,
  options: ConversationLoadOptions,
): boolean {
  if (options.provider !== "anthropic") {
    return true;
  }

  if (!message.content.some(isAnthropicReasoningBlock)) {
    return true;
  }

  if (message.requestMode !== expectedRequestModeForProvider(options.provider)) {
    return false;
  }

  if (!options.targetModel || message.model !== options.targetModel) {
    return false;
  }

  if (!options.targetReasoning?.enabled) {
    return false;
  }

  const catalogEntry = getCatalogEntry(options.targetModel);
  if (catalogEntry?.provider === "anthropic" && catalogEntry.reasoning.kind === "none") {
    return false;
  }

  return true;
}

function expectedRequestModeForProvider(provider: CanonicalProviderId): LlmCallRequestMode {
  return provider === "openai" ? "openai_responses" : "anthropic_messages";
}

function isAnthropicReasoningBlock(block: CanonicalContentBlock): boolean {
  return (
    (block.type === "reasoning" || block.type === "reasoning_redacted") &&
    block.providerData?.provider === "anthropic"
  );
}

function isProviderOnlyBlock(block: CanonicalContentBlock): boolean {
  return (
    block.type === "reasoning" ||
    block.type === "reasoning_redacted" ||
    block.type === "image"
  );
}
