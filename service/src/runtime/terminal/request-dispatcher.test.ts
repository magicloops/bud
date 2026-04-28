import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_DEFAULT_WAIT_TIMEOUT_MS,
  TERMINAL_LOCAL_TIMEOUT_GRACE_MS,
  TERMINAL_SETTLED_WAIT_TIMEOUT_MS,
  TerminalRequestDispatcher,
  resolveTerminalWaitTimeout,
} from "./request-dispatcher.js";
import type { TerminalSession } from "./session-types.js";

type LogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  meta: Record<string, unknown>;
};

function createLogger(logEntries: LogEntry[] = []) {
  return {
    info(meta: Record<string, unknown>, message: string) {
      logEntries.push({ level: "info", message, meta });
    },
    warn(meta: Record<string, unknown>, message: string) {
      logEntries.push({ level: "warn", message, meta });
    },
    error(meta: Record<string, unknown>, message: string) {
      logEntries.push({ level: "error", message, meta });
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

function createDispatcher(
  session = createSession(),
  sentFrames: Record<string, unknown>[] = [],
  logEntries: LogEntry[] = [],
  options: {
    getLastOffset?: () => number;
    getLatestReadiness?: () => Record<string, unknown> | null;
  } = {},
) {
  return new TerminalRequestDispatcher({
    logger: createLogger(logEntries),
    async getSession(sessionId: string) {
      return sessionId === session.sessionId ? session : null;
    },
    getSessionContext() {
      return { mode: "shell" };
    },
    getLatestReadiness() {
      return (options.getLatestReadiness?.() ?? null) as never;
    },
    getLastOffset() {
      return options.getLastOffset?.() ?? 0;
    },
    storeReadinessAssessment() {
      // noop
    },
    emitReadyEvent() {
      // noop
    },
    sendFrameToBud(_budId: string, payload: Record<string, unknown>) {
      sentFrames.push(payload);
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

test("resolveTerminalWaitTimeout applies one-hour settled policy", () => {
  assert.equal(
    resolveTerminalWaitTimeout("settled"),
    TERMINAL_SETTLED_WAIT_TIMEOUT_MS,
  );
  assert.equal(
    resolveTerminalWaitTimeout("settled", 10),
    TERMINAL_SETTLED_WAIT_TIMEOUT_MS,
  );
  assert.equal(resolveTerminalWaitTimeout("changed"), TERMINAL_DEFAULT_WAIT_TIMEOUT_MS);
  assert.equal(resolveTerminalWaitTimeout("none", 5_000), 5_000);
  assert.equal(resolveTerminalWaitTimeout("shell_ready", -1), TERMINAL_DEFAULT_WAIT_TIMEOUT_MS);
});

test("sendInteraction sends one-hour timeout for default settled waits", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const sendPromise = dispatcher.sendInteraction("sess_test", { text: "pwd", submit: true });

  await waitForPendingRegistration();
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0]?.wait_for, "settled");
  assert.equal(sentFrames[0]?.timeout_ms, TERMINAL_SETTLED_WAIT_TIMEOUT_MS);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(sendPromise, /agent_canceled/);
});

test("observeTerminal sends one-hour timeout and local grace for settled waits", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const logEntries: LogEntry[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames, logEntries);

  const observePromise = dispatcher.observeTerminal("sess_test", {
    waitFor: "settled",
    view: "delta",
  });

  await waitForPendingRegistration();
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0]?.wait_for, "settled");
  assert.equal(sentFrames[0]?.timeout_ms, TERMINAL_SETTLED_WAIT_TIMEOUT_MS);

  const observeLog = logEntries.find((entry) => entry.message === "Sending terminal_observe request");
  assert.equal(observeLog?.meta.timeoutMs, TERMINAL_SETTLED_WAIT_TIMEOUT_MS);
  assert.equal(
    observeLog?.meta.localTimeoutMs,
    TERMINAL_SETTLED_WAIT_TIMEOUT_MS + TERMINAL_LOCAL_TIMEOUT_GRACE_MS,
  );

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(observePromise, /agent_canceled/);
});

test("non-settled waits keep short or explicit timeout budgets", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "q",
    waitFor: "none",
  });
  const observePromise = dispatcher.observeTerminal(
    "sess_test",
    { waitFor: "changed", view: "delta" },
    5_000,
  );

  await waitForPendingRegistration();
  assert.equal(sentFrames[0]?.wait_for, "none");
  assert.equal(sentFrames[0]?.timeout_ms, TERMINAL_DEFAULT_WAIT_TIMEOUT_MS);
  assert.equal(sentFrames[1]?.wait_for, "changed");
  assert.equal(sentFrames[1]?.timeout_ms, 5_000);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 2);
  await assert.rejects(sendPromise, /agent_canceled/);
  await assert.rejects(observePromise, /agent_canceled/);
});

test("interrupt send rejects older pending waits without rejecting itself", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const originalSend = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
  });

  await waitForPendingRegistration();
  let rejectedCount = -1;
  const interruptSend = dispatcher.sendInteraction(
    "sess_test",
    { key: "ctrl+c", waitFor: "none" },
    {
      rejectPendingRequestsWith: "interrupted",
      onPendingRequestsRejected(count) {
        rejectedCount = count;
      },
    },
  );

  await assert.rejects(originalSend, /interrupted/);
  assert.equal(rejectedCount, 1);
  assert.equal(sentFrames.length, 2);
  assert.equal(sentFrames[1]?.key, "ctrl+c");
  assert.equal(sentFrames[1]?.wait_for, "none");

  dispatcher.handleSendResult("sess_test", {
    requestId: sentFrames[1]?.request_id as string,
    submitted: true,
    delta: null,
    readiness: {
      ready: false,
      confidence: 0.2,
      trigger: "error",
      hints: {
        looks_like_prompt: false,
        looks_like_confirmation: false,
        looks_like_password: false,
        looks_like_pager: false,
        looks_like_error: false,
        may_still_be_processing: true,
      },
    },
    error: null,
  });

  const interruptResult = await interruptSend;
  assert.equal(interruptResult.submitted, true);
});

test("settled send rejection logs wait state and output activity", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const logEntries: LogEntry[] = [];
  let latestOffset = 10;
  const dispatcher = createDispatcher(createSession(), sentFrames, logEntries, {
    getLastOffset() {
      return latestOffset;
    },
    getLatestReadiness() {
      return {
        ready: false,
        confidence: 0.42,
        trigger: "settled",
      };
    },
  });

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
  });

  await waitForPendingRegistration();
  latestOffset = 64;
  dispatcher.noteOutputObserved("sess_test", {
    requestOffset: 10,
    endOffset: latestOffset,
    outputBytes: 54,
  });

  assert.equal(dispatcher.rejectPendingRequestsForSessions(["sess_test"], "bud_offline"), 1);
  await assert.rejects(sendPromise, /bud_offline/);

  const rejectionLog = logEntries.find(
    (entry) => entry.message === "Rejected pending terminal send request",
  );
  assert.ok(rejectionLog, "expected a send rejection log entry");
  assert.equal(rejectionLog.meta.requestId, sentFrames[0]?.request_id);
  assert.equal(rejectionLog.meta.waitFor, "settled");
  assert.equal(rejectionLog.meta.latestOffset, latestOffset);
  assert.equal(rejectionLog.meta.outputEventCount, 1);
  assert.deepEqual(rejectionLog.meta.readinessNow, {
    ready: false,
    confidence: 0.42,
    trigger: "settled",
    promptType: null,
  });
});

test("session close promptly rejects a pending settled send", async () => {
  const dispatcher = createDispatcher();

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
  });

  await waitForPendingRegistration();
  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "session_closed"), 1);
  await assert.rejects(sendPromise, /session_closed/);
});
