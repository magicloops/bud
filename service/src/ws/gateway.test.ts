import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  type SessionTracker,
} from "./gateway.js";

function makeSocket() {
  let readyState = 1;
  const socket = {
    OPEN: 1,
    get readyState() {
      return readyState;
    },
    close() {
      readyState = 3;
    },
    send() {
      // noop
    },
  };

  return socket as SessionTracker["socket"];
}

function makeTracker(budId: string, sessionId: string): SessionTracker {
  return {
    budId,
    sessionId,
    lastHeartbeat: Date.now(),
    socket: makeSocket(),
  };
}

test("registerActiveSessionTracker replaces the active tracker and clears the previous timeout", () => {
  const activeSessions = new Map<string, SessionTracker>();
  const previous = makeTracker("bud-1", "session-old");
  previous.timeout = setTimeout(() => undefined, 60_000);
  activeSessions.set(previous.budId, previous);

  const next = makeTracker("bud-1", "session-new");
  const replaced = registerActiveSessionTracker(activeSessions, next);

  assert.equal(replaced, previous);
  assert.equal(activeSessions.get("bud-1"), next);
  assert.equal(previous.timeout, undefined);
});

test("deleteSessionTrackerIfCurrent ignores stale tracker cleanup after replacement", () => {
  const activeSessions = new Map<string, SessionTracker>();
  const stale = makeTracker("bud-1", "session-old");
  registerActiveSessionTracker(activeSessions, stale);

  const current = makeTracker("bud-1", "session-new");
  registerActiveSessionTracker(activeSessions, current);

  assert.equal(deleteSessionTrackerIfCurrent(activeSessions, stale), false);
  assert.equal(activeSessions.get("bud-1"), current);
  assert.equal(deleteSessionTrackerIfCurrent(activeSessions, current), true);
  assert.equal(activeSessions.has("bud-1"), false);
});

test("getActiveSessionTracker only returns the currently registered tracker", () => {
  const activeSessions = new Map<string, SessionTracker>();
  const stale = makeTracker("bud-1", "session-old");
  const current = makeTracker("bud-1", "session-new");

  registerActiveSessionTracker(activeSessions, stale);
  registerActiveSessionTracker(activeSessions, current);

  assert.equal(getActiveSessionTracker(activeSessions, "bud-1", stale), null);
  assert.equal(getActiveSessionTracker(activeSessions, "bud-1", current), current);
});
