import assert from "node:assert/strict";
import test from "node:test";
import {
  BUD_ACCENT_PALETTE,
  assignBudAccentColor,
  pickNextAccentColor,
  withFallbackAccentColors,
} from "./bud-accent.js";

const [pink, orange, cyan, purple, green] = BUD_ACCENT_PALETTE as [string, string, string, string, string];

test("pickNextAccentColor walks the palette in order and ignores unknown colors", () => {
  assert.equal(pickNextAccentColor([]), pink);
  assert.equal(pickNextAccentColor([pink]), orange);
  assert.equal(pickNextAccentColor([pink, orange]), cyan);
  assert.equal(pickNextAccentColor([null, undefined, "#ff0000", pink]), orange);
  // Gaps are filled before wrapping; a full cycle starts over at pink.
  assert.equal(pickNextAccentColor([pink, cyan]), orange);
  assert.equal(pickNextAccentColor([pink, orange, cyan, purple, green]), pink);
  assert.equal(pickNextAccentColor([pink, pink, orange, cyan, purple, green]), orange);
});

test("withFallbackAccentColors assigns NULL rows positionally by creation order", () => {
  const rows = [
    { budId: "b_3", accentColor: null, createdAt: new Date("2026-03-01") },
    { budId: "b_1", accentColor: null, createdAt: new Date("2026-01-01") },
    { budId: "b_2", accentColor: null, createdAt: new Date("2026-02-01") },
  ];
  // Input (list) order is preserved; colors follow creation order.
  assert.deepEqual(
    withFallbackAccentColors(rows).map((row) => [row.budId, row.accentColor]),
    [
      ["b_3", cyan],
      ["b_1", pink],
      ["b_2", orange],
    ],
  );
});

test("withFallbackAccentColors treats persisted colors as taken and tie-breaks on bud id", () => {
  const rows = [
    { budId: "b_a", accentColor: null, createdAt: "2026-01-01T00:00:00.000Z" },
    { budId: "b_b", accentColor: pink, createdAt: "2026-01-02T00:00:00.000Z" },
    { budId: "b_c", accentColor: null, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(
    withFallbackAccentColors(rows).map((row) => row.accentColor),
    [orange, pink, cyan],
  );
  // Missing timestamps sort first, ordered by id.
  assert.deepEqual(
    withFallbackAccentColors([
      { budId: "b_y", accentColor: null, createdAt: null },
      { budId: "b_x", accentColor: null, createdAt: null },
    ]).map((row) => row.accentColor),
    [orange, pink],
  );
});

test("assignBudAccentColor picks the first free color after resolving the owner's other Buds", () => {
  assert.equal(assignBudAccentColor([]), pink);
  assert.equal(
    assignBudAccentColor([{ budId: "b_1", accentColor: null, createdAt: new Date("2026-01-01") }]),
    orange,
  );
  assert.equal(
    assignBudAccentColor([
      { budId: "b_1", accentColor: purple, createdAt: new Date("2026-01-01") },
      { budId: "b_2", accentColor: null, createdAt: new Date("2026-01-02") },
    ]),
    orange,
  );
});
