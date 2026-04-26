import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOperationTransition, isAllowedStreamTransition } from "./daemon-state.js";

test("operation lifecycle allows uncertain reconnect recovery paths", () => {
  assert.equal(isAllowedOperationTransition("offered", "accepted"), true);
  assert.equal(isAllowedOperationTransition("running", "unknown"), true);
  assert.equal(isAllowedOperationTransition("unknown", "running"), true);
  assert.equal(isAllowedOperationTransition("succeeded", "running"), false);
});

test("stream lifecycle allows half-close, reset, and unknown transitions", () => {
  assert.equal(isAllowedStreamTransition("opening", "open"), true);
  assert.equal(isAllowedStreamTransition("open", "half_closed_local"), true);
  assert.equal(isAllowedStreamTransition("half_closed_local", "closed"), true);
  assert.equal(isAllowedStreamTransition("open", "unknown"), true);
  assert.equal(isAllowedStreamTransition("closed", "open"), false);
});
