import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadAgentRoutes } from "./agent.js";
import { AgentQuestionRequestError } from "../../agent/user-question-repository.js";
import { AskUserQuestionsContractError } from "../../agent/user-question-contracts.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;

class TestReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  code(code: number): this {
    this.statusCode = code;
    return this;
  }

  send(payload: unknown): unknown {
    this.payload = payload;
    this.sent = true;
    return payload;
  }
}

function createServer(): FastifyInstance & { routes: Map<string, RouteHandler> } {
  const routes = new Map<string, RouteHandler>();
  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    };

  return {
    routes,
    get: addRoute("GET"),
    post: addRoute("POST"),
  } as unknown as FastifyInstance & { routes: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "qr_01ASKQUESTIONTEST";

const SESSION = {
  user: {
    id: "user-1",
    email: "test@example.com",
    emailVerified: true,
    name: "Test User",
    image: null,
  },
  session: {
    id: "session-1",
    expiresAt: new Date("2026-05-19T21:00:00.000Z"),
  },
};

const THREAD = {
  threadId: THREAD_ID,
  budId: "bud-1",
  title: null,
  lastMessagePreview: null,
  lastActivityAt: new Date("2026-05-19T20:00:00.000Z"),
  messageCount: 0,
  pinned: false,
  archived: false,
  modelId: null,
  reasoningEffort: null,
  deletedAt: null,
  lastAttentionMessageId: null,
  lastAttentionMessageCreatedAt: null,
  lastAttentionKind: null,
  tenantId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-05-19T20:00:00.000Z"),
  updatedAt: new Date("2026-05-19T20:00:00.000Z"),
};

test("question-response route submits owned responses through AgentService", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const submissions: Array<Record<string, unknown>> = [];
  const agentService = {
    async submitQuestionResponse(args: Record<string, unknown>) {
      submissions.push(args);
      return {
        questionRequestId: REQUEST_ID,
        status: "answered",
        continuation: "live_tool_result",
      };
    },
  };

  const server = createServer();
  await registerThreadAgentRoutes(server, agentService as never, {} as never);
  const handler = server.routes.get("POST /api/threads/:threadId/agent/question-requests/:requestId/responses");
  assert.ok(handler);

  const body = {
    schema: "ask_user_questions_response_v1",
    client_response_id: "018f4f2a-0000-7000-9000-000000000000",
    answers: [
      {
        question_id: "env",
        status: "answered",
        answer: { kind: "single_choice", choice_id: "staging" },
      },
    ],
  };

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD_ID, requestId: REQUEST_ID },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, {
    ok: true,
    question_request_id: REQUEST_ID,
    status: "answered",
    continuation: "live_tool_result",
  });
  assert.deepEqual(submissions, [
    {
      threadId: THREAD_ID,
      questionRequestId: REQUEST_ID,
      response: body,
      answeredByUserId: "user-1",
    },
  ]);
});

test("question-response route enforces auth and thread ownership before submission", async (t) => {
  t.after(() => mock.restoreAll());

  const agentService = {
    async submitQuestionResponse() {
      assert.fail("submitQuestionResponse should not run before auth/ownership succeeds");
    },
  };
  const server = createServer();
  await registerThreadAgentRoutes(server, agentService as never, {} as never);
  const handler = server.routes.get("POST /api/threads/:threadId/agent/question-requests/:requestId/responses");
  assert.ok(handler);

  mock.method(auth.api, "getSession", async () => null);
  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: {},
    }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );

  mock.restoreAll();
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => null);

  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: {},
    }),
    { statusCode: 404, payload: { error: "thread_not_found" } },
  );
});

test("question-response route maps repository and contract errors to stable HTTP errors", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  let nextError: Error = new AgentQuestionRequestError("question_request_not_found", 404);
  const agentService = {
    async submitQuestionResponse() {
      throw nextError;
    },
  };

  const server = createServer();
  await registerThreadAgentRoutes(server, agentService as never, {} as never);
  const handler = server.routes.get("POST /api/threads/:threadId/agent/question-requests/:requestId/responses");
  assert.ok(handler);

  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: {},
    }),
    { statusCode: 404, payload: { error: "question_request_not_found" } },
  );

  nextError = new AgentQuestionRequestError("question_request_already_answered", 409);
  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: {},
    }),
    { statusCode: 409, payload: { error: "question_request_already_answered" } },
  );

  nextError = new AskUserQuestionsContractError("unknown_question_id", "Unknown question_id: other");
  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: {},
    }),
    {
      statusCode: 400,
      payload: { error: "unknown_question_id", message: "Unknown question_id: other" },
    },
  );
});
