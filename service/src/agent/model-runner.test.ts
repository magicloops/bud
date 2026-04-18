import assert from "node:assert/strict";
import test from "node:test";
import { AgentModelRunner } from "./model-runner.js";

function createRuntime() {
  return {
    emit() {
      return "cursor_1";
    },
    setDraftAssistant() {
      // noop
    },
  };
}

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

test("resolveReasoningEffort follows the selected model instead of the default-model snapshot", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
    "none",
  );

  assert.equal(runner.resolveReasoningEffort("gpt-4.1-mini", "none"), "none");
  assert.equal(runner.resolveReasoningEffort("o3-mini", "none"), "low");
});

test("extractToolCall normalizes legacy keys arrays to canonical semantic key strings", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const directive = runner.extractToolCall({
    id: "resp_legacy_key",
    content: [],
    stopReason: "tool_use",
    toolCalls: [
      {
        id: "call_send_legacy",
        name: "terminal_send",
        input: {
          keys: ["C-c"],
        },
      },
    ],
  });

  assert.deepEqual(directive, {
    type: "tool_call",
    tool: "terminal.send",
    text: undefined,
    submit: false,
    key: "ctrl+c",
    observeAfterMs: undefined,
    waitFor: undefined,
    timeoutMs: undefined,
    callId: "call_send_legacy",
  });
});
