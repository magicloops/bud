import assert from "node:assert/strict";
import test from "node:test";
import { openNow } from "./opening-hours.js";

test("open now from OpenStreetMap hours, at the place's local time; unknown when it can't tell", () => {
  // 7:10 PM in San Francisco on Friday, November 6 (03:10 UTC on the 7th).
  const evening = new Date("2026-11-07T03:10:00Z");
  assert.deepEqual(openNow("Mo-Su 10:00-02:00", "America/Los_Angeles", evening),
    { open_now: true, next_change: "2026-11-07T10:00:00.000Z" }, "open until 2 AM local, 10:00 UTC");
  assert.equal(openNow("Mo-Fr 09:00-17:00", "America/Los_Angeles", evening).open_now, false, "an office, closed at 7 PM");
  assert.equal(openNow("Mo-Fr 09:00-17:00", "UTC", evening).open_now, false, "Saturday 03:10 in UTC");
  assert.equal(openNow("Mo-Su 10:00-02:00", "America/Los_Angeles", new Date("2026-11-07T08:30:00Z")).open_now, true, "12:30 AM: still open overnight");
  assert.equal(openNow("24/7", "America/Los_Angeles", evening).open_now, true);
  assert.deepEqual(openNow("not hours", "America/Los_Angeles", evening), { open_now: null, next_change: null });
  assert.deepEqual(openNow(null, "America/Los_Angeles", evening), { open_now: null, next_change: null });
  assert.equal(openNow("Mo-Su 10:00-02:00 \"call ahead\"; Th unknown", "America/Los_Angeles", new Date("2026-11-06T03:10:00Z")).open_now, null,
    "Thursday is unknown");
});
