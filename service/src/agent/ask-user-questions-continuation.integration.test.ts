import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import { db } from "../db/client.js";
import { providerRegistry, type LLMProvider, type ModelCapabilities } from "../llm/index.js";
import { AgentService } from "./agent-service.js";
import {
  ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
  attachRequestIdToAskUserQuestionsRequest,
  normalizeAskUserQuestionsRequest,
  type AskUserQuestionsResponse,
} from "./user-question-contracts.js";
import type { AgentQuestionRequestRow } from "./user-question-repository.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "qr_01ASKQUESTIONTEST";

const REQUEST = attachRequestIdToAskUserQuestionsRequest(
  normalizeAskUserQuestionsRequest({
    title: "Deploy",
    body: "Choose the target before continuing.",
    questions: [
      {
        question_id: "env",
        kind: "single_choice",
        label: "Environment?",
        choices: [
          { choice_id: "staging", label: "Staging" },
          { choice_id: "production", label: "Production" },
        ],
      },
    ],
  }),
  REQUEST_ID,
);

const RESPONSE: AskUserQuestionsResponse = {
  schema: ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
  client_response_id: "018f4f2a-0000-7000-9000-000000000000",
  answers: [
    {
      question_id: "env",
      status: "answered",
      answer: { kind: "single_choice", choice_id: "staging" },
    },
  ],
};

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

function createTerminalManager() {
  const rejected: Array<{ threadId: string; errorMessage: string }> = [];
  return {
    rejected,
    manager: {
      async rejectPendingRequestsForThread(threadId: string, errorMessage: string) {
        rejected.push({ threadId, errorMessage });
      },
    },
  };
}

function createService() {
  const terminal = createTerminalManager();
  const service = new AgentService(
    terminal.manager as never,
    {} as never,
    createLogger() as never,
    false,
    false,
  );
  return { service, terminal };
}

function registerTestOpenAIProvider(t: TestContext): void {
  const previousOpenAI = providerRegistry.getProvider("openai");
  providerRegistry.unregister("openai");

  const capabilities: ModelCapabilities = {
    supportsVision: true,
    supportsTools: true,
    supportsStreaming: true,
    supportsJsonMode: true,
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    supportsThinking: false,
    supportsInterleavedThinking: false,
  };

  const provider: LLMProvider = {
    name: "openai",
    supportedModels: ["gpt-5.5"],
    async *invoke() {
      throw new Error("test OpenAI provider should not be invoked");
    },
    supportsModel(model: string) {
      return model === "gpt-5.5";
    },
    getModelCapabilities() {
      return capabilities;
    },
  };

  providerRegistry.register(provider);

  t.after(() => {
    providerRegistry.unregister("openai");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
  });
}

function buildRow(overrides: Partial<AgentQuestionRequestRow> = {}): AgentQuestionRequestRow {
  return {
    questionRequestId: REQUEST_ID,
    threadId: THREAD_ID,
    turnId: "turn-1",
    callId: "call-question",
    clientId: "018f4f2a-0000-7000-9000-000000000100",
    status: "pending",
    request: REQUEST as unknown as Record<string, unknown>,
    clientResponse: null,
    toolResult: null,
    clientResponseId: null,
    answeredByUserId: null,
    answeredAt: null,
    expiresAt: null,
    tenantId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-05-19T20:00:00.000Z"),
    updatedAt: new Date("2026-05-19T20:00:00.000Z"),
    ...overrides,
  };
}

function installAcceptTransaction(row: AgentQuestionRequestRow = buildRow()) {
  mock.method(db, "transaction", async (callback: (txArg: unknown) => Promise<unknown>) => {
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([row]);
                  },
                };
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([{ ...row, ...values }]);
                  },
                };
              },
            };
          },
        };
      },
    };
    return callback(tx);
  });
}

function installSkipPendingTransaction(rows: AgentQuestionRequestRow[] = [buildRow()]) {
  const updatedValues: Record<string, unknown>[] = [];
  mock.method(db, "transaction", async (callback: (txArg: unknown) => Promise<unknown>) => {
    const tx = {
      select() {
        return {
          from() {
            return {
              where() {
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            updatedValues.push(values);
            return {
              where() {
                return {
                  returning() {
                    const row = rows[updatedValues.length - 1];
                    return Promise.resolve(row ? [{ ...row, ...values }] : []);
                  },
                };
              },
            };
          },
        };
      },
    };
    return callback(tx);
  });
  return updatedValues;
}

test("submitQuestionResponse resolves a live waiter with one structured tool result", async (t) => {
  t.after(() => mock.restoreAll());
  installAcceptTransaction();

  const { service } = createService();
  const registry = Reflect.get(service, "userQuestions") as {
    register(threadId: string, questionRequestId: string): Promise<unknown>;
  };
  const waiter = registry.register(THREAD_ID, REQUEST_ID);

  const [result, resolved] = await Promise.all([
    service.submitQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: RESPONSE,
      answeredByUserId: "user-1",
    }),
    waiter,
  ]);

  assert.deepEqual(result, {
    questionRequestId: REQUEST_ID,
    status: "answered",
    continuation: "live_tool_result",
  });
  assert.equal((resolved as { toolResult: { schema: string } }).toolResult.schema, "ask_user_questions_tool_result_v1");
  assert.equal(
    (resolved as { toolResult: { responses: Array<{ display_answer?: string }> } }).toolResult.responses[0]?.display_answer,
    "Staging",
  );
});

test("supersedePendingUserQuestionsForFollowUp resolves a live waiter as skipped and waits for closeout", async (t) => {
  t.after(() => mock.restoreAll());
  const updatedValues = installSkipPendingTransaction();

  const { service } = createService();
  const registry = Reflect.get(service, "userQuestions") as {
    register(threadId: string, questionRequestId: string): Promise<unknown>;
  };
  const waiter = registry.register(THREAD_ID, REQUEST_ID);
  const superseded = service.supersedePendingUserQuestionsForFollowUp({
    threadId: THREAD_ID,
    answeredByUserId: "user-1",
  });

  const resolved = await waiter as {
    continuation?: string;
    reason?: string;
    toolResult: { responses: Array<{ status: string; skip_reason?: string }> };
    onFinalized?: () => void;
  };
  assert.equal(resolved.continuation, "supersede");
  assert.equal(resolved.reason, "superseded_by_user_message");
  assert.equal(resolved.toolResult.responses[0]?.status, "skipped");
  assert.equal(resolved.toolResult.responses[0]?.skip_reason, "user_skipped");
  assert.equal(updatedValues[0]?.status, "answered");
  assert.equal(updatedValues[0]?.answeredByUserId, "user-1");

  let completed = false;
  const completion = superseded.then((result) => {
    completed = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(completed, false);

  resolved.onFinalized?.();
  assert.deepEqual(await completion, { superseded: 1 });
});

test("submitQuestionResponse falls back to a self-contained user message without a live waiter", async (t) => {
  t.after(() => mock.restoreAll());
  registerTestOpenAIProvider(t);
  installAcceptTransaction();

  const { service } = createService();
  const startedTurns: Array<{ threadId: string; options: Record<string, unknown> }> = [];
  Reflect.set(service, "startUserMessage", async (threadId: string, options: Record<string, unknown>) => {
    startedTurns.push({ threadId, options });
    return { sessionId: "session-fallback" };
  });

  mock.method(db.query.threadTable, "findFirst", async () => ({
    threadId: THREAD_ID,
    budId: "bud-1",
    modelId: null,
    reasoningEffort: null,
    createdByUserId: "user-1",
  }) as never);

  let insertedMessage: Record<string, unknown> | null = null;
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      insertedMessage = values;
      return {
        returning() {
          return Promise.resolve([{ messageId: "22222222-2222-4222-8222-222222222222" }]);
        },
      };
    },
  }) as never);
  mock.method(db, "execute", async () => []);

  const result = await service.submitQuestionResponse({
    threadId: THREAD_ID,
    questionRequestId: REQUEST_ID,
    response: RESPONSE,
    answeredByUserId: "user-1",
  });

  assert.equal(result.questionRequestId, REQUEST_ID);
  assert.equal(result.status, "answered");
  assert.equal(result.continuation, "fallback_user_message");
  assert.equal(result.messageId, "22222222-2222-4222-8222-222222222222");
  assert.ok(result.clientId);

  const capturedMessage = insertedMessage as Record<string, unknown> | null;
  assert.ok(capturedMessage);
  assert.equal(capturedMessage.threadId, THREAD_ID);
  assert.equal(capturedMessage.role, "user");
  assert.equal(capturedMessage.createdByUserId, "user-1");
  assert.match(String(capturedMessage.content), /Environment\?/);
  assert.match(String(capturedMessage.content), /Answer: Staging/);
  assert.deepEqual(capturedMessage.metadata, {
    source: "ask_user_questions",
    question_request_id: REQUEST_ID,
    schema: "ask_user_questions_tool_result_v1",
    model: "gpt-5.5",
    reasoning_effort: "low",
    model_selection_source: "service_default",
  });
  assert.deepEqual(startedTurns, [
    {
      threadId: THREAD_ID,
      options: {
        model: "gpt-5.5",
        reasoningEffort: "low",
        modelSelectionSource: "service_default",
        ownerUserId: "user-1",
      },
    },
  ]);
});

test("cancelThread rejects pending question waiters and marks pending rows canceled", async (t) => {
  t.after(() => mock.restoreAll());
  const { service, terminal } = createService();
  const registry = Reflect.get(service, "userQuestions") as {
    register(threadId: string, questionRequestId: string): Promise<unknown>;
  };
  const waiter = registry
    .register(THREAD_ID, REQUEST_ID)
    .then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

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

  await service.cancelThread(THREAD_ID);

  assert.equal(await waiter, "agent_canceled");
  const capturedUpdate = updateCapture.values;
  assert.ok(capturedUpdate);
  assert.equal(capturedUpdate.status, "canceled");
  assert.ok(capturedUpdate.updatedAt instanceof Date);
  assert.deepEqual(terminal.rejected, [
    {
      threadId: THREAD_ID,
      errorMessage: "agent_canceled",
    },
  ]);
});
