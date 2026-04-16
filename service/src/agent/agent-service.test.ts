import assert from "node:assert/strict";
import test from "node:test";
import { AgentService } from "./agent-service.js";

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

test("terminal.send uses tmux C-c key notation for shared interrupt-style input", async () => {
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
        keys?: string[];
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
        keys: ["C-c"],
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

  const service = new AgentService(
    terminalSessionManager as never,
    {} as never,
    createLogger() as never,
    false,
    false,
  );
  (service as any).getOrCreateSession = async () => ({ sessionId: "sess_test" });

  const directive = {
    type: "tool_call",
    tool: "terminal.send",
    keys: ["C-c"],
    callId: "call_send_1",
  };

  const result = await (service as any).executeTerminalCall("thread_test", directive);
  const summary = (service as any).buildToolSummary(directive, result);

  assert.equal(result.kind, "interaction_ack");
  assert.equal(result.submitted, true);
  assert.deepEqual(result.delta, {
    changed: false,
    text: "",
    truncated: false,
  });
  assert.equal(result.contextAfter.mode, "repl");
  assert.equal(result.contextAfter.program, "python");
  assert.equal(result.contextAfter.source, "inferred");
  assert.equal(
    summary,
    "Attempted to send keys C-c; timed out waiting for settled output and no visible delta was observed",
  );
});

test("agent no longer accepts terminal_interrupt tool calls", () => {
  const service = new AgentService(
    {
      getSessionContext() {
        return { mode: "shell" };
      },
    } as never,
    {} as never,
    createLogger() as never,
    false,
    false,
  );

  const directive = (service as any).extractFunctionCall({
    id: "resp_1",
    content: [],
    stopReason: "tool_use",
    toolCalls: [
      {
        id: "call_interrupt_1",
        name: "terminal_interrupt",
        input: {},
      },
    ],
  });

  assert.equal(directive, null);
});
