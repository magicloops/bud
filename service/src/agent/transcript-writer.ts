import { db } from "../db/client.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { messageTable } from "../db/schema.js";
import type { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import {
  buildToolArgs,
  type AgentToolCallDirective,
  type ExecutedTerminalTool,
} from "./contracts.js";

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
      },
    });

    this.runtime.setPendingTool(
      threadId,
      {
        client_id: clientId,
        call_id: directive.callId,
        name: directive.tool,
        args,
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
    ownerUserId?: string | null;
  }): Promise<{ payload: Record<string, unknown>; message: SerializedAgentMessage; cursor: string }> {
    const { threadId, turnId, execution, clientId, ownerUserId } = args;
    const [toolMessage] = await db
      .insert(messageTable)
      .values({
        clientId,
        threadId,
        role: "tool",
        displayRole: "Tool",
        content: JSON.stringify(execution.payload),
        createdByUserId: ownerUserId ?? undefined,
        metadata: execution.payload,
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

    const [assistantMessage] = await db
      .insert(messageTable)
      .values({
        clientId,
        threadId,
        role: "assistant",
        displayRole: "Bud Agent",
        content: message,
        createdByUserId: ownerUserId ?? undefined,
        metadata: { status },
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
