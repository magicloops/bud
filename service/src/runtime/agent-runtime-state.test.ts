import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentEnvironmentSnapshot } from "../agent/environment.js";
import { AgentRuntimeStateManager } from "./agent-runtime-state.js";

test("new snapshots are idle and expose a resumable stream cursor", () => {
  const runtime = new AgentRuntimeStateManager();
  const snapshot = runtime.getSnapshot("thread-1");

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.phase, "idle");
  assert.equal(snapshot.environment, null);
  assert.equal(snapshot.context_budget, null);
  assert.equal(snapshot.last_error, null);
  assert.deepEqual(snapshot.draft_reasoning, []);
  assert.equal(typeof snapshot.stream_cursor, "string");
  assert.ok(snapshot.stream_cursor.length > 0);
});

test("startTurn creates an active snapshot before any visible event exists", () => {
  const runtime = new AgentRuntimeStateManager();
  const environment = buildEnvironmentFixture(true);
  const snapshot = runtime.startTurn("thread-1", "turn-1", environment);

  assert.equal(snapshot.active, true);
  assert.equal(snapshot.turn_id, "turn-1");
  assert.equal(snapshot.phase, "starting");
  assert.deepEqual(snapshot.environment, environment);
  assert.equal(snapshot.context_budget, null);
  assert.equal(snapshot.last_error, null);
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
      name: "terminal.send",
      args: { command: "pwd" },
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
      name: "terminal.send",
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
      name: "terminal.send",
      args: { command: "pwd" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { command: "pwd" },
      started_at: "2026-04-21T19:00:01.000Z",
    },
    toolCallCursor,
  );

  runtime.emit("thread-1", {
    event: "agent.tool_result",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
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
  runtime.setContextBudget("thread-1", buildContextBudgetSnapshotFixture("active_agent_decision"));
  runtime.setEnvironment("thread-1", buildEnvironmentFixture(true));
  runtime.emit("thread-1", {
    event: "final",
    data: { turn_id: "turn-1", status: "succeeded" },
  });

  const idle = runtime.finishTurn("thread-1");
  assert.equal(idle.active, false);
  assert.equal(idle.phase, "idle");
  assert.equal(idle.environment, null);
  assert.equal(idle.context_budget, null);

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

test("runtime snapshots preserve last_error after failed turns and clear it on new turns", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const finalCursor = runtime.emit("thread-1", {
    event: "final",
    data: {
      turn_id: "turn-1",
      status: "failed",
      error: "The local model is already busy. Try again after the current run finishes.\n\nError: DATA_PLANE_STREAM_LIMIT_EXCEEDED",
      error_code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
      retryable: true,
    },
  });
  const failed = runtime.setLastError(
    "thread-1",
    {
      turn_id: "turn-1",
      code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
      message: "The local model is already busy. Try again after the current run finishes.\n\nError: DATA_PLANE_STREAM_LIMIT_EXCEEDED",
      retryable: true,
      occurred_at: "2026-06-04T00:00:00.000Z",
    },
    finalCursor,
  );

  assert.equal(failed.last_error?.code, "DATA_PLANE_STREAM_LIMIT_EXCEEDED");
  assert.equal(failed.stream_cursor, finalCursor);

  const idle = runtime.finishTurn("thread-1");
  assert.equal(idle.active, false);
  assert.equal(idle.last_error?.turn_id, "turn-1");
  assert.equal(idle.last_error?.retryable, true);

  const nextTurn = runtime.startTurn("thread-1", "turn-2");
  assert.equal(nextTurn.last_error, null);
});

test("runtime snapshots serialize and clear active context budget state", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const budget = buildContextBudgetSnapshotFixture("active_agent_decision");
  const snapshot = runtime.setContextBudget("thread-1", budget);
  assert.deepEqual(snapshot.context_budget, budget);
  assert.deepEqual(runtime.getSnapshot("thread-1").context_budget, budget);

  const cleared = runtime.startTurn("thread-1", "turn-2");
  assert.equal(cleared.context_budget, null);
});

test("runtime snapshots store and update active environment state", () => {
  const runtime = new AgentRuntimeStateManager();
  const online = buildEnvironmentFixture(true);
  const offline = buildEnvironmentFixture(false);

  runtime.startTurn("thread-1", "turn-1", online);
  assert.deepEqual(runtime.getSnapshot("thread-1").environment, online);

  const updated = runtime.setEnvironment("thread-1", offline);
  assert.deepEqual(updated.environment, offline);
  assert.deepEqual(runtime.getSnapshot("thread-1").environment, offline);
});

test("runtime snapshots serialize and clear draft reasoning state", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const startCursor = runtime.emit("thread-1", {
    event: "agent.reasoning_start",
    data: {
      turn_id: "turn-1",
      client_id: "reasoning-client-1",
      llm_call_id: "llm-call-1",
      index: 0,
      provider: "ds4",
      provider_model: "deepseek-v4-flash",
      started_at: "2026-06-05T20:00:01.000Z",
    },
  });
  runtime.setDraftReasoning(
    "thread-1",
    {
      turnId: "turn-1",
      clientId: "reasoning-client-1",
      text: "Inspect terminal state.",
      llmCallId: "llm-call-1",
      index: 0,
      provider: "ds4",
      providerModel: "deepseek-v4-flash",
      startedAt: new Date("2026-06-05T20:00:01.000Z"),
    },
    startCursor,
  );

  const snapshot = runtime.getSnapshot("thread-1");
  assert.equal(snapshot.phase, "thinking");
  assert.equal(snapshot.draft_reasoning.length, 1);
  assert.deepEqual(snapshot.draft_reasoning[0], {
    client_id: "reasoning-client-1",
    text: "Inspect terminal state.",
    llm_call_id: "llm-call-1",
    index: 0,
    provider: "ds4",
    provider_model: "deepseek-v4-flash",
    started_at: "2026-06-05T20:00:01.000Z",
    updated_at: snapshot.draft_reasoning[0]?.updated_at,
  });

  runtime.clearDraftReasoning("thread-1", "reasoning-client-1");
  assert.deepEqual(runtime.getSnapshot("thread-1").draft_reasoning, []);
});

test("runtime snapshots expose pending tool metadata and draft assistant client id", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const toolCursor = runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { command: "pwd" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { command: "pwd" },
      started_at: "2026-04-21T19:00:01.000Z",
    },
    toolCursor,
  );

  const toolSnapshot = runtime.getSnapshot("thread-1");
  assert.equal(toolSnapshot.pending_tool?.client_id, "tool-client-1");
  assert.equal(toolSnapshot.pending_tool?.started_at, "2026-04-21T19:00:01.000Z");

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

test("runtime snapshots expose waiting_for_user for pending question prompts", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread-1", "turn-1");

  const toolCursor = runtime.emit("thread-1", {
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-question",
      name: "ask_user_questions",
      args: {
        schema: "ask_user_questions_request_v1",
        request_id: "qr_test",
        questions: [
          {
            question_id: "env",
            kind: "single_choice",
            label: "Environment?",
            skippable: true,
            choices: [{ choice_id: "staging", label: "Staging" }],
          },
        ],
      },
    },
  });
  runtime.setPendingUserQuestions(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-question",
      name: "ask_user_questions",
      args: {
        schema: "ask_user_questions_request_v1",
        request_id: "qr_test",
        questions: [],
      },
      started_at: "2026-05-19T12:00:00.000Z",
    },
    toolCursor,
  );

  const snapshot = runtime.getSnapshot("thread-1");
  assert.equal(snapshot.phase, "waiting_for_user");
  assert.equal(snapshot.pending_tool?.name, "ask_user_questions");
  assert.equal(snapshot.pending_tool?.args.request_id, "qr_test");
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
      name: "terminal.send",
      args: { command: "pwd" },
    },
  });
  runtime.setPendingTool(
    "thread-1",
    {
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { command: "pwd" },
      started_at: "2026-04-21T19:00:01.000Z",
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

function buildContextBudgetSnapshotFixture(source: "active_agent_decision" | "durable_reconstruction") {
  return {
    status: "available" as const,
    model: "gpt-test",
    provider: "openai",
    context_window_tokens: 100_000,
    usable_context_window_tokens: 80_000,
    reserved_output_tokens: 10_000,
    usable_input_window_tokens: 70_000,
    compaction_enabled: true,
    compaction_threshold_ratio: 0.9,
    compaction_threshold_tokens: 63_000,
    effective_budget_tokens: 63_000,
    message_estimated_tokens: 10_000,
    tool_schema_tokens: 2_000,
    estimated_input_tokens: 12_000,
    remaining_context_tokens: 51_000,
    percent_of_context_budget: 12_000 / 63_000,
    percent_of_model_window: 12_000 / 100_000,
    basis: "model_agnostic_estimate" as const,
    confidence: "medium" as const,
    source,
    phase: source === "active_agent_decision" ? "pre_turn" as const : "idle" as const,
    reason: source === "active_agent_decision" ? "context_limit" as const : null,
    turn_id: source === "active_agent_decision" ? "turn-1" : null,
    checked_at: "2026-05-24T10:00:00.000Z",
    stale: false,
    updated_at: "2026-05-24T10:00:00.000Z",
    latest_checkpoint_id: null,
    compacted_through_message_id: null,
    compacted_through_llm_call_id: null,
    provider_usage_estimate: null,
  };
}

function buildEnvironmentFixture(online: boolean) {
  return buildAgentEnvironmentSnapshot({
    budId: "bud-1",
    online,
    lastSeenAt: new Date("2026-05-24T10:00:00.000Z"),
  });
}
