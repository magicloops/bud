import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
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
    sessionId: string;
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
    finishTurn() {
      // noop
    },
    emit() {
      return "cursor-1";
    },
  };
  const service = new AgentService(
    {} as never,
    runtime as never,
    createLogger() as never,
    false,
    false,
  );

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
    sessionId: string;
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
