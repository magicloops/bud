import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import {
  acceptAgentQuestionResponse,
  AgentQuestionRequestError,
  type AgentQuestionRequestRow,
} from "./user-question-repository.js";
import {
  ASK_USER_QUESTIONS_RESPONSE_SCHEMA,
  AskUserQuestionsContractError,
  attachRequestIdToAskUserQuestionsRequest,
  buildAskUserQuestionsToolResult,
  normalizeAskUserQuestionsRequest,
  type AskUserQuestionsResponse,
} from "./user-question-contracts.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "qr_01ASKQUESTIONTEST";

const REQUEST = attachRequestIdToAskUserQuestionsRequest(
  normalizeAskUserQuestionsRequest({
    title: "Deploy",
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
      {
        question_id: "notify",
        kind: "boolean",
        label: "Notify team?",
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
    {
      question_id: "notify",
      status: "skipped",
      skip_reason: "user_skipped",
    },
  ],
};

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

function installTransactionHarness(row: AgentQuestionRequestRow | null) {
  let updatedValues: Record<string, unknown> | null = null;
  let updateCount = 0;
  const tx = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(row ? [row] : []);
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
          updatedValues = values;
          return {
            where() {
              return {
                returning() {
                  updateCount += 1;
                  return Promise.resolve(row ? [{ ...row, ...values }] : []);
                },
              };
            },
          };
        },
      };
    },
  };

  mock.method(db, "transaction", async (callback: (txArg: unknown) => Promise<unknown>) =>
    callback(tx),
  );

  return {
    get updatedValues() {
      return updatedValues;
    },
    get updateCount() {
      return updateCount;
    },
  };
}

test("acceptAgentQuestionResponse validates and persists the accepted response", async (t) => {
  t.after(() => mock.restoreAll());
  const harness = installTransactionHarness(buildRow());

  const accepted = await acceptAgentQuestionResponse({
    threadId: THREAD_ID,
    questionRequestId: REQUEST_ID,
    response: RESPONSE,
    answeredByUserId: "user-1",
  });

  assert.equal(accepted.alreadyAnswered, false);
  assert.equal(accepted.questionRequest.status, "answered");
  assert.equal(accepted.response.client_response_id, RESPONSE.client_response_id);
  assert.equal(accepted.toolResult.schema, "ask_user_questions_tool_result_v1");
  assert.equal(accepted.toolResult.responses[0]?.question.label, "Environment?");
  assert.equal(accepted.toolResult.responses[0]?.display_answer, "Staging");
  assert.equal(harness.updateCount, 1);
  assert.equal(harness.updatedValues?.status, "answered");
  assert.equal(harness.updatedValues?.clientResponseId, RESPONSE.client_response_id);
  assert.equal(harness.updatedValues?.answeredByUserId, "user-1");
  assert.ok(harness.updatedValues?.answeredAt instanceof Date);
});

test("acceptAgentQuestionResponse treats same client_response_id as idempotent success", async (t) => {
  t.after(() => mock.restoreAll());
  const toolResult = buildAskUserQuestionsToolResult(REQUEST, RESPONSE, REQUEST_ID);
  const harness = installTransactionHarness(buildRow({
    status: "answered",
    clientResponse: RESPONSE as unknown as Record<string, unknown>,
    toolResult: toolResult as unknown as Record<string, unknown>,
    clientResponseId: RESPONSE.client_response_id,
    answeredByUserId: "user-1",
    answeredAt: new Date("2026-05-19T20:01:00.000Z"),
  }));

  const accepted = await acceptAgentQuestionResponse({
    threadId: THREAD_ID,
    questionRequestId: REQUEST_ID,
    response: RESPONSE,
    answeredByUserId: "user-1",
  });

  assert.equal(accepted.alreadyAnswered, true);
  assert.equal(accepted.toolResult.summary_markdown, toolResult.summary_markdown);
  assert.equal(harness.updateCount, 0);
  assert.equal(harness.updatedValues, null);
});

test("acceptAgentQuestionResponse rejects conflicting or non-pending responses", async (t) => {
  t.after(() => mock.restoreAll());
  const toolResult = buildAskUserQuestionsToolResult(REQUEST, RESPONSE, REQUEST_ID);
  installTransactionHarness(buildRow({
    status: "answered",
    clientResponse: RESPONSE as unknown as Record<string, unknown>,
    toolResult: toolResult as unknown as Record<string, unknown>,
    clientResponseId: RESPONSE.client_response_id,
  }));

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: {
        ...RESPONSE,
        client_response_id: "018f4f2a-0000-7000-9000-000000000001",
      },
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentQuestionRequestError);
      assert.equal(err.code, "question_request_already_answered");
      assert.equal(err.statusCode, 409);
      return true;
    },
  );

  mock.restoreAll();
  installTransactionHarness(buildRow({ status: "canceled" }));

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: RESPONSE,
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentQuestionRequestError);
      assert.equal(err.code, "question_request_not_pending");
      assert.equal(err.statusCode, 409);
      return true;
    },
  );
});

test("acceptAgentQuestionResponse returns 404 for missing request rows", async (t) => {
  t.after(() => mock.restoreAll());
  installTransactionHarness(null);

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: RESPONSE,
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AgentQuestionRequestError);
      assert.equal(err.code, "question_request_not_found");
      assert.equal(err.statusCode, 404);
      return true;
    },
  );
});

test("acceptAgentQuestionResponse validates answers against the stored request", async (t) => {
  t.after(() => mock.restoreAll());
  const harness = installTransactionHarness(buildRow());

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: {
        ...RESPONSE,
        answers: [
          {
            question_id: "env",
            status: "answered",
            answer: { kind: "single_choice", choice_id: "missing" },
          },
        ],
      },
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AskUserQuestionsContractError);
      assert.equal(err.code, "invalid_answer");
      return true;
    },
  );

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: {
        ...RESPONSE,
        answers: [
          {
            question_id: "unknown",
            status: "answered",
            answer: { kind: "text", value: "wrong question" },
          },
        ],
      },
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AskUserQuestionsContractError);
      assert.equal(err.code, "unknown_question_id");
      return true;
    },
  );

  await assert.rejects(
    acceptAgentQuestionResponse({
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: {
        ...RESPONSE,
        answers: [
          {
            question_id: "notify",
            status: "answered",
            answer: { kind: "text", value: "wrong kind" },
          },
        ],
      },
      answeredByUserId: "user-1",
    }),
    (err: unknown) => {
      assert.ok(err instanceof AskUserQuestionsContractError);
      assert.equal(err.code, "invalid_answer");
      return true;
    },
  );

  assert.equal(harness.updateCount, 0);
});
