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

test("execute keeps ctrl+c summaries conservative when no visible delta is observed", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return {
        mode: "repl",
        program: "python",
        programDisplayName: "Python REPL",
        interactionStyle: "code",
        hints: ["Send Python code, not shell commands"],
      };
    },
    async sendInteraction(
      sessionId: string,
      interaction: {
        text?: string;
        submit?: boolean;
        key?: string;
        observeAfterMs?: number;
        waitFor?: string;
      },
      options?: {
        timeoutMs?: number;
      },
    ) {
      assert.equal(sessionId, "sess_test");
      assert.deepEqual(interaction, {
        text: undefined,
        submit: undefined,
        key: "ctrl+c",
        observeAfterMs: undefined,
        waitFor: undefined,
      });
      assert.equal(options, undefined);

      return {
        submitted: true,
        delta: {
          changed: false,
          text: "",
          truncated: false,
        },
        readiness: {
          ready: false,
          confidence: 0.35,
          trigger: "timeout",
          hints: {
            looks_like_prompt: false,
            looks_like_confirmation: false,
            looks_like_password: false,
            looks_like_pager: false,
            looks_like_error: false,
            may_still_be_processing: false,
          },
        },
      };
    },
  };

  const executor = new TerminalToolExecutor(
    terminalSessionManager as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    key: "ctrl+c",
    timeoutMs: 1,
    callId: "call_send_1",
  });

  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.submitted, true);
  assert.deepEqual(execution.result.delta, {
    changed: false,
    text: "",
    truncated: false,
  });
  assert.equal(execution.result.contextAfter?.mode, "repl");
  assert.equal(execution.result.contextAfter?.program, "python");
  assert.equal(execution.result.contextAfter?.source, "inferred");
  assert.equal(execution.args.wait_for, "settled");
  assert.equal(execution.payload.wait_for, "settled");
  assert.equal(
    execution.summary,
    "Send key ctrl+c; timed out waiting for settled output and no visible delta was observed",
  );
});

test("execute ignores model-supplied timeout_ms for terminal.observe", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell" };
    },
    async observeTerminal(
      sessionId: string,
      options: {
        lines?: number;
        waitFor?: string;
        view?: string;
      },
      timeoutMs?: number,
    ) {
      assert.equal(sessionId, "sess_test");
      assert.deepEqual(options, {
        lines: -50,
        waitFor: "settled",
        view: "delta",
      });
      assert.equal(timeoutMs, undefined);

      return {
        view: "delta",
        output: "done",
        outputBytes: 4,
        linesCaptured: 1,
        changed: true,
        truncated: false,
        readiness: {
          ready: true,
          confidence: 0.9,
          trigger: "settled",
          hints: {
            looks_like_prompt: true,
            looks_like_confirmation: false,
            looks_like_password: false,
            looks_like_pager: false,
            looks_like_error: false,
            may_still_be_processing: false,
          },
        },
      };
    },
  };

  const executor = new TerminalToolExecutor(
    terminalSessionManager as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.observe",
    waitFor: "settled",
    timeoutMs: 1,
    callId: "call_observe_1",
  });

  assert.equal(execution.result.kind, "observation");
  assert.equal(execution.args.wait_for, "settled");
  assert.equal(execution.payload.wait_for, "settled");
  assert.deepEqual(execution.result.delta, {
    changed: true,
    text: "done",
    truncated: false,
  });
});

test("execute returns conservative tool result when terminal.send wait is interrupted", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return {
        mode: "repl",
        program: "claude",
        programDisplayName: "Claude Code",
        interactionStyle: "natural_language",
        hints: ["Use natural language requests, not shell commands"],
      };
    },
    async sendInteraction() {
      throw new Error("interrupted");
    },
  };

  const executor = new TerminalToolExecutor(
    terminalSessionManager as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    text: "codex \"work\"",
    submit: true,
    callId: "call_send_interrupted",
  });

  assert.equal(execution.result.kind, "interaction_ack");
  assert.equal(execution.result.error, "interrupted");
  assert.equal(execution.result.submitted, true);
  assert.equal(execution.result.delta, null);
  assert.equal(execution.result.readiness.ready, false);
  assert.equal(execution.result.readiness.trigger, "error");
  assert.equal(execution.result.contextAfter?.mode, "repl");
  assert.equal(execution.result.contextAfter?.source, "inferred");
  assert.equal(
    execution.summary,
    "Terminal send wait was interrupted by the user after the input was sent",
  );
});

test("execute returns conservative tool result when terminal.observe wait is interrupted", async () => {
  const terminalSessionManager = {
    getSessionContext() {
      return { mode: "shell" };
    },
    async observeTerminal() {
      throw new Error("interrupted");
    },
  };

  const executor = new TerminalToolExecutor(
    terminalSessionManager as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.observe",
    waitFor: "settled",
    callId: "call_observe_interrupted",
  });

  assert.equal(execution.result.kind, "observation");
  assert.equal(execution.result.error, "interrupted");
  assert.deepEqual(execution.result.delta, {
    changed: false,
    text: "",
    truncated: false,
  });
  assert.equal(execution.result.readiness.ready, false);
  assert.equal(execution.result.readiness.trigger, "error");
  assert.equal(execution.summary, "Terminal observe wait was interrupted by the user");
});

test("execute rejects ambiguous terminal.send directives before touching the runtime", async () => {
  let sendCalls = 0;
  const executor = new TerminalToolExecutor(
    {
      getSessionContext() {
        return { mode: "shell" };
      },
      async sendInteraction() {
        sendCalls += 1;
        throw new Error("should_not_run");
      },
      getLatestReadiness() {
        return null;
      },
    } as never,
    createLogger() as never,
    false,
    false,
    async () => ({ sessionId: "sess_test" } as never),
  );

  const execution = await executor.execute("thread_test", {
    type: "tool_call",
    tool: "terminal.send",
    text: "pwd",
    key: "ctrl+c",
    callId: "call_send_invalid",
  });

  assert.equal(sendCalls, 0);
  assert.equal(execution.result.error, "ambiguous_interaction");
  assert.equal(execution.result.submitted, false);
  assert.equal(execution.summary, 'Send "pwd" and send key ctrl+c');
});
