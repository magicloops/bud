import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { AgentService } from "./agent-service.js";
import {
  buildAgentEnvironmentSnapshot,
  type AgentEnvironmentSnapshot,
} from "./environment.js";

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

function mockCurrentContextCheckpointBoundary() {
  let selectCall = 0;
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            orderBy() {
              return {
                limit() {
                  selectCall += 1;
                  if (selectCall % 2 === 1) {
                    return Promise.resolve([
                      {
                        messageId: "message-boundary-1",
                        createdAt: new Date("2026-05-01T00:00:00.000Z"),
                      },
                    ]);
                  }
                  return Promise.resolve([
                    {
                      llmCallId: "llm-boundary-1",
                      createdAt: new Date("2026-05-01T00:00:01.000Z"),
                    },
                  ]);
                },
              };
            },
          };
        },
      };
    },
  }) as never);
}

type CompactConversationIfNeeded = (args: {
  threadId: string;
  turnId: string;
  sessionId: string | null;
  model: string;
  modelReasoning: {
    providerModel: string;
    reasoningLevel: string;
    reasoning?: unknown;
  };
  providerName: "openai";
  phase: "pre_turn" | "mid_turn";
  reason: "context_limit" | "context_error_retry";
  conversation: Array<{ role: "user"; content: string }>;
  ownerUserId?: string | null;
  controller: AbortController;
  force?: boolean;
  compactedBoundaryKeys?: Set<string>;
}) => Promise<unknown>;

function buildNormalEnvironment(): AgentEnvironmentSnapshot {
  return buildAgentEnvironmentSnapshot({
    budId: "bud-1",
    online: true,
    lastSeenAt: new Date("2026-05-01T00:00:00.000Z"),
  });
}

function stubNormalEnvironment(service: AgentService): AgentEnvironmentSnapshot {
  const environment = buildNormalEnvironment();
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  return environment;
}

function buildCompactionArgs() {
  return {
    threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
    turnId: "01KQG8FX9YZAR32E4RGWVVA67G",
    sessionId: "sess_test",
    model: "gpt-5.5",
    modelReasoning: {
      providerModel: "gpt-5.5",
      reasoningLevel: "low",
    },
    providerName: "openai" as const,
    phase: "pre_turn" as const,
    reason: "context_limit" as const,
    conversation: [{ role: "user" as const, content: "Please continue." }],
    ownerUserId: "user-1",
    controller: new AbortController(),
    force: true,
    compactedBoundaryKeys: new Set<string>(),
  };
}

test("cancelThread aborts the active turn, rejects waits, and cancels pending question rows", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const terminalCalls: Array<{ threadId: string; errorMessage: string }> = [];
  const service = new AgentService(
    {
      async rejectPendingRequestsForThread(threadId: string, errorMessage: string) {
        terminalCalls.push({ threadId, errorMessage });
      },
    } as never,
    {} as never,
    createLogger() as never,
    false,
    false,
  );

  const controller = new AbortController();
  const cancellations = Reflect.get(service, "cancellations") as Map<string, AbortController>;
  cancellations.set("thread-1", controller);

  const updateCapture: { values: Record<string, unknown> | null } = { values: null };
  mock.method(db, "update", () => ({
    set(values: Record<string, unknown>) {
      updateCapture.values = values;
      return {
        where() {
          return Promise.resolve(undefined);
        },
      };
    },
  }) as never);

  await service.cancelThread("thread-1");

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.isThreadActive("thread-1"), false);
  const capturedUpdate = updateCapture.values;
  assert.ok(capturedUpdate);
  assert.equal(capturedUpdate.status, "canceled");
  assert.ok(capturedUpdate.updatedAt instanceof Date);
  assert.deepEqual(terminalCalls, [
    {
      threadId: "thread-1",
      errorMessage: "agent_canceled",
    },
  ]);
});

test("automatic compaction emits start and done runtime events without checkpoint internals", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockCurrentContextCheckpointBoundary();

  const runtimeEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const thinkingCursors: string[] = [];
  const runtime = {
    emit(_threadId: string, event: { event: string; data: Record<string, unknown> }) {
      runtimeEvents.push(event);
      return `cursor-${runtimeEvents.length}`;
    },
    setContextBudget() {
      // noop
    },
    markThinking(_threadId: string, cursor?: string) {
      if (cursor) {
        thinkingCursors.push(cursor);
      }
    },
  };
  const service = new AgentService(
    {} as never,
    runtime as never,
    createLogger() as never,
    false,
    false,
  );

  Reflect.set(service, "contextCompactor", {
    async compact() {
      assert.equal(runtimeEvents[0]?.event, "agent.compaction_start");
      return {
        checkpoint: { checkpointId: "checkpoint-1" },
        replacementHistory: [{ role: "user", content: "secret summary" }],
        estimatedTokensAfter: 42,
      };
    },
  });
  Reflect.set(service, "conversationLoader", {
    async loadWithDiagnostics() {
      return {
        messages: [],
        reconstruction: {
          mode: "canonical_only",
        },
      };
    },
  });

  const compactConversationIfNeeded = Reflect.get(
    service,
    "compactConversationIfNeeded",
  ) as CompactConversationIfNeeded;
  await compactConversationIfNeeded.call(service, buildCompactionArgs());

  assert.deepEqual(runtimeEvents.map((event) => event.event), [
    "agent.compaction_start",
    "agent.compaction_done",
  ]);
  assert.deepEqual(thinkingCursors, ["cursor-1", "cursor-2"]);
  assert.equal(runtimeEvents[0]?.data.turn_id, "01KQG8FX9YZAR32E4RGWVVA67G");
  assert.equal(runtimeEvents[0]?.data.trigger, "auto");
  assert.equal(runtimeEvents[0]?.data.reason, "context_limit");
  assert.equal(runtimeEvents[0]?.data.phase, "pre_turn");
  assert.equal("checkpoint_id" in runtimeEvents[0]!.data, false);
  assert.equal("summary" in runtimeEvents[1]!.data, false);
  assert.equal("replacementHistory" in runtimeEvents[1]!.data, false);
  assert.equal(runtimeEvents[1]?.data.checkpoint_id, "checkpoint-1");
  assert.equal(runtimeEvents[1]?.data.tokens_after, 42);
  assert.equal(
    (runtimeEvents[1]?.data.context_budget as Record<string, unknown> | undefined)?.source,
    "compaction_event",
  );
});

test("automatic compaction skip stores the active budget decision used by the trigger", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const contextBudgets: Array<Record<string, unknown>> = [];
  const runtime = {
    emit() {
      throw new Error("compaction should not emit when below threshold");
    },
    setContextBudget(_threadId: string, snapshot: Record<string, unknown>) {
      contextBudgets.push(snapshot);
    },
    markThinking() {
      // noop
    },
  };
  const service = new AgentService(
    {} as never,
    runtime as never,
    createLogger() as never,
    false,
    false,
  );

  const compactConversationIfNeeded = Reflect.get(
    service,
    "compactConversationIfNeeded",
  ) as CompactConversationIfNeeded;
  const result = await compactConversationIfNeeded.call(service, {
    ...buildCompactionArgs(),
    force: false,
  });

  assert.equal(result, null);
  assert.equal(contextBudgets.length, 1);
  assert.equal(contextBudgets[0]?.status, "available");
  assert.equal(contextBudgets[0]?.source, "active_agent_decision");
  assert.equal(contextBudgets[0]?.basis, "model_agnostic_estimate");
  assert.equal(contextBudgets[0]?.phase, "pre_turn");
  assert.equal(contextBudgets[0]?.reason, "context_limit");
  assert.equal(contextBudgets[0]?.turn_id, "01KQG8FX9YZAR32E4RGWVVA67G");
});

test("automatic compaction emits sanitized failure events", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockCurrentContextCheckpointBoundary();

  let failedCheckpointRecorded = false;
  const runtimeEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const runtime = {
    emit(_threadId: string, event: { event: string; data: Record<string, unknown> }) {
      if (event.event === "agent.compaction_failed") {
        assert.equal(failedCheckpointRecorded, true);
      }
      runtimeEvents.push(event);
      return `cursor-${runtimeEvents.length}`;
    },
    setContextBudget() {
      // noop
    },
    markThinking() {
      // noop
    },
  };
  const service = new AgentService(
    {} as never,
    runtime as never,
    createLogger() as never,
    false,
    false,
  );

  Reflect.set(service, "contextCompactor", {
    async compact() {
      failedCheckpointRecorded = true;
      throw new Error("raw provider failure with summary text");
    },
  });

  const compactConversationIfNeeded = Reflect.get(
    service,
    "compactConversationIfNeeded",
  ) as CompactConversationIfNeeded;
  await assert.rejects(
    compactConversationIfNeeded.call(service, buildCompactionArgs()),
    /raw provider failure/,
  );

  assert.deepEqual(runtimeEvents.map((event) => event.event), [
    "agent.compaction_start",
    "agent.compaction_failed",
  ]);
  const failed = runtimeEvents[1]!.data;
  assert.equal(failed.error_code, "context_compaction_failed");
  assert.equal(failed.retryable, false);
  assert.equal("error" in failed, false);
  assert.equal("message" in failed, false);
  assert.equal("summary" in failed, false);
  assert.equal("replacement_history" in failed, false);
});

test("final no-tool response records exactly one LLM call", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: unknown[] = [];
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ insert: db.insert.bind(db) } as never)
  );
  mock.method(db, "insert", () => ({
    values(values: unknown) {
      insertedValues.push(values);
      return {};
    },
  }) as never);

  const runtimeEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const loggerEvents: Array<{ message: string; meta: Record<string, unknown> }> = [];
  const logger = {
    info(meta: Record<string, unknown>, message: string) {
      loggerEvents.push({ meta, message });
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  };
  const runtime = {
    markThinking() {
      // noop
    },
    setEnvironment() {
      // noop
    },
    setContextBudget() {
      // noop
    },
    finishTurn() {
      // noop
    },
    emit(_threadId: string, event: { event: string; data: Record<string, unknown> }) {
      runtimeEvents.push(event);
      return "cursor-1";
    },
  };
  const service = new AgentService(
    {} as never,
    runtime as never,
    logger as never,
    false,
    false,
  );
  const environment = stubNormalEnvironment(service);

  Reflect.set(service, "conversationLoader", {
    async loadWithDiagnostics() {
      return {
        messages: [],
        reconstruction: {
          mode: "canonical_fallback",
          targetProvider: "openai",
          degraded: true,
          degradedReasons: ["provider_switch_canonical_fallback"],
          sourceProviders: ["anthropic"],
          providerNativeCallCount: 0,
          providerNativeOutputItemCount: 0,
          canonicalFallbackMessageCount: 2,
          omittedProviderOnlyItemCount: 1,
          providerCallCounts: {
            anthropic: 1,
          },
          providerOnlyOutputItemCounts: {
            anthropic: 1,
          },
        },
      };
    },
  });
  Reflect.set(service, "modelRunner", {
    resolveProviderName() {
      return "openai";
    },
    async invokeModel() {
      return {
        assistantClientId: "assistant-client-1",
        response: {
          id: "resp-final",
          content: [{ type: "text", text: "Done." }],
          stopReason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        },
      };
    },
    extractToolCalls() {
      return [];
    },
    parseFinalResponse() {
      return {
        message: "Done.",
        status: "succeeded",
      };
    },
  });
  Reflect.set(service, "transcriptWriter", {
    async recordFinalAssistant() {
      return {
        message_id: "message-final-1",
        client_id: "assistant-client-1",
        role: "assistant",
        display_role: "Bud Agent",
        content: "Done.",
        metadata: {},
        created_at: "2026-04-30T22:35:41.721Z",
      };
    },
  });

  const runAgentFlow = Reflect.get(service, "runAgentFlow") as (args: {
    threadId: string;
    turnId: string;
    sessionId: string | null;
    model: string;
    modelReasoning: {
      providerModel: string;
      reasoningLevel: string;
    };
    modelSelection: {
      model: string;
      reasoningEffort: string;
      source: string;
    };
    environment: AgentEnvironmentSnapshot;
    ownerUserId?: string | null;
    controller: AbortController;
  }) => Promise<void>;

  await runAgentFlow.call(service, {
    threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
    turnId: "01KQG8FX9YZAR32E4RGWVVA67G",
    sessionId: "sess_test",
    model: "gpt-5.5",
    modelReasoning: {
      providerModel: "gpt-5.5",
      reasoningLevel: "low",
    },
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "service_default",
    },
    environment,
    ownerUserId: "user-1",
    controller: new AbortController(),
  });

  const llmCallRows = insertedValues.filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      (value as Record<string, unknown>).provider === "openai",
  );
  assert.equal(llmCallRows.length, 1);
  assert.equal(llmCallRows[0]?.providerResponseId, "resp-final");
  assert.deepEqual(llmCallRows[0]?.cacheMetadata, {
    reconstruction_mode: "canonical_fallback",
    reconstruction_degraded: true,
    reconstruction_target_provider: "openai",
    reconstruction_source_providers: ["anthropic"],
    reconstruction_provider_native_call_count: 0,
    reconstruction_provider_native_output_item_count: 0,
    reconstruction_canonical_fallback_message_count: 2,
    reconstruction_omitted_provider_only_item_count: 1,
    reconstruction_degraded_reasons: ["provider_switch_canonical_fallback"],
    reconstruction_provider_call_counts: {
      anthropic: 1,
    },
    reconstruction_provider_only_output_item_counts: {
      anthropic: 1,
    },
  });
  const outputItems = insertedValues.find(
    (value): value is Array<Record<string, unknown>> => Array.isArray(value),
  );
  assert.ok(outputItems);
  assert.deepEqual(outputItems[0]?.canonicalPayload, {
    type: "text",
    text: "Done.",
    assistantPhase: "final_answer",
  });
  assert.equal(
    loggerEvents.some((event) => event.message === "LLM conversation reconstruction degraded"),
    true,
  );
});

test("OpenAI tool-loop replay marks pre-tool assistant text as commentary", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: unknown[] = [];
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ insert: db.insert.bind(db) } as never)
  );
  mock.method(db, "insert", () => ({
    values(values: unknown) {
      insertedValues.push(values);
      return {};
    },
  }) as never);

  const runtime = {
    markThinking() {
      // noop
    },
    setEnvironment() {
      // noop
    },
    setContextBudget() {
      // noop
    },
    finishTurn() {
      // noop
    },
    emit() {
      return "cursor-1";
    },
  };
  const service = new AgentService(
    {
      async getSession() {
        return null;
      },
    } as never,
    runtime as never,
    createLogger() as never,
    false,
    false,
  );
  const environment = stubNormalEnvironment(service);

  Reflect.set(service, "conversationLoader", {
    async loadWithDiagnostics() {
      return {
        messages: [{ role: "user", content: "Inspect first" }],
        reconstruction: {
          mode: "canonical_only",
          targetProvider: "openai",
          degraded: false,
          degradedReasons: [],
          sourceProviders: [],
          providerNativeCallCount: 0,
          providerNativeOutputItemCount: 0,
          canonicalFallbackMessageCount: 0,
          omittedProviderOnlyItemCount: 0,
          providerCallCounts: {},
          providerOnlyOutputItemCounts: {},
        },
      };
    },
  });

  let invokeCount = 0;
  let secondInvokeMessages: unknown[] | null = null;
  Reflect.set(service, "modelRunner", {
    resolveProviderName() {
      return "openai";
    },
    async invokeModel(_threadId: string, _turnId: string, messages: unknown[]) {
      invokeCount += 1;
      if (invokeCount === 1) {
        return {
          assistantClientId: "assistant-client-1",
          response: {
            id: "resp-tool",
            content: [
              { type: "text", text: "I will inspect first." },
              {
                type: "tool_use",
                id: "call-observe",
                name: "terminal_observe",
                input: { view: "screen" },
              },
            ],
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "call-observe",
                name: "terminal_observe",
                input: { view: "screen" },
              },
            ],
          },
        };
      }
      secondInvokeMessages = messages;
      return {
        assistantClientId: "assistant-client-2",
        response: {
          id: "resp-final",
          content: [{ type: "text", text: "Done." }],
          stopReason: "end_turn",
        },
      };
    },
    extractToolCalls(response: { toolCalls?: unknown[] }) {
      return response.toolCalls?.length
        ? [
            {
              type: "tool_call",
              tool: "terminal.observe",
              callId: "call-observe",
              view: "screen",
            },
          ]
        : [];
    },
    parseFinalResponse() {
      return {
        message: "Done.",
        status: "succeeded",
      };
    },
  });
  Reflect.set(service, "toolExecutor", {
    async execute() {
      return {
        directive: {
          type: "tool_call",
          tool: "terminal.observe",
          callId: "call-observe",
          view: "screen",
        },
        args: { view: "screen" },
        summary: "Observed terminal screen",
        outputTruncationReason: null,
        result: {
          kind: "observation",
          output: "screen",
          readiness: {
            ready: true,
            confidence: 1,
            trigger: "prompt_detected",
            hints: {
              looks_like_prompt: true,
              looks_like_confirmation: false,
              looks_like_password: false,
              looks_like_pager: false,
              looks_like_error: false,
              may_still_be_processing: false,
            },
          },
          view: "screen",
        },
        payload: {
          tool: "terminal.observe",
          call_id: "call-observe",
          kind: "observation",
          output: "screen",
        },
      };
    },
  });
  Reflect.set(service, "transcriptWriter", {
    async recordAssistantTextSegment() {
      return { message_id: "message-intermediate-1" };
    },
    emitToolCall() {
      return {
        modelArgs: { view: "screen" },
        clientArgs: { view: "screen" },
        cursor: "cursor-tool-call",
      };
    },
    async recordToolResult() {
      return {
        payload: {
          tool: "terminal.observe",
          call_id: "call-observe",
          kind: "observation",
          output: "screen",
        },
        message: { message_id: "message-tool-1" },
        cursor: "cursor-tool-result",
      };
    },
    async recordFinalAssistant() {
      return {
        message_id: "message-final-1",
        client_id: "assistant-client-2",
        role: "assistant",
        display_role: "Bud Agent",
        content: "Done.",
        metadata: {},
        created_at: "2026-05-22T20:00:00.000Z",
      };
    },
  });

  const runAgentFlow = Reflect.get(service, "runAgentFlow") as (args: {
    threadId: string;
    turnId: string;
    sessionId: string | null;
    model: string;
    modelReasoning: {
      providerModel: string;
      reasoningLevel: string;
    };
    modelSelection: {
      model: string;
      reasoningEffort: string;
      source: string;
    };
    environment: AgentEnvironmentSnapshot;
    ownerUserId?: string | null;
    controller: AbortController;
  }) => Promise<void>;

  await runAgentFlow.call(service, {
    threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
    turnId: "01KQG8FX9YZAR32E4RGWVVA67G",
    sessionId: "sess_test",
    model: "gpt-5.5",
    modelReasoning: {
      providerModel: "gpt-5.5",
      reasoningLevel: "low",
    },
    modelSelection: {
      model: "gpt-5.5",
      reasoningEffort: "low",
      source: "service_default",
    },
    environment,
    ownerUserId: "user-1",
    controller: new AbortController(),
  });

  assert.ok(secondInvokeMessages);
  assert.deepEqual(secondInvokeMessages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect first.", assistantPhase: "commentary" },
      {
        type: "tool_use",
        id: "call-observe",
        name: "terminal_observe",
        input: { view: "screen" },
      },
    ],
  });

  const outputItemGroups = insertedValues.filter(
    (value): value is Array<Record<string, unknown>> => Array.isArray(value),
  );
  assert.deepEqual(outputItemGroups[0]?.[0]?.canonicalPayload, {
    type: "text",
    text: "I will inspect first.",
    assistantPhase: "commentary",
  });
});
