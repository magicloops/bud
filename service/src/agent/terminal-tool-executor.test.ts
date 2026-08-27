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

test("terminal.run still-running report carries the dispatched command_id from the command store", async () => {
  const lookups: string[] = [];
  let dispatched = false;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      dispatched = true;
      throw new Error("send_timeout");
    },
    async getLatestCommandForSession(sessionId: string) {
      lookups.push(sessionId);
      // Real ordering: the pre-dispatch busy check sees NO open command (the
      // row only exists once the dispatched command's started event lands).
      if (!dispatched) {
        return null;
      }
      return {
        commandId: "cmd_running",
        terminalSessionId: sessionId,
        commandStartedAt: new Date("2026-08-17T10:00:00.000Z"),
        commandFinishedAt: null,
        exitCode: null,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "sleep 999999",
    callId: "call_run_timeout_cmd_id",
  });

  // Pre-check + still-running command_id recovery + openCommand fact.
  assert.equal(lookups.length >= 2, true);
  assert.equal(execution.result.status, "still_running");
  assert.equal(execution.result.commandId, "cmd_running");
  assert.equal(execution.payload.command_id, "cmd_running");
  assert.match(String(execution.payload.note), /terminal\.observe/);
});

test("terminal.run still-running report keeps command_id null when the latest command already finished", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      throw new Error("send_timeout");
    },
    async getLatestCommandForSession(sessionId: string) {
      // The started event for the timed-out run was lost; the newest persisted
      // command is an older, finished one — reporting it would mislabel it.
      return {
        commandId: "cmd_previous",
        terminalSessionId: sessionId,
        commandStartedAt: new Date("2026-08-17T09:00:00.000Z"),
        commandFinishedAt: new Date("2026-08-17T09:00:05.000Z"),
        exitCode: 0,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "sleep 999999",
    callId: "call_run_timeout_stale_cmd",
  });

  assert.equal(execution.result.status, "still_running");
  assert.equal(execution.result.commandId, null);
  assert.equal(execution.payload.command_id, null);
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
        submit: true,
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
  assert.match(String(execution.result.note), /never settled/);
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

test("terminal.run is refused with terminal_busy while a command is open (pre-check, nothing dispatched)", async () => {
  let dispatched = false;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      dispatched = true;
      return { dispatched: true, outcome: null };
    },
    async getLatestCommandForSession(sessionId: string) {
      // An inline TUI (codex) launched earlier: open command, mode still shell.
      return {
        commandId: "cmd_codex",
        terminalSessionId: sessionId,
        commandStartedAt: new Date(Date.now() - 90_000),
        commandFinishedAt: null,
        exitCode: null,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "ls -t debug/*.md | head -5",
    callId: "call_busy_guard",
  });

  assert.equal(dispatched, false, "guarded run must never touch the PTY");
  assert.equal(execution.result.status, "terminal_busy");
  assert.equal(execution.result.commandId, "cmd_codex");
  const openCommand = execution.payload.open_command as { command_id: string; running_ms: number };
  assert.equal(openCommand.command_id, "cmd_codex");
  assert.equal(openCommand.running_ms >= 90_000, true);
  assert.match(String(execution.payload.note), /terminal\.send/);
  assert.match(String(execution.payload.note), /ctrl\+c/);
});

test("daemon command_in_flight errors map to the same terminal_busy result (backstop)", async () => {
  let calls = 0;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      throw new Error("command_in_flight");
    },
    async getLatestCommandForSession(sessionId: string) {
      calls += 1;
      // Pre-check races: the service store has not seen the started event yet,
      // but the daemon's authoritative facts refuse the dispatch.
      if (calls === 1) {
        return null;
      }
      return {
        commandId: "cmd_late",
        terminalSessionId: sessionId,
        commandStartedAt: new Date(Date.now() - 5_000),
        commandFinishedAt: null,
        exitCode: null,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "echo hi",
    callId: "call_busy_backstop",
  });

  assert.equal(execution.result.status, "terminal_busy");
  assert.equal(execution.result.commandId, "cmd_late");
});

test("terminal.run resolving with interactive_started becomes a normal 'interactive' result", async () => {
  let dispatchedInteractive = false;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      dispatchedInteractive = true;
      return {
        dispatched: true,
        outcome: {
          event: "interactive_started",
          data: { command_id: "cmd_codex", signal: "bracketed_paste" },
        },
      };
    },
    async getLatestCommandForSession(sessionId: string) {
      // Real ordering: the open command row only exists post-dispatch.
      if (!dispatchedInteractive) {
        return null;
      }
      return {
        commandId: "cmd_codex",
        terminalSessionId: sessionId,
        commandStartedAt: new Date(Date.now() - 500),
        commandFinishedAt: null,
        exitCode: null,
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "codex",
    callId: "call_interactive",
  });

  assert.equal(execution.result.status, "interactive");
  assert.equal(execution.result.commandId, "cmd_codex");
  assert.equal(execution.result.error, undefined);
  assert.match(String(execution.payload.note), /terminal\.send/);
  const openCommand = execution.payload.open_command as { command_id: string };
  assert.equal(openCommand.command_id, "cmd_codex");
});

test("terminal.send of a shell command at a prompt carries the real exit code (substitutability)", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async sendInteraction() {
      // Settled-awaits accept command_finished: typing a command via
      // terminal.send still produces run-quality facts.
      return {
        dispatched: true,
        outcome: {
          event: "command_finished",
          data: { command_id: "cmd_send_ls", exit_code: 1, duration_ms: 40 },
        },
      };
    },
    async observeTerminal() {
      return { view: "delta", output: "ls: nope", linesCaptured: 1, changed: true };
    },
    async getLatestCommandForSession() {
      return null;
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    rawText: "ls /missing",
    callId: "call_send_command",
  });

  assert.equal(execution.result.interactionExitCode, 1);
  assert.equal(execution.payload.exit_code, 1);
  assert.equal(execution.result.dispatched, true);
});

test("terminal.wait is knobless: one awaited observe with the stall window, boundary facts win", async () => {
  const observeCalls: Array<Record<string, unknown>> = [];
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return { commandId: "cmd_open", commandStartedAt: new Date(Date.now() - 5000), commandFinishedAt: null };
    },
    async observeTerminal(sessionId: string, options: Record<string, unknown>) {
      observeCalls.push(options);
      assert.equal(sessionId, "sess_test");
      return {
        view: "delta",
        output: "build finished\n$ ",
        linesCaptured: 2,
        changed: true,
        mode: "shell",
        integration: "osc133",
        altScreen: false,
        outcome: { event: "command_finished", data: { command_id: "cmd_open", exit_code: 0 } },
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_cmd",
  });

  assert.deepEqual(observeCalls, [
    { view: "delta", lines: -50, await: "settled", quietMs: 1500 },
  ]);
  assert.equal(execution.result.kind, "wait");
  assert.equal(execution.result.waitOutcome, "command_finished");
  assert.equal(execution.result.waitExitCode, 0);
  assert.equal(execution.payload.outcome, "command_finished");
  assert.equal(execution.payload.exit_code, 0);
  assert.equal(execution.payload.output, "build finished\n$ ");
  assert.equal(typeof execution.payload.waited_ms, "number");
  assert.equal("until" in execution.payload, false);
  assert.match(execution.summary, /command finished \(exit 0\)/);
});

test("terminal.wait maps a stalled outcome to look-at-it guidance", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return { commandId: "cmd_codex", commandStartedAt: new Date(Date.now() - 60_000), commandFinishedAt: null };
    },
    async observeTerminal() {
      return {
        view: "delta",
        output: "Apply this patch? [y/n]",
        linesCaptured: 1,
        changed: true,
        mode: "shell",
        integration: "osc133",
        altScreen: false,
        outcome: { event: "stalled", data: { mode: "shell", quiet_ms: 1500 } },
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_stalled",
  });

  assert.equal(execution.result.waitOutcome, "stalled");
  assert.equal(execution.payload.outcome, "stalled");
  assert.equal(execution.payload.output, "Apply this patch? [y/n]");
  assert.match(String(execution.payload.note), /answer with terminal\.send/);
  assert.match(execution.summary, /output stopped changing/);
});

test("terminal.wait already-idle terminals resolve as settled immediately", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async observeTerminal() {
      return {
        view: "delta",
        output: "",
        linesCaptured: 0,
        changed: false,
        mode: "shell",
        integration: "osc133",
        altScreen: false,
        outcome: { event: "settled", data: { mode: "shell", quiet_ms: 0, immediate: true } },
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_settled",
  });

  assert.equal(execution.result.waitOutcome, "settled");
  assert.equal(execution.payload.changed, false);
  assert.equal(execution.summary, "Terminal is already settled");
});

test("terminal.wait budget expiry is a normal timeout result with a delta fallback and call-again guidance", async () => {
  let calls = 0;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return { commandId: "cmd_open", commandStartedAt: new Date(Date.now() - 1000), commandFinishedAt: null };
    },
    async observeTerminal(_sessionId: string, options: Record<string, unknown>) {
      calls += 1;
      if (options.await) {
        throw new Error("observe_timeout");
      }
      return { view: "delta", output: "still going", linesCaptured: 1, changed: true, mode: "shell" };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_timeout",
  });

  assert.equal(calls, 2);
  assert.equal(execution.result.kind, "wait");
  assert.equal(execution.result.waitOutcome, "timeout");
  assert.equal(execution.result.error, undefined);
  assert.equal(execution.payload.outcome, "timeout");
  assert.equal(execution.payload.output, "still going");
  assert.match(String(execution.payload.note), /call terminal\.wait again/);
  assert.match(execution.summary, /still busy/);
});

test("terminal.wait superseded by a follow-up message flags the result and skips the extra observe", async () => {
  let calls = 0;
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async observeTerminal() {
      calls += 1;
      throw new Error("superseded_by_user_message");
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_superseded",
  });

  assert.equal(calls, 1);
  assert.equal(execution.result.superseded, true);
  assert.equal(execution.result.waitOutcome, "superseded");
  assert.equal(execution.payload.outcome, "superseded");
  assert.equal(execution.summary, "Terminal wait ended because the user sent a new message");
});

test("terminal.wait interrupted by the user stays a conservative tool result", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async observeTerminal(_sessionId: string, options: Record<string, unknown>) {
      if (options.await) {
        throw new Error("interrupted");
      }
      return { view: "delta", output: "^C", linesCaptured: 1, changed: true, mode: "shell" };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_interrupted",
  });

  assert.equal(execution.result.waitOutcome, "interrupted");
  assert.equal(execution.result.error, "interrupted");
  assert.equal(execution.payload.output, "^C");
  assert.equal(execution.summary, "Terminal wait was interrupted by the user");
});

test("terminal.wait against a daemon without awaited observes notes the immediate snapshot", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "unknown", integration: "none", cwd: null };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async observeTerminal() {
      return { view: "delta", output: "", linesCaptured: 0, changed: false, mode: "unknown" };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.wait",
    callId: "call_wait_legacy",
  });

  assert.equal(execution.result.waitOutcome, "settled");
  assert.match(String(execution.payload.note), /does not support waiting/);
});

test("terminal.run maps the daemon's input_absorbed outcome to an honest status", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async sendInteraction() {
      return {
        dispatched: true,
        outcome: { event: "input_absorbed", data: { signal: "prompt_ready" } },
      };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.run",
    command: "   ",
    callId: "call_absorbed",
  });

  assert.equal(execution.result.kind, "command");
  assert.equal(execution.result.status, "input_absorbed");
  assert.equal(execution.result.error, undefined);
  assert.equal(execution.payload.status, "input_absorbed");
  assert.match(String(execution.payload.note), /no shell command started/);
});

test("terminal.observe output is tail-capped for the model", async () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell", integration: "osc133", cwd: "/repo" };
    },
    async getLatestCommandForSession() {
      return null;
    },
    async observeTerminal() {
      return { view: "history", output: big, linesCaptured: 4000, mode: "shell" };
    },
  };

  const execution = await createExecutor(terminalSessionManager).execute("thread_test", {
    type: "tool_call",
    tool: "terminal.observe",
    view: "history",
    callId: "call_observe_big",
  });

  assert.equal(execution.result.truncated, true);
  assert.equal(execution.outputTruncationReason, "service_observe_limit");
  assert.ok(Buffer.byteLength(String(execution.payload.output), "utf-8") < 33 * 1024);
  assert.match(String(execution.payload.output), /^\[\.\.\. earlier output omitted/);
  assert.ok(String(execution.payload.output).endsWith("line 3999 " + "x".repeat(20)));
  assert.equal(execution.payload.output_truncation_reason, "service_observe_limit");
});
