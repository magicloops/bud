import assert from "node:assert/strict";
import test from "node:test";
import {
  BUD_ACCENT_PALETTE,
  assignBudAccentColor,
  fnv1a32,
  pickBudAccentColor,
} from "./bud-accent.js";

test("fnv1a32 is stable and matches the reference vectors", () => {
  // Standard FNV-1a 32-bit test vectors.
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

test("pickBudAccentColor is a pure function of the id and lands in the palette", () => {
  const first = pickBudAccentColor("b_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  const again = pickBudAccentColor("b_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  assert.equal(first, again);
  assert.ok(BUD_ACCENT_PALETTE.includes(first));
  // Different ids spread across the palette rather than collapsing to one slot.
  const seen = new Set(
    Array.from({ length: 50 }, (_, index) => pickBudAccentColor(`b_${index}`)),
  );
  assert.ok(seen.size > 1);
});

test("assignBudAccentColor prefers the least-used palette color", () => {
  const budId = "b_new";
  const hashed = pickBudAccentColor(budId);
  // Every color except one is taken once: the untaken one wins even if the
  // id hashes elsewhere.
  const free = BUD_ACCENT_PALETTE.find((color) => color !== hashed)!;
  const taken = BUD_ACCENT_PALETTE.filter((color) => color !== free);
  assert.equal(assignBudAccentColor(budId, taken), free);
});

test("assignBudAccentColor falls back to the hash slot on ties and ignores unknown colors", () => {
  const budId = "b_tie";
  assert.equal(assignBudAccentColor(budId, []), pickBudAccentColor(budId));
  assert.equal(
    assignBudAccentColor(budId, [null, undefined, "#ff0000", "oklch(0.5 0.1 10)"]),
    pickBudAccentColor(budId),
  );
  // All taken once each → still a tie → hash slot.
  assert.equal(assignBudAccentColor(budId, [...BUD_ACCENT_PALETTE]), pickBudAccentColor(budId));
});
