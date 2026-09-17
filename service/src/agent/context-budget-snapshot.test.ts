import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { resolveEffectiveModelSelection } from "../llm/index.js";
import type { ContextBudget } from "./context-budget.js";
import { resolveContextBudget } from "./context-budget.js";
import type { AgentContextCheckpoint } from "./context-checkpoint-repository.js";
import {
  buildContextBudgetSnapshot,
  type ContextBudgetSnapshot,
} from "./context-budget-snapshot.js";
import { captureContextBaseline, type ContextRequestIdentity } from "./context-accounting.js";
import { buildContextBudgetDecision } from "./context-budget-state.js";
import type { CanonicalMessage } from "../llm/types.js";
import { AGENT_TOOL_SCHEMA_TOKENS } from "./tool-definitions.js";

const KNOWN_BUDGET: ContextBudget = {
  enabled: true,
  requestKind: "agent_turn",
  contextWindowTokens: 100_000,
  usableContextWindowTokens: 80_000,
  reservedOutputTokens: 10_000,
  usableInputWindowTokens: 70_000,
  thresholdRatio: 0.9,
  thresholdTokens: 63_000,
  effectiveInputBudgetTokens: 63_000,
  invalidReason: null,
};

test("buildContextBudgetSnapshot exposes the same threshold as automatic compaction", () => {
  const previousRatio = config.agentAutoCompactionRatio;
  const previousEnabled = config.agentAutoCompactionEnabled;
  config.agentAutoCompactionRatio = 1;
  config.agentAutoCompactionEnabled = true;
  try {
    const selection = resolveEffectiveModelSelection({
      requestedModel: "gpt-5.6-sol",
      serviceDefaultModel: "gpt-5.6-sol",
      validateAvailability: false,
    });
    const budget = resolveContextBudget({
      model: selection.model,
      modelReasoning: selection.modelReasoning,
    });

    const snapshot = buildContextBudgetSnapshot({
    toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
      model: selection.model,
      provider: selection.modelReasoning.providerName,
      budget,
      conversation: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ],
      checkpoint: null,
      compactionCount: 2,
      now: new Date("2026-05-24T10:00:00.000Z"),
    });

    assertAvailable(snapshot);
    assert.equal(snapshot.compaction_count, 2);
    assert.equal(
      snapshot.breakdown.reduce((sum, entry) => sum + entry.tokens, 0),
      snapshot.estimated_input_tokens,
      "breakdown sums to the trigger estimate",
    );
    assert.equal(snapshot.breakdown.find((entry) => entry.kind === "tool_schemas")?.tokens, AGENT_TOOL_SCHEMA_TOKENS);
    assert.ok(snapshot.breakdown.every((entry) => entry.percent_of_estimated_input >= 0 && entry.percent_of_estimated_input <= 1));
    assert.equal(snapshot.context_window_tokens, 1_050_000);
    assert.equal(snapshot.usable_context_window_tokens, 272_000);
    assert.equal(snapshot.reserved_output_tokens, 128_000);
    assert.equal(snapshot.usable_input_window_tokens, 272_000);
    assert.equal(snapshot.compaction_threshold_tokens, budget.thresholdTokens);
    assert.equal(snapshot.effective_budget_tokens, budget.effectiveInputBudgetTokens);
    assert.equal(snapshot.compaction_threshold_tokens, 244_800);
    assert.equal(snapshot.tool_schema_tokens, AGENT_TOOL_SCHEMA_TOKENS);
    assert.equal(snapshot.estimated_input_tokens, snapshot.message_estimated_tokens + AGENT_TOOL_SCHEMA_TOKENS);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("buildContextBudgetSnapshot returns unknown when model context window is unavailable", () => {
  const snapshot = buildContextBudgetSnapshot({
    toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
    model: "local-model",
    provider: "local",
    budget: {
      enabled: true,
      requestKind: "agent_turn",
      contextWindowTokens: null,
      usableContextWindowTokens: null,
      reservedOutputTokens: null,
      usableInputWindowTokens: null,
      thresholdRatio: 0.9,
      thresholdTokens: null,
      effectiveInputBudgetTokens: null,
      invalidReason: "unknown_model_context_window",
    },
    conversation: [],
    checkpoint: null,
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assert.deepEqual(snapshot, {
    status: "unknown",
    model: "local-model",
    provider: "local",
    reason: "unknown_model_context_window",
    source: "durable_reconstruction",
    phase: "idle",
    turn_id: null,
    checked_at: "2026-05-24T10:00:00.000Z",
    stale: false,
    updated_at: "2026-05-24T10:00:00.000Z",
  });
});

test("buildContextBudgetSnapshot uses usable input window when compaction is disabled", () => {
  const snapshot = buildContextBudgetSnapshot({
    toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
    model: "gpt-test",
    provider: "openai",
    budget: {
      ...KNOWN_BUDGET,
      enabled: false,
      effectiveInputBudgetTokens: 70_000,
    },
    conversation: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    checkpoint: null,
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assertAvailable(snapshot);
  assert.equal(snapshot.effective_budget_tokens, 70_000);
  assert.equal(snapshot.compaction_threshold_tokens, 63_000);
  assert.equal(snapshot.compaction_enabled, false);
  assert.equal(snapshot.context_window_tokens, 100_000);
  assert.equal(snapshot.usable_context_window_tokens, 80_000);
  assert.equal(snapshot.reserved_output_tokens, 10_000);
  assert.equal(snapshot.usable_input_window_tokens, 70_000);
  assert.equal(snapshot.tool_schema_tokens, AGENT_TOOL_SCHEMA_TOKENS);
  assert.equal(snapshot.estimated_input_tokens, snapshot.message_estimated_tokens + AGENT_TOOL_SCHEMA_TOKENS);
  assert.equal(snapshot.basis, "model_agnostic_estimate");
  assert.equal(snapshot.confidence, "medium");
});

test("buildContextBudgetSnapshot returns unknown for invalid context policy", () => {
  const snapshot = buildContextBudgetSnapshot({
    toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
    model: "gpt-test",
    provider: "openai",
    budget: {
      enabled: true,
      requestKind: "agent_turn",
      contextWindowTokens: 100_000,
      usableContextWindowTokens: 1_000,
      reservedOutputTokens: 2_000,
      usableInputWindowTokens: null,
      thresholdRatio: 0.9,
      thresholdTokens: null,
      effectiveInputBudgetTokens: null,
      invalidReason: "invalid_context_policy",
    },
    conversation: [],
    checkpoint: null,
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assert.deepEqual(snapshot, {
    status: "unknown",
    model: "gpt-test",
    provider: "openai",
    reason: "invalid_context_policy",
    source: "durable_reconstruction",
    phase: "idle",
    turn_id: null,
    checked_at: "2026-05-24T10:00:00.000Z",
    stale: false,
    updated_at: "2026-05-24T10:00:00.000Z",
  });
});

test("active compaction and durable meter use the same anchored total", () => {
  const requestIdentity: ContextRequestIdentity = { provider: "openai", model: "gpt-test",
    reasoning: { enabled: false }, requestMode: "openai_responses", checkpointId: null, tools: [] };
  const conversation: CanonicalMessage[] = [{ role: "user", content: "hello" }];
  const usageAnchor = { llmCallId: "call-1", baseline: captureContextBaseline(conversation, requestIdentity),
    usage: { input_tokens: 64_000, output_tokens: 20_000 } };
  const args = { model: "gpt-test", provider: "openai", budget: KNOWN_BUDGET,
    conversation, usageAnchor, requestIdentity, checkpoint: null, toolSchemaTokens: 100 };
  const snapshot = buildContextBudgetSnapshot(args);
  const decision = buildContextBudgetDecision({ ...args, source: "active_agent_decision" });
  assertAvailable(snapshot);
  assert.equal(snapshot.estimated_input_tokens, 64_000);
  assert.equal(snapshot.basis, "provider_token_count");
  assert.equal(decision.estimatedTokens, snapshot.estimated_input_tokens);
  assert.equal(decision.shouldCompact, true);
  assert.equal(snapshot.breakdown.reduce((n, row) => n + row.percent_of_estimated_input, 0), 1);
  assert.notEqual(snapshot.breakdown.reduce((n, row) => n + row.tokens, 0), snapshot.estimated_input_tokens);
  conversation.push({ role: "assistant", content: "response" });
  const appended = buildContextBudgetSnapshot(args);
  assertAvailable(appended);
  assert.equal(appended.basis, "provider_usage_trigger");
  assert.equal(appended.estimated_input_tokens, 64_000 + appended.provider_usage_estimate!.delta_tokens);
  assert.ok(appended.estimated_input_tokens < 65_000, "raw output usage is not replayed input");
});

test("buildContextBudgetSnapshot carries checkpoint metadata and stale state", () => {
  const checkpoint = {
    checkpointId: "checkpoint-1",
    compactedThroughMessageId: "message-1",
    compactedThroughLlmCallId: "llm-call-1",
  } as AgentContextCheckpoint;

  const snapshot = buildContextBudgetSnapshot({
    toolSchemaTokens: AGENT_TOOL_SCHEMA_TOKENS,
    model: "gpt-test",
    provider: "openai",
    budget: KNOWN_BUDGET,
    conversation: [],
    checkpoint,
    stale: true,
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assertAvailable(snapshot);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.source, "durable_reconstruction");
  assert.equal(snapshot.phase, "idle");
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.turn_id, null);
  assert.equal(snapshot.checked_at, "2026-05-24T10:00:00.000Z");
  assert.equal(snapshot.latest_checkpoint_id, "checkpoint-1");
  assert.equal(snapshot.compacted_through_message_id, "message-1");
  assert.equal(snapshot.compacted_through_llm_call_id, "llm-call-1");
});

function assertAvailable(
  snapshot: ContextBudgetSnapshot,
): asserts snapshot is Extract<ContextBudgetSnapshot, { status: "available" }> {
  assert.equal(snapshot.status, "available");
}
