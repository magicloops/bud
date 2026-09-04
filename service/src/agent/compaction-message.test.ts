import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextCheckpoint } from "./context-checkpoint-repository.js";
import {
  buildCompactionMessageValues,
  COMPACTION_MESSAGE_ROLE,
  serializeCompactionMessage,
} from "./compaction-message.js";

const CHECKPOINT = {
  checkpointId: "chk-1",
  threadId: "thread-1",
  trigger: "auto",
  reason: "context_limit",
  phase: "mid_turn",
  implementation: "local_summary",
  status: "completed",
  sourceProvider: "openai",
  sourceModel: "gpt-5.6-sol",
  sourceReasoningEffort: "low",
  summary: "Earlier work: fixed the build.",
  replacementHistory: [{ role: "user", content: "summary" }, { role: "user", content: "kept" }],
  compactedThroughMessageId: "m-40",
  compactedThroughMessageCreatedAt: new Date("2026-09-03T09:59:00.000Z"),
  compactedThroughLlmCallId: "llm-7",
  compactedThroughLlmCallCreatedAt: null,
  inputTokensBefore: 245_000,
  estimatedTokensAfter: 12_000,
  error: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-09-03T10:00:00.000Z"),
  completedAt: new Date("2026-09-03T10:00:05.000Z"),
} as unknown as AgentContextCheckpoint;

test("buildCompactionMessageValues maps a completed checkpoint to a browser-only transcript row", () => {
  const values = buildCompactionMessageValues(CHECKPOINT, { turnId: "turn-1" });
  assert.equal(values.role, COMPACTION_MESSAGE_ROLE);
  assert.equal(values.displayRole, "Context compacted");
  assert.equal(values.threadId, "thread-1");
  assert.equal(values.content, "Earlier work: fixed the build.");
  assert.equal(values.createdByUserId, "user-1");
  // The row lands at the moment the cut completed.
  assert.equal((values.createdAt as Date).toISOString(), "2026-09-03T10:00:05.000Z");
  assert.ok(values.clientId);
  assert.ok(values.messageId);
  assert.deepEqual(values.metadata, {
    artifact_kind: "context_compaction",
    model_visible: false,
    status: "completed",
    checkpoint_id: "chk-1",
    turn_id: "turn-1",
    trigger: "auto",
    reason: "context_limit",
    phase: "mid_turn",
    tokens_before: 245_000,
    tokens_after: 12_000,
    compacted_through_message_id: "m-40",
    compacted_through_llm_call_id: "llm-7",
    source_provider: "openai",
    source_model: "gpt-5.6-sol",
    source_reasoning_effort: "low",
    replacement_history_message_count: 2,
  });
});

test("buildCompactionMessageValues omits turn_id for backfilled rows and tolerates nulls", () => {
  const values = buildCompactionMessageValues({
    ...CHECKPOINT,
    summary: null,
    completedAt: null,
    inputTokensBefore: null,
    estimatedTokensAfter: null,
    compactedThroughMessageId: null,
    compactedThroughLlmCallId: null,
    sourceProvider: null,
    createdByUserId: null,
  } as unknown as AgentContextCheckpoint);
  assert.equal(values.content, "");
  assert.equal((values.createdAt as Date).toISOString(), "2026-09-03T10:00:00.000Z");
  assert.equal(values.createdByUserId, undefined);
  const metadata = values.metadata as Record<string, unknown>;
  assert.equal("turn_id" in metadata, false);
  assert.equal(metadata.tokens_before, null);
  assert.equal(metadata.compacted_through_message_id, null);
});

test("serializeCompactionMessage produces the wire shape", () => {
  assert.deepEqual(
    serializeCompactionMessage({
      messageId: "m-9",
      clientId: "c-9",
      displayRole: null,
      content: "s",
      metadata: null,
      createdAt: new Date("2026-09-03T10:00:05.000Z"),
    }),
    {
      message_id: "m-9",
      client_id: "c-9",
      role: "compaction",
      display_role: "Context compacted",
      content: "s",
      metadata: {},
      created_at: "2026-09-03T10:00:05.000Z",
    },
  );
});
