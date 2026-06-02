import { ulid } from "ulid";
import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { llmCallItemTable, llmCallTable } from "../db/schema.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalProviderId,
  CanonicalReasoningBlock,
  AssistantMessagePhase,
  ReasoningConfig,
  TokenUsage,
} from "./types.js";

const CANONICAL_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "ds4",
] as const satisfies readonly CanonicalProviderId[];

export type LlmCallRequestMode =
  | "openai_responses"
  | "anthropic_messages"
  | "ds4_openai_chat";

export type LlmCallVisibility = "provider_only" | "product_text" | "tool";

export type LlmReconstructionMode =
  | "canonical_only"
  | "provider_native"
  | "canonical_fallback"
  | "mixed_degraded";

export type LlmReconstructionDiagnostics = {
  mode: LlmReconstructionMode;
  targetProvider: CanonicalProviderId | null;
  targetModel?: string | null;
  targetReasoning?: ReasoningConfig | null;
  checkpointApplied?: boolean;
  checkpointId?: string;
  checkpointCreatedAt?: string;
  checkpointReplacementHistoryMessageCount?: number;
  compactedThroughMessageId?: string | null;
  compactedThroughLlmCallId?: string | null;
  degraded: boolean;
  degradedReasons: string[];
  sourceProviders: CanonicalProviderId[];
  providerNativeCallCount: number;
  providerNativeOutputItemCount: number;
  canonicalFallbackMessageCount: number;
  omittedProviderOnlyItemCount: number;
  providerCallCounts: Partial<Record<CanonicalProviderId, number>>;
  providerOnlyOutputItemCounts: Partial<Record<CanonicalProviderId, number>>;
  sameProviderIncompatibleCallCount?: number;
  sameProviderIncompatibleOutputItemCount?: number;
  itemlessCompletedCallCounts?: Partial<Record<CanonicalProviderId, number>>;
  outputlessCompletedCallCounts?: Partial<Record<CanonicalProviderId, number>>;
};

export type RecordLlmCallArgs = {
  llmCallId?: string;
  threadId: string;
  turnId: string;
  stepIndex: number;
  provider: CanonicalProviderId;
  model: string;
  requestMode: LlmCallRequestMode;
  providerResponseId?: string | null;
  output: CanonicalContentBlock[];
  usage?: TokenUsage;
  ownerUserId?: string | null;
  assistantMessageId?: string | null;
  promptCacheKey?: string | null;
  reconstruction?: LlmReconstructionDiagnostics | null;
};

export type RecordLlmToolResultItemArgs = {
  llmCallId: string;
  threadId: string;
  sequence: number;
  toolCallId: string;
  content: string;
  payload: Record<string, unknown>;
  messageId?: string | null;
  ownerUserId?: string | null;
};

type LlmCallItemRow = typeof llmCallItemTable.$inferSelect;

export type ProviderLedgerThreadDiagnostics = {
  providerCallCounts: Partial<Record<CanonicalProviderId, number>>;
  outputItemCounts: Partial<Record<CanonicalProviderId, number>>;
  providerOnlyOutputItemCounts: Partial<Record<CanonicalProviderId, number>>;
  itemlessCompletedCallCounts?: Partial<Record<CanonicalProviderId, number>>;
  outputlessCompletedCallCounts?: Partial<Record<CanonicalProviderId, number>>;
};

export type ProviderLedgerMessage = {
  createdAt: Date;
  llmCallId: string;
  model: string;
  requestMode: LlmCallRequestMode;
  content: CanonicalContentBlock[];
};

export type ProviderLedgerBoundary = {
  createdAt: Date | null;
  llmCallId: string | null;
};

export async function recordLlmCall(args: RecordLlmCallArgs): Promise<{ llmCallId: string }> {
  const llmCallId = args.llmCallId ?? ulid();
  const cacheMetadata = cacheMetadataFromUsage(args.usage, args.reconstruction);

  const items = args.output.map((block, index) =>
    buildOutputItemValue({
      llmCallId,
      threadId: args.threadId,
      sequence: index,
      block,
      messageId:
        block.type === "text" && args.assistantMessageId ? args.assistantMessageId : null,
      ownerUserId: args.ownerUserId,
    }),
  );

  await db.transaction(async (tx) => {
    await tx.insert(llmCallTable).values({
      llmCallId,
      threadId: args.threadId,
      turnId: args.turnId,
      stepIndex: args.stepIndex,
      provider: args.provider,
      model: args.model,
      requestMode: args.requestMode,
      providerResponseId: args.providerResponseId ?? undefined,
      status: "completed",
      usage: args.usage ? jsonRecord(args.usage) : undefined,
      cacheMetadata: cacheMetadata ? jsonRecord(cacheMetadata) : undefined,
      promptCacheKey: args.promptCacheKey ?? undefined,
      completedAt: new Date(),
      createdByUserId: args.ownerUserId ?? undefined,
    });

    if (items.length > 0) {
      await tx.insert(llmCallItemTable).values(items);
    }
  });

  return { llmCallId };
}

export async function recordLlmToolResultItem(
  args: RecordLlmToolResultItemArgs,
): Promise<void> {
  await db.insert(llmCallItemTable).values({
    llmCallItemId: ulid(),
    llmCallId: args.llmCallId,
    threadId: args.threadId,
    direction: "input",
    role: "user",
    kind: "tool_result",
    sequence: args.sequence,
    toolCallId: args.toolCallId,
    text: args.content,
    canonicalPayload: jsonRecord({
      type: "tool_result",
      tool_use_id: args.toolCallId,
      content: args.content,
    }),
    providerPayload: jsonRecord(args.payload),
    visibility: "tool",
    messageId: args.messageId ?? undefined,
    createdByUserId: args.ownerUserId ?? undefined,
  });
}

export async function loadProviderLedgerMessages(
  threadId: string,
  provider: CanonicalProviderId,
  options?: { after?: ProviderLedgerBoundary | null },
): Promise<ProviderLedgerMessage[]> {
  const afterBoundary = llmCallAfterBoundary(options?.after ?? null);
  const conditions: SQL<unknown>[] = [
    eq(llmCallTable.threadId, threadId),
    eq(llmCallTable.provider, provider),
  ];
  if (afterBoundary) {
    conditions.push(afterBoundary);
  }

  const rows = await db
    .select({
      llmCallId: llmCallTable.llmCallId,
      createdAt: llmCallTable.createdAt,
      model: llmCallTable.model,
      requestMode: llmCallTable.requestMode,
      itemKind: llmCallItemTable.kind,
      itemDirection: llmCallItemTable.direction,
      itemSequence: llmCallItemTable.sequence,
      canonicalPayload: llmCallItemTable.canonicalPayload,
      providerPayload: llmCallItemTable.providerPayload,
    })
    .from(llmCallTable)
    .innerJoin(llmCallItemTable, eq(llmCallItemTable.llmCallId, llmCallTable.llmCallId))
    .where(and(...conditions))
    .orderBy(
      asc(llmCallTable.createdAt),
      asc(llmCallTable.llmCallId),
      asc(llmCallItemTable.sequence),
    );

  const grouped = new Map<
    string,
    {
      createdAt: Date;
      model: string;
      requestMode: LlmCallRequestMode;
      content: CanonicalContentBlock[];
    }
  >();
  for (const row of rows) {
    if (!row.llmCallId) {
      continue;
    }
    const group = grouped.get(row.llmCallId) ?? {
      createdAt: row.createdAt,
      model: row.model,
      requestMode: parseRequestMode(row.requestMode),
      content: [],
    };
    grouped.set(row.llmCallId, group);

    if (row.itemDirection !== "output" || !row.itemKind || !row.canonicalPayload) {
      continue;
    }

    const block = blockFromPayload(row.itemKind, row.canonicalPayload, row.providerPayload);
    if (block) {
      group.content.push(block);
    }
  }

  return Array.from(grouped.entries())
    .filter(([, value]) => value.content.length > 0)
    .map(([llmCallId, value]) => ({
      llmCallId,
      createdAt: value.createdAt,
      model: value.model,
      requestMode: value.requestMode,
      content: provider === "openai"
        ? deriveOpenAIAssistantPhases(value.content)
        : value.content,
    }));
}

export async function loadProviderLedgerThreadDiagnostics(
  threadId: string,
  options?: { after?: ProviderLedgerBoundary | null },
): Promise<ProviderLedgerThreadDiagnostics> {
  const afterBoundary = llmCallAfterBoundary(options?.after ?? null);
  const conditions: SQL<unknown>[] = [eq(llmCallTable.threadId, threadId)];
  if (afterBoundary) {
    conditions.push(afterBoundary);
  }

  const rows = await db
    .select({
      provider: llmCallTable.provider,
      llmCallId: llmCallTable.llmCallId,
      status: llmCallTable.status,
      itemDirection: llmCallItemTable.direction,
      itemVisibility: llmCallItemTable.visibility,
    })
    .from(llmCallTable)
    .leftJoin(llmCallItemTable, eq(llmCallItemTable.llmCallId, llmCallTable.llmCallId))
    .where(and(...conditions));

  const callSummariesByProvider: Partial<
    Record<
      CanonicalProviderId,
      Map<
        string,
        {
          status: string;
          totalItemCount: number;
          outputItemCount: number;
          providerOnlyOutputItemCount: number;
        }
      >
    >
  > = {};
  const outputItemCounts: Partial<Record<CanonicalProviderId, number>> = {};
  const providerOnlyOutputItemCounts: Partial<Record<CanonicalProviderId, number>> = {};

  for (const row of rows) {
    if (!isCanonicalProviderId(row.provider)) {
      continue;
    }

    callSummariesByProvider[row.provider] ??= new Map();
    const providerSummaries = callSummariesByProvider[row.provider];
    if (!providerSummaries) {
      continue;
    }
    const callSummary = providerSummaries.get(row.llmCallId) ?? {
      status: row.status,
      totalItemCount: 0,
      outputItemCount: 0,
      providerOnlyOutputItemCount: 0,
    };
    providerSummaries.set(row.llmCallId, callSummary);

    if (!row.itemDirection) {
      continue;
    }

    callSummary.totalItemCount += 1;

    if (row.itemDirection === "output") {
      callSummary.outputItemCount += 1;
      outputItemCounts[row.provider] = (outputItemCounts[row.provider] ?? 0) + 1;
      if (row.itemVisibility === "provider_only") {
        callSummary.providerOnlyOutputItemCount += 1;
        providerOnlyOutputItemCounts[row.provider] =
          (providerOnlyOutputItemCounts[row.provider] ?? 0) + 1;
      }
    }
  }

  return {
    providerCallCounts: countMaps(callSummariesByProvider),
    outputItemCounts,
    providerOnlyOutputItemCounts,
    ...completedCallIntegrityCounts(callSummariesByProvider),
  };
}

export function canonicalBlockFromLedgerItem(row: Pick<
  LlmCallItemRow,
  "kind" | "canonicalPayload" | "providerPayload"
>): CanonicalContentBlock | null {
  return blockFromPayload(row.kind, row.canonicalPayload, row.providerPayload);
}

function buildOutputItemValue(args: {
  llmCallId: string;
  threadId: string;
  sequence: number;
  block: CanonicalContentBlock;
  messageId?: string | null;
  ownerUserId?: string | null;
}): typeof llmCallItemTable.$inferInsert {
  const { block } = args;
  const providerData =
    (block.type === "reasoning" || block.type === "reasoning_redacted")
      ? block.providerData
      : undefined;
  const providerPayload = providerData?.payload;

  return {
    llmCallItemId: ulid(),
    llmCallId: args.llmCallId,
    threadId: args.threadId,
    direction: "output",
    role: "assistant",
    kind: kindForBlock(block),
    sequence: args.sequence,
    providerItemId: providerItemIdForBlock(block),
    toolCallId: block.type === "tool_use" ? block.id : undefined,
    text: textForBlock(block),
    canonicalPayload: jsonRecord(block),
    providerPayload: providerPayload ? jsonRecord(providerPayload) : {},
    visibility: visibilityForBlock(block),
    messageId: args.messageId ?? undefined,
    createdByUserId: args.ownerUserId ?? undefined,
  };
}

function kindForBlock(block: CanonicalContentBlock): string {
  switch (block.type) {
    case "text":
      return "text";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "reasoning":
      return "reasoning";
    case "reasoning_redacted":
      return "reasoning_redacted";
    case "image":
      return "image";
  }
}

function visibilityForBlock(block: CanonicalContentBlock): LlmCallVisibility {
  switch (block.type) {
    case "text":
      return "product_text";
    case "tool_use":
    case "tool_result":
      return "tool";
    case "image":
    case "reasoning":
    case "reasoning_redacted":
      return "provider_only";
  }
}

function textForBlock(block: CanonicalContentBlock): string | undefined {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return block.text;
    default:
      return undefined;
  }
}

function providerItemIdForBlock(block: CanonicalContentBlock): string | undefined {
  if (block.type === "tool_use") {
    return block.id;
  }
  if (block.type === "reasoning") {
    const payload = block.providerData?.payload as Record<string, unknown> | undefined;
    return typeof payload?.id === "string" ? payload.id : undefined;
  }
  return undefined;
}

function blockFromPayload(
  kind: string,
  canonicalPayload: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
): CanonicalContentBlock | null {
  switch (kind) {
    case "text":
      if (typeof canonicalPayload.text === "string") {
        const assistantPhase = parseAssistantMessagePhase(canonicalPayload.assistantPhase);
        return {
          type: "text",
          text: canonicalPayload.text,
          ...(assistantPhase ? { assistantPhase } : {}),
        };
      }
      return null;
    case "tool_use":
      if (
        typeof canonicalPayload.id === "string" &&
        typeof canonicalPayload.name === "string" &&
        isRecord(canonicalPayload.input)
      ) {
        return {
          type: "tool_use",
          id: canonicalPayload.id,
          name: canonicalPayload.name,
          input: canonicalPayload.input,
        };
      }
      return null;
    case "reasoning":
      return reasoningBlockFromPayload(canonicalPayload, providerPayload);
    case "reasoning_redacted":
      return {
        type: "reasoning_redacted",
        providerData: {
          provider: "anthropic",
          payload: Object.keys(providerPayload).length > 0 ? providerPayload : canonicalPayload,
        },
      };
    default:
      return null;
  }
}

function reasoningBlockFromPayload(
  canonicalPayload: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
): CanonicalReasoningBlock | null {
  if (typeof canonicalPayload.text !== "string") {
    return null;
  }

  const providerData = canonicalPayload.providerData;
  if (isRecord(providerData)) {
    const provider = providerData.provider;
    if (provider === "openai" || provider === "anthropic" || provider === "ds4") {
      return {
        type: "reasoning",
        text: canonicalPayload.text,
        providerData: {
          provider,
          payload: Object.keys(providerPayload).length > 0
            ? providerPayload
            : providerData.payload,
        },
      };
    }
  }

  return {
    type: "reasoning",
    text: canonicalPayload.text,
  };
}

function cacheMetadataFromUsage(
  usage?: TokenUsage,
  reconstruction?: LlmReconstructionDiagnostics | null,
): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  if (typeof usage?.cached_input_tokens === "number") {
    metadata.openai_cached_input_tokens = usage.cached_input_tokens;
  }
  if (typeof usage?.cache_creation_input_tokens === "number") {
    metadata.anthropic_cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage?.cache_read_input_tokens === "number") {
    metadata.anthropic_cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (reconstruction) {
    metadata.reconstruction_mode = reconstruction.mode;
    metadata.reconstruction_degraded = reconstruction.degraded;
    metadata.reconstruction_target_provider = reconstruction.targetProvider;
    if (reconstruction.targetModel !== undefined) {
      metadata.reconstruction_target_model = reconstruction.targetModel;
    }
    if (reconstruction.targetReasoning !== undefined) {
      metadata.reconstruction_target_reasoning = reconstruction.targetReasoning;
    }
    metadata.reconstruction_source_providers = reconstruction.sourceProviders;
    if (reconstruction.checkpointApplied !== undefined) {
      metadata.reconstruction_checkpoint_applied = reconstruction.checkpointApplied;
    }
    if (reconstruction.checkpointId) {
      metadata.reconstruction_checkpoint_id = reconstruction.checkpointId;
    }
    if (reconstruction.checkpointCreatedAt) {
      metadata.reconstruction_checkpoint_created_at = reconstruction.checkpointCreatedAt;
    }
    if (typeof reconstruction.checkpointReplacementHistoryMessageCount === "number") {
      metadata.reconstruction_checkpoint_replacement_history_message_count =
        reconstruction.checkpointReplacementHistoryMessageCount;
    }
    if (reconstruction.compactedThroughMessageId !== undefined) {
      metadata.reconstruction_compacted_through_message_id =
        reconstruction.compactedThroughMessageId;
    }
    if (reconstruction.compactedThroughLlmCallId !== undefined) {
      metadata.reconstruction_compacted_through_llm_call_id =
        reconstruction.compactedThroughLlmCallId;
    }
    metadata.reconstruction_provider_native_call_count =
      reconstruction.providerNativeCallCount;
    metadata.reconstruction_provider_native_output_item_count =
      reconstruction.providerNativeOutputItemCount;
    metadata.reconstruction_canonical_fallback_message_count =
      reconstruction.canonicalFallbackMessageCount;
    metadata.reconstruction_omitted_provider_only_item_count =
      reconstruction.omittedProviderOnlyItemCount;
    metadata.reconstruction_degraded_reasons = reconstruction.degradedReasons;
    metadata.reconstruction_provider_call_counts = reconstruction.providerCallCounts;
    metadata.reconstruction_provider_only_output_item_counts =
      reconstruction.providerOnlyOutputItemCounts;
    if (typeof reconstruction.sameProviderIncompatibleCallCount === "number") {
      metadata.reconstruction_same_provider_incompatible_call_count =
        reconstruction.sameProviderIncompatibleCallCount;
    }
    if (typeof reconstruction.sameProviderIncompatibleOutputItemCount === "number") {
      metadata.reconstruction_same_provider_incompatible_output_item_count =
        reconstruction.sameProviderIncompatibleOutputItemCount;
    }
    if (reconstruction.itemlessCompletedCallCounts) {
      metadata.reconstruction_itemless_completed_call_counts =
        reconstruction.itemlessCompletedCallCounts;
    }
    if (reconstruction.outputlessCompletedCallCounts) {
      metadata.reconstruction_outputless_completed_call_counts =
        reconstruction.outputlessCompletedCallCounts;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(value ?? {})) as unknown;
  return isRecord(normalized) ? normalized : { value: normalized };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssistantMessagePhase(value: unknown): AssistantMessagePhase | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function deriveOpenAIAssistantPhases(
  content: CanonicalContentBlock[],
): CanonicalContentBlock[] {
  const fallbackPhase: AssistantMessagePhase = content.some((block) => block.type === "tool_use")
    ? "commentary"
    : "final_answer";

  return content.map((block) => {
    if (block.type !== "text" || block.assistantPhase) {
      return block;
    }
    return {
      ...block,
      assistantPhase: fallbackPhase,
    };
  });
}

function isCanonicalProviderId(value: string): value is CanonicalProviderId {
  return value === "openai" || value === "anthropic" || value === "ds4";
}

function parseRequestMode(value: string): LlmCallRequestMode {
  return value === "openai_responses" ||
    value === "anthropic_messages" ||
    value === "ds4_openai_chat"
    ? value
    : "openai_responses";
}

function llmCallAfterBoundary(boundary: ProviderLedgerBoundary | null): SQL<unknown> | undefined {
  if (!boundary?.createdAt || !boundary.llmCallId) {
    return undefined;
  }

  return or(
    gt(llmCallTable.createdAt, boundary.createdAt),
    and(
      eq(llmCallTable.createdAt, boundary.createdAt),
      gt(llmCallTable.llmCallId, boundary.llmCallId),
    ),
  );
}

function countMaps(
  maps: Partial<Record<CanonicalProviderId, Map<string, unknown>>>,
): Partial<Record<CanonicalProviderId, number>> {
  const counts: Partial<Record<CanonicalProviderId, number>> = {};
  for (const provider of CANONICAL_PROVIDER_IDS) {
    const count = maps[provider]?.size ?? 0;
    if (count > 0) {
      counts[provider] = count;
    }
  }
  return counts;
}

function completedCallIntegrityCounts(
  summariesByProvider: Partial<
    Record<
      CanonicalProviderId,
      Map<
        string,
        {
          status: string;
          totalItemCount: number;
          outputItemCount: number;
        }
      >
    >
  >,
): Pick<
  ProviderLedgerThreadDiagnostics,
  "itemlessCompletedCallCounts" | "outputlessCompletedCallCounts"
> {
  const itemlessCompletedCallCounts: Partial<Record<CanonicalProviderId, number>> = {};
  const outputlessCompletedCallCounts: Partial<Record<CanonicalProviderId, number>> = {};

  for (const provider of CANONICAL_PROVIDER_IDS) {
    for (const summary of summariesByProvider[provider]?.values() ?? []) {
      if (summary.status !== "completed") {
        continue;
      }
      if (summary.totalItemCount === 0) {
        itemlessCompletedCallCounts[provider] =
          (itemlessCompletedCallCounts[provider] ?? 0) + 1;
      } else if (summary.outputItemCount === 0) {
        outputlessCompletedCallCounts[provider] =
          (outputlessCompletedCallCounts[provider] ?? 0) + 1;
      }
    }
  }

  return {
    ...(Object.keys(itemlessCompletedCallCounts).length > 0
      ? { itemlessCompletedCallCounts }
      : {}),
    ...(Object.keys(outputlessCompletedCallCounts).length > 0
      ? { outputlessCompletedCallCounts }
      : {}),
  };
}

export function buildRequestMode(provider: CanonicalProviderId): LlmCallRequestMode {
  if (provider === "openai") {
    return "openai_responses";
  }
  if (provider === "anthropic") {
    return "anthropic_messages";
  }
  return "ds4_openai_chat";
}

export function createLlmCallId(): string {
  return ulid();
}

export function createCanonicalAssistantMessageFromLedger(
  content: CanonicalContentBlock[],
): CanonicalMessage {
  return {
    role: "assistant",
    content,
  };
}
