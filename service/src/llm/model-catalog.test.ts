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
  ]);
  assert.equal(getGlobalDefaultModelEntry().id, "claude-opus-4-6");
});

test("model catalog captures provider-specific reasoning levels", () => {
  const gpt54 = getCatalogEntry("gpt-5.4");
  const opus46 = getCatalogEntry("claude-opus-4-6");
  const opus47 = getCatalogEntry("claude-opus-4-7");
  const haiku45 = getCatalogEntry("claude-haiku-4-5");

  assert.ok(gpt54);
  assert.deepEqual(gpt54.reasoning.levels, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(gpt54.reasoning.defaultLevel, "none");

  assert.ok(opus46);
  assert.deepEqual(opus46.reasoning.levels, ["low", "medium", "high", "max"]);
  assert.equal(opus46.reasoning.defaultLevel, "high");

  assert.ok(opus47);
  assert.deepEqual(opus47.reasoning.levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(opus47.reasoning.defaultLevel, "xhigh");

  assert.ok(haiku45);
  assert.deepEqual(haiku45.reasoning.levels, ["none", "low", "medium", "high"]);
});

test("reasoning option labels are stable for API clients", () => {
  const opus47 = getCatalogEntry("claude-opus-4-7");
  assert.ok(opus47);

  assert.deepEqual(getReasoningLevelOptions(opus47), [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
    { value: "max", label: "Max" },
  ]);
});
