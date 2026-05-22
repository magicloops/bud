import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { AgentTranscriptWriter } from "./transcript-writer.js";
import type { ExecutedTerminalTool } from "./contracts.js";
import { buildExecutedUserQuestionTool } from "./user-question-repository.js";
import {
  buildAskUserQuestionsToolResult,
  normalizeAskUserQuestionsRequest,
} from "./user-question-contracts.js";

function createRuntimeRecorder() {
  const events: Array<{ threadId: string; event: string; data: Record<string, unknown> }> = [];
  const pendingTools: Array<{
    threadId: string;
    pendingTool: Record<string, unknown>;
    cursor: string;
  }> = [];
  const pendingUserQuestions: Array<{
    threadId: string;
    pendingTool: Record<string, unknown>;
    cursor: string;
  }> = [];

  return {
    events,
    pendingTools,
    pendingUserQuestions,
    runtime: {
      emit(threadId: string, event: { event: string; data: Record<string, unknown> }) {
        events.push({ threadId, event: event.event, data: event.data });
        return `${event.event}-cursor`;
      },
      setPendingTool(
        threadId: string,
        pendingTool: Record<string, unknown>,
        cursor: string,
      ) {
        pendingTools.push({ threadId, pendingTool, cursor });
      },
      setPendingUserQuestions(
        threadId: string,
        pendingTool: Record<string, unknown>,
        cursor: string,
      ) {
        pendingUserQuestions.push({ threadId, pendingTool, cursor });
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

  const { runtime, events, pendingTools } = createRuntimeRecorder();
  const writer = new AgentTranscriptWriter(runtime as never);
  const execution: ExecutedTerminalTool = {
    directive: {
      type: "tool_call",
      tool: "terminal.send",
      text: "pwd",
      submit: true,
      callId: "call-1",
    },
    args: { text: "pwd", submit: true, wait_for: "settled" },
    summary: 'Send "pwd"',
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
      wait_for: "settled",
      summary: 'Send "pwd"',
      kind: "interaction_ack",
      readiness: { ready: true, confidence: 0.9, trigger: "settled" },
      submitted: true,
      delta: { changed: true, text: "/repo", truncated: false },
      context_after: { mode: "shell", source: "observed" },
    },
  };
  const startedAt = new Date("2026-04-21T19:00:01.000Z");
  const finishedAt = new Date("2026-04-21T19:00:04.250Z");
  const pathContextBefore = {
    schema: "terminal_cwd_v1",
    source: "terminal_runtime_cache",
    reported_by: "tmux_pane_current_path",
    terminal_session_id: "sess_test",
    host_cwd: "/Users/adam/bud",
    captured_at: "2026-04-21T19:00:00.000Z",
  } as const;
  const pathContextAfter = {
    ...pathContextBefore,
    host_cwd: "/Users/adam/bud/service",
    captured_at: "2026-04-21T19:00:04.000Z",
  } as const;

  const emittedToolCall = writer.emitToolCall(
    "thread-1",
    "turn-1",
    execution.directive,
    "tool-client-1",
    startedAt,
  );
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
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "explicit_request",
    },
    pathContextBefore,
    pathContextAfter,
  });

  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0]?.content, JSON.stringify(execution.payload));
  assert.deepEqual(insertedValues[0]?.metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
    model: "gpt-5.5",
    reasoning_effort: "low",
    model_selection_source: "explicit_request",
    path_context_before: pathContextBefore,
    path_context_after: pathContextAfter,
  });

  assert.equal(events.length, 2);
  assert.deepEqual(emittedToolCall.modelArgs, { text: "pwd", submit: true });
  assert.deepEqual(emittedToolCall.clientArgs, {
    text: "pwd",
    submit: true,
    wait_for: "settled",
  });
  assert.deepEqual(events[0], {
    threadId: "thread-1",
    event: "agent.tool_call",
    data: {
      turn_id: "turn-1",
      client_id: "tool-client-1",
      call_id: "call-1",
      name: "terminal.send",
      args: { text: "pwd", submit: true, wait_for: "settled" },
      started_at: "2026-04-21T19:00:01.000Z",
    },
  });
  assert.deepEqual(pendingTools, [
    {
      threadId: "thread-1",
      pendingTool: {
        client_id: "tool-client-1",
        call_id: "call-1",
        name: "terminal.send",
        args: { text: "pwd", submit: true, wait_for: "settled" },
        started_at: "2026-04-21T19:00:01.000Z",
      },
      cursor: "agent.tool_call-cursor",
    },
  ]);
  assert.equal(events[1]?.event, "agent.tool_result");
  assert.equal(events[1]?.data.started_at, "2026-04-21T19:00:01.000Z");
  assert.equal(events[1]?.data.finished_at, "2026-04-21T19:00:04.250Z");
  assert.equal(events[1]?.data.duration_ms, 3250);
  assert.deepEqual((events[1]?.data.message as Record<string, unknown>).metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
    model: "gpt-5.5",
    reasoning_effort: "low",
    model_selection_source: "explicit_request",
    path_context_before: pathContextBefore,
    path_context_after: pathContextAfter,
  });

  assert.deepEqual(result.payload, execution.payload);
  assert.deepEqual(result.message.metadata, {
    ...execution.payload,
    started_at: "2026-04-21T19:00:01.000Z",
    finished_at: "2026-04-21T19:00:04.250Z",
    duration_ms: 3250,
    model: "gpt-5.5",
    reasoning_effort: "low",
    model_selection_source: "explicit_request",
    path_context_before: pathContextBefore,
    path_context_after: pathContextAfter,
  });
});

test("ask_user_questions tool calls use waiting prompt runtime state and completed Q/A result rows", async (t) => {
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
              messageId: "message-question-1",
              clientId: values.clientId,
              role: values.role,
              displayRole: values.displayRole,
              content: values.content,
              metadata: values.metadata,
              createdAt: new Date("2026-05-19T20:00:05.000Z"),
            },
          ];
        },
      };
    },
  }) as never);
  mock.method(db, "execute", async () => []);

  const { runtime, events, pendingTools, pendingUserQuestions } = createRuntimeRecorder();
  const writer = new AgentTranscriptWriter(runtime as never);
  const request = normalizeAskUserQuestionsRequest({
    title: "Deploy",
    questions: [
      {
        question_id: "env",
        kind: "single_choice",
        label: "Environment?",
        choices: [{ choice_id: "staging", label: "Staging" }],
      },
    ],
  });
  const directive = {
    type: "tool_call",
    tool: "ask_user_questions",
    callId: "call-question",
    request: {
      ...request,
      request_id: "qr_test",
    },
  } as const;
  const toolResult = buildAskUserQuestionsToolResult(
    directive.request,
    {
      schema: "ask_user_questions_response_v1",
      client_response_id: "018f4f2a-0000-7000-9000-000000000000",
      answers: [
        {
          question_id: "env",
          status: "answered",
          answer: { kind: "single_choice", choice_id: "staging" },
        },
      ],
    },
    "qr_test",
  );
  const execution = buildExecutedUserQuestionTool({
    directive,
    toolResult,
  });

  writer.emitToolCall(
    "thread-1",
    "turn-1",
    directive,
    "question-client-1",
    new Date("2026-05-19T20:00:01.000Z"),
  );
  const result = await writer.recordToolResult({
    threadId: "thread-1",
    turnId: "turn-1",
    execution,
    clientId: "question-client-1",
    timing: {
      startedAt: new Date("2026-05-19T20:00:01.000Z"),
      finishedAt: new Date("2026-05-19T20:00:04.000Z"),
      durationMs: 3000,
    },
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "service_default",
    },
    ownerUserId: "user-1",
    llmCallId: "llm-call-1",
  });

  assert.deepEqual(pendingTools, []);
  assert.equal(pendingUserQuestions.length, 1);
  assert.equal(pendingUserQuestions[0]?.pendingTool.name, "ask_user_questions");
  assert.equal((pendingUserQuestions[0]?.pendingTool.args as Record<string, unknown>).request_id, "qr_test");

  assert.equal(insertedValues.length, 1);
  assert.equal(insertedValues[0]?.role, "tool");
  assert.equal(insertedValues[0]?.createdByUserId, "user-1");
  assert.equal((insertedValues[0]?.metadata as Record<string, unknown>).tool, "ask_user_questions");
  assert.equal((insertedValues[0]?.metadata as Record<string, unknown>).llm_call_id, "llm-call-1");

  assert.equal(events[0]?.event, "agent.tool_call");
  assert.equal(events[1]?.event, "agent.tool_result");
  assert.deepEqual(events[1]?.data.user_questions, {
    kind: "user_questions",
    requestId: "qr_test",
    responses: toolResult.responses,
  });
  assert.equal((events[1]?.data.message as Record<string, unknown>).message_id, "message-question-1");
  assert.deepEqual(result.payload.result, toolResult);
});

test("assistant text segments are persisted before tool calls without finalizing the turn", async (t) => {
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
              messageId: "message-assistant-1",
              clientId: values.clientId,
              role: values.role,
              displayRole: values.displayRole,
              content: values.content,
              metadata: values.metadata,
              createdAt: new Date("2026-04-21T20:00:05.000Z"),
            },
          ];
        },
      };
    },
  }) as never);
  mock.method(db, "execute", async () => []);

  const { runtime, events } = createRuntimeRecorder();
  const writer = new AgentTranscriptWriter(runtime as never);

  const result = await writer.recordAssistantTextSegment({
    threadId: "thread-1",
    turnId: "turn-1",
    message: "I will inspect the terminal first.",
    clientId: "assistant-client-1",
    segmentKind: "intermediate",
    followedByToolCall: true,
    llmCallId: "llm-call-1",
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      source: "service_default",
    },
  });

  assert.equal(insertedValues.length, 1);
  assert.deepEqual(insertedValues[0]?.metadata, {
    status: "succeeded",
    turn_id: "turn-1",
    segment_kind: "intermediate",
    assistant_phase: "commentary",
    llm_call_id: "llm-call-1",
    followed_by_tool_call: true,
    model: "gpt-5.5",
    reasoning_effort: "medium",
    model_selection_source: "service_default",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "agent.message");
  assert.equal(events[0]?.data.text, "I will inspect the terminal first.");
  assert.equal((events[0]?.data.message as Record<string, unknown>).message_id, "message-assistant-1");
  assert.equal(result.message_id, "message-assistant-1");
});

test("final assistant messages persist final_answer assistant phase metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: Array<Record<string, unknown>> = [];
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert() {
        return {
          values(values: Record<string, unknown>) {
            insertedValues.push(values);
            return {
              returning() {
                return [
                  {
                    messageId: "message-final-1",
                    clientId: values.clientId,
                    role: values.role,
                    displayRole: values.displayRole,
                    content: values.content,
                    metadata: values.metadata,
                    createdAt: new Date("2026-05-22T20:00:05.000Z"),
                  },
                ];
              },
            };
          },
        };
      },
      execute() {
        return Promise.resolve([]);
      },
      select() {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      limit() {
                        return Promise.resolve([
                          {
                            budId: "bud-1",
                            threadTitle: null,
                            threadOwnerUserId: null,
                            budDisplayName: "Bud",
                            budName: "bud",
                          },
                        ]);
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };
    return callback(tx as never);
  });

  const { runtime, events } = createRuntimeRecorder();
  const writer = new AgentTranscriptWriter(runtime as never);

  const result = await writer.recordFinalAssistant({
    threadId: "thread-1",
    turnId: "turn-1",
    message: "Done.",
    status: "succeeded",
    clientId: "assistant-client-1",
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "service_default",
    },
    llmCallId: "llm-call-1",
  });

  assert.equal(insertedValues.length, 1);
  assert.deepEqual(insertedValues[0]?.metadata, {
    status: "succeeded",
    turn_id: "turn-1",
    segment_kind: "final",
    assistant_phase: "final_answer",
    llm_call_id: "llm-call-1",
    attention_kind: "assistant_completed",
    model: "gpt-5.5",
    reasoning_effort: "low",
    model_selection_source: "service_default",
  });
  assert.equal(events[0]?.event, "agent.message");
  assert.equal(events[1]?.event, "final");
  assert.equal(result.message_id, "message-final-1");
});
