import test from "node:test";
import assert from "node:assert/strict";
import { browserColorSeed } from "./color.js";
import { BUD_ACCENT_PALETTE } from "../bud-accent.js";

test("accent seeds encode the palette, grayscale, and a custom hue as clipped sRGB", () => {
  assert.deepEqual(BUD_ACCENT_PALETTE.map(browserColorSeed), [
    "#EE50E6", "#F94B00", "#00BEB6", "#8E8AFF", "#37AF08",
  ]);
  assert.equal(browserColorSeed("oklch(0.70 0 0)"), "#9E9E9E");
  assert.equal(browserColorSeed("oklch(0.70 0 280)"), "#9E9E9E");
  assert.equal(browserColorSeed("oklch(0.65 0.10 90)"), "#A78C41");
});

test("invalid or out-of-policy accents never become profile seeds", () => {
  for (const color of ["", "#ABCDEF", "red", "oklch(NaN 0 0)",
    "oklch(0.5 0.1 10)", "oklch(0.9 0.1 10)", "oklch(0.7 0.4 10)",
    "oklch(0.7 0.1 360)", "oklch(0.7 0.1 -1)", "oklch(0.7 0.1 10); color:red"]) {
    assert.equal(browserColorSeed(color), undefined, color);
  }
});
