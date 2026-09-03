import { ulid } from "ulid";
import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
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
  type AssistantMessagePhase,
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
  toolNameForConversation,
  type AgentToolCallDirective,
} from "./contracts.js";
import {
  ASK_USER_QUESTIONS_TOOL,
  normalizeAskUserQuestionsRequest,
  parseStoredAskUserQuestionsRequest,
} from "./user-question-contracts.js";
import {
  getLatestCompletedContextCheckpoint,
  type AgentContextCheckpoint,
} from "./context-checkpoint-repository.js";
import { CHECKPOINT_SUMMARY_PREFIX } from "./context-budget.js";
import { resolveSystemPrompt, type SystemPromptScope } from "./system-prompt.js";

type StoredMessageRow = {
  messageId: string;
  clientId: string;
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

type ConversationCheckpointRepository = {
  getLatestCompletedCheckpoint(threadId: string): Promise<AgentContextCheckpoint | null>;
};

/**
 * Where each model-visible message came from. Parallel to
 * `LoadedConversation.messages`; the messages themselves are unchanged by
 * this side-channel (design/full-transcript-mode.md, "model view").
 */
export type MessageSource =
  | { kind: "system_prompt"; scope: SystemPromptScope; version: string }
  | { kind: "runtime_instruction" }
  | { kind: "checkpoint_summary"; checkpoint_id: string }
  | { kind: "checkpoint_history"; checkpoint_id: string }
  | { kind: "message"; message_id: string; client_id: string; role: string }
  | { kind: "ledger"; llm_call_id: string }
  | { kind: "repair" };

export type LoadedConversation = {
  messages: CanonicalMessage[];
  sources: MessageSource[];
  reconstruction: LlmReconstructionDiagnostics;
};

export function createCanonicalTextMessage(
  role: "system" | "user" | "assistant",
  text: string,
  assistantPhase?: AssistantMessagePhase,
): CanonicalMessage {
  return {
    role,
    content: [
      {
        type: "text",
        text,
        ...(role === "assistant" && assistantPhase ? { assistantPhase } : {}),
      },
    ],
  };
}

export class AgentConversationLoader {
  constructor(
    private readonly checkpointRepository: ConversationCheckpointRepository = {
      getLatestCompletedCheckpoint: getLatestCompletedContextCheckpoint,
    },
  ) {}

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
    const messages: CanonicalMessage[] = [];
    const sources: MessageSource[] = [];
    const emit = (message: CanonicalMessage, source: MessageSource) => {
      messages.push(message);
      sources.push(source);
    };

    const systemPrompt = await resolveSystemPrompt({ threadId });
    emit(createCanonicalTextMessage("system", systemPrompt.text), {
      kind: "system_prompt",
      scope: systemPrompt.scope,
      version: systemPrompt.version,
    });

    const checkpoint = await this.checkpointRepository.getLatestCompletedCheckpoint(threadId);
    const replacementHistory = checkpoint
      ? checkpoint.replacementHistory.filter((message) => message.role !== "system")
      : [];
    for (const message of replacementHistory) {
      emit(message, {
        kind: isCheckpointSummaryMessage(message) ? "checkpoint_summary" : "checkpoint_history",
        checkpoint_id: checkpoint!.checkpointId,
      });
    }

    const rows = await this.loadStoredRows(threadId, checkpoint);

    if (!options?.provider) {
      for (const row of rows) {
        this.appendStoredMessage(emit, row, { toolUseFromProviderLedger: false });
      }
      return {
        messages,
        sources,
        reconstruction: buildReconstructionDiagnostics({
          targetProvider: null,
          rows,
          ledgerMessages: [],
          ledgerSummary: emptyProviderLedgerThreadDiagnostics(),
          canonicalFallbackMessageCount: countModelTranscriptRows(rows),
          checkpoint,
          replacementHistoryMessageCount: replacementHistory.length,
        }),
      };
    }

    const ledgerBoundary = checkpoint
      ? {
          createdAt: checkpoint.compactedThroughLlmCallCreatedAt,
          llmCallId: checkpoint.compactedThroughLlmCallId,
        }
      : null;
    const ledgerSummary = includeDiagnostics
      ? await loadProviderLedgerThreadDiagnostics(threadId, { after: ledgerBoundary })
      : emptyProviderLedgerThreadDiagnostics();
    const loadedLedgerMessages = await loadProviderLedgerMessages(threadId, options.provider, {
      after: ledgerBoundary,
    });
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
        emit(createCanonicalAssistantMessageFromLedger(item.ledger.content), {
          kind: "ledger",
          llm_call_id: item.ledger.llmCallId,
        });
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

      this.appendStoredMessage(emit, item.row, {
        toolUseFromProviderLedger,
      });
    }

    const repaired = repairOrphanedToolCalls(messages, sources);
    if (repaired.injectedResults > 0) {
      console.warn(
        "[conversation_loader] repaired orphaned tool calls in replay (crashed turn left function calls without outputs)",
        { threadId, injectedResults: repaired.injectedResults }
      );
    }

    return {
      messages: repaired.messages,
      sources: repaired.sources ?? sources,
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
        checkpoint,
        replacementHistoryMessageCount: replacementHistory.length,
      }),
    };
  }

  private async loadStoredRows(
    threadId: string,
    checkpoint: AgentContextCheckpoint | null,
  ): Promise<StoredMessageRow[]> {
    const conditions: SQL<unknown>[] = [eq(messageTable.threadId, threadId)];
    const afterBoundary = messageAfterCheckpointBoundary(checkpoint);
    if (afterBoundary) {
      conditions.push(afterBoundary);
    }

    return db
      .select({
        messageId: messageTable.messageId,
        clientId: messageTable.clientId,
        role: messageTable.role,
        content: messageTable.content,
        metadata: messageTable.metadata,
        createdAt: messageTable.createdAt,
      })
      .from(messageTable)
      .where(and(...conditions))
      .orderBy(asc(messageTable.createdAt), asc(messageTable.messageId));
  }

  private appendStoredMessage(
    emit: (message: CanonicalMessage, source: MessageSource) => void,
    row: {
      messageId: string;
      clientId: string;
      role: string;
      content: string;
      metadata: unknown;
    },
    options: { toolUseFromProviderLedger: boolean },
  ): void {
    const source: MessageSource = {
      kind: "message",
      message_id: row.messageId,
      client_id: row.clientId,
      role: row.role,
    };
    const messages = {
      push(message: CanonicalMessage) {
        emit(message, source);
      },
    };
    if (row.role === "reasoning") {
      return;
    }

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
      messages.push(createCanonicalTextMessage(
        "assistant",
        row.content,
        assistantPhaseFromMetadata(row.metadata),
      ));
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
        command?: string;
        raw_text?: string;
        text?: string;
        submit?: boolean;
        key?: string;
        keys?: string[];
        lines?: number;
        view?: string;
        until?: string;
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
        case "terminal.run":
          // Retired tool: historical rows replay as the unified send.
          if (typeof payload.command !== "string") {
            return null;
          }
          // Enter is the default: no explicit `submit` in the replayed args.
          return {
            type: "tool_call",
            tool: "terminal.send",
            text: payload.command,
            callId,
          };
        case "terminal.send": {
          // Historical rows carry `raw_text` (pre-unification) or `command`
          // (0.2); all replay as the unified `text`.
          const text =
            typeof payload.text === "string"
              ? payload.text
              : typeof payload.raw_text === "string"
                ? payload.raw_text
                : typeof payload.command === "string"
                  ? payload.command
                  : undefined;
          return {
            type: "tool_call",
            tool: "terminal.send",
            text,
            // Enter is the default; only an explicit compose (`submit:false`)
            // is worth replaying.
            ...(payload.submit === false ? { submit: false } : {}),
            key: normalizeToolKeyInput(payload.key, payload.keys),
            callId,
          };
        }
        case "terminal.observe":
          return {
            type: "tool_call",
            tool: "terminal.observe",
            lines: typeof payload.lines === "number" ? payload.lines : undefined,
            view: this.parseObservationView(payload.view),
            callId,
          };
        case "terminal.wait":
          // Historical rows may carry the retired `until` arg; ignored.
          return {
            type: "tool_call",
            tool: "terminal.wait",
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
  checkpoint?: AgentContextCheckpoint | null;
  replacementHistoryMessageCount?: number;
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
    ...(args.checkpoint
      ? {
          checkpointApplied: true,
          checkpointId: args.checkpoint.checkpointId,
          checkpointCreatedAt: args.checkpoint.createdAt.toISOString(),
          checkpointReplacementHistoryMessageCount:
            args.replacementHistoryMessageCount ?? 0,
          compactedThroughMessageId: args.checkpoint.compactedThroughMessageId,
          compactedThroughLlmCallId: args.checkpoint.compactedThroughLlmCallId,
        }
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

function messageAfterCheckpointBoundary(
  checkpoint: AgentContextCheckpoint | null,
): SQL<unknown> | undefined {
  if (
    !checkpoint?.compactedThroughMessageCreatedAt ||
    !checkpoint.compactedThroughMessageId
  ) {
    return undefined;
  }

  return or(
    gt(messageTable.createdAt, checkpoint.compactedThroughMessageCreatedAt),
    and(
      eq(messageTable.createdAt, checkpoint.compactedThroughMessageCreatedAt),
      gt(messageTable.messageId, checkpoint.compactedThroughMessageId),
    ),
  );
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
  return (["openai", "anthropic", "ds4"] as const).filter(
    (provider) => (counts[provider] ?? 0) > 0,
  );
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
  if (provider === "openai") {
    return "openai_responses";
  }
  if (provider === "anthropic") {
    return "anthropic_messages";
  }
  if (provider === "bud_local") {
    return "openai_chat_completions";
  }
  return "ds4_openai_responses";
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

function assistantPhaseFromMetadata(metadata: unknown): AssistantMessagePhase | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  const explicit = parseAssistantMessagePhase(record.assistant_phase);
  if (explicit) {
    return explicit;
  }
  if (record.segment_kind === "intermediate") {
    return "commentary";
  }
  if (record.segment_kind === "final") {
    return "final_answer";
  }
  return undefined;
}

function parseAssistantMessagePhase(value: unknown): AssistantMessagePhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

/**
 * A turn that crashes between recording the model's tool calls (provider
 * ledger) and recording the tool results leaves orphaned calls in the
 * transcript. Providers reject such replays outright (OpenAI Responses:
 * "No tool output found for function call ..."), permanently poisoning the
 * thread. Inject an explicit interrupted-result for every orphaned call so
 * replay stays valid and the model sees what actually happened.
 * Pure and provider-agnostic (canonical layer).
 */
export function repairOrphanedToolCalls(
  messages: CanonicalMessage[],
  sources?: MessageSource[],
): {
  messages: CanonicalMessage[];
  sources?: MessageSource[];
  injectedResults: number;
} {
  const blocksOf = (message: CanonicalMessage) =>
    Array.isArray(message.content) ? message.content : [];

  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of blocksOf(message)) {
      if (block.type === "tool_result") {
        resultIds.add(block.tool_use_id);
      }
    }
  }

  const out: CanonicalMessage[] = [];
  const outSources: MessageSource[] | undefined = sources ? [] : undefined;
  let injectedResults = 0;
  messages.forEach((message, index) => {
    out.push(message);
    outSources?.push(sources![index]!);
    if (message.role !== "assistant") return;
    const orphaned = blocksOf(message).filter(
      (block) => block.type === "tool_use" && !resultIds.has(block.id)
    );
    if (orphaned.length === 0) return;
    injectedResults += orphaned.length;
    outSources?.push({ kind: "repair" });
    out.push({
      role: "user",
      content: orphaned.map((block) => ({
        type: "tool_result" as const,
        tool_use_id: block.type === "tool_use" ? block.id : "",
        content: JSON.stringify({
          error: "interrupted",
          summary:
            "Tool execution was interrupted before any result was recorded (the turn failed). Treat this call as failed and re-issue it if it is still needed.",
        }),
      })),
    });
  });

  return { messages: out, ...(outSources ? { sources: outSources } : {}), injectedResults };
}

function isCheckpointSummaryMessage(message: CanonicalMessage): boolean {
  const text = typeof message.content === "string"
    ? message.content
    : message.content.find((block) => block.type === "text")?.text ?? "";
  return text.trimStart().startsWith(CHECKPOINT_SUMMARY_PREFIX);
}
