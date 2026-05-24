import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import {
  isProviderContextWindowError,
  providerRegistry,
  type CanonicalContentBlock,
  type CanonicalMessage,
  type CanonicalProviderId,
  type CanonicalResponse,
  type CanonicalStreamEvent,
  type CanonicalStopReason,
  type ModelConfig,
  type ReasoningLevel,
  type ResolvedModelReasoning,
  type TokenUsage,
} from "../llm/index.js";
import {
  estimateCanonicalMessagesTokens,
  estimateTextTokens,
  resolveContextBudget,
} from "./context-budget.js";
import {
  getCurrentContextCheckpointBoundary,
  getThreadCheckpointOwner,
  recordCompletedContextCheckpoint,
  recordFailedContextCheckpoint,
  type AgentContextCheckpoint,
  type AgentContextCheckpointPhase,
  type AgentContextCheckpointReason,
  type AgentContextCheckpointTrigger,
} from "./context-checkpoint-repository.js";

const COMPACTION_PROMPT = `
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`.trim();

const CHECKPOINT_SUMMARY_PREFIX = `
Another Bud Agent model compacted earlier context for this thread. Use this checkpoint to continue the task without repeating completed work. The visible transcript still exists in the product, but your model-visible context has been shortened. Summary:
`.trim();

const RECENT_USER_MESSAGE_TOKEN_BUDGET = 20_000;
const MAX_COMPACTION_RETRIES = 4;

export type CompactContextInput = {
  threadId: string;
  turnId: string;
  phase: AgentContextCheckpointPhase;
  trigger: AgentContextCheckpointTrigger;
  reason: AgentContextCheckpointReason;
  model: string;
  provider: CanonicalProviderId;
  modelReasoning: ResolvedModelReasoning;
  conversation: CanonicalMessage[];
  inputTokensBefore?: number | null;
  ownerUserId?: string | null;
  tenantId?: string | null;
  currentTerminalContext?: string | null;
  signal?: AbortSignal;
};

export type CompactContextResult = {
  checkpoint: AgentContextCheckpoint;
  replacementHistory: CanonicalMessage[];
  estimatedTokensAfter: number;
};

export class AgentContextCompactor {
  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly debugEnabled = false,
  ) {}

  async compact(input: CompactContextInput): Promise<CompactContextResult> {
    const owner = await this.resolveOwner(input);
    const boundaries = await getCurrentContextCheckpointBoundary(input.threadId);
    const budget = resolveContextBudget({
      model: input.model,
      modelReasoning: input.modelReasoning,
    });
    let compactionMessages = trimCompactionRequestToEstimatedBudget(
      buildCompactionMessages(input.conversation),
      budget.thresholdTokens,
    );
    let lastContextError: unknown = null;

    for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt += 1) {
      try {
        const summary = await this.createSummary(input, compactionMessages);
        const replacementHistory = buildReplacementHistory({
          conversation: input.conversation,
          summary,
          currentTerminalContext: input.currentTerminalContext,
        });
        const estimatedTokensAfter = estimateCanonicalMessagesTokens(replacementHistory);
        const checkpoint = await recordCompletedContextCheckpoint({
          threadId: input.threadId,
          trigger: input.trigger,
          reason: input.reason,
          phase: input.phase,
          sourceProvider: input.provider,
          sourceModel: input.modelReasoning.providerModel,
          sourceReasoningEffort: input.modelReasoning.reasoningLevel,
          summary,
          replacementHistory,
          boundaries,
          inputTokensBefore: input.inputTokensBefore,
          estimatedTokensAfter,
          ownerUserId: owner.ownerUserId,
          tenantId: owner.tenantId,
        });

        this.debug("Context compaction completed", {
          threadId: input.threadId,
          turnId: input.turnId,
          checkpointId: checkpoint.checkpointId,
          phase: input.phase,
          tokensBefore: input.inputTokensBefore,
          tokensAfter: estimatedTokensAfter,
        });

        return {
          checkpoint,
          replacementHistory,
          estimatedTokensAfter,
        };
      } catch (err) {
        if (!isProviderContextWindowError(err)) {
          await this.recordFailure(input, owner, boundaries, err);
          throw err;
        }

        lastContextError = err;
        const trimmed = trimCompactionRequest(compactionMessages);
        if (!trimmed) {
          break;
        }
        compactionMessages = trimmed;
      }
    }

    const error = lastContextError instanceof Error
      ? lastContextError
      : new Error("context_compaction_failed");
    await this.recordFailure(input, owner, boundaries, error);
    throw new Error(
      "context_compaction_failed: provider could not summarize the current context within its context window",
      { cause: error },
    );
  }

  private async createSummary(
    input: CompactContextInput,
    compactionMessages: CanonicalMessage[],
  ): Promise<string> {
    const provider = providerRegistry.getProviderForModel(input.model);
    const modelConfig: ModelConfig = {
      model: input.modelReasoning.providerModel,
      maxOutputTokens: Math.min(config.agentMaxOutputTokens, 16_000),
      reasoning: input.modelReasoning.reasoning,
      responseFormat: "text",
      toolChoice: "none",
    };

    const response = provider.invokeSync
      ? await provider.invokeSync(compactionMessages, [], modelConfig, input.signal)
      : await collectProviderResponse(
          provider.invoke(compactionMessages, [], modelConfig, input.signal),
        );
    const summary = collectText(response.content).trim();
    if (!summary) {
      throw new Error("context_compaction_empty_summary");
    }
    return summary;
  }

  private async resolveOwner(input: CompactContextInput): Promise<{
    ownerUserId: string | null;
    tenantId: string | null;
  }> {
    if (input.ownerUserId !== undefined && input.tenantId !== undefined) {
      return {
        ownerUserId: input.ownerUserId ?? null,
        tenantId: input.tenantId ?? null,
      };
    }
    const storedOwner = await getThreadCheckpointOwner(input.threadId);
    return {
      ownerUserId: input.ownerUserId ?? storedOwner.ownerUserId,
      tenantId: input.tenantId ?? storedOwner.tenantId,
    };
  }

  private async recordFailure(
    input: CompactContextInput,
    owner: { ownerUserId: string | null; tenantId: string | null },
    boundaries: Awaited<ReturnType<typeof getCurrentContextCheckpointBoundary>>,
    error: unknown,
  ): Promise<void> {
    await recordFailedContextCheckpoint({
      threadId: input.threadId,
      trigger: input.trigger,
      reason: input.reason,
      phase: input.phase,
      sourceProvider: input.provider,
      sourceModel: input.modelReasoning.providerModel,
      sourceReasoningEffort: input.modelReasoning.reasoningLevel,
      boundaries,
      inputTokensBefore: input.inputTokensBefore,
      ownerUserId: owner.ownerUserId,
      tenantId: owner.tenantId,
      error: errorToRecord(error),
    });
  }

  private debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "agent_context_compaction" }, message);
  }
}

function buildCompactionMessages(conversation: CanonicalMessage[]): CanonicalMessage[] {
  return [
    ...cloneMessages(conversation),
    {
      role: "user",
      content: [{ type: "text", text: COMPACTION_PROMPT }],
    },
  ];
}

function buildReplacementHistory(args: {
  conversation: CanonicalMessage[];
  summary: string;
  currentTerminalContext?: string | null;
}): CanonicalMessage[] {
  const replacement: CanonicalMessage[] = [];

  replacement.push({
    role: "user",
    content: [{
      type: "text",
      text: `${CHECKPOINT_SUMMARY_PREFIX}\n\n${args.summary.trim()}`,
    }],
  });

  const recentUserMessages = collectRecentUserMessages(args.conversation);
  replacement.push(...recentUserMessages);
  if (args.currentTerminalContext?.trim()) {
    replacement.push({
      role: "user",
      content: [{
        type: "text",
        text: `Current terminal context at compaction time:\n${args.currentTerminalContext.trim()}`,
      }],
    });
  }

  return replacement;
}

function collectRecentUserMessages(conversation: CanonicalMessage[]): CanonicalMessage[] {
  const selected: CanonicalMessage[] = [];
  let remainingBudget = RECENT_USER_MESSAGE_TOKEN_BUDGET;

  for (const message of [...conversation].reverse()) {
    if (!isRealUserTextMessage(message)) {
      continue;
    }

    const tokenEstimate = estimateCanonicalMessagesTokens([message]);
    if (tokenEstimate <= remainingBudget) {
      selected.push(message);
      remainingBudget -= tokenEstimate;
      continue;
    }

    const truncated = truncateUserMessageToBudget(message, remainingBudget);
    if (truncated) {
      selected.push(truncated);
    }
    break;
  }

  return selected.reverse();
}

function isRealUserTextMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  const blocks = normalizeContent(message.content);
  if (blocks.length === 0 || blocks.every((block) => block.type === "tool_result")) {
    return false;
  }
  const text = collectText(blocks);
  return Boolean(text.trim()) && !text.includes(CHECKPOINT_SUMMARY_PREFIX);
}

function truncateUserMessageToBudget(
  message: CanonicalMessage,
  remainingBudget: number,
): CanonicalMessage | null {
  if (remainingBudget <= 16) {
    return null;
  }
  const text = collectText(normalizeContent(message.content));
  const marker = "\n\n[Earlier user message truncated during context compaction.]";
  const maxChars = Math.max(0, (remainingBudget - estimateTextTokens(marker)) * 4);
  if (maxChars <= 0) {
    return null;
  }
  return {
    role: "user",
    content: [{
      type: "text",
      text: `${text.slice(-maxChars)}${marker}`,
    }],
  };
}

function trimCompactionRequest(messages: CanonicalMessage[]): CanonicalMessage[] | null {
  if (messages.length <= 2) {
    return null;
  }

  const trimmed = cloneMessages(messages);
  const removableIndex = trimmed.findIndex((message, index) =>
    index > 0 && index < trimmed.length - 1
  );
  if (removableIndex < 0) {
    return null;
  }

  const removed = trimmed.splice(removableIndex, 1)[0];
  removePairedToolMessage(trimmed, removed, removableIndex);
  return trimmed.length < messages.length ? trimmed : null;
}

function trimCompactionRequestToEstimatedBudget(
  messages: CanonicalMessage[],
  maxTokens: number | null,
): CanonicalMessage[] {
  if (!maxTokens) {
    return messages;
  }

  let trimmed = messages;
  while (estimateCanonicalMessagesTokens(trimmed) > maxTokens) {
    const next = trimCompactionRequest(trimmed);
    if (!next) {
      return trimmed;
    }
    trimmed = next;
  }
  return trimmed;
}

function removePairedToolMessage(
  messages: CanonicalMessage[],
  removed: CanonicalMessage | undefined,
  removedIndex: number,
): void {
  if (!removed) {
    return;
  }
  const removedToolUseIds = toolUseIds(removed);
  const removedToolResultIds = toolResultIds(removed);

  if (removedToolUseIds.size > 0) {
    const pairIndex = messages.findIndex((message, index) =>
      index >= removedIndex && intersects(toolResultIds(message), removedToolUseIds)
    );
    if (pairIndex >= 0) {
      messages.splice(pairIndex, 1);
    }
  }

  if (removedToolResultIds.size > 0) {
    for (let index = Math.min(removedIndex - 1, messages.length - 1); index >= 0; index -= 1) {
      if (intersects(toolUseIds(messages[index]), removedToolResultIds)) {
        messages.splice(index, 1);
        break;
      }
    }
  }
}

async function collectProviderResponse(
  events: AsyncIterable<CanonicalStreamEvent>,
): Promise<CanonicalResponse> {
  const textBlocks = new Map<number, string>();
  let responseId = "context_compaction";
  let stopReason: CanonicalStopReason = "end_turn";
  let usage: TokenUsage | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        responseId = event.id;
        break;
      case "message_done":
        stopReason = event.stop_reason;
        usage = event.usage;
        break;
      case "text_delta": {
        textBlocks.set(event.index, `${textBlocks.get(event.index) ?? ""}${event.delta}`);
        break;
      }
      case "error":
        throw event.error;
    }
  }

  return {
    id: responseId,
    stopReason,
    usage,
    content: Array.from(textBlocks.entries())
      .sort(([left], [right]) => left - right)
      .map(([, text]) => ({ type: "text" as const, text })),
  };
}

function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return JSON.parse(JSON.stringify(messages)) as CanonicalMessage[];
}

function normalizeContent(content: string | CanonicalContentBlock[]): CanonicalContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function collectText(content: CanonicalContentBlock[]): string {
  return content
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolUseIds(message: CanonicalMessage | undefined): Set<string> {
  return new Set(
    normalizeContent(message?.content ?? [])
      .filter((block): block is Extract<CanonicalContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use"
      )
      .map((block) => block.id),
  );
}

function toolResultIds(message: CanonicalMessage | undefined): Set<string> {
  return new Set(
    normalizeContent(message?.content ?? [])
      .filter((block): block is Extract<CanonicalContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result"
      )
      .map((block) => block.tool_use_id),
  );
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function errorToRecord(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      retryable: isProviderContextWindowError(error) ? error.retryable : false,
      code: isProviderContextWindowError(error) ? "CONTEXT_WINDOW" : "COMPACTION_FAILED",
      provider: isProviderContextWindowError(error) ? error.provider : undefined,
      model: isProviderContextWindowError(error) ? error.model : undefined,
      provider_code: isProviderContextWindowError(error) ? error.providerCode : undefined,
    };
  }
  return {
    code: "COMPACTION_FAILED",
    message: String(error),
    retryable: false,
  };
}
