import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { db } from "../db/client.js";
import { AgentService } from "../agent/agent-service.js";
import { AgentModelRunner } from "../agent/model-runner.js";
import { AgentConversationLoader } from "../agent/conversation-loader.js";
import { buildAgentEnvironmentSnapshot } from "../agent/environment.js";
import { resolveAgentToolsForEnvironment } from "../agent/tool-definitions.js";
import { buildToolArgs, toolNameForConversation, type GoogleToolCallDirective } from "../agent/contracts.js";
import type { AgentExecutionHooks } from "../agent/execution-lifecycle.js";
import type { CanonicalMessage, CanonicalResponse } from "../llm/index.js";
import { GoogleAgentExecutor } from "./agent-executor.js";
import { googleFetch, googleJson } from "./http.js";
import type { GoogleConnections } from "./connections.js";
import { googleFixture } from "./test-fixture.js";
import { GoogleError, GoogleHttpError } from "./config.js";

const logger = { info() {}, warn() {}, error() {} };
const offline = buildAgentEnvironmentSnapshot({ budId: "bud", online: false, lastSeenAt: null });
const hooks: AgentExecutionHooks = {
  googleEnabled: true, invocation: { id: "invocation", workerId: "worker", fence: 1 },
  async checkpoint() {}, async beforeTool() {}, async afterTool() {},
};
const call: GoogleToolCallDirective = { type: "tool_call", tool: "google_call", callId: "call",
  args: { connection_id: "connection", tool_name: "calendar_create_event", arguments_json: JSON.stringify({ calendar_id: "primary", event: { summary: "Test", start: { date_time: "2030-11-13T15:00:00-08:00" }, end: { date_time: "2030-11-13T15:15:00-08:00" } } }) } };

function fixtureExecutor() {
  const fixture = googleFixture();
  let owns = true;
  let onDispatch = () => {};
  const connections: Pick<GoogleConnections, "list" | "call"> = {
    list: async owner => owner === "alice" ? [{ connection_id: "connection", email: "alice@example.com",
      status: "connected", calendar_access: true, updated_at: new Date().toISOString() }] : [],
    call: async (owner, id, request, signal, beforeDispatch) => {
      assert.equal(owner, "alice"); assert.equal(id, "connection");
      await beforeDispatch();
      const reply = await googleJson(googleFetch(fixture.fetcher, signal),
        `https://www.googleapis.com/calendar/v3${request.path}`, owner, { method: request.method,
          body: request.body === undefined ? undefined : JSON.stringify(request.body) });
      onDispatch(); return reply;
    },
  };
  return { fixture, executor: new GoogleAgentExecutor(connections, async owner => owner === "alice" && owns),
    loseOwnershipAfterDispatch: () => { onDispatch = () => { owns = false; }; } };
}

test("Google catalog is explicit, stays available offline, and parser/replay preserve call pairing", () => {
  assert.ok(!resolveAgentToolsForEnvironment(offline).some(t => t.name === "google_call"));
  const tools = resolveAgentToolsForEnvironment(offline, { google: true });
  assert.ok(tools.some(t => t.name === "google_call"));
  assert.ok(!tools.some(t => t.name === "terminal_send"));
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const loader = new AgentConversationLoader();
  for (const name of ["google_call", "google_search_tools"] as const) {
    const args = name === "google_call" ? call.args : { query: "Calendar events" };
    const [directive] = runner.extractToolCalls({ id: "response", stopReason: "tool_use", content: [],
      toolCalls: [{ id: "call", name, input: args }] });
    assert.deepEqual(buildToolArgs(directive), args);
    assert.equal(toolNameForConversation(directive.tool), name);
    assert.deepEqual(Reflect.get(loader, "parseStoredToolDirective").call(loader,
      JSON.stringify({ tool: name, call_id: "call", args })), directive);
  }
});

test("agent discovery and call use the owning connection; legacy/automation/foreign calls never dispatch", async () => {
  const { executor, fixture } = fixtureExecutor();
  const signal = new AbortController().signal;
  const discovery = await executor.execute("thread", { ...call, tool: "google_search_tools", args: { query: "create" } }, "alice", signal, hooks);
  assert.equal(discovery.result.ok, true);
  assert.match(JSON.stringify(discovery.payload), /calendar_create_event/);
  assert.doesNotMatch(JSON.stringify(discovery.payload), /unreviewed_tool|access_token/);
  assert.equal(fixture.calls.length, 0);
  for (const context of [undefined, { ...hooks, googleEnabled: false }, { ...hooks, invocation: undefined }]) {
    assert.equal((await executor.execute("thread", call, "alice", signal, context)).result.error, "google_unavailable");
  }
  assert.equal((await executor.execute("thread", call, "bob", signal, hooks)).result.error, "google_not_found");
  assert.equal((await executor.execute("thread", { ...call, args: { ...call.args, arguments_json: '{"to":123}' } }, "alice", signal, hooks)).result.error, "google_invalid_arguments");
  assert.equal(fixture.calls.length, 0);
  assert.equal((await executor.execute("thread", call, "alice", signal, hooks)).result.ok, true);
  assert.equal(fixture.calls.length, 1);
});

test("lost write responses and lost authority after dispatch stop instead of returning retryable errors", async () => {
  for (const outcome of ["lost_response", "lost_owner"] as const) {
    const { executor, fixture, loseOwnershipAfterDispatch } = fixtureExecutor();
    if (outcome === "lost_response") fixture.loseReply(); else loseOwnershipAfterDispatch();
    await assert.rejects(executor.execute("thread", call, "alice", new AbortController().signal, hooks), /google_outcome_unknown/);
    assert.equal(fixture.calls.length, 1);
  }
});

test("disabled Calendar API gives setup guidance and remains a definite write rejection", async () => {
  let requests = 0;
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, request, signal, beforeDispatch) => {
    await beforeDispatch();
    return googleJson(googleFetch(async () => {
      requests++;
      return Response.json({ error: { message: "private provider text", details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 });
    }, signal), `https://www.googleapis.com/calendar/v3${request.path}`, "fixture-token", { method: request.method });
  } }, async () => true);
  const result = await executor.execute("thread", call, "alice", new AbortController().signal, hooks);
  assert.equal(result.result.error, "google_api_disabled");
  assert.equal(result.result.retryable, false);
  assert.match(result.summary, /Enable Google Calendar API/);
  assert.doesNotMatch(JSON.stringify(result), /private provider text|fixture-token|google_outcome_unknown/);
  assert.equal(requests, 1);
  assert.equal(result.payload.connect_request, undefined);
});

test("missing or revoked Calendar access offers in-chat consent only to the owning human", async () => {
  let failure = "google_reconnect_required";
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async () => { throw new GoogleError(failure); } },
    async owner => owner === "alice");
  const signal = new AbortController().signal;
  const discovery = { ...call, tool: "google_search_tools" as const, args: { query: "calendar" } };
  for (const directive of [discovery, call]) {
    const result = await executor.execute("thread", directive, "alice", signal, hooks);
    assert.deepEqual(result.payload.connect_request, { provider: "google_calendar", thread_id: "thread" });
    assert.match(String(result.payload.note), /in this chat/);
    assert.doesNotMatch(JSON.stringify(result.payload), /authorization_url|code_verifier|oauth_state/);
    for (const [owner, context] of [["bob", hooks], ["alice", { ...hooks, googleEnabled: false }]] as const) {
      assert.equal((await executor.execute("thread", directive, owner, signal, context)).payload.connect_request, undefined);
    }
  }
  failure = "google_calendar_permissions_required";
  assert.ok((await executor.execute("thread", call, "alice", signal, hooks)).payload.connect_request);
  failure = "google_not_found";
  assert.equal((await executor.execute("thread", call, "alice", signal, hooks)).payload.connect_request, undefined);
  const rejected = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, _request, _signal, before) => {
    await before(); throw new GoogleHttpError(401);
  } }, async () => true);
  assert.ok((await rejected.execute("thread", call, "alice", signal, hooks)).payload.connect_request);
  const { executor: connected } = fixtureExecutor();
  assert.equal((await connected.execute("thread", discovery, "alice", signal, hooks)).payload.connect_request, undefined);
});

for (const lostResponse of [false, true]) test(`agent loop ${lostResponse ? "leaves unknown write intent unresolved" : "delivers Google evidence with owner attribution"}`, async t => {
  t.after(() => mock.restoreAll());
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (fn: (tx: unknown) => Promise<unknown>) => fn({ insert: db.insert.bind(db) }));
  const runtime = { markThinking() {}, setEnvironment() {}, finishTurn() {}, setLastError() {}, emit() { return "cursor"; } };
  const service = new AgentService({} as never, runtime as never, logger as never, false, false);
  Reflect.set(service, "getEnvironmentForThread", async () => offline);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const { executor, fixture } = fixtureExecutor();
  if (lostResponse) fixture.loseReply();
  Reflect.set(service, "googleToolExecutor", executor);
  let invocations = 0;
  let delivered: CanonicalMessage[] = [];
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async (_thread: string, _turn: string, messages: CanonicalMessage[]) => {
    invocations++;
    const response: CanonicalResponse = invocations === 1
      ? { id: "r1", stopReason: "tool_use", content: [{ type: "tool_use", id: call.callId, name: call.tool, input: call.args }],
        toolCalls: [{ id: call.callId, name: call.tool, input: call.args },
          ...(lostResponse ? [{ id: "trailing-call", name: call.tool, input: call.args }] : [])] }
      : { id: "r2", stopReason: "end_turn", content: [{ type: "text", text: "Created the requested event." }] };
    delivered = messages;
    return { response, assistantClientId: null, reasoningSegments: [], assistantTiming: null };
  });
  let recorded = false, completed = false, intentCount = 0;
  Reflect.set(service, "transcriptWriter", {
    emitToolCall: () => ({ clientArgs: call.args }),
    recordToolResult: async (args: { execution: { payload: Record<string, unknown> }; ownerUserId: string }) => {
      assert.equal(args.ownerUserId, "alice"); recorded = true;
      return { payload: args.execution.payload, message: { message_id: "message" } };
    }, recordFinalAssistant: async () => { assert.ok(recorded); },
  });
  const run = Reflect.get(service, "runAgentFlow").bind(service);
  const result = run({ threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
    modelReasoning: { providerModel: "fixture", reasoningLevel: "low" },
    modelSelection: { model: "fixture", reasoningEffort: "low", source: "explicit_request" },
    environment: offline, ownerUserId: "alice", controller: new AbortController(), executionHooks: {
      ...hooks, beforeTool: async () => { assert.equal(fixture.calls.length, 0); intentCount++; },
      afterTool: async () => { assert.ok(recorded); completed = true; },
    } });
  if (lostResponse) {
    await assert.rejects(result, /google_outcome_unknown/);
    assert.equal(invocations, 1); assert.equal(recorded, false); assert.equal(completed, false);
  } else {
    await result;
    assert.equal(invocations, 2); assert.ok(completed);
    assert.match(JSON.stringify(delivered), /event for alice/);
  }
  assert.equal(intentCount, 1); assert.equal(fixture.calls.length, 1);
});
