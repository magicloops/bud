import assert from "node:assert/strict";
import test from "node:test";
import {
  getCatalogEntry,
  getGlobalDefaultModelEntry,
  getReasoningLevelOptions,
  listCatalogEntries,
} from "./model-catalog.js";

test("model catalog exposes the current default model lineup", () => {
  const modelIds = listCatalogEntries().map((entry) => entry.id);

  assert.deepEqual(modelIds, [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-7",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
    "ds4-deepseek-v4-flash",
  ]);
  assert.equal(getGlobalDefaultModelEntry().id, "gpt-5.5");
});

test("model catalog captures provider-specific reasoning levels", () => {
  const gpt54 = getCatalogEntry("gpt-5.4");
  const opus46 = getCatalogEntry("claude-opus-4-6");
  const opus47 = getCatalogEntry("claude-opus-4-7");
  const haiku45 = getCatalogEntry("claude-haiku-4-5");
  const ds4 = getCatalogEntry("ds4-deepseek-v4-flash");

  assert.ok(gpt54);
  assert.deepEqual(gpt54.reasoning.levels, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(gpt54.reasoning.defaultLevel, "none");

  const gpt55 = getCatalogEntry("gpt-5.5");
  assert.ok(gpt55);
  assert.deepEqual(gpt55.reasoning.levels, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(gpt55.reasoning.defaultLevel, "low");

  assert.ok(opus46);
  assert.deepEqual(opus46.reasoning.levels, ["low", "medium", "high", "max"]);
  assert.equal(opus46.reasoning.defaultLevel, "high");

  assert.ok(opus47);
  assert.deepEqual(opus47.reasoning.levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(opus47.reasoning.defaultLevel, "xhigh");

  assert.ok(haiku45);
  assert.deepEqual(haiku45.reasoning.levels, ["none", "low", "medium", "high"]);

  assert.ok(ds4);
  assert.equal(ds4.reasoning.kind, "ds4_responses_reasoning_effort");
  assert.deepEqual(ds4.reasoning.levels, ["none", "low"]);
  assert.equal(ds4.reasoning.defaultLevel, "none");
  assert.equal(
    ds4.reasoning.kind === "ds4_responses_reasoning_effort"
      ? ds4.reasoning.maxRequiresContextWindowTokens
      : null,
    393_216,
  );
});

test("model catalog captures GPT-5.5 usable context policy", () => {
  const gpt55 = getCatalogEntry("gpt-5.5");
  assert.ok(gpt55);

  assert.equal(gpt55.capabilities.contextWindowTokens, 1_050_000);
  assert.equal(gpt55.capabilities.usableContextWindowTokens, 400_000);
  assert.equal(gpt55.capabilities.maxOutputTokens, 128_000);
  assert.equal(gpt55.capabilities.reservedOutputTokens, 128_000);
});

test("model catalog captures ds4 output capability and reserved budget", () => {
  const ds4 = getCatalogEntry("ds4-deepseek-v4-flash");
  assert.ok(ds4);

  assert.equal(ds4.capabilities.contextWindowTokens, 100_000);
  assert.equal(ds4.capabilities.maxOutputTokens, 384_000);
  assert.equal(ds4.capabilities.reservedOutputTokens, 20_000);
});

test("reasoning option labels are stable for API clients", () => {
  const opus47 = getCatalogEntry("claude-opus-4-7");
  const ds4 = getCatalogEntry("ds4-deepseek-v4-flash");
  assert.ok(opus47);
  assert.ok(ds4);

  assert.deepEqual(getReasoningLevelOptions(opus47), [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
    { value: "max", label: "Max" },
  ]);
  assert.deepEqual(getReasoningLevelOptions(ds4), [
    { value: "none", label: "Fast" },
    { value: "low", label: "Thinking" },
  ]);
});
