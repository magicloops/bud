import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { getCatalogEntry, listCatalogEntries, resolveEffectiveModelSelection } from "../llm/index.js";
import {
  estimateCanonicalToolsTokens,
  resolveContextBudget,
  resolveModelContextPolicy,
  shouldCompactContext,
} from "./context-budget.js";

test("resolveModelContextPolicy defaults usable context and output reserve", () => {
  const entry = getCatalogEntry("gpt-5.4");
  assert.ok(entry);

  const policy = resolveModelContextPolicy(entry);

  assert.equal(policy.contextWindowTokens, 1_050_000);
  assert.equal(policy.usableContextWindowTokens, 1_050_000);
  assert.equal(policy.reservedOutputTokens, 128_000);
  assert.equal(policy.usableInputWindowTokens, 922_000);
  assert.equal(policy.invalidReason, null);
});

test("resolveContextBudget derives GPT-5.5 usable input threshold", () => {
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

    assert.equal(budget.contextWindowTokens, 1_050_000);
    assert.equal(budget.usableContextWindowTokens, 272_000);
    assert.equal(budget.reservedOutputTokens, 128_000);
    // The usable cap applies to input directly; the reserve only binds
    // against the hard window (1,050,000 - 128,000 = 922,000 > 272,000).
    assert.equal(budget.usableInputWindowTokens, 272_000);
    assert.equal(budget.thresholdRatio, 0.9);
    assert.equal(budget.thresholdTokens, 244_800);
    assert.equal(budget.effectiveInputBudgetTokens, 244_800);
    assert.equal(shouldCompactContext({ estimatedTokens: 240_000, budget }), false);
    assert.equal(shouldCompactContext({ estimatedTokens: 250_000, budget }), true);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveContextBudget derives valid ds4 usable input window", () => {
  const previousRatio = config.agentAutoCompactionRatio;
  const previousEnabled = config.agentAutoCompactionEnabled;
  config.agentAutoCompactionRatio = 1;
  config.agentAutoCompactionEnabled = true;
  try {
    const selection = resolveEffectiveModelSelection({
      requestedModel: "ds4-deepseek-v4-flash",
      serviceDefaultModel: "gpt-5.5",
      validateAvailability: false,
    });

    const budget = resolveContextBudget({
      model: selection.model,
      modelReasoning: selection.modelReasoning,
    });

    assert.equal(budget.contextWindowTokens, 100_000);
    assert.equal(budget.usableContextWindowTokens, 100_000);
    assert.equal(budget.reservedOutputTokens, 20_000);
    assert.equal(budget.usableInputWindowTokens, 80_000);
    assert.equal(budget.thresholdRatio, 0.9);
    assert.equal(budget.thresholdTokens, 72_000);
    assert.equal(budget.effectiveInputBudgetTokens, 72_000);
    assert.equal(budget.invalidReason, null);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveContextBudget honors lower auto-compaction ratio overrides", () => {
  const previousRatio = config.agentAutoCompactionRatio;
  const previousEnabled = config.agentAutoCompactionEnabled;
  config.agentAutoCompactionRatio = 0.4;
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

    assert.equal(budget.usableInputWindowTokens, 272_000);
    assert.equal(budget.thresholdRatio, 0.4);
    assert.equal(budget.thresholdTokens, 108_800);
    assert.equal(budget.effectiveInputBudgetTokens, 108_800);
    assert.equal(shouldCompactContext({ estimatedTokens: 108_799, budget }), false);
    assert.equal(shouldCompactContext({ estimatedTokens: 108_800, budget }), true);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveContextBudget uses usable input window for compaction summary budget", () => {
  const previousRatio = config.agentAutoCompactionRatio;
  const previousEnabled = config.agentAutoCompactionEnabled;
  config.agentAutoCompactionRatio = 0.9;
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
      requestKind: "compaction_summary",
    });

    assert.equal(budget.thresholdTokens, 244_800);
    assert.equal(budget.effectiveInputBudgetTokens, 272_000);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveModelContextPolicy returns invalid policy when reserve exceeds the hard window", () => {
  const entry = getCatalogEntry("gpt-5.4");
  assert.ok(entry);

  const policy = resolveModelContextPolicy({
    ...entry,
    capabilities: {
      ...entry.capabilities,
      contextWindowTokens: 1_000,
      reservedOutputTokens: 2_000,
    },
  });

  assert.equal(policy.contextWindowTokens, 1_000);
  assert.equal(policy.usableContextWindowTokens, 1_000);
  assert.equal(policy.reservedOutputTokens, 2_000);
  assert.equal(policy.usableInputWindowTokens, null);
  assert.equal(policy.invalidReason, "invalid_context_policy");
});

test("resolveModelContextPolicy treats a usable cap below the reserve as a small input window, not an error", () => {
  const entry = getCatalogEntry("gpt-5.4");
  assert.ok(entry);
  // The reserve binds against the hard window only; a 1K usable cap is a
  // (tiny) valid input budget.
  const policy = resolveModelContextPolicy({
    ...entry,
    capabilities: { ...entry.capabilities, usableContextWindowTokens: 1_000, reservedOutputTokens: 2_000 },
  });
  assert.equal(policy.usableInputWindowTokens, 1_000);
  assert.equal(policy.invalidReason, null);
});

test("estimateCanonicalToolsTokens includes serialized tool schemas", () => {
  const estimate = estimateCanonicalToolsTokens([
    {
      name: "example_tool",
      description: "Example tool.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: "Value to use." },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  ]);

  assert.ok(estimate > 20);
  assert.equal(estimateCanonicalToolsTokens([]), 0);
});

test("resolveContextBudget gives GPT-5.6 Sol the full 272K usable input window (Codex parity)", () => {
  const previousRatio = config.agentAutoCompactionRatio;
  const previousEnabled = config.agentAutoCompactionEnabled;
  config.agentAutoCompactionRatio = 0.9;
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
    assert.equal(budget.contextWindowTokens, 1_050_000);
    assert.equal(budget.usableContextWindowTokens, 272_000);
    assert.equal(budget.reservedOutputTokens, 128_000);
    // Previously 272,000 - 128,000 = 144,000 (threshold 136,800).
    assert.equal(budget.usableInputWindowTokens, 272_000);
    assert.equal(budget.thresholdTokens, 244_800);
    // Theoretical overshoot (threshold - 1 + full output) still fits the hard window.
    assert.ok(244_799 + 128_000 <= budget.contextWindowTokens);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveModelContextPolicy keeps the output reserve binding when the usable window is the hard window", () => {
  // gpt-5.4-mini: 400K hard, no usable cap, 128K reserve → input must leave room.
  const policy = resolveModelContextPolicy(getCatalogEntry("gpt-5.4-mini"));
  assert.equal(policy.usableContextWindowTokens, 400_000);
  assert.equal(policy.usableInputWindowTokens, 272_000);
});

test("every catalog entry satisfies usable_input + reserve <= hard and usable_input <= usable", () => {
  for (const entry of listCatalogEntries()) {
    const policy = resolveModelContextPolicy(entry);
    assert.equal(policy.invalidReason, null, entry.id);
    assert.ok(policy.usableInputWindowTokens! + policy.reservedOutputTokens! <= policy.contextWindowTokens!, entry.id);
    assert.ok(policy.usableInputWindowTokens! <= policy.usableContextWindowTokens!, entry.id);
  }
});
