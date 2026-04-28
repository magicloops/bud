import { db } from "../db/client.js";
import { recordThreadAttentionMetadata, recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { budTable, messageTable, pushNotificationOutboxTable, threadTable } from "../db/schema.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import {
  buildToolArgs,
  type AgentToolCallDirective,
  type ExecutedTerminalTool,
  type ToolExecutionTiming,
  serializeToolExecutionTiming,
} from "./contracts.js";
import { buildAssistantPreviewBody, buildNotificationTitle } from "../notifications/index.js";

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
  ): { args: Record<string, unknown>; cursor: string } {
    const args = buildToolArgs(directive);
    const cursor = this.runtime.emit(threadId, {
      event: "agent.tool_call",
      data: {
        turn_id: turnId,
        client_id: clientId,
        call_id: directive.callId,
        name: directive.tool,
        args,
        started_at: startedAt.toISOString(),
      },
    });

    this.runtime.setPendingTool(
      threadId,
      {
        client_id: clientId,
        call_id: directive.callId,
        name: directive.tool,
        args,
        started_at: startedAt.toISOString(),
      },
      cursor,
    );

    return { args, cursor };
  }

  async recordToolResult(args: {
    threadId: string;
    turnId: string;
    execution: ExecutedTerminalTool;
    clientId: string;
    timing: ToolExecutionTiming;
    ownerUserId?: string | null;
  }): Promise<{ payload: Record<string, unknown>; message: SerializedAgentMessage; cursor: string }> {
    const { threadId, turnId, execution, clientId, timing, ownerUserId } = args;
    const serializedTiming = serializeToolExecutionTiming(timing);
    const persistedMetadata = {
      ...execution.payload,
      ...serializedTiming,
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
    ownerUserId?: string | null;
  }): Promise<SerializedAgentMessage> {
    const { threadId, turnId, message, status, clientId, ownerUserId } = args;
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
          metadata: { status, attention_kind: "assistant_completed" },
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
