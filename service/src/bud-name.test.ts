import assert from "node:assert/strict";
import { test } from "node:test";

import { BUD_NAME_MAX_LENGTH, pickBudName } from "./bud-name.js";

test("free name is kept as-is (trimmed)", () => {
  assert.equal(pickBudName("mbp", []), "mbp");
  assert.equal(pickBudName("  mbp  ", ["other"]), "mbp");
});

test("collision suffixes from -2 upward, skipping taken slots", () => {
  assert.equal(pickBudName("host", ["host"]), "host-2");
  assert.equal(pickBudName("host", ["host", "host-2"]), "host-3");
  assert.equal(pickBudName("host", ["host", "host-3"]), "host-2");
});

test("stability: a reconnect hello with the raw hostname keeps the suffixed name", () => {
  // Bud stored as host-2; daemon still requests "host" on every hello.
  assert.equal(pickBudName("host", ["host"], "host-2"), "host-2");
  // And an unsuffixed current name is stable too.
  assert.equal(pickBudName("host", ["host-2"], "host"), "host");
});

test("a genuinely different requested name re-resolves fresh", () => {
  assert.equal(pickBudName("workbench", ["host"], "host-2"), "workbench");
  assert.equal(pickBudName("workbench", ["workbench"], "host-2"), "workbench-2");
});

test("stability does not keep a name another bud now holds", () => {
  assert.equal(pickBudName("host", ["host-2", "host"], "host-2"), "host-3");
});

test("lookalike suffixes are not treated as variants", () => {
  // "host-two" and "host-2x" are different names, not suffix variants.
  assert.equal(pickBudName("host", [], "host-two"), "host");
  assert.equal(pickBudName("host", [], "host-2x"), "host");
});

test("blank requested names fall back to bud", () => {
  assert.equal(pickBudName("   ", []), "bud");
  assert.equal(pickBudName("", ["bud"]), "bud-2");
});

test("length cap holds with and without suffixes", () => {
  const long = "x".repeat(200);
  const base = pickBudName(long, []);
  assert.equal(base.length, BUD_NAME_MAX_LENGTH);
  const suffixed = pickBudName(long, [base]);
  assert.equal(suffixed.length, BUD_NAME_MAX_LENGTH);
  assert.ok(suffixed.endsWith("-2"));
});
