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
  parseWaitForArg,
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
import { AGENT_SYSTEM_PROMPT } from "./system-prompt.js";

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

type ConversationCheckpointRepository = {
  getLatestCompletedCheckpoint(threadId: string): Promise<AgentContextCheckpoint | null>;
};

export type LoadedConversation = {
  messages: CanonicalMessage[];
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
    const messages: CanonicalMessage[] = [
      createCanonicalTextMessage("system", AGENT_SYSTEM_PROMPT),
    ];

    const checkpoint = await this.checkpointRepository.getLatestCompletedCheckpoint(threadId);
    const replacementHistory = checkpoint
      ? checkpoint.replacementHistory.filter((message) => message.role !== "system")
      : [];
    messages.push(...replacementHistory);

    const rows = await this.loadStoredRows(threadId, checkpoint);

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
    messages: CanonicalMessage[],
    row: {
      role: string;
      content: string;
      metadata: unknown;
    },
    options: { toolUseFromProviderLedger: boolean },
  ): void {
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
        case "terminal.send": {
          let command = typeof payload.command === "string" ? payload.command : undefined;
          let rawText = typeof payload.raw_text === "string" ? payload.raw_text : undefined;

          if (command === undefined && rawText === undefined && typeof payload.text === "string") {
            if (payload.submit === true) {
              command = payload.text;
            } else {
              rawText = payload.text;
            }
          }

          return {
            type: "tool_call",
            tool: "terminal.send",
            command,
            rawText,
            key: normalizeToolKeyInput(payload.key, payload.keys),
            observeAfterMs:
              typeof payload.observe_after_ms === "number"
                ? payload.observe_after_ms
                : undefined,
            waitFor: parseWaitForArg(payload.wait_for),
            callId,
          };
        }
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
