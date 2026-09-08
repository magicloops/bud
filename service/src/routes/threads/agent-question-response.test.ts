import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadAgentRoutes } from "./agent.js";
import { AgentQuestionRequestError } from "../../agent/user-question-repository.js";
import { AskUserQuestionsContractError } from "../../agent/user-question-contracts.js";
import { buildAgentEnvironmentSnapshot } from "../../agent/environment.js";
import { InvocationError } from "../../agent/invocation-repository.js";

type RouteHandler = (request: Record<string, unknown>, reply: TestReply) => Promise<unknown> | unknown;
type TestLogEntry = {
  level: "warn";
  meta: unknown;
  message: string;
};

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
  logs: TestLogEntry[] = [],
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, log: createTestLogger(logs), ...request }, reply);
  return {
    statusCode: reply.statusCode,
    payload: reply.sent ? reply.payload : result,
  };
}

function createTestLogger(logs: TestLogEntry[]) {
  return {
    warn(meta: unknown, message: string) {
      logs.push({ level: "warn", meta, message });
    },
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

test("review abandonment requires owner access and an explicit current-state acknowledgement", async t => {
  t.after(() => mock.restoreAll());
  let signedIn = false;
  let owned = false;
  mock.method(auth.api, "getSession", async () => signedIn ? SESSION as never : null);
  mock.method(db.query.threadTable, "findFirst", async () => owned ? THREAD as never : null);
  let calls = 0;
  let failure: string | undefined;
  const server = createServer();
  await registerThreadAgentRoutes(server, { durableInvocations: {
    abandonReviewed: async (owner: string, thread: string, id: string, at: string) => {
      calls++;
      assert.deepEqual([owner, thread, id, at], [SESSION.user.id, THREAD_ID, "inv-review", "2026-09-04T00:00:00.000Z"]);
      if (failure) throw new InvocationError(failure);
      return { id, status: "canceled", reservesThread: false, outcomeCode: "user_abandoned_after_review" };
    },
  } } as never, {} as never);
  const handler = server.routes.get("POST /api/threads/:threadId/agent/invocations/:invocationId/abandon")!;
  const request = { params: { threadId: THREAD_ID, invocationId: "inv-review" },
    body: { acknowledge_possible_effects: true, expected_updated_at: "2026-09-04T00:00:00.000Z" } };
  assert.equal((await invokeRoute(handler, request)).statusCode, 401);
  signedIn = true;
  assert.equal((await invokeRoute(handler, request)).statusCode, 404);
  owned = true;
  assert.equal((await invokeRoute(handler, { ...request, body: { ...request.body, acknowledge_possible_effects: false } })).statusCode, 400);
  assert.equal(calls, 0);
  assert.equal((await invokeRoute(handler, request)).statusCode, 200);
  failure = "invocation_review_conflict";
  assert.equal((await invokeRoute(handler, request)).statusCode, 409);
  failure = "invocation_not_found";
  assert.equal((await invokeRoute(handler, request)).statusCode, 404);
});

test("agent-state route includes runtime last_error after authorization", async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);

  const environment = buildAgentEnvironmentSnapshot({
    budId: THREAD.budId,
    online: true,
    lastSeenAt: new Date("2026-05-19T20:00:00.000Z"),
  });
  const lastError = {
    turn_id: "01KT80FP55HJS8MYBN9TB9AW57",
    code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
    message: "The local model is already busy. Try again after the current run finishes.\n\nError: DATA_PLANE_STREAM_LIMIT_EXCEEDED",
    retryable: true,
    occurred_at: "2026-06-04T00:28:13.870Z",
  };
  const contextBudget = {
    status: "available",
    source: "active_agent_decision",
    checked_at: "2026-06-04T00:28:13.868Z",
  };
  const agentRuntime = {
    getSnapshot(threadId: string) {
      assert.equal(threadId, THREAD_ID);
      return {
        active: true,
        turn_id: lastError.turn_id,
        phase: "thinking",
        can_cancel: true,
        stream_cursor: "cursor-runtime",
        pending_tool: null,
        draft_assistant: null,
        environment,
        context_budget: contextBudget,
        last_error: lastError,
        updated_at: "2026-06-04T00:28:13.870Z",
      };
    },
  };
  const agentService = {
    async getEnvironmentForBud(budId: string) {
      assert.equal(budId, THREAD.budId);
      return environment;
    },
  };

  const server = createServer();
  await registerThreadAgentRoutes(server, agentService as never, agentRuntime as never);
  const handler = server.routes.get("GET /api/threads/:threadId/agent/state");
  assert.ok(handler);

  const response = await invokeRoute(handler, {
    params: { threadId: THREAD_ID },
  });

  assert.equal(response.statusCode, 200);
  assert.equal((response.payload as Record<string, unknown>).last_error, lastError);
  assert.equal((response.payload as Record<string, unknown>).environment, environment);
  assert.equal((response.payload as Record<string, unknown>).context_budget, contextBudget);
});

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
  const logs: TestLogEntry[] = [];
  const invalidBody = {
    schema: "ask_user_questions_response_v1",
    client_response_id: "018f4f2a-0000-7000-9000-000000000000",
    answers: [
      {
        question_id: "other",
        status: "answered",
        answer: { kind: "text", value: "do not log this raw answer" },
      },
    ],
  };
  assert.deepEqual(
    await invokeRoute(handler, {
      params: { threadId: THREAD_ID, requestId: REQUEST_ID },
      body: invalidBody,
    }, logs),
    {
      statusCode: 400,
      payload: { error: "unknown_question_id", message: "Unknown question_id: other" },
    },
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.message, "Question response validation failed");
  assert.equal((logs[0]?.meta as Record<string, unknown>).errorCode, "unknown_question_id");
  const serializedLog = JSON.stringify(logs[0]?.meta);
  assert.match(serializedLog, /"value_length":26/);
  assert.doesNotMatch(serializedLog, /do not log this raw answer/);
});

test("durable answer responses carry invocation identity after ownership checks", async t => {
  t.after(() => mock.restoreAll());
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => THREAD as never);
  const server = createServer();
  await registerThreadAgentRoutes(server, { submitQuestionResponse: async (args: { answeredByUserId: string }) => {
    assert.equal(args.answeredByUserId, SESSION.user.id);
    return { questionRequestId: REQUEST_ID, status: "answered", continuation: "durable_invocation", invocationId: "inv" };
  } } as never, {} as never);
  const handler = server.routes.get("POST /api/threads/:threadId/agent/question-requests/:requestId/responses")!;
  const response = await invokeRoute(handler, { params: { threadId: THREAD_ID, requestId: REQUEST_ID }, body: {} });
  assert.equal(response.statusCode, 200);
  assert.equal((response.payload as Record<string, unknown>).invocation_id, "inv");
  assert.equal((response.payload as Record<string, unknown>).continuation, "durable_invocation");
});

test("agent state recovers persisted app and automation requests only after thread authorization", async t => {
  t.after(() => mock.restoreAll());
  let signedIn = false, owned = false, reads = 0;
  mock.method(auth.api, "getSession", async () => signedIn ? SESSION as never : null);
  mock.method(db.query.threadTable, "findFirst", async () => owned ? THREAD as never : null);
  const pending = [{ request_id: "dar_pending", turn_id: "turn", client_id: "client", call_id: "call",
    request: { request_id: "dar_pending", status: "pending" } }];
  const proposals = [{ proposal_id: "ap_pending", turn_id: "turn", client_id: "proposal-client", call_id: "proposal-call",
    proposal: { proposal_id: "ap_pending", status: "pending" }, created_at: "2026-09-06T00:00:00.000Z" }];
  const bootstrap = [{ proposal_id: "bp_pending", turn_id: "turn", client_id: "bootstrap-client", call_id: "bootstrap-call",
    proposal: { proposal_id: "bp_pending", kind: "existing_contacts", status: "pending", member_count: 3 }, created_at: "2026-09-06T00:00:00.000Z" }];
  let proposalReads = 0, bootstrapReads = 0;
  let bootstrapResolved = false;
  const server = createServer();
  await registerThreadAgentRoutes(server, {
    getEnvironmentForBud: async () => buildAgentEnvironmentSnapshot({ budId: THREAD.budId, online: false }),
    durableInvocations: {
      listForThread: async () => [], pendingQuestionsForThread: async () => [],
      pendingDataRequestsForThread: async (owner: string, thread: string) => {
        reads++; assert.deepEqual([owner, thread], [SESSION.user.id, THREAD_ID]); return pending;
      },
      pendingAutomationProposalsForThread: async (owner: string, thread: string) => {
        proposalReads++; assert.deepEqual([owner, thread], [SESSION.user.id, THREAD_ID]); return proposals;
      },
      pendingBootstrapProposalsForThread: async (owner: string, thread: string) => {
        bootstrapReads++; assert.deepEqual([owner, thread], [SESSION.user.id, THREAD_ID]); return bootstrapResolved ? [] : bootstrap;
      },
    },
  } as never, { getSnapshot: () => ({ active: true, pending_tool: null, context_budget: { status: "available" } }) } as never);
  const handler = server.routes.get("GET /api/threads/:threadId/agent/state")!;
  const request = { params: { threadId: THREAD_ID } };
  assert.equal((await invokeRoute(handler, request)).statusCode, 401);
  signedIn = true;
  assert.equal((await invokeRoute(handler, request)).statusCode, 404);
  assert.equal(reads, 0);
  assert.equal(proposalReads, 0);
  assert.equal(bootstrapReads, 0);
  owned = true;
  const response = await invokeRoute(handler, request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.payload as Record<string, unknown>).pending_data_requests, pending);
  assert.deepEqual((response.payload as Record<string, unknown>).pending_automation_requests, proposals);
  assert.deepEqual((response.payload as Record<string, unknown>).pending_bootstrap_requests, bootstrap);
  assert.equal(reads, 1);
  assert.equal(proposalReads, 1);
  assert.equal(bootstrapReads, 1);
  bootstrapResolved = true;
  const refreshed = await invokeRoute(handler, request);
  assert.deepEqual((refreshed.payload as Record<string, unknown>).pending_bootstrap_requests, []);
});
