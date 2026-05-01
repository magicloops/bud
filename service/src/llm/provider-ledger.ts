import { ulid } from "ulid";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { llmCallItemTable, llmCallTable } from "../db/schema.js";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalProviderId,
  CanonicalReasoningBlock,
  TokenUsage,
} from "./types.js";

export type LlmCallRequestMode = "openai_responses" | "anthropic_messages";

export type LlmCallVisibility = "provider_only" | "product_text" | "tool";

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

export async function recordLlmCall(args: RecordLlmCallArgs): Promise<{ llmCallId: string }> {
  const llmCallId = args.llmCallId ?? ulid();
  const cacheMetadata = cacheMetadataFromUsage(args.usage);

  await db.insert(llmCallTable).values({
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

  if (items.length > 0) {
    await db.insert(llmCallItemTable).values(items);
  }

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
): Promise<Array<{ createdAt: Date; llmCallId: string; content: CanonicalContentBlock[] }>> {
  const rows = await db
    .select({
      llmCallId: llmCallTable.llmCallId,
      createdAt: llmCallTable.createdAt,
      itemKind: llmCallItemTable.kind,
      itemDirection: llmCallItemTable.direction,
      itemSequence: llmCallItemTable.sequence,
      canonicalPayload: llmCallItemTable.canonicalPayload,
      providerPayload: llmCallItemTable.providerPayload,
    })
    .from(llmCallTable)
    .innerJoin(llmCallItemTable, eq(llmCallItemTable.llmCallId, llmCallTable.llmCallId))
    .where(and(eq(llmCallTable.threadId, threadId), eq(llmCallTable.provider, provider)))
    .orderBy(asc(llmCallTable.createdAt), asc(llmCallItemTable.sequence));

  const grouped = new Map<string, { createdAt: Date; content: CanonicalContentBlock[] }>();
  for (const row of rows) {
    if (!row.llmCallId) {
      continue;
    }
    const group = grouped.get(row.llmCallId) ?? {
      createdAt: row.createdAt,
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
      content: value.content,
    }));
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
        return { type: "text", text: canonicalPayload.text };
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
    if (provider === "openai" || provider === "anthropic") {
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

function cacheMetadataFromUsage(usage?: TokenUsage): Record<string, unknown> | null {
  if (!usage) {
    return null;
  }

  const metadata: Record<string, unknown> = {};
  if (typeof usage.cached_input_tokens === "number") {
    metadata.openai_cached_input_tokens = usage.cached_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    metadata.anthropic_cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    metadata.anthropic_cache_read_input_tokens = usage.cache_read_input_tokens;
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

export function buildRequestMode(provider: CanonicalProviderId): LlmCallRequestMode {
  return provider === "openai" ? "openai_responses" : "anthropic_messages";
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
