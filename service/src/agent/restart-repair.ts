import type { FastifyBaseLogger } from "fastify";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { llmCallItemTable, llmCallTable, messageTable, threadTable } from "../db/schema.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { recordThreadMessageMetadata } from "../db/thread-metadata.js";
import { recordLlmToolResultItem } from "../llm/provider-ledger.js";
import { ASK_USER_QUESTIONS_TOOL } from "./user-question-contracts.js";

/**
 * Boot-time repair for tool calls a prior process died on (deploy, crash,
 * kill mid-`terminal.wait` — the tool most likely to be in flight, since it
 * parks for up to 30 minutes).
 *
 * A turn lives only in memory: after a restart the provider ledger holds the
 * assistant `tool_use` item with no `tool_result`, and the visible transcript
 * has no tool row at all — the agent just goes silent. Replay already
 * survives this (`repairOrphanedToolCalls` injects an interrupted result at
 * load time), but the hole stays in the database forever and the timeline
 * never says what happened. This module closes the hole durably, once:
 *
 * - records the missing ledger `tool_result` (so replay repair stops firing
 *   for that call), and
 * - persists a product tool row reporting `error: "server_restarted"`
 *   (canonical code `SERVER_RESTARTED`) with model-facing guidance — for
 *   terminal tools it notes the Bud-side terminal kept running.
 *
 * `ask_user_questions` calls are deliberately skipped: they have their own
 * durable lifecycle (`agent_question_request` rows; post-restart answers
 * become fallback user messages).
 */

export type DanglingToolCall = {
  llmCallId: string;
  threadId: string;
  turnId: string;
  toolCallId: string;
  /** Canonical `tool_use` block: `{ type, id, name, input }`. */
  canonicalPayload: Record<string, unknown>;
  threadOwnerUserId: string | null;
};

export type DanglingToolCallRepair = {
  tool: string;
  summary: string;
  payload: Record<string, unknown>;
};

const GENERIC_NOTE =
  "The service restarted before this tool call finished, so no result was recorded. " +
  "Treat the call as not executed to completion and re-issue it if it is still needed.";

const TERMINAL_NOTE =
  "The service restarted before this tool call finished, so no result was recorded. " +
  "The terminal and any program in it kept running on the Bud — nothing was interrupted " +
  "there, and a running command may have finished meanwhile. Check the current state with " +
  "terminal.observe, keep waiting with terminal.wait, or re-run the command if it never started.";

/** Canonical (model-facing) tool name → product tool name used in payloads/renderers. */
function productToolName(canonicalName: string): string {
  switch (canonicalName) {
    case "terminal_run":
      return "terminal.run";
    case "terminal_send":
      return "terminal.send";
    case "terminal_observe":
      return "terminal.observe";
    case "terminal_wait":
      return "terminal.wait";
    case "web_view_open":
      return "web_view.open";
    case "web_view_close":
      return "web_view.close";
    case "web_view_list":
      return "web_view.list";
    default:
      // Already-dotted names (ledger rows written from directives) pass through.
      return canonicalName;
  }
}

/** Result `kind` the executor would have used, so renderers stay consistent. */
function payloadKind(tool: string): string | null {
  switch (tool) {
    case "terminal.run":
      return "command";
    case "terminal.send":
      return "interaction_ack";
    case "terminal.observe":
      return "observation";
    case "terminal.wait":
      return "wait";
    case "web_view.open":
    case "web_view.close":
    case "web_view.list":
      return "web_view";
    default:
      return null;
  }
}

/** Pure: the synthesized result for one dangling call. */
export function buildDanglingToolCallRepair(call: DanglingToolCall): DanglingToolCallRepair {
  const block = call.canonicalPayload;
  const canonicalName = typeof block.name === "string" && block.name.length > 0
    ? block.name
    : "unknown_tool";
  const tool = productToolName(canonicalName);
  const isTerminal = tool.startsWith("terminal.");
  const kind = payloadKind(tool);
  const args =
    block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  const summary =
    tool === "terminal.wait"
      ? "Terminal wait was interrupted by a service restart; the terminal kept running"
      : `Tool call ${tool} was interrupted by a service restart before a result was recorded`;

  return {
    tool,
    summary,
    payload: {
      tool,
      call_id: call.toolCallId,
      ...args,
      summary,
      ...(kind ? { kind } : {}),
      ...(tool === "terminal.wait" ? { outcome: "interrupted" } : {}),
      error: "server_restarted",
      ok: false,
      code: "SERVER_RESTARTED",
      retryable: true,
      note: isTerminal ? TERMINAL_NOTE : GENERIC_NOTE,
      server_restart_repair: true,
    },
  };
}

/**
 * Outbound `tool_use` items with no matching inbound `tool_result` in the
 * same thread (uses `llm_call_item_tool_call_idx`), oldest first.
 * `ask_user_questions` is excluded in SQL and re-checked in JS.
 */
export async function findDanglingToolCalls(): Promise<DanglingToolCall[]> {
  const rows = await db
    .select({
      llmCallId: llmCallItemTable.llmCallId,
      threadId: llmCallItemTable.threadId,
      toolCallId: llmCallItemTable.toolCallId,
      canonicalPayload: llmCallItemTable.canonicalPayload,
      turnId: llmCallTable.turnId,
      threadOwnerUserId: threadTable.createdByUserId,
    })
    .from(llmCallItemTable)
    .innerJoin(llmCallTable, eq(llmCallItemTable.llmCallId, llmCallTable.llmCallId))
    .innerJoin(threadTable, eq(llmCallItemTable.threadId, threadTable.threadId))
    .where(
      and(
        eq(llmCallItemTable.direction, "output"),
        eq(llmCallItemTable.kind, "tool_use"),
        isNotNull(llmCallItemTable.toolCallId),
        sql`coalesce(${llmCallItemTable.canonicalPayload} ->> 'name', '') <> ${ASK_USER_QUESTIONS_TOOL}`,
        sql`not exists (
          select 1 from llm_call_item repaired
          where repaired.kind = 'tool_result'
            and repaired.tool_call_id = ${llmCallItemTable.toolCallId}
            and repaired.thread_id = ${llmCallItemTable.threadId}
        )`,
      ),
    )
    .orderBy(asc(llmCallItemTable.createdAt));

  return rows
    .filter(
      (row): row is typeof row & { toolCallId: string } =>
        typeof row.toolCallId === "string" && row.toolCallId.length > 0,
    )
    .filter((row) => (row.canonicalPayload as { name?: unknown }).name !== ASK_USER_QUESTIONS_TOOL)
    .map((row) => ({
      llmCallId: row.llmCallId,
      threadId: row.threadId,
      turnId: row.turnId,
      toolCallId: row.toolCallId,
      canonicalPayload: (row.canonicalPayload ?? {}) as Record<string, unknown>,
      threadOwnerUserId: row.threadOwnerUserId ?? null,
    }));
}

type RepairDeps = {
  recordToolResultItem: typeof recordLlmToolResultItem;
  recordThreadMeta: typeof recordThreadMessageMetadata;
};

/**
 * Repair every dangling call. Awaited from server boot BEFORE `listen`, so
 * repairs precede new traffic; a failure on one call logs and continues (the
 * replay-time repair remains the safety net). Idempotent: the inserted
 * ledger item makes a repaired call non-dangling on the next boot.
 */
export async function repairDanglingToolCalls(
  logger: FastifyBaseLogger,
  deps: RepairDeps = {
    recordToolResultItem: recordLlmToolResultItem,
    recordThreadMeta: recordThreadMessageMetadata,
  },
): Promise<{ found: number; repaired: number }> {
  const dangling = await findDanglingToolCalls();
  let repaired = 0;
  const inputSequenceByCall = new Map<string, number>();

  for (const call of dangling) {
    try {
      const repair = buildDanglingToolCallRepair(call);
      const content = JSON.stringify(repair.payload);

      const [toolMessage] = await db
        .insert(messageTable)
        .values({
          clientId: generateMessageClientId(),
          threadId: call.threadId,
          role: "tool",
          displayRole: "Tool",
          content,
          createdByUserId: call.threadOwnerUserId ?? undefined,
          metadata: {
            ...repair.payload,
            turn_id: call.turnId,
          },
        })
        .returning({ messageId: messageTable.messageId });

      const sequence = inputSequenceByCall.get(call.llmCallId) ?? 0;
      inputSequenceByCall.set(call.llmCallId, sequence + 1);
      await deps.recordToolResultItem({
        llmCallId: call.llmCallId,
        threadId: call.threadId,
        sequence,
        toolCallId: call.toolCallId,
        content,
        payload: repair.payload,
        messageId: toolMessage?.messageId ?? null,
        ownerUserId: call.threadOwnerUserId,
      });
      await deps.recordThreadMeta(call.threadId, repair.summary);

      repaired += 1;
      logger.info(
        {
          threadId: call.threadId,
          turnId: call.turnId,
          llmCallId: call.llmCallId,
          toolCallId: call.toolCallId,
          tool: repair.tool,
        },
        "Repaired dangling tool call from a prior shutdown",
      );
    } catch (err) {
      logger.error(
        { err, threadId: call.threadId, toolCallId: call.toolCallId },
        "Failed to repair dangling tool call (continuing)",
      );
    }
  }

  return { found: dangling.length, repaired };
}
