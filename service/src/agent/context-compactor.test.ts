import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { providerRegistry } from "../llm/index.js";
import type { ProviderInvocationContext } from "../llm/provider.js";
import type {
  CanonicalMessage,
  CanonicalStreamEvent,
  CanonicalTool,
  ModelConfig,
} from "../llm/types.js";
import { AgentContextCompactor } from "./context-compactor.js";

function createLogger() {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child() {
      return this;
    },
  } as never;
}

function stubCheckpointDb() {
  // getCurrentContextCheckpointBoundary: two select().from().where().orderBy().limit() chains.
  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            orderBy() {
              return {
                async limit() {
                  return [];
                },
              };
            },
          };
        },
      };
    },
  }));
  // recordCompletedContextCheckpoint / recordFailedContextCheckpoint:
  // insert().values().returning() — echo the inserted row back.
  mock.method(db, "insert", () => ({
    values(row: Record<string, unknown>) {
      return {
        async returning() {
          return [row];
        },
      };
    },
  }));
}

test("compaction forwards the Bud invocation context to the provider", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  stubCheckpointDb();

  const capturedContexts: Array<ProviderInvocationContext | undefined> = [];
  const capturedTools: CanonicalTool[][] = [];
  const fakeProvider = {
    name: "bud_local",
    supportedModels: ["compaction-test-model"],
    supportsModel(model: string) {
      return model === "compaction-test-model";
    },
    getModelCapabilities() {
      throw new Error("not used");
    },
    // No invokeSync — mirrors the Bud-local providers, which only stream and
    // hard-require the invocation context (the regression this test pins).
    async *invoke(
      _messages: CanonicalMessage[],
      tools: CanonicalTool[],
      _config: ModelConfig,
      _signal?: AbortSignal,
      context?: ProviderInvocationContext,
    ): AsyncIterable<CanonicalStreamEvent> {
      capturedContexts.push(context);
      capturedTools.push(tools);
      if (!context?.budId) {
        throw new Error("Bud-local provider requires Bud invocation context");
      }
      yield { type: "message_start", id: "resp-1" };
      yield { type: "content_start", index: 0, content_type: "text" };
      yield { type: "text_delta", index: 0, delta: "Checkpoint summary." };
      yield { type: "content_done", index: 0 };
      yield {
        type: "message_done",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
  mock.method(providerRegistry, "getProviderForModel", () => fakeProvider as never);

  const compactor = new AgentContextCompactor(createLogger());
  const result = await compactor.compact({
    threadId: "thread-ctx-1",
    budId: "bud-ctx-1",
    turnId: "01KQG8FX9YZAR32E4RGWVVA67G",
    phase: "pre_turn",
    trigger: "auto",
    reason: "context_limit",
    model: "compaction-test-model",
    provider: "bud_local",
    modelReasoning: {
      providerModel: "compaction-test-model",
      reasoningLevel: "low",
    } as never,
    conversation: [
      { role: "user", content: [{ type: "text", text: "Please continue the task." }] },
    ],
    tools: [
      {
        name: "terminal_run",
        description: "Run a command",
        parameters: { type: "object", properties: {} },
      },
    ],
    ownerUserId: "user-1",
    tenantId: null,
  });

  assert.equal(capturedContexts.length, 1);
  assert.deepEqual(capturedContexts[0], {
    threadId: "thread-ctx-1",
    budId: "bud-ctx-1",
    ownerUserId: "user-1",
  });
  // Tool schemas ride along (with tool_choice "none") for prompt-cache reuse.
  assert.equal(capturedTools.length, 1);
  assert.deepEqual(capturedTools[0]?.map((tool) => tool.name), ["terminal_run"]);
  assert.equal(result.checkpoint.summary, "Checkpoint summary.");
  assert.ok(
    result.replacementHistory.some((message) =>
      JSON.stringify(message.content).includes("Checkpoint summary."),
    ),
  );
});
