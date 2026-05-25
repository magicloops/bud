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
  type ContextBudgetUsageAnchor,
} from "./context-budget-snapshot.js";
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
      requestedModel: "gpt-5.5",
      serviceDefaultModel: "gpt-5.5",
      validateAvailability: false,
    });
    const budget = resolveContextBudget({
      model: selection.model,
      modelReasoning: selection.modelReasoning,
    });

    const snapshot = buildContextBudgetSnapshot({
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
      now: new Date("2026-05-24T10:00:00.000Z"),
    });

    assertAvailable(snapshot);
    assert.equal(snapshot.context_window_tokens, 1_050_000);
    assert.equal(snapshot.usable_context_window_tokens, 400_000);
    assert.equal(snapshot.reserved_output_tokens, 128_000);
    assert.equal(snapshot.usable_input_window_tokens, 272_000);
    assert.equal(snapshot.compaction_threshold_tokens, budget.thresholdTokens);
    assert.equal(snapshot.effective_budget_tokens, budget.effectiveInputBudgetTokens);
    assert.equal(snapshot.compaction_threshold_tokens, 258_400);
    assert.equal(snapshot.tool_schema_tokens, AGENT_TOOL_SCHEMA_TOKENS);
    assert.equal(snapshot.estimated_input_tokens, snapshot.message_estimated_tokens + AGENT_TOOL_SCHEMA_TOKENS);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("buildContextBudgetSnapshot returns unknown when model context window is unavailable", () => {
  const snapshot = buildContextBudgetSnapshot({
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

test("buildContextBudgetSnapshot reports provider usage only as diagnostics", () => {
  const usageAnchor: ContextBudgetUsageAnchor = {
    llmCallId: "llm-call-1",
    createdAt: new Date("2026-05-24T09:59:00.000Z"),
    provider: "openai",
    model: "gpt-test-provider",
    usage: {
      input_tokens: 1_000,
      output_tokens: 250,
    },
    reasoning: {
      enabled: false,
    },
  };

  const snapshot = buildContextBudgetSnapshot({
    model: "gpt-test",
    provider: "openai",
    budget: KNOWN_BUDGET,
    conversation: [
      {
        role: "user",
        content: [{ type: "text", text: "This rough estimate should not win." }],
      },
    ],
    checkpoint: null,
    usageAnchor,
    deltaMessages: [],
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assertAvailable(snapshot);
  assert.equal(snapshot.basis, "model_agnostic_estimate");
  assert.equal(snapshot.confidence, "medium");
  assert.equal(snapshot.provider_usage_estimate?.estimated_input_tokens, 1_250);
  assert.equal(snapshot.provider_usage_estimate?.input_tokens, 1_000);
  assert.equal(snapshot.provider_usage_estimate?.output_tokens, 250);
  assert.equal(snapshot.provider_usage_estimate?.llm_call_id, "llm-call-1");
  assert.equal(snapshot.provider_usage_estimate?.confidence, "high");
});

test("buildContextBudgetSnapshot keeps backend trigger estimate primary when provider diagnostics exceed threshold", () => {
  const budget: ContextBudget = {
    ...KNOWN_BUDGET,
    thresholdTokens: 27_200,
    effectiveInputBudgetTokens: 27_200,
  };
  const usageAnchor: ContextBudgetUsageAnchor = {
    llmCallId: "llm-call-2",
    createdAt: new Date("2026-05-24T09:59:00.000Z"),
    provider: "openai",
    model: "gpt-test-provider",
    usage: {
      input_tokens: 32_000,
      output_tokens: 3_000,
    },
    reasoning: {
      enabled: false,
    },
  };

  const snapshot = buildContextBudgetSnapshot({
    model: "gpt-test",
    provider: "openai",
    budget,
    conversation: [
      {
        role: "user",
        content: "x".repeat((15_142 - 8) * 4),
      },
    ],
    checkpoint: null,
    usageAnchor,
    deltaMessages: [],
    now: new Date("2026-05-24T10:00:00.000Z"),
  });

  assertAvailable(snapshot);
  assert.equal(snapshot.message_estimated_tokens, 15_142);
  assert.equal(snapshot.tool_schema_tokens, AGENT_TOOL_SCHEMA_TOKENS);
  assert.equal(snapshot.estimated_input_tokens, 15_142 + AGENT_TOOL_SCHEMA_TOKENS);
  assert.equal(snapshot.provider_usage_estimate?.estimated_input_tokens, 35_000);
  assert.equal(snapshot.percent_of_context_budget, (15_142 + AGENT_TOOL_SCHEMA_TOKENS) / 27_200);
  assert.equal(snapshot.basis, "model_agnostic_estimate");
});

test("buildContextBudgetSnapshot carries checkpoint metadata and stale state", () => {
  const checkpoint = {
    checkpointId: "checkpoint-1",
    compactedThroughMessageId: "message-1",
    compactedThroughLlmCallId: "llm-call-1",
  } as AgentContextCheckpoint;

  const snapshot = buildContextBudgetSnapshot({
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
