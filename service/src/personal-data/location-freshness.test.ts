import assert from "node:assert/strict";
import test from "node:test";
import { freshness, type RecentReading } from "./location.js";

const now = new Date("2026-11-07T03:10:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const fix = (minutes: number, lat: number, extra: Partial<RecentReading> = {}): RecentReading =>
  ({ kind: "fix", coordinate: { lat, lon: -122.4184 }, horizontal_accuracy_m: 10, at: ago(minutes), ...extra });

test("Phase 13 freshness: since, moving and a note from the recent readings", () => {
  // Three fixes in about the same spot: here since the earliest, not moving, and no visit is open.
  const still = freshness([fix(2, 37.75260), fix(6, 37.75262), fix(12, 37.75258)], null, now);
  assert.deepEqual([still.since, still.moving], [ago(12), false]);
  assert.equal(still.now_note, "Latest reading 2 minutes ago, in about the same spot for 12 minutes; no visit open, so the owner may have left.");
  // The run stops at the first reading away from the newest.
  assert.deepEqual(freshness([fix(2, 37.7526), fix(6, 37.7526), fix(12, 37.7600)], null, now).since, ago(6));
  // Speed says moving even when the readings are close.
  assert.equal(freshness([fix(1, 37.7526, { speed_mps: 1.4 })], null, now).moving, true);
  assert.equal(freshness([fix(1, 37.7526, { speed_mps: 0.2 })], null, now).moving, false);
  // One reading without a speed: unknown.
  assert.equal(freshness([fix(1, 37.7526)], null, now).moving, null);
  // An open visit: since its arrival.
  const visit = freshness([fix(8, 37.7526), { kind: "visit", coordinate: { lat: 37.7527, lon: -122.4183 }, horizontal_accuracy_m: 25,
    at: ago(12), visit_id: "v" }], { arrival_at: ago(12), started_at: ago(12) }, now);
  assert.deepEqual([visit.since, visit.moving], [ago(12), false]);
  assert.equal(visit.now_note, "Probably still here: a visit open for 12 minutes and the latest reading 8 minutes ago.");
  // Old: may have moved.
  assert.equal(freshness([fix(180, 37.7526)], null, now).now_note, "Last seen 3 hours ago; may have moved since.");
  assert.deepEqual(freshness([], null, now), { since: null, moving: null, now_note: null });
});
