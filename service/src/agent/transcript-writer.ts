import { db } from "../db/client.js";
import { recordThreadAttentionMetadata, recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { budTable, messageTable, pushNotificationOutboxTable, threadTable } from "../db/schema.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import {
  buildEffectiveToolArgs,
  buildToolArgs,
  type AgentToolCallDirective,
  type ExecutedTerminalTool,
  type ToolExecutionTiming,
  serializeToolExecutionTiming,
} from "./contracts.js";
import { buildAssistantPreviewBody, buildNotificationTitle } from "../notifications/index.js";
import type { ModelSelectionSource, ReasoningLevel } from "../llm/index.js";
import type { TerminalPathContext } from "../runtime/terminal-session-manager.js";

type PersistedAgentMessage = {
  messageId: string;
  clientId: string | null;
  role: string;
  displayRole: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type SerializedAgentMessage = {
  message_id: string;
  client_id: string | null;
  role: string;
  display_role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type AgentMessageModelSelection = {
  model: string;
  reasoningEffort: ReasoningLevel;
  source: ModelSelectionSource;
};

export class AgentTranscriptWriter {
  private readonly runtime: AgentRuntimeStateManager;

  constructor(runtime: AgentRuntimeStateManager) {
    this.runtime = runtime;
  }

  emitToolCall(
    threadId: string,
    turnId: string,
    directive: AgentToolCallDirective,
    clientId: string,
    startedAt: Date,
  ): {
    modelArgs: Record<string, unknown>;
    clientArgs: Record<string, unknown>;
    cursor: string;
  } {
    const modelArgs = buildToolArgs(directive);
    const clientArgs = buildEffectiveToolArgs(directive);
    const cursor = this.runtime.emit(threadId, {
      event: "agent.tool_call",
      data: {
        turn_id: turnId,
        client_id: clientId,
        call_id: directive.callId,
        name: directive.tool,
        args: clientArgs,
        started_at: startedAt.toISOString(),
      },
    });

    this.runtime.setPendingTool(
      threadId,
      {
        client_id: clientId,
        call_id: directive.callId,
        name: directive.tool,
        args: clientArgs,
        started_at: startedAt.toISOString(),
      },
      cursor,
    );

    return { modelArgs, clientArgs, cursor };
  }

  async recordToolResult(args: {
    threadId: string;
    turnId: string;
    execution: ExecutedTerminalTool;
    clientId: string;
    timing: ToolExecutionTiming;
    modelSelection: AgentMessageModelSelection;
    ownerUserId?: string | null;
    llmCallId?: string | null;
    pathContextBefore?: TerminalPathContext | null;
    pathContextAfter?: TerminalPathContext | null;
  }): Promise<{ payload: Record<string, unknown>; message: SerializedAgentMessage; cursor: string }> {
    const {
      threadId,
      turnId,
      execution,
      clientId,
      timing,
      modelSelection,
      ownerUserId,
      llmCallId,
      pathContextBefore,
      pathContextAfter,
    } = args;
    const serializedTiming = serializeToolExecutionTiming(timing);
    const persistedMetadata = {
      ...execution.payload,
      ...serializedTiming,
      ...serializeModelSelectionMetadata(modelSelection),
      ...(llmCallId ? { llm_call_id: llmCallId } : {}),
      ...(pathContextBefore ? { path_context_before: pathContextBefore } : {}),
      ...(pathContextAfter ? { path_context_after: pathContextAfter } : {}),
    };
    const [toolMessage] = await db
      .insert(messageTable)
      .values({
        clientId,
        threadId,
        role: "tool",
        displayRole: "Tool",
        content: JSON.stringify(execution.payload),
        createdByUserId: ownerUserId ?? undefined,
        metadata: persistedMetadata,
      })
      .returning({
        messageId: messageTable.messageId,
        clientId: messageTable.clientId,
        role: messageTable.role,
        displayRole: messageTable.displayRole,
        content: messageTable.content,
        metadata: messageTable.metadata,
        createdAt: messageTable.createdAt,
      });

    await recordThreadMessageMetadata(threadId, execution.summary);

    const serializedMessage = this.serializePersistedMessage(toolMessage);
    const cursor = this.runtime.emit(threadId, {
      event: "agent.tool_result",
      data: {
        turn_id: turnId,
        client_id: clientId,
        call_id: execution.directive.callId,
        message_id: serializedMessage.message_id,
        name: execution.directive.tool,
        summary: execution.summary,
        output: execution.result.output,
        output_bytes: execution.result.outputBytes,
        readiness: execution.result.readiness,
        truncated: execution.result.truncated,
        output_truncation_reason: execution.outputTruncationReason,
        omitted_lines: execution.result.omittedLines,
        ...serializedTiming,
        message: serializedMessage,
      },
    });

    this.runtime.markThinking(threadId, cursor);

    return {
      payload: execution.payload,
      message: serializedMessage,
      cursor,
    };
  }

  async recordFinalAssistant(args: {
    threadId: string;
    turnId: string;
    message: string;
    status: "succeeded" | "failed";
    clientId: string;
    modelSelection: AgentMessageModelSelection;
    ownerUserId?: string | null;
    llmCallId?: string | null;
    pathContext?: TerminalPathContext | null;
  }): Promise<SerializedAgentMessage> {
    const {
      threadId,
      turnId,
      message,
      status,
      clientId,
      modelSelection,
      ownerUserId,
      llmCallId,
      pathContext,
    } = args;
    const assistantMessage = await db.transaction(async (tx) => {
      const [insertedMessage] = await tx
        .insert(messageTable)
        .values({
          clientId,
          threadId,
          role: "assistant",
          displayRole: "Bud Agent",
          content: message,
          createdByUserId: ownerUserId ?? undefined,
          metadata: {
            status,
            turn_id: turnId,
            segment_kind: "final",
            ...(llmCallId ? { llm_call_id: llmCallId } : {}),
            ...(pathContext ? { path_context: pathContext } : {}),
            attention_kind: "assistant_completed",
            ...serializeModelSelectionMetadata(modelSelection),
          },
        })
        .returning({
          messageId: messageTable.messageId,
          clientId: messageTable.clientId,
          role: messageTable.role,
          displayRole: messageTable.displayRole,
          content: messageTable.content,
          metadata: messageTable.metadata,
          createdAt: messageTable.createdAt,
        });

      await recordThreadMessageMetadata(threadId, message, tx);
      await recordThreadAttentionMetadata(
        {
          threadId,
          messageId: insertedMessage.messageId,
          messageCreatedAt: insertedMessage.createdAt,
          kind: "assistant_completed",
        },
        tx,
      );

      const [threadInfo] = await tx
        .select({
          budId: threadTable.budId,
          threadTitle: threadTable.title,
          threadOwnerUserId: threadTable.createdByUserId,
          budDisplayName: budTable.displayName,
          budName: budTable.name,
        })
        .from(threadTable)
        .innerJoin(budTable, eq(threadTable.budId, budTable.budId))
        .where(eq(threadTable.threadId, threadId))
        .limit(1);

      const budLabel = threadInfo?.budDisplayName ?? threadInfo?.budName ?? "Bud";
      const title = buildNotificationTitle(threadInfo?.threadTitle ?? null, budLabel);
      const body = buildAssistantPreviewBody(message);
      const notificationUserId = ownerUserId ?? threadInfo?.threadOwnerUserId ?? null;
      const payload = {
        kind: "assistant_completed",
        thread_id: threadId,
        message_id: insertedMessage.messageId,
        client_id: insertedMessage.clientId,
        bud_id: threadInfo?.budId ?? null,
        sent_at: insertedMessage.createdAt.toISOString(),
      } satisfies Record<string, unknown>;

      if (notificationUserId) {
        await tx.insert(pushNotificationOutboxTable).values({
          notificationId: ulid(),
          userId: notificationUserId,
          threadId,
          messageId: insertedMessage.messageId,
          kind: "assistant_completed",
          status: "pending",
          dedupeKey: `user:${notificationUserId}:thread:${threadId}:message:${insertedMessage.messageId}:kind:assistant_completed`,
          collapseKey: `thread:${threadId}`,
          title,
          body,
          payload,
          createdByUserId: notificationUserId,
        });
      }

      return insertedMessage;
    });

    const serializedMessage = this.serializePersistedMessage(assistantMessage);
    const cursor = this.runtime.emit(threadId, {
      event: "agent.message",
      data: {
        turn_id: turnId,
        client_id: clientId,
        message_id: serializedMessage.message_id,
        text: message,
        message: serializedMessage,
      },
    });

    this.runtime.clearDraftAssistant(threadId, cursor);
    this.runtime.emit(threadId, {
      event: "final",
      data: {
        turn_id: turnId,
        status,
        text: message,
        message_id: serializedMessage.message_id,
      },
    });

    return serializedMessage;
  }

  async recordAssistantTextSegment(args: {
    threadId: string;
    turnId: string;
    message: string;
    clientId: string;
    segmentKind: "intermediate" | "final";
    modelSelection: AgentMessageModelSelection;
    ownerUserId?: string | null;
    llmCallId?: string | null;
    followedByToolCall?: boolean;
    pathContext?: TerminalPathContext | null;
  }): Promise<SerializedAgentMessage> {
    const {
      threadId,
      turnId,
      message,
      clientId,
      segmentKind,
      modelSelection,
      ownerUserId,
      llmCallId,
      followedByToolCall,
      pathContext,
    } = args;
    const [insertedMessage] = await db
      .insert(messageTable)
      .values({
        clientId,
        threadId,
        role: "assistant",
        displayRole: "Bud Agent",
        content: message,
        createdByUserId: ownerUserId ?? undefined,
        metadata: {
          status: "succeeded",
          turn_id: turnId,
          segment_kind: segmentKind,
          ...(llmCallId ? { llm_call_id: llmCallId } : {}),
          ...(followedByToolCall ? { followed_by_tool_call: true } : {}),
          ...(pathContext ? { path_context: pathContext } : {}),
          ...serializeModelSelectionMetadata(modelSelection),
        },
      })
      .returning({
        messageId: messageTable.messageId,
        clientId: messageTable.clientId,
        role: messageTable.role,
        displayRole: messageTable.displayRole,
        content: messageTable.content,
        metadata: messageTable.metadata,
        createdAt: messageTable.createdAt,
      });

    await recordThreadMessageMetadata(threadId, message);

    const serializedMessage = this.serializePersistedMessage(insertedMessage);
    const cursor = this.runtime.emit(threadId, {
      event: "agent.message",
      data: {
        turn_id: turnId,
        client_id: clientId,
        message_id: serializedMessage.message_id,
        text: message,
        message: serializedMessage,
      },
    });

    this.runtime.clearDraftAssistant(threadId, cursor);
    return serializedMessage;
  }

  private serializePersistedMessage(message: PersistedAgentMessage): SerializedAgentMessage {
    return {
      message_id: message.messageId,
      client_id: message.clientId,
      role: message.role,
      display_role: message.displayRole ?? message.role,
      content: message.content,
      metadata: message.metadata ?? {},
      created_at: message.createdAt.toISOString(),
    };
  }
}

function serializeModelSelectionMetadata(
  selection: AgentMessageModelSelection,
): Record<string, unknown> {
  return {
    model: selection.model,
    reasoning_effort: selection.reasoningEffort,
    model_selection_source: selection.source,
  };
}
