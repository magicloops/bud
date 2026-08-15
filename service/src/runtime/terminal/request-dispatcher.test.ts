import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_AWAITED_SEND_TIMEOUT_MS,
  TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS,
  TerminalRequestDispatcher,
  resolveTerminalSendTimeout,
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
    cwd: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startedAt: null,
    lastActivityAt: null,
    outputLogBytes: 0,
    createdByUserId: "user-1",
    tenantId: null,
  };
}

function createDispatcher(
  session = createSession(),
  sentFrames: Record<string, unknown>[] = [],
  logEntries: LogEntry[] = [],
  options: {
    getLastOffset?: () => number;
  } = {},
) {
  return new TerminalRequestDispatcher({
    logger: createLogger(logEntries),
    async getSession(sessionId: string) {
      return sessionId === session.sessionId ? session : null;
    },
    getLastOffset() {
      return options.getLastOffset?.() ?? 0;
    },
    sendFrameToBud(_budId: string, payload: Record<string, unknown>) {
      sentFrames.push(payload);
      return true;
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
    { view: "delta", lines: -50 },
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
    { text: "pwd", submit: true, await: "command" },
    { timeoutMs: 30_000 },
  );

  await waitForPendingRegistration();
  assert.equal(dispatcher.rejectPendingRequestsForSessions(["sess_test"], "bud_offline"), 1);
  await assert.rejects(sendPromise, /bud_offline/);
});

test("resolveTerminalSendTimeout applies the one-hour awaited-send budget", () => {
  assert.equal(resolveTerminalSendTimeout("settled"), TERMINAL_AWAITED_SEND_TIMEOUT_MS);
  assert.equal(resolveTerminalSendTimeout("command"), TERMINAL_AWAITED_SEND_TIMEOUT_MS);
  assert.equal(resolveTerminalSendTimeout(undefined), TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveTerminalSendTimeout("settled", 10), 10);
  assert.equal(resolveTerminalSendTimeout(undefined, 5_000), 5_000);
  assert.equal(resolveTerminalSendTimeout("command", -1), TERMINAL_AWAITED_SEND_TIMEOUT_MS);
});

test("terminal_send frames carry the 0.3 shape (await, no wait_for or timeout_ms)", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "pwd",
    submit: true,
    await: "command",
  });

  await waitForPendingRegistration();
  assert.equal(sentFrames.length, 1);
  const frame = sentFrames[0]!;
  assert.equal(frame.type, "terminal_send");
  assert.equal(frame.proto, "0.3");
  assert.equal(frame.text, "pwd");
  assert.equal(frame.submit, true);
  assert.equal(frame.await, "command");
  assert.equal("wait_for" in frame, false);
  assert.equal("timeout_ms" in frame, false);
  assert.equal("observe_after_ms" in frame, false);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(sendPromise, /agent_canceled/);
});

test("terminal_observe frames carry view and lines only", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const observePromise = dispatcher.observeTerminal("sess_test", {
    view: "screen",
    lines: -30,
  });

  await waitForPendingRegistration();
  assert.equal(sentFrames.length, 1);
  const frame = sentFrames[0]!;
  assert.equal(frame.type, "terminal_observe");
  assert.equal(frame.proto, "0.3");
  assert.equal(frame.view, "screen");
  assert.equal(frame.lines, -30);
  assert.equal("wait_for" in frame, false);
  assert.equal("timeout_ms" in frame, false);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(observePromise, /agent_canceled/);
});

test("dispatch-only sends omit await and keep the short local budget", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const logEntries: LogEntry[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames, logEntries);

  const sendPromise = dispatcher.sendInteraction("sess_test", { key: "ctrl+c" });

  await waitForPendingRegistration();
  assert.equal(sentFrames[0]?.key, "ctrl+c");
  assert.equal("await" in sentFrames[0]!, false);

  const sendLog = logEntries.find((entry) => entry.message === "Sending terminal_send request");
  assert.equal(sendLog?.meta.timeoutMs, TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(sendPromise, /agent_canceled/);
});

test("awaited sends use the one-hour service-owned budget", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const logEntries: LogEntry[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames, logEntries);

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "sleep 600",
    submit: true,
    await: "settled",
  });

  await waitForPendingRegistration();
  const sendLog = logEntries.find((entry) => entry.message === "Sending terminal_send request");
  assert.equal(sendLog?.meta.timeoutMs, TERMINAL_AWAITED_SEND_TIMEOUT_MS);

  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "agent_canceled"), 1);
  await assert.rejects(sendPromise, /agent_canceled/);
});

test("interrupt send rejects older pending waits without rejecting itself", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const originalSend = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
    await: "settled",
  });

  await waitForPendingRegistration();
  let rejectedCount = -1;
  const interruptSend = dispatcher.sendInteraction(
    "sess_test",
    { key: "ctrl+c" },
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

  dispatcher.handleSendResult("sess_test", {
    requestId: sentFrames[1]?.request_id as string,
    dispatched: true,
    outcome: null,
    error: null,
  });

  const interruptResult = await interruptSend;
  assert.equal(interruptResult.dispatched, true);
  assert.equal(interruptResult.outcome, null);
});

test("awaited send resolves with the terminating event outcome", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "false",
    submit: true,
    await: "command",
  });

  await waitForPendingRegistration();
  await dispatcher.handleSendResult("sess_test", {
    requestId: sentFrames[0]?.request_id as string,
    dispatched: true,
    outcome: {
      event: "command_finished",
      data: {
        command_id: "cmd_01H",
        exit_code: 1,
        duration_ms: 12,
        output_byte_start: 0,
        output_byte_end: 64,
      },
    },
    error: null,
  });

  const result = await sendPromise;
  assert.equal(result.dispatched, true);
  assert.equal(result.outcome?.event, "command_finished");
  assert.equal(result.outcome?.data.exit_code, 1);
});

test("send result errors reject the pending send", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "pwd",
    submit: true,
  });

  await waitForPendingRegistration();
  await dispatcher.handleSendResult("sess_test", {
    requestId: sentFrames[0]?.request_id as string,
    dispatched: false,
    outcome: null,
    error: "session_not_found",
  });

  await assert.rejects(sendPromise, /session_not_found/);
});

test("observe result resolves with grid-backed mode facts", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const dispatcher = createDispatcher(createSession(), sentFrames);

  const observePromise = dispatcher.observeTerminal("sess_test", { view: "screen" });

  await waitForPendingRegistration();
  await dispatcher.handleObserveResult("sess_test", {
    requestId: sentFrames[0]?.request_id as string,
    view: "screen",
    output: Buffer.from("hello screen", "utf-8").toString("base64"),
    linesCaptured: 24,
    changed: true,
    mode: "tui",
    integration: "osc133",
    altScreen: true,
    cursorRow: 3,
    cursorCol: 11,
    error: null,
  });

  const result = await observePromise;
  assert.equal(result.output, "hello screen");
  assert.equal(result.linesCaptured, 24);
  assert.equal(result.changed, true);
  assert.equal(result.mode, "tui");
  assert.equal(result.integration, "osc133");
  assert.equal(result.altScreen, true);
  assert.equal(result.cursorRow, 3);
  assert.equal(result.cursorCol, 11);
});

test("settled send rejection logs wait state and output activity", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const logEntries: LogEntry[] = [];
  let latestOffset = 10;
  const dispatcher = createDispatcher(createSession(), sentFrames, logEntries, {
    getLastOffset() {
      return latestOffset;
    },
  });

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
    await: "settled",
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
  assert.equal(rejectionLog.meta.await, "settled");
  assert.equal(rejectionLog.meta.latestOffset, latestOffset);
  assert.equal(rejectionLog.meta.outputEventCount, 1);
});

test("session close promptly rejects a pending settled send", async () => {
  const dispatcher = createDispatcher();

  const sendPromise = dispatcher.sendInteraction("sess_test", {
    text: "codex \"work\"",
    submit: true,
    await: "settled",
  });

  await waitForPendingRegistration();
  assert.equal(dispatcher.rejectPendingRequestsForSession("sess_test", "session_closed"), 1);
  await assert.rejects(sendPromise, /session_closed/);
});

test("send validation rejects ambiguous and empty interactions", async () => {
  const dispatcher = createDispatcher();

  await assert.rejects(
    dispatcher.sendInteraction("sess_test", { text: "x", key: "enter" }),
    /ambiguous_interaction/,
  );
  await assert.rejects(dispatcher.sendInteraction("sess_test", {}), /empty_interaction/);
  await assert.rejects(
    dispatcher.sendInteraction("sess_test", { submit: true }),
    /submit_requires_text/,
  );
});
