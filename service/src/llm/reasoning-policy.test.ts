import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidModelSelectionError,
  InvalidReasoningEffortError,
  resolveEffectiveModelSelection,
} from "./reasoning-policy.js";

test("resolveEffectiveModelSelection prefers explicit submitted selections", () => {
  const selection = resolveEffectiveModelSelection({
    requestedModel: "gpt-5.5",
    requestedReasoning: null,
    threadModel: "claude-opus-4-6",
    threadReasoning: "high",
    serviceDefaultModel: "claude-sonnet-4-6",
    validateAvailability: false,
  });

  assert.equal(selection.model, "gpt-5.5");
  assert.equal(selection.reasoningEffort, "low");
  assert.equal(selection.source, "explicit_request");
});

test("resolveEffectiveModelSelection uses stored thread selection when no model is submitted", () => {
  const selection = resolveEffectiveModelSelection({
    threadModel: "claude-opus-4-6",
    threadReasoning: "medium",
    serviceDefaultModel: "gpt-5.5",
    validateAvailability: false,
  });

  assert.equal(selection.model, "claude-opus-4-6");
  assert.equal(selection.reasoningEffort, "medium");
  assert.equal(selection.source, "thread");
});

test("resolveEffectiveModelSelection falls back to service default for invalid stored thread selection", () => {
  const selection = resolveEffectiveModelSelection({
    threadModel: "missing-model",
    threadReasoning: "medium",
    serviceDefaultModel: "gpt-5.5",
    validateAvailability: false,
  });

  assert.equal(selection.model, "gpt-5.5");
  assert.equal(selection.reasoningEffort, "low");
  assert.equal(selection.source, "service_default");
  assert.equal(selection.storedModelValid, false);
});

test("resolveEffectiveModelSelection rejects null explicit model submissions", () => {
  assert.throws(
    () =>
      resolveEffectiveModelSelection({
        requestedModel: null,
        serviceDefaultModel: "gpt-5.5",
        validateAvailability: false,
      }),
    InvalidModelSelectionError,
  );
});

test("resolveEffectiveModelSelection rejects unsupported explicit reasoning", () => {
  assert.throws(
    () =>
      resolveEffectiveModelSelection({
        requestedModel: "gpt-5.5",
        requestedReasoning: "max",
        serviceDefaultModel: "gpt-5.5",
        validateAvailability: false,
      }),
    InvalidReasoningEffortError,
  );
});

test("resolveEffectiveModelSelection accepts ds4 thinking and rejects ds4 max", () => {
  const thinking = resolveEffectiveModelSelection({
    requestedModel: "ds4-deepseek-v4-flash",
    requestedReasoning: "low",
    serviceDefaultModel: "gpt-5.5",
    validateAvailability: false,
  });

  assert.equal(thinking.model, "ds4-deepseek-v4-flash");
  assert.equal(thinking.reasoningEffort, "low");
  assert.deepEqual(thinking.modelReasoning.reasoning, {
    enabled: true,
    effort: "low",
    summaryLevel: "auto",
  });

  assert.throws(
    () =>
      resolveEffectiveModelSelection({
        requestedModel: "ds4-deepseek-v4-flash",
        requestedReasoning: "max",
        serviceDefaultModel: "gpt-5.5",
        validateAvailability: false,
      }),
    InvalidReasoningEffortError,
  );
});
