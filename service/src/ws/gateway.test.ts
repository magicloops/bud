import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  sendFrameToBud,
  type SessionTracker,
} from "./gateway.js";
import { sessions } from "./session-trackers.js";

function makeSocket() {
  let readyState = 1;
  const sentFrames: string[] = [];
  const socket = {
    OPEN: 1,
    get readyState() {
      return readyState;
    },
    close() {
      readyState = 3;
    },
    send(payload: string) {
      sentFrames.push(payload);
    },
    sentFrames,
  };

  return socket as unknown as SessionTracker["socket"];
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

test("sendFrameToBud serializes frames onto the authoritative active socket", () => {
  sessions.clear();
  const tracker = makeTracker("bud-1", "session-current");
  sessions.set("bud-1", tracker);

  const sent = sendFrameToBud("bud-1", { type: "terminal_ensure", session_id: "sess-1" });

  assert.equal(sent, true);
  assert.deepEqual((tracker.socket as any).sentFrames, [
    JSON.stringify({ type: "terminal_ensure", session_id: "sess-1" }),
  ]);

  sessions.clear();
});

test("sendFrameToBud refuses closed sockets and unknown buds", () => {
  sessions.clear();

  assert.equal(sendFrameToBud("bud-missing", { type: "noop" }), false);

  const tracker = makeTracker("bud-1", "session-current");
  tracker.socket.close();
  sessions.set("bud-1", tracker);

  assert.equal(sendFrameToBud("bud-1", { type: "noop" }), false);
  assert.deepEqual((tracker.socket as any).sentFrames, []);

  sessions.clear();
});
