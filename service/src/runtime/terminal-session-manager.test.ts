import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSessionManager } from "./terminal-session-manager.js";
import type { TerminalSession } from "./terminal/session-types.js";

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
  };
}

type EmittedEvent = { event: string; data: Record<string, unknown>; id?: string };

function createManager(events: EmittedEvent[] = []) {
  return new TerminalSessionManager(
    createLogger() as never,
    {
      emit(_sessionId: string, event: EmittedEvent) {
        events.push(event);
      },
    } as never,
  );
}

function createSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    sessionId: "sess_test",
    threadId: "thread-1",
    budId: "bud-1",
    instanceId: null,
    state: "ready",
    cols: 200,
    rows: 50,
    cwd: null,
    createdAt: new Date("2026-05-01T19:00:00.000Z"),
    startedAt: null,
    lastActivityAt: new Date("2026-05-01T20:00:00.000Z"),
    outputLogBytes: 0,
    createdByUserId: "user-1",
    tenantId: null,
    ...overrides,
  };
}

function stubSessionStore(
  manager: TerminalSessionManager,
  session: TerminalSession | null,
  extras: Record<string, unknown> = {},
) {
  Reflect.set(manager, "sessionStore", {
    async getSession() {
      return session;
    },
    async updateStatus() {
      // noop
    },
    async updateCwd() {
      // noop
    },
    async markClosed() {
      // noop
    },
    ...extras,
  });
}

test("mode_changed events update the session runtime context and forward to SSE", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  stubSessionStore(manager, createSession());

  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "mode_changed",
    data: { mode: "tui", integration: "osc133" },
    ts: 1731,
  });

  const context = manager.getSessionContext("sess_test");
  assert.equal(context.mode, "tui");
  assert.equal(context.integration, "osc133");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "terminal.event");
  assert.deepEqual(events[0]?.data, {
    session_id: "sess_test",
    event: "mode_changed",
    data: { mode: "tui", integration: "osc133" },
    ts: 1731,
  });
  assert.equal(events[0]?.id, undefined);
});

test("prompt_ready events store the latest cwd on runtime state and DB", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  const cwdWrites: Array<{ sessionId: string; cwd: string }> = [];
  stubSessionStore(manager, createSession(), {
    async updateCwd(sessionId: string, cwd: string) {
      cwdWrites.push({ sessionId, cwd });
    },
  });

  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "prompt_ready",
    data: { cwd: "/Users/adam/bud" },
    ts: 1731,
  });

  assert.equal(manager.getSessionContext("sess_test").cwd, "/Users/adam/bud");
  assert.deepEqual(cwdWrites, [{ sessionId: "sess_test", cwd: "/Users/adam/bud" }]);
  assert.equal(events[0]?.event, "terminal.event");
});

test("unknown terminal_event values are ignored for processing but still forwarded", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  stubSessionStore(manager, createSession());

  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "hologram_ready",
    data: { anything: true },
    ts: 1731,
  });

  assert.equal(manager.getSessionContext("sess_test").mode, "unknown");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data.event, "hologram_ready");
});

test("child_exited closes the session locally and rejects pending requests", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  let markedClosed = 0;
  stubSessionStore(manager, createSession(), {
    async markClosed() {
      markedClosed += 1;
    },
  });
  let rejected: string | null = null;
  Reflect.set(manager, "requestDispatcher", {
    rejectPendingRequestsForSession(_sessionId: string, reason: string) {
      rejected = reason;
      return 1;
    },
  });

  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "child_exited",
    data: { exit_code: 0 },
    ts: 1731,
  });

  assert.equal(markedClosed, 1);
  assert.equal(rejected, "session_closed");
  const statusEvent = events.find((event) => event.event === "terminal.status");
  assert.deepEqual(statusEvent?.data, { state: "closed", reason: "child_exited" });
  const forwarded = events.find((event) => event.event === "terminal.event");
  assert.equal(forwarded?.data.event, "child_exited");
});

test("command_started and command_finished persist owner-stamped command rows", async () => {
  const manager = createManager();
  stubSessionStore(manager, createSession());
  const started: unknown[] = [];
  const finished: unknown[] = [];
  Reflect.set(manager, "commandStore", {
    async recordCommandStarted(session: TerminalSession, event: unknown) {
      started.push({ owner: session.createdByUserId, event });
    },
    async recordCommandFinished(session: TerminalSession, event: unknown) {
      finished.push({ owner: session.createdByUserId, event });
    },
  });

  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "command_started",
    data: { command_id: "cmd_1", output_byte_start: 16384 },
    ts: 1_700_000_000_000,
  });
  await manager.handleTerminalEvent("bud-1", "sess_test", {
    event: "command_finished",
    data: {
      command_id: "cmd_1",
      exit_code: 1,
      duration_ms: 2311,
      output_byte_start: 16384,
      output_byte_end: 18101,
    },
    ts: 1_700_000_002_311,
  });

  assert.deepEqual(started, [
    {
      owner: "user-1",
      event: { commandId: "cmd_1", outputByteStart: 16384, ts: 1_700_000_000_000 },
    },
  ]);
  assert.deepEqual(finished, [
    {
      owner: "user-1",
      event: {
        commandId: "cmd_1",
        exitCode: 1,
        durationMs: 2311,
        outputByteStart: 16384,
        outputByteEnd: 18101,
        ts: 1_700_000_002_311,
      },
    },
  ]);
});

test("terminal frames from a bud that does not own the session are dropped", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  stubSessionStore(manager, createSession({ budId: "bud-owner" }));

  let outputIngested = 0;
  Reflect.set(manager, "outputStore", {
    async handleTerminalOutput() {
      outputIngested += 1;
    },
    getLastOffset() {
      return 0;
    },
    clearSessionCache() {
      // noop
    },
  });
  let sendResults = 0;
  let observeResults = 0;
  Reflect.set(manager, "requestDispatcher", {
    async handleSendResult() {
      sendResults += 1;
    },
    async handleObserveResult() {
      observeResults += 1;
    },
    noteOutputObserved() {
      // noop
    },
  });

  await manager.handleTerminalOutput("bud-intruder", "sess_test", {
    data: Buffer.from("stolen").toString("base64"),
    byte_offset: 0,
  });
  await manager.handleTerminalEvent("bud-intruder", "sess_test", {
    event: "prompt_ready",
    data: { cwd: "/tmp" },
    ts: 1731,
  });
  await manager.handleSendResult("bud-intruder", "sess_test", {
    requestId: "send_1",
    dispatched: true,
    outcome: null,
    error: null,
  });
  await manager.handleObserveResult("bud-intruder", "sess_test", {
    requestId: "obs_1",
    view: "screen",
    output: "",
    linesCaptured: 0,
    error: null,
  });
  await manager.handleTerminalStatus("bud-intruder", "sess_test", { state: "ready" });

  assert.equal(outputIngested, 0);
  assert.equal(sendResults, 0);
  assert.equal(observeResults, 0);
  assert.equal(events.length, 0);
  assert.equal(manager.getSessionContext("sess_test").cwd, null);

  // The owning bud's frames still flow.
  await manager.handleTerminalOutput("bud-owner", "sess_test", {
    data: Buffer.from("ok").toString("base64"),
    byte_offset: 0,
  });
  assert.equal(outputIngested, 1);
});

test("terminal frames for unknown sessions are dropped", async () => {
  const events: EmittedEvent[] = [];
  const manager = createManager(events);
  stubSessionStore(manager, null);

  let ingested = 0;
  Reflect.set(manager, "outputStore", {
    async handleTerminalOutput() {
      ingested += 1;
    },
  });

  await manager.handleTerminalOutput("bud-1", "sess_missing", {
    data: Buffer.from("x").toString("base64"),
    byte_offset: 0,
  });

  assert.equal(ingested, 0);
  assert.equal(events.length, 0);
});

test("getPathContextForSession returns cached cwd metadata without daemon access", async () => {
  const manager = createManager();
  stubSessionStore(
    manager,
    createSession({ cwd: "/Users/adam/bud/service" }),
  );

  assert.deepEqual(await manager.getPathContextForSession("sess_test"), {
    schema: "terminal_cwd_v1",
    source: "terminal_runtime_cache",
    reported_by: "prompt_ready_osc7",
    terminal_session_id: "sess_test",
    host_cwd: "/Users/adam/bud/service",
    captured_at: "2026-05-01T20:00:00.000Z",
  });
});

test("ensureSession forwards the stored end offset as resume_from_offset", async () => {
  const manager = createManager();
  const ensureCalls: Array<{ sessionId: string; options: unknown }> = [];
  Reflect.set(manager, "sessionStore", {
    async ensureSession(sessionId: string, options: unknown) {
      ensureCalls.push({ sessionId, options });
      return { ok: true, resumed: false, created: true };
    },
  });
  Reflect.set(manager, "outputStore", {
    async getStoredEndOffset(sessionId: string) {
      assert.equal(sessionId, "sess_test");
      return 84213;
    },
  });

  const result = await manager.ensureSession("sess_test");
  assert.equal(result.ok, true);
  assert.deepEqual(ensureCalls, [
    { sessionId: "sess_test", options: { resumeFromOffset: 84213 } },
  ]);
});
