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

test("cancelThread aborts the active turn and rejects pending terminal waits", async () => {
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

  await service.cancelThread("thread-1");

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.isThreadActive("thread-1"), false);
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
  assert.equal(
    loggerEvents.some((event) => event.message === "LLM conversation reconstruction degraded"),
    true,
  );
});
