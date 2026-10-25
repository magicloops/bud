import assert from "node:assert/strict";
import test from "node:test";
import type { ValidEvent } from "./contracts.js";
import { followUpRequests } from "./follow-ups.js";

const event = (eventType: string, payload: unknown, at: string): ValidEvent => ({ line: 1, eventId: at, eventType, schemaVersion: 1,
  occurredAt: new Date(at), recordedAt: new Date(at), envelope: { payload }, payloadHash: "", byteLength: 0 });

test("a batch asks about places with non-initial region reports or follow-up readings, latest direction first", () => {
  const home = "01M5KD6NQN33ZS31CJ8NRXDXCZ", office = "01M5DV10ZNSFWHYS34RCZ6F1PR";
  const requests = followUpRequests([
    event("location.region_transition.v1", { place_id: home, transition: "exited", initial: false }, "2026-10-24T20:00:00Z"),
    event("location.fix.v1", { follow_up: { place_id: home, transition: "entered" } }, "2026-10-24T20:05:00Z"),
    event("location.region_transition.v1", { place_id: office, transition: "entered", initial: true }, "2026-10-24T20:01:00Z"),
    event("location.fix.v1", { coordinate: { lat: 1, lon: 1 } }, "2026-10-24T20:02:00Z"),
    event("location.fix.v1", { follow_up: { place_id: "home", transition: "entered" } }, "2026-10-24T20:03:00Z"),
  ]);
  assert.deepEqual([...requests].map(([id, request]) => [id, request.transition]), [[home, "entered"]],
    "initial reports, plain fixes and malformed follow-ups ask nothing");
});
