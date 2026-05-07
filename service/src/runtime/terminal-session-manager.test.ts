import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSessionManager } from "./terminal-session-manager.js";

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

function createManager() {
  return new TerminalSessionManager(createLogger() as never, { emit() {} } as never);
}

function setPendingPythonCommand(manager: TerminalSessionManager, sessionId: string) {
  manager.setPendingCommand(sessionId, {
    input: "python",
    command: "python",
    sentAt: Date.now(),
    source: "agent",
  });
}

test("non-shell readiness does not clear pending repl context", async () => {
  const manager = createManager();
  const sessionId = "sess_test";
  setPendingPythonCommand(manager, sessionId);

  assert.equal(manager.getSessionContext(sessionId).mode, "repl");

  await manager.handleTerminalReady(sessionId, {
    assessment: {
      ready: true,
      confidence: 0.9,
      trigger: "activity_stable",
      hints: {
        looks_like_prompt: false,
        looks_like_confirmation: false,
        looks_like_password: false,
        looks_like_pager: false,
        looks_like_error: false,
        may_still_be_processing: false,
      },
      activity_checks: 2,
      stable_checks: 2,
    },
  });

  const context = manager.getSessionContext(sessionId);
  assert.equal(context.mode, "repl");
  assert.equal(context.program, "python");
});

test("observed shell readiness clears pending repl context and updates latest readiness", async () => {
  const manager = createManager();
  const sessionId = "sess_test";
  setPendingPythonCommand(manager, sessionId);

  await manager.handleTerminalReady(sessionId, {
    assessment: {
      ready: true,
      confidence: 0.95,
      trigger: "prompt_detected",
      prompt_type: "shell",
      hints: {
        looks_like_prompt: true,
        looks_like_confirmation: false,
        looks_like_password: false,
        looks_like_pager: false,
        looks_like_error: false,
        may_still_be_processing: false,
      },
      quiet_for_ms: 1500,
    },
  });

  const context = manager.getSessionContext(sessionId);
  assert.equal(context.mode, "shell");
  assert.equal(context.pendingCommand, undefined);

  assert.deepEqual(manager.getLatestReadiness(sessionId), {
    ready: true,
    confidence: 0.95,
    trigger: "prompt_detected",
    prompt_type: "shell",
    hints: {
      looks_like_prompt: true,
      looks_like_confirmation: false,
      looks_like_password: false,
      looks_like_pager: false,
      looks_like_error: false,
      may_still_be_processing: false,
    },
    quiet_for_ms: 1500,
  });
});

test("getPathContextForSession returns cached cwd metadata without daemon access", async () => {
  const manager = createManager();
  Reflect.set(manager, "sessionStore", {
    async getSession(sessionId: string) {
      assert.equal(sessionId, "sess_test");
      return {
        sessionId,
        threadId: "thread-1",
        budId: "bud-1",
        instanceId: null,
        state: "ready",
        cols: 200,
        rows: 50,
        cwd: "/Users/adam/bud/service",
        createdAt: new Date("2026-05-01T19:00:00.000Z"),
        startedAt: null,
        lastActivityAt: new Date("2026-05-01T20:00:00.000Z"),
        outputLogBytes: 0,
      };
    },
  });

  assert.deepEqual(await manager.getPathContextForSession("sess_test"), {
    schema: "terminal_cwd_v1",
    source: "terminal_runtime_cache",
    reported_by: "tmux_pane_current_path",
    terminal_session_id: "sess_test",
    host_cwd: "/Users/adam/bud/service",
    captured_at: "2026-05-01T20:00:00.000Z",
  });
});
