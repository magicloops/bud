import assert from "node:assert/strict";
import test from "node:test";
import type { ValidEvent } from "./contracts.js";
import { followUpRequests } from "./follow-ups.js";

const event = (eventType: string, payload: unknown, at: string): ValidEvent => ({ line: 1, eventId: at, eventType, schemaVersion: 1,
  occurredAt: new Date(at), recordedAt: new Date(at), envelope: { payload }, payloadHash: "", byteLength: 0 });

test("a batch asks about follow-ups by ID, from tagged region reports and follow-up readings", () => {
  const home = "01M5KD6NQN33ZS31CJ8NRXDXCZ", office = "01M5DV10ZNSFWHYS34RCZ6F1PR";
  const requests = followUpRequests([
    event("location.region_transition.v1", { place_id: home, transition: "exited", initial: false, geometry_revision: "7",
      follow_up_id: "exit-1" }, "2026-10-24T20:00:00Z"),
    event("location.fix.v1", { follow_up: { id: "entry-2", place_id: home, geometry_revision: "7", transition: "entered" } }, "2026-10-24T20:05:00Z"),
    event("location.region_transition.v1", { place_id: office, transition: "entered", initial: false, geometry_revision: "3" },
      "2026-10-24T20:01:00Z"),
    event("location.fix.v1", { coordinate: { lat: 1, lon: 1 } }, "2026-10-24T20:02:00Z"),
    event("location.fix.v1", { follow_up: { id: "bad id!", place_id: home, geometry_revision: "7", transition: "entered" } }, "2026-10-24T20:03:00Z"),
  ]);
  assert.deepEqual([...requests], [
    ["exit-1", { placeId: home, revision: "7", transition: "exited" }],
    ["entry-2", { placeId: home, revision: "7", transition: "entered" }],
  ], "each follow-up separately; untagged reports, plain fixes and malformed IDs ask nothing");
});
