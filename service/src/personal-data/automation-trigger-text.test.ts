import assert from "node:assert/strict";
import test from "node:test";
import { admissionText, duration, localTime, timeAgo, timeZoneLine, when } from "./automation-trigger-text.js";

test("trigger times read as people say them, in the phone's time zone", () => {
  const zone = "America/Los_Angeles";
  const now = new Date("2026-10-24T00:40:00Z"); // 5:40 PM PDT on Oct 23
  assert.equal(localTime(new Date("2026-10-24T00:36:00Z"), zone, now), "5:36 PM");
  assert.equal(localTime(new Date("2026-10-23T06:10:00Z"), zone, now), "yesterday at 11:10 PM");
  assert.equal(localTime(new Date("2026-10-20T16:05:00Z"), zone, now), "Tue, Oct 20 at 9:05 AM");
  // Without a reported zone: UTC, labelled.
  assert.equal(localTime(new Date("2026-10-24T00:36:00Z"), null, now), "12:36 AM UTC");
  assert.equal(timeAgo(new Date(now.getTime() - 30_000), now), null);
  assert.equal(timeAgo(new Date(now.getTime() - 60_000), now), "about a minute ago");
  assert.equal(timeAgo(new Date(now.getTime() - 4 * 60_000), now), "about 4 minutes ago");
  assert.equal(timeAgo(new Date(now.getTime() - 3 * 3600_000), now), "about 3 hours ago");
  assert.equal(timeAgo(new Date(now.getTime() - 3 * 86_400_000), now), null);
  assert.equal(when(new Date("2026-10-24T00:36:00Z"), zone, now), "5:36 PM (about 4 minutes ago)");
  assert.equal(timeZoneLine(zone), "Times are in America/Los_Angeles, the phone's time zone.");
});

test("durations read naturally", () => {
  assert.equal(duration(20), "1 minute");
  assert.equal(duration(25 * 60), "25 minutes");
  assert.equal(duration(100 * 60), "about 2 hours");
  assert.equal(duration(93_665), "about 26 hours", "not 1561 minutes (October 24)");
  assert.equal(duration(3 * 86_400), "about 3 days");
});

test("the run's input puts the event first, the instruction next and bookkeeping last", () => {
  assert.equal(admissionText({ event: "Arrived at Home at 5:36 PM.", instruction: "Remind me to water the plants.",
    automationName: "Arrive at Home", automationId: "rule-1", reference: ["Times are in UTC."] }),
  "Arrived at Home at 5:36 PM.\n\nRemind me to water the plants.\n\n---\n" +
    "For reference. Don't mention these details unless the instruction asks for them.\n" +
    "- Triggered by the \"Arrive at Home\" automation (ID rule-1).\n- Times are in UTC.\n" +
    "- Your reply appears in this conversation, and its start is shown as a push notification.");
});
