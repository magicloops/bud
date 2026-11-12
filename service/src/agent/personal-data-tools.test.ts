import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/client.js";
import { AgentModelRunner } from "./model-runner.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { AgentService } from "./agent-service.js";
import { PersonalDataToolExecutor } from "./personal-data-tool-executor.js";
import { buildToolArgs, type PersonalDataToolCallDirective } from "./contracts.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { DataRequestError } from "../personal-data/contracts.js";
import type { CanonicalMessage, CanonicalResponse } from "../llm/index.js";
import type { AgentDataQueries } from "../personal-data/agent-queries.js";

const logger = { info() {}, warn() {}, error() {} };
/** The access log, recorded here instead of written to a database. */
type Logged = { owner?: string; actor: { kind: string; ref: string; threadId?: string | null; turnId?: string | null }; sources: readonly string[]; operation: string;
  outcome?: string; recordCount?: number | null; policyVersion?: number | null; window?: unknown };
const logged: Logged[] = [];
const log = { record: async (entry: Logged) => { logged.push(entry); }, recordQuietly: async (entry: Logged) => { logged.push(entry); } };
const directive: PersonalDataToolCallDirective = { type: "tool_call", tool: "contacts_search", args: { search: "Ada" }, callId: "call-1" };
const queryResult: Awaited<ReturnType<AgentDataQueries["execute"]>> = {
  data: { items: [{ id: "contact-1" }], next_cursor: null },
  permission: { version: 1, contact_fields: ["names", "organization", "phones", "emails"], health_types: ["workouts", "sleep"], history_days: 30, observed_since: "2026-08-05T00:00:00Z" },
  interpretation: "Untrusted observed data",
};

test("personal-data tools remain available offline and normalize optional null arguments", () => {
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false, lastSeenAt: null });
  const names = resolveAgentToolsForEnvironment(environment).map(t => t.name);
  for (const name of ["contacts_get", "contacts_search", "contacts_history", "location_context", "timeline_query", "health_workouts", "health_sleep"]) assert.ok(names.includes(name));
  assert.ok(!names.includes("terminal_send"));
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const parsed = runner.extractToolCalls({ id: "response", content: [], stopReason: "tool_use", toolCalls: [
    { name: "contacts_search", id: "call-1", input: { search: "Ada", visibility: null, cursor: null, limit: null } },
  ] });
  assert.deepEqual(parsed, [directive]);
  const loader = new AgentConversationLoader();
  const parse = Reflect.get(loader, "parseStoredToolDirective").bind(loader);
  assert.deepEqual(parse(JSON.stringify({ tool: directive.tool, call_id: directive.callId, args: directive.args, data: queryResult.data })), directive);
  assert.deepEqual(buildToolArgs(directive), { search: "Ada" });
});

test("personal-data execution rechecks thread ownership and reports permission errors without leaking failures", async () => {
  let queries = 0;
  const executor = new PersonalDataToolExecutor({ execute: async owner => { queries++; assert.equal(owner, "alice"); return queryResult; } },
    async (thread, owner) => thread === "owned" && owner === "alice", undefined, log);
  assert.equal((await executor.execute("foreign", directive, "alice")).result.ok, false);
  assert.equal((await executor.execute("owned", directive, "bob")).result.ok, false);
  assert.equal(queries, 0);
  assert.deepEqual((await executor.execute("owned", directive, "alice")).payload.data, queryResult.data);
  assert.equal(queries, 1);
  const denied = new PersonalDataToolExecutor({ execute: async () => { throw new DataRequestError(403, "data_permission_required", "Approve data access"); } }, async () => true, undefined, log);
  const result = await denied.execute("owned", directive, "alice");
  assert.equal(result.payload.permission_settings_path, "/data");
  assert.equal(result.payload.approval_required, true);
  assert.equal(result.payload.reason, "agent_not_allowed");
  // A source the user turned off: the agent learns which one, and that it can't fix it.
  const off = new PersonalDataToolExecutor({ execute: async () => {
    throw new DataRequestError(403, "source_off", "Location is turned off in Data sources.", false, 0, { source: "location" }); } }, async () => true, undefined, log);
  const refused = await off.execute("owned", directive, "alice");
  assert.deepEqual([refused.result.ok, refused.result.retryable, refused.payload.error, refused.payload.reason, refused.payload.source],
    [false, false, "source_off", "source_off", "location"]);
  assert.equal(refused.payload.approval_required, undefined);
  const failed = new PersonalDataToolExecutor({ execute: async () => { throw new Error("secret SQL parameters"); } }, async () => true, undefined, log);
  assert.doesNotMatch(JSON.stringify(await failed.execute("owned", directive, "alice")), /secret SQL/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executor.execute("owned", directive, "alice", controller.signal));
  assert.equal(queries, 1);
});

test("agent loop delivers a scoped query result to the next model step and stamps its transcript owner", async t => {
  t.after(() => mock.restoreAll());
  const ledger: unknown[] = [];
  mock.method(db, "insert", () => ({ values: (values: unknown) => { ledger.push(values); return {}; } }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const runtime = { markThinking() {}, setEnvironment() {}, finishTurn() {}, emit() { return "cursor"; } };
  const service = new AgentService({} as never, runtime as never, logger as never, false, false);
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false, lastSeenAt: null });
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  let invocations = 0;
  let delivered: CanonicalMessage[] = [];
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async (_thread: string, _turn: string, messages: CanonicalMessage[]) => {
    invocations++;
    const response: CanonicalResponse = invocations === 1
      ? { id: "r1", stopReason: "tool_use", content: [{ type: "tool_use", id: "call-1", name: "contacts_search", input: { search: "Ada" } }], toolCalls: [{ id: "call-1", name: "contacts_search", input: { search: "Ada" } }] }
      : { id: "r2", stopReason: "end_turn", content: [{ type: "text", text: "Found contact evidence." }] };
    if (invocations === 2) delivered = messages;
    return { response, assistantClientId: null, provider: "openai", providerModel: "fixture", reasoningSegments: [], assistantTiming: null };
  });
  Reflect.set(service, "personalDataToolExecutor", new PersonalDataToolExecutor({ execute: async owner => { assert.equal(owner, "alice"); return queryResult; } }, async (thread, owner) => thread === "thread" && owner === "alice", async () => undefined, log));
  let recorded = false;
  Reflect.set(service, "transcriptWriter", {
    emitToolCall: (_thread: string, _turn: string, call: PersonalDataToolCallDirective) => ({ clientArgs: buildToolArgs(call) }),
    recordToolResult: async (args: { execution: { payload: Record<string, unknown> }; ownerUserId: string }) => {
      assert.equal(args.ownerUserId, "alice"); recorded = true;
      return { payload: args.execution.payload, message: { message_id: "message" } };
    },
    recordFinalAssistant: async () => { assert.ok(recorded); },
  });
  const lifecycle: string[] = [];
  const run = Reflect.get(service, "runAgentFlow").bind(service);
  await run({ threadId: "thread", turnId: "turn", sessionId: null, model: "fixture", modelReasoning: { providerModel: "fixture", reasoningLevel: "low" },
    modelSelection: { model: "fixture", reasoningEffort: "low", source: "explicit_request" }, environment, ownerUserId: "alice", controller: new AbortController(), executionHooks: {
      checkpoint: async () => { lifecycle.push("checkpoint"); },
      beforeTool: async () => { assert.equal(recorded, false); lifecycle.push("intent"); },
      afterTool: async () => { assert.ok(recorded); lifecycle.push("evidence"); },
    } });
  assert.equal(invocations, 2);
  assert.ok(lifecycle.indexOf("intent") < lifecycle.indexOf("evidence"));
  assert.ok(recorded);
  assert.match(JSON.stringify(delivered), /contact-1/);
  assert.match(JSON.stringify(ledger), /contacts_search/);
});

test("conversation initialization failures finish runtime state before rejecting completion", async () => {
  let finished = false;
  let failedEvent = false;
  const service = new AgentService({} as never, {
    finishTurn() { finished = true; },
    emit(_thread: string, event: { event: string }) { failedEvent = event.event === "final"; return "cursor"; },
    setLastError() {},
  } as never, logger as never, false, false);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => { throw new Error("fixture load failure"); } });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  const original = runner.resolveProviderName;
  runner.resolveProviderName = () => "openai";
  try {
    await assert.rejects(Reflect.get(service, "runAgentFlow").call(service, {
      threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
      modelReasoning: { providerModel: "fixture" }, modelSelection: {}, environment: {}, controller: new AbortController(),
    }), /fixture load failure/);
    assert.ok(finished);
    assert.ok(failedEvent);
  } finally { runner.resolveProviderName = original; }
});

test("query results are withheld when the invocation fence changes during the read", async () => {
  let fence = 1;
  const executor = new PersonalDataToolExecutor({ execute: async (_owner, _tool, _args, ceiling) => {
    assert.equal(ceiling?.historyDays, 2); fence++; return queryResult;
  } }, async () => true, async (_thread, _owner, turn) => {
    assert.equal(turn, "turn");
    return { scopes: ["contacts.read"], historyDays: 2, grantVersion: 1, binding: `inv:${fence}` };
  }, log);
  const result = await executor.execute("owned", directive, "alice", undefined, "turn");
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error, "automation_changed");
  assert.equal(result.payload.data, undefined);
});

test("query results are withheld when thread ownership is lost during the read", async () => {
  let owned = true;
  let began!: () => void;
  let release!: () => void;
  const querying = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const executor = new PersonalDataToolExecutor({ execute: async () => {
    began(); await held; return queryResult;
  } }, async () => owned, async () => undefined, log);
  const pending = executor.execute("owned", directive, "alice");
  await querying;
  owned = false;
  release();
  const result = await pending;
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error, "not_found");
  assert.equal(result.payload.data, undefined);
  assert.equal(result.payload.permission, undefined);
  assert.doesNotMatch(JSON.stringify(result), /contact-1/);
});

test("cancellation during final ownership validation withholds queried data", async () => {
  const controller = new AbortController();
  let checks = 0;
  const executor = new PersonalDataToolExecutor({ execute: async () => queryResult }, async () => {
    if (++checks === 2) controller.abort();
    return true;
  }, async () => undefined, log);
  await assert.rejects(executor.execute("owned", directive, "alice", controller.signal), { name: "AbortError" });
  assert.equal(checks, 2);
});


test("exact contact lookup survives model extraction and stored transcript replay", () => {
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const input = { contact_id: "contact", revision_id: "revision" };
  const calls = runner.extractToolCalls({ id: "r", content: [], stopReason: "tool_use",
    toolCalls: [{ name: "contacts_get", id: "exact", input }] });
  assert.equal(calls.length, 1);
  assert.deepEqual(buildToolArgs(calls[0]), input);
  const loader = new AgentConversationLoader();
  const parse = Reflect.get(loader, "parseStoredToolDirective").bind(loader);
  assert.deepEqual(parse(JSON.stringify({ tool: "contacts_get", call_id: "exact", args: input })), calls[0]);
});

test("every data tool call for an owned thread is in the access log, and a read that can't be logged isn't delivered", async () => {
  logged.length = 0;
  const call = (tool: PersonalDataToolCallDirective["tool"], args: Record<string, unknown> = {}): PersonalDataToolCallDirective =>
    ({ type: "tool_call", tool, args, callId: "call" });
  const executor = new PersonalDataToolExecutor({ execute: async () => queryResult }, async thread => thread === "owned",
    async (_thread, _owner, turn) => turn === "automated"
      ? { scopes: ["contacts.read"], historyDays: 2, grantVersion: 1, binding: "run", automationId: "auto-1" } : undefined, log);
  // A person's turn: the conversation is the actor. Counts and the policy version, never the result.
  await executor.execute("owned", directive, "alice", undefined, "turn-1");
  assert.deepEqual([...logged], [{ owner: "alice", actor: { kind: "agent", ref: "owned", threadId: "owned", turnId: "turn-1" }, sources: ["contacts"],
    operation: "contacts_search", window: undefined, recordCount: 1, policyVersion: 1 }]);
  assert.doesNotMatch(JSON.stringify(logged), /Ada|contact-1/);
  // An automation's run: the automation is the actor, in the same conversation.
  await executor.execute("owned", call("health_workouts", { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" }), "alice", undefined, "automated");
  assert.deepEqual([logged[1].actor, logged[1].sources, logged[1].window], [{ kind: "automation", ref: "auto-1", threadId: "owned", turnId: "automated" },
    ["health"], { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") }]);
  // A tool that reads two sources is logged against both.
  await executor.execute("owned", call("location_context", { contact_id: "c" }), "alice", undefined, "turn-1");
  assert.deepEqual(logged[2].sources, ["location", "contacts"]);
  // A lookup that sends a location to Geoapify also logs the processor, for the same conversation.
  await executor.execute("owned", call("places_nearby"), "alice", undefined, "turn-1");
  assert.deepEqual(logged.slice(3).map(entry => [entry.actor.kind, entry.actor.ref, entry.actor.threadId, entry.operation]),
    [["agent", "owned", "owned", "places_nearby"], ["processor", "geoapify", "owned", "nearby_search"]]);
  // Someone else's thread isn't a read of this owner's data: nothing is logged.
  await executor.execute("foreign", directive, "alice", undefined, "turn-1");
  assert.equal(logged.length, 5);
  // A refusal is logged with its reason.
  const off = new PersonalDataToolExecutor({ execute: async () => {
    throw new DataRequestError(403, "source_off", "Location is turned off in Data sources.", false, 0, { source: "location" }); } },
    async () => true, async () => undefined, log);
  await off.execute("owned", call("location_recent"), "alice", undefined, "turn-1");
  assert.deepEqual([logged[5].operation, logged[5].sources, logged[5].outcome, logged[5].recordCount], ["location_recent", ["location"], "source_off", undefined]);

  // The log can't be written: the result is withheld and reported as a retryable failure.
  const unlogged = new PersonalDataToolExecutor({ execute: async () => queryResult }, async () => true, async () => undefined,
    { record: async () => { throw new Error("log unavailable"); }, recordQuietly: async () => {} });
  const withheld = await unlogged.execute("owned", directive, "alice", undefined, "turn-1");
  assert.deepEqual([withheld.result.ok, withheld.result.retryable, withheld.payload.error, withheld.payload.data], [false, true, "data_query_failed", undefined]);
});
