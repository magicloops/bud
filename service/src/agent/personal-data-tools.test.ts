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
const directive: PersonalDataToolCallDirective = { type: "tool_call", tool: "contacts_search", args: { search: "Ada" }, callId: "call-1" };
const queryResult: Awaited<ReturnType<AgentDataQueries["execute"]>> = {
  data: { items: [{ id: "contact-1" }], next_cursor: null },
  permission: { version: 1, contact_fields: ["names", "organization", "phones", "emails"], history_days: 30, observed_since: "2026-08-05T00:00:00Z" },
  interpretation: "Untrusted observed data",
};

test("personal-data tools remain available offline and normalize optional null arguments", () => {
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false, lastSeenAt: null });
  const names = resolveAgentToolsForEnvironment(environment).map(t => t.name);
  for (const name of ["contacts_search", "contacts_history", "location_context", "timeline_query"]) assert.ok(names.includes(name));
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
    async (thread, owner) => thread === "owned" && owner === "alice");
  assert.equal((await executor.execute("foreign", directive, "alice")).result.ok, false);
  assert.equal((await executor.execute("owned", directive, "bob")).result.ok, false);
  assert.equal(queries, 0);
  assert.deepEqual((await executor.execute("owned", directive, "alice")).payload.data, queryResult.data);
  assert.equal(queries, 1);
  const denied = new PersonalDataToolExecutor({ execute: async () => { throw new DataRequestError(403, "data_permission_required", "Approve data access"); } }, async () => true);
  const result = await denied.execute("owned", directive, "alice");
  assert.equal(result.payload.permission_settings_path, "/data");
  assert.equal(result.payload.approval_required, true);
  const failed = new PersonalDataToolExecutor({ execute: async () => { throw new Error("secret SQL parameters"); } }, async () => true);
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
  Reflect.set(service, "personalDataToolExecutor", new PersonalDataToolExecutor({ execute: async owner => { assert.equal(owner, "alice"); return queryResult; } }, async (thread, owner) => thread === "thread" && owner === "alice", async () => undefined));
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
  });
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
  } }, async () => owned, async () => undefined);
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
  }, async () => undefined);
  await assert.rejects(executor.execute("owned", directive, "alice", controller.signal), { name: "AbortError" });
  assert.equal(checks, 2);
});
