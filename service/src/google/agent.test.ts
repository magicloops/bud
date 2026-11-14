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
import { OpenAIProvider } from "../llm/providers/openai.js";
import { config } from "../config.js";
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
      status: "connected", calendar_access: true, gmail_access: false, drive_access: false,
      calendar_write_access: true, gmail_write_access: false, drive_write_access: false,
      access: { calendar: "read_write", gmail: "none", drive: "none" }, updated_at: new Date().toISOString() }] : [],
    call: async (owner, id, request, signal, beforeDispatch, _service, authorization) => {
      assert.equal(owner, "alice"); assert.equal(id, "connection");
      await beforeDispatch("dispatch");
      authorization?.onDispatchChange?.(true);
      const reply = await googleJson(googleFetch(fixture.fetcher, signal),
        `https://www.googleapis.com/calendar/v3${request.path}`, owner, { method: request.method,
          body: request.body === undefined ? undefined : JSON.stringify(request.body) });
      onDispatch(); return reply;
    },
  };
  return { fixture, executor: new GoogleAgentExecutor(connections, async owner => owner === "alice" && owns ? "bud" : undefined),
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

test("oversized Gmail threads retain newest messages as valid bounded JSON with follow-up IDs", async () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({ id: `message${index}`, internalDate: String(1000 + index),
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Conversation" }],
      body: { data: Buffer.from(`reply ${index}: ` + '最新🌱\n"'.repeat(4000)).toString("base64url") } } }));
  let requests = 0;
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, request, _signal, before) => {
    await before("dispatch"); requests++;
    return request.path === "/threads/conversation" ? { id: "conversation", messages } : messages.find(message => request.path === `/messages/${message.id}`)!;
  } }, async () => "bud");
  const invoke = (tool_name: string, args: unknown) => executor.execute("thread", { ...call, args: { connection_id: "connection", tool_name,
    arguments_json: JSON.stringify(args) } }, "alice", new AbortController().signal, hooks);
  const thread = await invoke("gmail_get_thread", { thread_id: "conversation" });
  assert.equal(thread.result.ok, true);
  const text = String(thread.payload.text), data = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) < 32768);
  assert.doesNotMatch(text, /\ufffd/);
  assert.equal(data.messages_order, "newest_first");
  assert.equal(data.messages[0].id, "message5");
  assert.match(data.messages[0].bodies[0].content, /^reply 5: 最新🌱/);
  assert.equal(thread.payload.truncated, true);
  assert.ok(data.omitted_messages > 0);
  assert.ok(data.omitted_message_ids.includes("message0"));
  const earlier = await invoke("gmail_get_message", { message_id: data.omitted_message_ids[0] });
  const message = JSON.parse(String(earlier.payload.text));
  assert.equal(message.id, data.omitted_message_ids[0]);
  assert.ok(message.bodies[0].content.length > 0);
  assert.ok(Buffer.byteLength(String(earlier.payload.text)) < 32768);
  assert.equal(requests, 2);
});

test("transient Google refresh failure remains retryable without an OAuth card or automatic retry", async () => {
  let attempts = 0;
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async () => {
    attempts++;
    throw new GoogleError("google_refresh_unavailable", true);
  } }, async () => "bud");
  const result = await executor.execute("thread", call, "alice", new AbortController().signal, hooks);
  assert.equal(result.result.error, "google_refresh_unavailable");
  assert.equal(result.result.retryable, true);
  assert.equal(result.payload.retryable, true);
  assert.equal(result.payload.connect_request, undefined);
  assert.equal(attempts, 1);
  assert.match(result.summary, /temporarily/);
});

test("oversized non-Gmail fallback is a valid JSON preview within the existing result cap", async () => {
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, _request, _signal, before) => {
    await before("dispatch"); return { id: "event", description: '🌱"\\'.repeat(12000) };
  } }, async () => "bud");
  const result = await executor.execute("thread", { ...call, args: { connection_id: "connection", tool_name: "calendar_get_event",
    arguments_json: JSON.stringify({ calendar_id: "primary", event_id: "event" }) } }, "alice", new AbortController().signal, hooks);
  assert.equal(result.payload.truncated, true);
  const text = String(result.payload.text);
  assert.ok(Buffer.byteLength(text) <= 32768);
  assert.equal(JSON.parse(text).truncated, true);
  assert.doesNotMatch(text, /\ufffd/);
});

test("task discovery requests only its exact access level and skips consent for sufficient grants", async () => {
  for (const service of ["calendar", "gmail", "drive"] as const) {
    for (const granted of ["none", "read_only", "read_write"] as const) {
      for (const requested of ["read_only", "read_write"] as const) {
        const executor = new GoogleAgentExecutor({ list: async () => [{ connection_id: "connection", email: "alice@example.com",
          status: "connected", calendar_access: true, gmail_access: true, drive_access: true,
          calendar_write_access: true, gmail_write_access: true, drive_write_access: true,
          access: { calendar: "none", gmail: "none", drive: "none", [service]: granted }, updated_at: "now" }],
          call: async () => { throw new Error("Discovery must not dispatch"); } }, async () => "bud");
        const result = await executor.execute("thread", { ...call, tool: "google_search_tools", args: { service, query: "", access: requested } },
          "alice", new AbortController().signal, hooks);
        const sufficient = granted === "read_write" || (granted === "read_only" && requested === "read_only");
        assert.deepEqual(result.payload.connect_request, sufficient ? undefined : { provider: `google_${service}`, thread_id: "thread", access: requested });
        assert.equal((result.payload.tools as unknown[]).length > 0, sufficient);
      }
    }
  }
});

test("strict OpenAI discovery can ask for the default service and access", async () => {
  const definition = resolveAgentToolsForEnvironment(offline, { google: true }).find(tool => tool.name === "google_search_tools")!;
  const provider = new OpenAIProvider("fixture-key");
  const [strict] = Reflect.get(provider, "transformTools").call(provider, [definition]);
  for (const field of ["service", "access"]) {
    assert.ok(strict.parameters.required.includes(field));
    assert.ok(strict.parameters.properties[field].type.includes("null"));
    assert.ok(strict.parameters.properties[field].enum.includes(null));
  }
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async () => assert.fail() }, async () => "bud");
  for (const args of [{ query: "" }, { query: "", service: null, access: null },
    { query: "", service: "drive", access: null }, { query: "", service: null, access: "read_write" }]) {
    const result = await executor.execute("thread", { ...call, tool: "google_search_tools", args },
      "alice", new AbortController().signal, hooks);
    assert.deepEqual(result.payload.connect_request, { provider: `google_${args.service ?? "calendar"}`,
      thread_id: "thread", access: args.access ?? "read_only" });
    assert.ok(String(result.payload.note).includes(new URL("/bud/thread", config.appBaseUrl).href));
  }
});

test("validation reports actionable fields and malformed JSON before dispatch", async () => {
  const { executor, fixture } = fixtureExecutor();
  const run = (arguments_json: string) => executor.execute("thread", { ...call, args: { ...call.args, arguments_json } },
    "alice", new AbortController().signal, hooks);
  const malformed = await run("{");
  assert.equal(malformed.result.error, "google_invalid_arguments");
  assert.deepEqual(malformed.payload.validation_errors, [{ field: "arguments_json", message: "Supply a valid JSON object string." }]);
  const missing = await run(JSON.stringify({ calendar_id: "primary", event: { summary: "private subject" } }));
  assert.deepEqual((missing.payload.validation_errors as { field: string }[]).map(issue => issue.field), ["event.start", "event.end"]);
  assert.doesNotMatch(JSON.stringify(missing.payload.validation_errors), /private subject/);
  assert.equal(fixture.calls.length, 0);
});

test("transient reads are retryable while ambiguous writes require review", async () => {
  const invoke = (status: number, write: boolean) => {
    const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_o, _id, _r, _s, before, _svc, auth) => {
      await before("dispatch");
      if (write) auth?.onDispatchChange?.(true);
      throw new GoogleHttpError(status);
    } }, async () => "bud");
    return executor.execute("thread", write ? call : { ...call, args: { connection_id: "connection",
      tool_name: "gmail_get_message", arguments_json: '{"message_id":"message"}' } },
      "alice", new AbortController().signal, hooks);
  };
  for (const status of [429, 503]) assert.equal((await invoke(status, false)).result.retryable, true);
  assert.equal((await invoke(429, true)).result.retryable, false);
  await assert.rejects(invoke(503, true), /google_outcome_unknown/);
  assert.equal((await invoke(412, false)).result.error, "google_precondition_failed");
});

test("cancellation after the write checkpoint but before fetch keeps the cancellation reason", async () => {
  const controller = new AbortController();
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_o, _id, _r, signal, before) => {
    await before("dispatch");
    controller.abort(new Error("canceled before fetch"));
    signal.throwIfAborted();
    assert.fail("a canceled write should never reach fetch");
  } }, async () => "bud");
  await assert.rejects(executor.execute("thread", call, "alice", controller.signal, hooks), /canceled before fetch/);
});

test("actual tool access controls upgrade cards including read-only POST free/busy", async () => {
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, _request, _signal, _before, _service, options) => {
    throw new GoogleError(options?.access === "write" ? "google_calendar_write_permissions_required" : "google_calendar_permissions_required");
  } }, async () => "bud");
  for (const directive of [call, { ...call, args: { connection_id: "connection", tool_name: "calendar_free_busy",
    arguments_json: JSON.stringify({ calendar_ids: ["primary"], time_min: "2030-11-13T15:00:00-08:00", time_max: "2030-11-13T16:00:00-08:00" }) } }]) {
    const result = await executor.execute("thread", directive, "alice", new AbortController().signal, hooks);
    assert.deepEqual(result.payload.connect_request, { provider: "google_calendar", thread_id: "thread",
      access: directive === call ? "read_write" : "read_only" });
  }
});

test("disabled Calendar API gives setup guidance and remains a definite write rejection", async () => {
  let requests = 0;
  const executor = new GoogleAgentExecutor({ list: async () => [], call: async (_owner, _id, request, signal, beforeDispatch, _service, authorization) => {
    await beforeDispatch("dispatch");
      authorization?.onDispatchChange?.(true);
    return googleJson(googleFetch(async () => {
      requests++;
      return Response.json({ error: { message: "private provider text", details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 });
    }, signal), `https://www.googleapis.com/calendar/v3${request.path}`, "fixture-token", { method: request.method });
  } }, async () => "bud");
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
    async owner => owner === "alice" ? "bud" : undefined);
  const signal = new AbortController().signal;
  const discovery = { ...call, tool: "google_search_tools" as const, args: { query: "calendar" } };
  for (const directive of [discovery, call]) {
    const result = await executor.execute("thread", directive, "alice", signal, hooks);
    assert.deepEqual(result.payload.connect_request, { provider: "google_calendar", thread_id: "thread", access: directive.tool === "google_call" ? "read_write" : "read_only" });
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
    await before("dispatch"); throw new GoogleHttpError(401);
  } }, async () => "bud");
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
