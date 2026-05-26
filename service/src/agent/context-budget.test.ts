import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { getCatalogEntry, resolveEffectiveModelSelection } from "../llm/index.js";
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
    assert.equal(budget.usableContextWindowTokens, 400_000);
    assert.equal(budget.reservedOutputTokens, 128_000);
    assert.equal(budget.usableInputWindowTokens, 272_000);
    assert.equal(budget.thresholdRatio, 0.95);
    assert.equal(budget.thresholdTokens, 258_400);
    assert.equal(budget.effectiveInputBudgetTokens, 258_400);
    assert.equal(shouldCompactContext({ estimatedTokens: 250_000, budget }), false);
    assert.equal(shouldCompactContext({ estimatedTokens: 260_000, budget }), true);
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
  config.agentAutoCompactionRatio = 0.95;
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

    assert.equal(budget.thresholdTokens, 258_400);
    assert.equal(budget.effectiveInputBudgetTokens, 272_000);
  } finally {
    config.agentAutoCompactionRatio = previousRatio;
    config.agentAutoCompactionEnabled = previousEnabled;
  }
});

test("resolveModelContextPolicy returns invalid policy when reserve exceeds usable window", () => {
  const entry = getCatalogEntry("gpt-5.4");
  assert.ok(entry);

  const policy = resolveModelContextPolicy({
    ...entry,
    capabilities: {
      ...entry.capabilities,
      usableContextWindowTokens: 1_000,
      reservedOutputTokens: 2_000,
    },
  });

  assert.equal(policy.contextWindowTokens, 1_050_000);
  assert.equal(policy.usableContextWindowTokens, 1_000);
  assert.equal(policy.reservedOutputTokens, 2_000);
  assert.equal(policy.usableInputWindowTokens, null);
  assert.equal(policy.invalidReason, "invalid_context_policy");
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
