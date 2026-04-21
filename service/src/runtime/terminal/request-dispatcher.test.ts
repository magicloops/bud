import assert from "node:assert/strict";
import test from "node:test";
import { TerminalRequestDispatcher } from "./request-dispatcher.js";
import type { TerminalSession } from "./session-types.js";

function createLogger() {
  return {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  } as never;
}

function createSession(sessionId = "sess_test"): TerminalSession {
  return {
    sessionId,
    threadId: "thread-1",
    budId: "bud-1",
    instanceId: null,
    state: "pending",
    cols: 200,
    rows: 50,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: null,
    lastActivityAt: null,
    outputLogBytes: 0,
  };
}

function createDispatcher(session = createSession()) {
  return new TerminalRequestDispatcher({
    logger: createLogger(),
    async getSession(sessionId: string) {
      return sessionId === session.sessionId ? session : null;
    },
    getSessionContext() {
      return { mode: "shell" };
    },
    getLatestReadiness() {
      return null;
    },
    getLastOffset() {
      return 0;
    },
    storeReadinessAssessment() {
      // noop
    },
    emitReadyEvent() {
      // noop
    },
    sendFrameToBud() {
      return true;
    },
    summarizeContextForLog() {
      return {};
    },
    summarizeObservedOutput() {
      return {};
    },
  });
}

async function waitForPendingRegistration(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test("rejectPendingRequestsForSession aborts an in-flight observe", async () => {
  const dispatcher = createDispatcher();

  const observePromise = dispatcher.observeTerminal(
    "sess_test",
    { waitFor: "settled", view: "delta", lines: -50 },
    30_000,
  );

  await waitForPendingRegistration();
  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(observePromise, /agent_canceled/);
});

test("rejectPendingRequestsForSessions aborts an in-flight send", async () => {
  const dispatcher = createDispatcher();

  const sendPromise = dispatcher.sendInteraction(
    "sess_test",
    { text: "pwd", submit: true },
    { timeoutMs: 30_000 },
  );

  await waitForPendingRegistration();
  assert.equal(dispatcher.rejectPendingRequestsForSessions(["sess_test"], "bud_offline"), 1);
  await assert.rejects(sendPromise, /bud_offline/);
});
