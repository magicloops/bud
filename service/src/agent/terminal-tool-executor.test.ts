import assert from "node:assert/strict";
import test from "node:test";
import { TerminalToolExecutor } from "./terminal-tool-executor.js";

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

function createExecutor(terminalSessionManager: Record<string, unknown>) {
  return new TerminalToolExecutor(
    terminalSessionManager as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );
}

test("terminal.run dispatches await command and returns exit code 0 with output", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction(
      sessionId: string,
      interaction: { text?: string; submit?: boolean; key?: string; await?: string },
    ) {
      assert.equal(sessionId, "sess_test");
      assert.deepEqual(interaction, {
        text: "pwd",
        submit: true,
        await: "command",
      });
      return {
        dispatched: true,
        outcome: {
          event: "command_finished",
          data: {
            command_id: "cmd_01",
            exit_code: 0,
            duration_ms: 42,
            output_byte_start: 0,
            output_byte_end: 6,
          },
        },
      };
    },
    async getCommandOutput(commandId: string) {
      assert.equal(commandId, "cmd_01");
      return {
        command: { commandId: "cmd_01", exitCode: 0, outputByteStart: 0, outputByteEnd: 6 },
        output: "/repo\n",
        outputBytes: 6,
        truncated: false,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "pwd",
    callId: "call_run_ok",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.status, "completed");
  assert.equal(execution.result.commandId, "cmd_01");
  assert.equal(execution.result.exitCode, 0);
  assert.equal(execution.result.durationMs, 42);
  assert.equal(execution.result.output, "/repo\n");
  assert.equal(execution.result.truncated, false);
  assert.equal(execution.result.mode, "shell");
  assert.equal(execution.result.cwd, "/repo");
  assert.equal(execution.result.error, undefined);
  assert.deepEqual(execution.args, { command: "pwd" });
  assert.equal(execution.payload.exit_code, 0);
  assert.equal(execution.payload.duration_ms, 42);
  assert.equal(execution.payload.output, "/repo\n");
  assert.equal(execution.payload.command_id, "cmd_01");
  assert.equal(execution.payload.ok, undefined);
  assert.equal(execution.outputTruncationReason, null);
  assert.equal(execution.summary, 'Ran "pwd" (exit 0 in 42ms)');
});

test("terminal.run with a failing command is a normal tool result, not an error", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "sentinel", cwd: "/repo" };
    },
    async sendInteraction() {
      return {
        dispatched: true,
        outcome: {
          event: "command_finished",
          data: { command_id: "cmd_02", exit_code: 1, duration_ms: 1500 },
        },
      };
    },
    async getCommandOutput() {
      return {
        command: { commandId: "cmd_02", exitCode: 1 },
        output: "grep: no matches\n",
        outputBytes: 17,
        truncated: false,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "grep -r missing_symbol src/",
    callId: "call_run_exit1",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.status, "completed");
  assert.equal(execution.result.exitCode, 1);
  assert.equal(execution.result.error, undefined);
  assert.equal(execution.result.errorCode, undefined);
  assert.equal(execution.payload.exit_code, 1);
  assert.equal(execution.payload.ok, undefined);
  assert.equal(execution.payload.code, undefined);
  assert.match(execution.summary, /exit 1/);
});

test("terminal.run service timeout reports still-running, never a fabricated failure", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      throw new Error("send_timeout");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "sleep 999999",
    callId: "call_run_timeout",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.status, "still_running");
  assert.equal(execution.result.error, undefined);
  assert.equal(execution.result.errorCode, undefined);
  assert.equal(execution.result.exitCode, undefined);
  assert.equal(execution.payload.status, "still_running");
  assert.equal(execution.payload.ok, undefined);
  assert.match(String(execution.payload.note), /terminal\.observe/);
  assert.match(execution.summary, /still running/);
});

test("terminal.run tail-kept truncation is surfaced with a truncation reason", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: null };
    },
    async sendInteraction() {
      return {
        dispatched: true,
        outcome: {
          event: "command_finished",
          data: { command_id: "cmd_03", exit_code: 0, duration_ms: 10 },
        },
      };
    },
    async getCommandOutput() {
      return {
        command: { commandId: "cmd_03", exitCode: 0 },
        output: "...tail of a very long output",
        outputBytes: 29,
        truncated: true,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "yes | head -c 1000000",
    callId: "call_run_truncated",
  });

  assert.equal(execution.result.truncated, true);
  assert.equal(execution.payload.truncated, true);
  assert.equal(execution.outputTruncationReason, "service_backfill_limit");
  assert.equal(execution.payload.output_truncation_reason, "service_backfill_limit");
});

test("terminal.run treats a non-command outcome as a structured EXEC_FAILED error", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "none", cwd: null };
    },
    async sendInteraction() {
      return {
        dispatched: true,
        outcome: { event: "settled", data: { mode: "shell", quiet_ms: 500 } },
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "pwd",
    callId: "call_run_settled",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.error, "unexpected_outcome_settled");
  assert.equal(execution.result.errorCode, "EXEC_FAILED");
  assert.equal(execution.result.retryable, true);
  assert.equal(execution.payload.ok, false);
  assert.equal(execution.payload.code, "EXEC_FAILED");
});

test("terminal.send dispatches await settled and returns the post-send delta", async () => {
  const observeCalls: Array<Record<string, unknown>> = [];
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "repl", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction(
      sessionId: string,
      interaction: { text?: string; submit?: boolean; key?: string; await?: string },
    ) {
      assert.equal(sessionId, "sess_test");
      assert.deepEqual(interaction, {
        text: "print(1 + 1)",
        submit: false,
        await: "settled",
      });
      return {
        dispatched: true,
        outcome: { event: "settled", data: { mode: "repl", quiet_ms: 400 } },
      };
    },
    async observeTerminal(sessionId: string, options: Record<string, unknown>) {
      observeCalls.push(options);
      assert.equal(sessionId, "sess_test");
      return {
        view: "delta",
        output: ">>> print(1 + 1)",
        linesCaptured: 1,
        changed: true,
        mode: "repl",
        integration: "osc133",
        altScreen: false,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    rawText: "print(1 + 1)",
    callId: "call_send_raw",
  });

  assert.deepEqual(observeCalls, [{ view: "delta" }]);
  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.dispatched, true);
  assert.equal(execution.result.rawTextSent, true);
  assert.equal(execution.result.keySent, null);
  assert.deepEqual(execution.result.delta, { changed: true, text: ">>> print(1 + 1)" });
  assert.equal(execution.result.changed, true);
  assert.equal(execution.result.mode, "repl");
  assert.equal(execution.result.altScreen, false);
  assert.deepEqual(execution.args, { raw_text: "print(1 + 1)" });
  assert.equal(execution.payload.dispatched, true);
  assert.deepEqual(execution.payload.delta, { changed: true, text: ">>> print(1 + 1)" });
  assert.equal(execution.summary, 'Type raw text "print(1 + 1)"; observed new terminal content');
});

test("terminal.send key gestures dispatch one semantic key with settled proof", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "tui", integration: "none", cwd: null };
    },
    async sendInteraction(
      _sessionId: string,
      interaction: { text?: string; submit?: boolean; key?: string; await?: string },
    ) {
      assert.deepEqual(interaction, { key: "ctrl+c", await: "settled" });
      return {
        dispatched: true,
        outcome: { event: "settled", data: { mode: "tui", quiet_ms: 300 } },
      };
    },
    async observeTerminal() {
      return {
        view: "delta",
        output: "",
        linesCaptured: 0,
        changed: false,
        mode: "shell",
        integration: "osc133",
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    key: "ctrl+c",
    callId: "call_send_key",
  });

  assert.equal(execution.result.dispatched, true);
  assert.equal(execution.result.rawTextSent, false);
  assert.equal(execution.result.keySent, "ctrl+c");
  assert.deepEqual(execution.result.delta, { changed: false, text: "" });
  assert.equal(execution.result.mode, "shell");
  assert.equal(execution.summary, "Send key ctrl+c; no visible change on screen");
});

test("terminal.send settle timeout returns dispatched with a screen fallback note", async () => {
  const observedViews: unknown[] = [];
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "tui", integration: "none", cwd: null };
    },
    async sendInteraction() {
      throw new Error("send_timeout");
    },
    async observeTerminal(_sessionId: string, options: { view?: string }) {
      observedViews.push(options.view);
      return {
        view: "screen",
        output: "spinner still going",
        linesCaptured: 1,
        mode: "tui",
        integration: "none",
        altScreen: true,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    key: "enter",
    callId: "call_send_settle_timeout",
  });

  assert.deepEqual(observedViews, ["screen"]);
  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.dispatched, true);
  assert.equal(execution.result.error, undefined);
  assert.equal(execution.result.delta, null);
  assert.equal(execution.result.output, "spinner still going");
  assert.equal(execution.result.altScreen, true);
  assert.match(String(execution.result.note), /still active/);
  assert.match(execution.summary, /still active without settling/);
});

test("terminal.send rejects command-less empty input with terminal.run guidance", async () => {
  let sendCalls = 0;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: null, cwd: null };
    },
    async sendInteraction() {
      sendCalls += 1;
      throw new Error("should_not_run");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    callId: "call_send_empty",
  });

  assert.equal(sendCalls, 0);
  assert.equal(execution.result.error, "empty_interaction");
  assert.equal(execution.result.dispatched, false);
  assert.equal(
    execution.summary,
    "Invalid terminal.send input: provide raw_text or key (shell commands belong to terminal.run)",
  );
});

test("terminal.send rejects ambiguous raw_text plus key before touching the runtime", async () => {
  let sendCalls = 0;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: null, cwd: null };
    },
    async sendInteraction() {
      sendCalls += 1;
      throw new Error("should_not_run");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    rawText: "y",
    key: "enter",
    callId: "call_send_ambiguous",
  });

  assert.equal(sendCalls, 0);
  assert.equal(execution.result.error, "ambiguous_interaction");
  assert.equal(execution.result.dispatched, false);
  assert.equal(
    execution.summary,
    "Invalid terminal.send input: provide exactly one of raw_text or key",
  );
});

test("terminal.observe defaults to the delta view", async () => {
  const observeCalls: Array<Record<string, unknown>> = [];
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async observeTerminal(sessionId: string, options: Record<string, unknown>) {
      observeCalls.push(options);
      assert.equal(sessionId, "sess_test");
      return {
        view: "delta",
        output: "new output line",
        linesCaptured: 1,
        changed: true,
        mode: "shell",
        integration: "osc133",
        altScreen: false,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.observe",
    callId: "call_observe_default",
  });

  assert.deepEqual(observeCalls, [{ view: "delta", lines: -50 }]);
  assert.equal(execution.result.kind, "observation");
  assert.equal(execution.result.view, "delta");
  assert.equal(execution.result.output, "new output line");
  assert.equal(execution.result.changed, true);
  assert.equal(execution.result.mode, "shell");
  assert.equal(execution.payload.view, "delta");
  assert.equal(execution.payload.lines_captured, 1);
  assert.equal(execution.summary, "Observed terminal delta");
});

test("terminal.send wait interrupted by the user stays a conservative tool result", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "repl", integration: "none", cwd: null };
    },
    async sendInteraction() {
      throw new Error("interrupted");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    rawText: "work on this",
    callId: "call_send_interrupted",
  });

  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.error, "interrupted");
  assert.equal(execution.result.dispatched, true);
  assert.equal(execution.result.delta, null);
  assert.equal(
    execution.summary,
    "Terminal send wait was interrupted by the user after the input was sent",
  );
});

test("terminal.run wait interrupted by the user reports an unresolved command", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: null };
    },
    async sendInteraction() {
      throw new Error("interrupted");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "npm install",
    callId: "call_run_interrupted",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.status, "still_running");
  assert.equal(execution.result.error, "interrupted");
  assert.equal(execution.result.exitCode, undefined);
  assert.match(String(execution.result.note), /terminal\.observe/);
});

test("terminal.observe wait interrupted by the user stays a conservative tool result", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: null, cwd: null };
    },
    async observeTerminal() {
      throw new Error("interrupted");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.observe",
    callId: "call_observe_interrupted",
  });

  assert.equal(execution.result.kind, "observation");
  assert.equal(execution.result.error, "interrupted");
  assert.equal(execution.result.output, "");
  assert.equal(execution.summary, "Terminal observe wait was interrupted by the user");
});

test("bud offline before session resolution returns a retryable structured result", async () => {
  const executor = new TerminalToolExecutor(
    {} as never,
    createLogger() as never,
    false,
    false,
    async () => {
      throw new Error("bud_offline");
    },
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "pwd",
    callId: "call_run_offline",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.error, "bud_offline");
  assert.equal(execution.result.errorCode, "BUD_DISCONNECTED");
  assert.equal(execution.result.retryable, true);
  assert.equal(execution.payload.ok, false);
  assert.equal(execution.payload.code, "BUD_DISCONNECTED");
  assert.equal(
    execution.summary,
    "The Bud disconnected before terminal input could be confirmed.",
  );
});

test("bud disconnect during terminal.send returns a retryable structured result", async () => {
  const executor = createExecutor({
    getSessionContext() {
      return { mode: "shell", integration: null, cwd: null };
    },
    async sendInteraction() {
      throw new Error("bud_disconnected");
    },
  });

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    key: "enter",
    callId: "call_send_offline",
  });

  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.dispatched, false);
  assert.equal(execution.result.error, "bud_offline");
  assert.equal(execution.result.errorCode, "BUD_DISCONNECTED");
  assert.equal(execution.result.retryable, true);
  assert.equal(execution.payload.ok, false);
  assert.equal(
    execution.summary,
    "The Bud disconnected before terminal input could be confirmed.",
  );
});
