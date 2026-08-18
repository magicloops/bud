import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentMessageTiming,
  buildToolArgs,
  serializeAgentMessageTiming,
  serializeTerminalDelta,
  serializeToolExecutionTiming,
  toolNameForConversation,
} from "./contracts.js";

test("agent message timing serializes service wall-clock duration metadata", () => {
  const startedAt = new Date("2026-04-21T19:00:01.000Z");
  const finishedAt = new Date("2026-04-21T19:00:04.250Z");
  const timing = buildAgentMessageTiming(startedAt, finishedAt);

  assert.deepEqual(timing, {
    startedAt,
    finishedAt,
    durationMs: 3250,
  });
  assert.deepEqual(serializeAgentMessageTiming(timing), {
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
    duration_source: "service_wall_clock",
  });
  assert.deepEqual(serializeToolExecutionTiming(timing), serializeAgentMessageTiming(timing));
});

test("terminal tool args serialize the proto 0.3 model-facing shapes", () => {
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "terminal.run",
      command: "git status",
      callId: "call-run",
    }),
    { command: "git status" },
  );
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "terminal.send",
      rawText: "partial input",
      callId: "call-send-raw",
    }),
    { raw_text: "partial input" },
  );
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "terminal.send",
      key: "ctrl+c",
      callId: "call-send-key",
    }),
    { key: "ctrl+c" },
  );
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "terminal.observe",
      lines: -50,
      callId: "call-observe-default",
    }),
    { lines: -50 },
  );
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "terminal.observe",
      view: "screen",
      callId: "call-observe-screen",
    }),
    { view: "screen" },
  );
  assert.deepEqual(
    buildToolArgs({
      type: "tool_call",
      tool: "web_view.open",
      targetHost: "localhost",
      targetPort: 5173,
      path: "/",
      callId: "call-web-view-open",
    }),
    {
      target_host: "localhost",
      target_port: 5173,
      path: "/",
    },
  );
});

test("terminal directives map to canonical provider tool names", () => {
  assert.equal(toolNameForConversation("terminal.run"), "terminal_run");
  assert.equal(toolNameForConversation("terminal.send"), "terminal_send");
  assert.equal(toolNameForConversation("terminal.observe"), "terminal_observe");
});

test("terminal deltas serialize changed and text only", () => {
  assert.equal(serializeTerminalDelta(null), null);
  assert.equal(serializeTerminalDelta(undefined), null);
  assert.deepEqual(serializeTerminalDelta({ changed: true, text: "hello" }), {
    changed: true,
    text: "hello",
  });
});
