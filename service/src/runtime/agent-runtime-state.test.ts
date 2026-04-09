import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeStateManager } from "./agent-runtime-state.js";

test("new snapshots are idle and expose a resumable stream cursor", () => {
  const runtime = new AgentRuntimeStateManager();
  const snapshot = runtime.getSnapshot("thread-1");

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.phase, "idle");
  assert.equal(typeof snapshot.stream_cursor, "string");
  assert.ok(snapshot.stream_cursor.length > 0);
});

test("startTurn creates an active snapshot before any visible event exists", () => {
  const runtime = new AgentRuntimeStateManager();
  const snapshot = runtime.startTurn("thread-1", "turn-1");

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.turn_id, "turn-1");
  assert.equal(snapshot.phase, "starting");
  assert.equal(typeof snapshot.stream_cursor, "string");
  assert.ok(snapshot.stream_cursor.length > 0);

  const attachedEvents: string[] = [];
  const attachment = runtime.attachCallback(
    "thread-1",
    (event) => {
      attachedEvents.push(event.event);
    },
    { afterCursor: snapshot.stream_cursor },
  );

  assert.equal(attachment.status, "attached");
  assert.deepEqual(attachedEvents, []);
  attachment.detach();
});

test("no-cursor attach is live-only for agent runtime streams", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");
  runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
  });

  const replayedEvents: string[] = [];
  const attachment = runtime.attachCallback("thread-1", (event) => {
    replayedEvents.push(event.event);
  });

  assert.equal(attachment.status, "attached");
  assert.deepEqual(replayedEvents, []);

  runtime.emit("thread-1", {
    event: "agent.tool_result",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
    },
  });

  assert.deepEqual(replayedEvents, ["agent.tool_result"]);
  attachment.detach();
});

test("attach after a known cursor replays only newer visible events", () => {
  const runtime = new AgentRuntimeStateManager();
  const started = runtime.startTurn("thread-1", "turn-1");
  const toolCallCursor = runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
    toolCallCursor,
  );

  runtime.emit("thread-1", {
    event: "agent.tool_result",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
    },
  });
  runtime.markThinking("thread-1");

  const replayedEvents: string[] = [];
  const attachment = runtime.attachCallback(
    "thread-1",
    (event) => {
      replayedEvents.push(event.event);
    },
    { afterCursor: started.stream_cursor },
  );

  assert.equal(attachment.status, "attached");
  assert.deepEqual(replayedEvents, ["agent.tool_call", "agent.tool_result"]);
  attachment.detach();
});

test("missing resume cursor requires explicit resync", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");
  runtime.emit("thread-1", {
    event: "agent.message_start",
    data: { turn_id: "turn-1", client_id: "assistant-client-1" },
  });

  const attachment = runtime.attachCallback("thread-1", () => {}, {
    afterCursor: "cursor_missing",
  });

  assert.equal(attachment.status, "resync_required");
});

test("finishing a turn returns the snapshot to idle with a fresh cursor", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");
  runtime.emit("thread-1", {
    event: "final",
    data: { turn_id: "turn-1", status: "succeeded" },
  });

  const idle = runtime.finishTurn("thread-1");
  assert.equal(idle.active, false);
  assert.equal(idle.phase, "idle");

  const replayedEvents: string[] = [];
  const attachment = runtime.attachCallback(
    "thread-1",
    (event) => {
      replayedEvents.push(event.event);
    },
    { afterCursor: idle.stream_cursor },
  );

  assert.equal(attachment.status, "attached");
  assert.deepEqual(replayedEvents, []);
  attachment.detach();
});

test("runtime snapshots expose client_id on pending_tool and draft_assistant", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const toolCursor = runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
    toolCursor,
  );

  const toolSnapshot = runtime.getSnapshot("thread-1");
  assert.equal(toolSnapshot.pending_tool?.client_id, "tool-client-1");

  const messageCursor = runtime.emit("thread-1", {
    event: "agent.message_start",
    data: {
      turn_id: "turn-1",
      client_id: "assistant-client-1",
    },
  });
  runtime.setDraftAssistant("thread-1", "assistant-client-1", "Hello", messageCursor);

  const draftSnapshot = runtime.getSnapshot("thread-1");
  assert.equal(draftSnapshot.pending_tool, null);
  assert.equal(draftSnapshot.draft_assistant?.client_id, "assistant-client-1");
  assert.equal(draftSnapshot.draft_assistant?.text, "Hello");
});

test("advanceCursor preserves runtime state while acknowledging external events", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const toolCursor = runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.run",
      args: { input: "pwd\n" },
    },
    toolCursor,
  );

  const externalCursor = runtime.emit("thread-1", {
    event: "thread.title",
    data: {
      thread_id: "thread-1",
      title: "List Directory Contents",
      source: "generated_first_user_message",
      updated_at: new Date().toISOString(),
    },
  });

  const snapshot = runtime.advanceCursor("thread-1", externalCursor);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.phase, "tool_running");
  assert.equal(snapshot.pending_tool?.client_id, "tool-client-1");
  assert.equal(snapshot.stream_cursor, externalCursor);

  const replayedEvents: string[] = [];
  const attachment = runtime.attachCallback(
    "thread-1",
    (event) => {
      replayedEvents.push(event.event);
    },
    { afterCursor: externalCursor },
  );

  assert.equal(attachment.status, "attached");
  assert.deepEqual(replayedEvents, []);
  attachment.detach();
});
