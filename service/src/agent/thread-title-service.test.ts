import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGeneratedThreadTitle } from "./thread-title-service.js";

test("normalizeGeneratedThreadTitle trims labels and punctuation", () => {
  assert.equal(
    normalizeGeneratedThreadTitle('Title: "Fix OAuth Callback Flow."'),
    "Fix OAuth Callback Flow",
  );
});

test("normalizeGeneratedThreadTitle preserves longer titles", () => {
  assert.equal(
    normalizeGeneratedThreadTitle("Investigate missing session stream reconnection bug"),
    "Investigate missing session stream reconnection bug",
  );
});

test("normalizeGeneratedThreadTitle accepts short titles", () => {
  assert.equal(normalizeGeneratedThreadTitle("Bugfix"), "Bugfix");
  assert.equal(normalizeGeneratedThreadTitle("Assistant Introduction"), "Assistant Introduction");
});
