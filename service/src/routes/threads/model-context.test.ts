import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { FastifyInstance } from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { AGENT_CANONICAL_TOOLS } from "../../agent/tool-definitions.js";
import type { MessageSource } from "../../agent/conversation-loader.js";
import type { CanonicalMessage } from "../../llm/index.js";
import {
  buildModelContextDocument,
  registerThreadModelContextRoutes,
  serializeCanonicalBlock,
} from "./model-context.js";

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

function createServer(): FastifyInstance & { handlers: Map<string, RouteHandler> } {
  const handlers = new Map<string, RouteHandler>();
  const addRoute =
    (method: string) =>
    (path: string, handler: RouteHandler) => {
      handlers.set(`${method} ${path}`, handler);
    };
  return {
    handlers,
    get: addRoute("GET"),
  } as unknown as FastifyInstance & { handlers: Map<string, RouteHandler> };
}

async function invokeRoute(
  handler: RouteHandler,
  request: Record<string, unknown> = {},
): Promise<{ statusCode: number; payload: unknown }> {
  const reply = new TestReply();
  const result = await handler({ headers: {}, ...request }, reply);
  return { statusCode: reply.statusCode, payload: reply.sent ? reply.payload : result };
}

const SESSION = {
  user: { id: "user-1", email: "test@example.com", emailVerified: true, name: "Test User", image: null },
  session: { id: "session-1", expiresAt: new Date("2026-04-21T21:00:00.000Z") },
};

async function registerHandler() {
  const server = createServer();
  await registerThreadModelContextRoutes(server, {} as never, {} as never);
  const handler = server.handlers.get("GET /api/threads/:threadId/model-context");
  assert.ok(handler);
  return handler;
}

test("model-context route registers and rejects unauthenticated requests", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => null);
  const handler = await registerHandler();
  assert.deepEqual(
    await invokeRoute(handler, { params: { threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5" } }),
    { statusCode: 401, payload: { error: "unauthorized" } },
  );
});

test("model-context route returns 404 for signed-in non-owners before loading anything", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mock.method(auth.api, "getSession", async () => SESSION as never);
  mock.method(db.query.threadTable, "findFirst", async () => null);
  const select = mock.method(db, "select", () => {
    throw new Error("must not load conversation");
  });
  const handler = await registerHandler();
  assert.deepEqual(
    await invokeRoute(handler, { params: { threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5" } }),
    { statusCode: 404, payload: { error: "thread_not_found" } },
  );
  assert.equal(select.mock.callCount(), 0);
});

test("buildModelContextDocument serializes messages with provenance and per-message tokens", () => {
  const messages: CanonicalMessage[] = [
    { role: "system", content: [{ type: "text", text: "You are Bud." }] },
    { role: "system", content: "The selected Bud is currently offline." },
    { role: "user", content: [{ type: "text", text: "List files" }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Plan." },
        { type: "text", text: "Running ls.", assistantPhase: "commentary" },
        { type: "tool_use", id: "call-1", name: "terminal_send", input: { text: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "a b c" }] },
  ];
  const sources: MessageSource[] = [
    { kind: "system_prompt", scope: "default", version: "sha256:abc" },
    { kind: "runtime_instruction" },
    { kind: "message", message_id: "m-1", client_id: "c-1", role: "user" },
    { kind: "ledger", llm_call_id: "llm-1" },
    { kind: "repair" },
  ];

  const doc = buildModelContextDocument({
    model: "gpt-5.6-sol",
    provider: "openai",
    generatedAt: new Date("2026-09-03T10:00:00.000Z"),
    turnActive: false,
    messages,
    sources,
    tools: AGENT_CANONICAL_TOOLS,
    compaction: { checkpointId: "chk-1", compactedThroughMessageId: "m-0" },
    contextBudget: null,
  });

  assert.equal(doc.model, "gpt-5.6-sol");
  assert.equal(doc.generated_at, "2026-09-03T10:00:00.000Z");
  assert.deepEqual(doc.system_prompt, { scope: "default", version: "sha256:abc" });
  assert.deepEqual(doc.compaction, { checkpoint_id: "chk-1", compacted_through_message_id: "m-0" });
  assert.equal(doc.messages.length, 5);
  assert.deepEqual(doc.messages.map((message) => message.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(doc.messages.map((message) => message.source.kind), [
    "system_prompt",
    "runtime_instruction",
    "message",
    "ledger",
    "repair",
  ]);
  // String content is normalized to a text block; assistantPhase becomes snake_case.
  assert.deepEqual(doc.messages[1]!.content, [{ type: "text", text: "The selected Bud is currently offline." }]);
  assert.deepEqual(doc.messages[3]!.content[1], { type: "text", text: "Running ls.", assistant_phase: "commentary" });
  assert.deepEqual(doc.messages[4]!.content, [{ type: "tool_result", tool_use_id: "call-1", content: "a b c" }]);
  assert.ok(doc.messages.every((message) => message.estimated_tokens > 0));
  assert.equal(doc.tools.length, AGENT_CANONICAL_TOOLS.length);
  assert.ok(doc.tool_schema_tokens > 0);
  assert.equal(
    doc.estimated_input_tokens,
    doc.messages.reduce((total, message) => total + message.estimated_tokens, 0) + doc.tool_schema_tokens,
  );
});

test("buildModelContextDocument refuses misaligned provenance", () => {
  assert.throws(() =>
    buildModelContextDocument({
      model: "m",
      provider: "openai",
      generatedAt: new Date(),
      turnActive: false,
      messages: [{ role: "user", content: "hi" }],
      sources: [],
      tools: [],
      compaction: null,
      contextBudget: null,
    }),
  );
});

test("serializeCanonicalBlock keeps nested tool results and redacts reasoning payloads", () => {
  assert.deepEqual(
    serializeCanonicalBlock({
      type: "tool_result",
      tool_use_id: "call-2",
      content: [{ type: "text", text: "nested" }],
      is_error: true,
    }),
    { type: "tool_result", tool_use_id: "call-2", content: [{ type: "text", text: "nested" }], is_error: true },
  );
  assert.deepEqual(
    serializeCanonicalBlock({ type: "reasoning_redacted", providerData: { secret: true } } as never),
    { type: "reasoning_redacted" },
  );
});
