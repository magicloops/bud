import assert from "node:assert/strict";
import test from "node:test";
import { earlierLine, nearbyLine, nearbyMatch, placeContext } from "./place-context.js";

const at = (...distances: number[]) => distances.map((distance, i) => ({ name: `Place ${i}`, distance_m: distance, category_label: "café" }));

test("how clear a visit's nearest candidate is: clear only when the next is further by more than the accuracy", () => {
  assert.equal(nearbyMatch(at(12), 20), "clear", "the only one, within reach");
  assert.equal(nearbyMatch(at(10, 20), 5), "clear", "a precise fix: 10 m further (the 10 m floor)");
  assert.equal(nearbyMatch(at(10, 19), 5), "several");
  assert.equal(nearbyMatch(at(15, 35), 96), "several", "November 5, 10:48: 20 m apart is within ±96 m");
  assert.equal(nearbyMatch(at(6, 120), 52), "clear", "the next is further than the accuracy");
  assert.equal(nearbyMatch(at(25, 28), 3), "several", "a precise visit still reaches 30 m");
  assert.equal(nearbyMatch(at(40, 60), 20), "none_close");
  assert.equal(nearbyMatch(at(40, 160), 80), "clear", "a coarse visit reaches further");
  assert.equal(nearbyMatch([], 20), "none_close");
  // An older or Apple-sourced name has no stored list: nothing to add.
  assert.deepEqual(placeContext({ nearby: null }, 20), {});
  assert.deepEqual(Object.keys(placeContext({ nearby: at(10) }, 20)), ["nearby_places", "match", "match_note"]);
});

test("trigger lines for a visit away from saved places", () => {
  assert.equal(nearbyLine([{ name: "Finjan Qahwa", category_label: "café", distance_m: 19.4 }, { name: "Cappstone", distance_m: 25 }], 100),
    "Nearby (OpenStreetMap, within 100 m; candidates, not verified): Finjan Qahwa (café, 19 m), Cappstone (25 m).");
  assert.equal(nearbyLine([], 100), null);
  const day = (date: Date) => date.toISOString().slice(0, 10);
  assert.equal(earlierLine({ count: 6, first_at: new Date("2026-10-12T00:00:00Z"), usual_place: "Finjan Qahwa" }, day),
    "Visited within 50 m 6 times before, since 2026-10-12; usually near Finjan Qahwa.");
  assert.equal(earlierLine({ count: 1, first_at: new Date("2026-10-12T00:00:00Z"), usual_place: null }, day),
    "Visited within 50 m once before, since 2026-10-12.");
  assert.equal(earlierLine({ count: 0 }, day), null);
});
