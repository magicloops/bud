import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidModelSelectionError,
  InvalidReasoningEffortError,
  resolveEffectiveModelSelection,
} from "./reasoning-policy.js";

test("resolveEffectiveModelSelection prefers explicit submitted selections", () => {
  const selection = resolveEffectiveModelSelection({
    requestedModel: "gpt-5.6-sol",
    requestedReasoning: null,
    threadModel: "claude-opus-4-6",
    threadReasoning: "high",
    serviceDefaultModel: "claude-sonnet-4-6",
    validateAvailability: false,
  });

  assert.equal(selection.model, "gpt-5.6-sol");
  assert.equal(selection.reasoningEffort, "low");
  assert.equal(selection.source, "explicit_request");
});

test("resolveEffectiveModelSelection uses stored thread selection when no model is submitted", () => {
  const selection = resolveEffectiveModelSelection({
    threadModel: "claude-opus-4-6",
    threadReasoning: "medium",
    serviceDefaultModel: "gpt-5.6-sol",
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
    serviceDefaultModel: "gpt-5.6-sol",
    validateAvailability: false,
  });

  assert.equal(selection.model, "gpt-5.6-sol");
  assert.equal(selection.reasoningEffort, "medium");
  assert.equal(selection.source, "service_default");
  assert.equal(selection.storedModelValid, false);
});

test("resolveEffectiveModelSelection rejects null explicit model submissions", () => {
  assert.throws(
    () =>
      resolveEffectiveModelSelection({
        requestedModel: null,
        serviceDefaultModel: "gpt-5.6-sol",
        validateAvailability: false,
      }),
    InvalidModelSelectionError,
  );
});

test("resolveEffectiveModelSelection rejects unsupported explicit reasoning", () => {
  assert.throws(
    () =>
      resolveEffectiveModelSelection({
        requestedModel: "gpt-5.6-sol",
        requestedReasoning: "minimal",
        serviceDefaultModel: "gpt-5.6-sol",
        validateAvailability: false,
      }),
    InvalidReasoningEffortError,
  );
});

test("gpt-5.6 family accepts max and luna defaults to high", () => {
  const solMax = resolveEffectiveModelSelection({
    requestedModel: "gpt-5.6-sol",
    requestedReasoning: "max",
    serviceDefaultModel: "gpt-5.6-luna",
    validateAvailability: false,
  });
  assert.equal(solMax.model, "gpt-5.6-sol");
  assert.equal(solMax.reasoningEffort, "max");
  assert.deepEqual(solMax.modelReasoning.reasoning, {
    enabled: true,
    effort: "max",
    summaryLevel: "auto",
  });

  const lunaDefault = resolveEffectiveModelSelection({
    serviceDefaultModel: "gpt-5.6-luna",
    validateAvailability: false,
  });
  assert.equal(lunaDefault.model, "gpt-5.6-luna");
  assert.equal(lunaDefault.reasoningEffort, "high");
});

test("resolveEffectiveModelSelection accepts ds4 thinking and rejects ds4 max", () => {
  const thinking = resolveEffectiveModelSelection({
    requestedModel: "ds4-deepseek-v4-flash",
    requestedReasoning: "low",
    serviceDefaultModel: "gpt-5.6-sol",
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
        serviceDefaultModel: "gpt-5.6-sol",
        validateAvailability: false,
      }),
    InvalidReasoningEffortError,
  );
});


test("Astra validates its own reasoning levels and rejects none", () => {
  for (const requestedReasoning of [undefined, "low", "medium", "high", "xhigh", "max"]) {
    const selection = resolveEffectiveModelSelection({ requestedModel: "gpt-6-astra", requestedReasoning,
      serviceDefaultModel: "gpt-5.6-luna", validateAvailability: false });
    assert.equal(selection.reasoningEffort, requestedReasoning ?? "medium");
  }
  assert.throws(() => resolveEffectiveModelSelection({ requestedModel: "gpt-6-astra", requestedReasoning: "none",
    serviceDefaultModel: "gpt-5.6-luna", validateAvailability: false }), InvalidReasoningEffortError);
});

test("retired stored models fall back and retain requested attribution", () => {
  const input = { threadModel: "gpt-5.5", serviceDefaultModel: "gpt-5.6-luna" };
  assert.equal(resolveEffectiveModelSelection({ ...input, validateAvailability: false }).storedModelValid, false);
  const selection = resolveEffectiveModelSelection({ ...input, validateAvailability: false });
  assert.equal(selection.model, "gpt-5.6-luna");
  assert.equal(selection.fallbackFrom, "gpt-5.5");
});


test("unavailable saved local models never fall back to cloud", () => {
  assert.throws(() => resolveEffectiveModelSelection({ threadModel: "bud-local:owned:offline",
    serviceDefaultModel: "gpt-5.6-luna", validateAvailability: false }), InvalidModelSelectionError);
});

test("stale client retirement fallback is explicit and unknown fresh IDs remain errors", () => {
  const input = { serviceDefaultModel: "gpt-6-astra", validateAvailability: false, allowRetiredFallback: true };
  const resolved = resolveEffectiveModelSelection({ ...input, requestedModel: "gpt-5.5", requestedReasoning: "none" });
  assert.equal(resolved.model, "gpt-6-astra");
  assert.equal(resolved.reasoningEffort, "medium");
  assert.equal(resolved.reasoningAdjusted, true);
  assert.throws(() => resolveEffectiveModelSelection({ ...input, requestedModel: "typo-model" }), InvalidModelSelectionError);
});
