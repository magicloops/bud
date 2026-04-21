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
      assert.deepEqual(options, { timeoutMs: 30000 });

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
  assert.equal(
    execution.summary,
    "Attempted to send key ctrl+c; timed out waiting for settled output and no visible delta was observed",
  );
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
  assert.equal(execution.summary, 'Attempted to send "pwd" and send key ctrl+c');
});
