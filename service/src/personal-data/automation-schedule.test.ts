import assert from "node:assert/strict";
import test from "node:test";
import { isTimeZone, latestWindowAtOrBefore, localTimeToInstant, nextWindowAfter } from "./automation-schedule.js";

const daily = (local_time: string, timezone: string) => ({ local_time, weekdays: [1, 2, 3, 4, 5, 6, 7], timezone });

test("local times resolve through the zone's offset, including half-hour zones", () => {
  assert.equal(localTimeToInstant(2026, 1, 15, 9, 0, "America/Los_Angeles").toISOString(), "2026-01-15T17:00:00.000Z");
  assert.equal(localTimeToInstant(2026, 7, 15, 9, 0, "America/Los_Angeles").toISOString(), "2026-07-15T16:00:00.000Z");
  assert.equal(localTimeToInstant(2026, 7, 15, 9, 0, "Asia/Kolkata").toISOString(), "2026-07-15T03:30:00.000Z");
  assert.equal(localTimeToInstant(2026, 7, 15, 9, 0, "UTC").toISOString(), "2026-07-15T09:00:00.000Z");
});

test("a skipped spring-forward time shifts later and an ambiguous fall-back time uses its first occurrence", () => {
  // New York: 2026-03-08 02:00 EST jumps to 03:00 EDT; 2026-11-01 02:00 EDT falls back to 01:00 EST.
  assert.equal(localTimeToInstant(2026, 3, 8, 2, 30, "America/New_York").toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(localTimeToInstant(2026, 11, 1, 1, 30, "America/New_York").toISOString(), "2026-11-01T05:30:00.000Z");
});

test("ambiguous times use the earlier occurrence and skipped times shift by the gap, across zones", () => {
  // Fall back: London/Berlin 2026-10-25, Lord Howe (half-hour change) 2026-04-05.
  assert.equal(localTimeToInstant(2026, 10, 25, 1, 30, "Europe/London").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(localTimeToInstant(2026, 10, 25, 2, 30, "Europe/Berlin").toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(localTimeToInstant(2026, 4, 5, 1, 45, "Australia/Lord_Howe").toISOString(), "2026-04-04T14:45:00.000Z");
  // Spring forward: the nonexistent time lands after the gap.
  assert.equal(localTimeToInstant(2026, 3, 29, 1, 30, "Europe/London").toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(localTimeToInstant(2026, 10, 4, 2, 15, "Australia/Lord_Howe").toISOString(), "2026-10-03T15:45:00.000Z");
  // Unaffected times either side of a transition.
  assert.equal(localTimeToInstant(2026, 10, 24, 9, 0, "Europe/London").toISOString(), "2026-10-24T08:00:00.000Z");
  assert.equal(localTimeToInstant(2026, 10, 26, 9, 0, "Europe/London").toISOString(), "2026-10-26T09:00:00.000Z");
});

test("the latest window is at or before now and respects weekdays", () => {
  const schedule = daily("09:00", "America/Los_Angeles");
  assert.equal(latestWindowAtOrBefore(schedule, new Date("2026-07-15T16:00:00Z"))!.toISOString(), "2026-07-15T16:00:00.000Z");
  assert.equal(latestWindowAtOrBefore(schedule, new Date("2026-07-15T15:59:59Z"))!.toISOString(), "2026-07-14T16:00:00.000Z");
  // 2026-07-15 is a Wednesday; a Monday-only rule looks back to Monday the 13th.
  const monday = { ...schedule, weekdays: [1] };
  assert.equal(latestWindowAtOrBefore(monday, new Date("2026-07-15T20:00:00Z"))!.toISOString(), "2026-07-13T16:00:00.000Z");
  assert.equal(nextWindowAfter(monday, new Date("2026-07-15T20:00:00Z"))!.toISOString(), "2026-07-20T16:00:00.000Z");
});

test("windows follow the local wall clock across daylight-saving changes", () => {
  const schedule = daily("09:00", "America/New_York");
  assert.equal(latestWindowAtOrBefore(schedule, new Date("2026-03-07T20:00:00Z"))!.toISOString(), "2026-03-07T14:00:00.000Z");
  assert.equal(latestWindowAtOrBefore(schedule, new Date("2026-03-09T20:00:00Z"))!.toISOString(), "2026-03-09T13:00:00.000Z");
  assert.equal(nextWindowAfter(schedule, new Date("2026-10-31T20:00:00Z"))!.toISOString(), "2026-11-01T14:00:00.000Z");
});

test("the local date, not the UTC date, selects the weekday", () => {
  // 2026-07-13 23:30 in Los Angeles is Monday locally but Tuesday in UTC.
  const schedule = { local_time: "23:30", weekdays: [1], timezone: "America/Los_Angeles" };
  assert.equal(latestWindowAtOrBefore(schedule, new Date("2026-07-14T07:00:00Z"))!.toISOString(), "2026-07-14T06:30:00.000Z");
});

test("timezone validation accepts IANA names only", () => {
  assert.ok(isTimeZone("Europe/London"));
  assert.ok(!isTimeZone("Mars/Olympus"));
  assert.ok(!isTimeZone(""));
});
