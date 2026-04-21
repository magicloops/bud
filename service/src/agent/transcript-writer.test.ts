import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { AgentTranscriptWriter } from "./transcript-writer.js";
import type { ExecutedTerminalTool } from "./contracts.js";

function createRuntimeRecorder() {
  const events: Array<{ threadId: string; event: string; data: Record<string, unknown> }> = [];

  return {
    events,
    runtime: {
      emit(threadId: string, event: { event: string; data: Record<string, unknown> }) {
        events.push({ threadId, event: event.event, data: event.data });
        return `${event.event}-cursor`;
      },
      setPendingTool() {
        // noop
      },
      markThinking() {
        // noop
      },
      clearDraftAssistant() {
        // noop
      },
    },
  };
}

test("tool timing is emitted on the stream and persisted only in metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: Array<Record<string, unknown>> = [];
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      insertedValues.push(values);
      return {
        returning() {
          return [
            {
              messageId: "message-1",
              clientId: values.clientId,
              role: values.role,
              displayRole: values.displayRole,
              content: values.content,
              metadata: values.metadata,
              createdAt: new Date("2026-04-21T19:00:05.000Z"),
            },
          ];
        },
      };
    },
  }) as never);
  mock.method(db, "execute", async () => []);

  const { runtime, events } = createRuntimeRecorder();
  const writer = new AgentTranscriptWriter(runtime as never);
  const execution: ExecutedTerminalTool = {
    directive: {
      type: "tool_call",
      tool: "terminal.send",
      text: "pwd",
      submit: true,
      callId: "call-1",
    },
    args: { text: "pwd", submit: true },
    summary: 'Attempted to send "pwd"',
    outputTruncationReason: null,
    result: {
      kind: "interaction_ack",
      readiness: { ready: true, confidence: 0.9, trigger: "settled" },
      submitted: true,
      delta: { changed: true, text: "/repo", truncated: false },
      contextAfter: { mode: "shell", source: "observed" },
    },
    payload: {
      tool: "terminal.send",
      call_id: "call-1",
      text: "pwd",
      submit: true,
      summary: 'Attempted to send "pwd"',
      kind: "interaction_ack",
      readiness: { ready: true, confidence: 0.9, trigger: "settled" },
      submitted: true,
      delta: { changed: true, text: "/repo", truncated: false },
      context_after: { mode: "shell", source: "observed" },
    },
  };
  const startedAt = new Date("2026-04-21T19:00:01.000Z");
  const finishedAt = new Date("2026-04-21T19:00:04.250Z");

  writer.emitToolCall("thread-1", "turn-1", execution.directive, "tool-client-1", startedAt);
  const result = await writer.recordToolResult({
    threadId: "thread-1",
    turnId: "turn-1",
    execution,
    clientId: "tool-client-1",
    timing: {
      startedAt,
      finishedAt,
      durationMs: 3250,
    },
  });

  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0]?.content, JSON.stringify(execution.payload));
  assert.deepEqual(insertedValues[0]?.metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
  });

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    threadId: "thread-1",
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { text: "pwd", submit: true },
      started_at: "2026-04-21T19:00:01.000Z",
    },
  });
  assert.equal(events[1]?.event, "agent.tool_result");
  assert.equal(events[1]?.data.started_at, "2026-04-21T19:00:01.000Z");
  assert.equal(events[1]?.data.finished_at, "2026-04-21T19:00:04.250Z");
  assert.equal(events[1]?.data.duration_ms, 3250);
  assert.deepEqual((events[1]?.data.message as Record<string, unknown>).metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
  });

  assert.deepEqual(result.payload, execution.payload);
  assert.deepEqual(result.message.metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
  });
});
