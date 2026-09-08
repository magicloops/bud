import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { db } from "../db/client.js";
import { AgentService } from "./agent-service.js";
import { AgentModelRunner } from "./model-runner.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import type { CanonicalTool } from "../llm/index.js";
const logger = { info() {}, warn() {}, error() {} };
const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false });
const input = { automation_id: "rule", expected_version: 0 };
const call = { id: "proposal-call", name: "automations_request_activation", input };

test("agent parks automation review after intent and emits only committed public metadata", async t => {
  t.after(() => mock.restoreAll());
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const events: string[] = [];
  const publicProposal = { proposal_id: "ap_proposal", status: "pending", version: 0, definition: { name: "Contacts" } };
  const runtime = {
    markThinking() {}, setEnvironment() {},
    finishTurn() { events.push("finished"); },
    emit(_thread: string, event: { event: string; data: Record<string, unknown> }) {
      assert.equal(event.event, "agent.tool_call");
      assert.deepEqual(event.data.args, publicProposal);
      assert.ok(events.includes("parked"));
      events.push("emitted"); return "cursor";
    },
    setPendingUserQuestions(_thread: string, pending: { args: unknown }) {
      assert.deepEqual(pending.args, publicProposal); events.push("waiting");
    },
  };
  const service = new AgentService({} as never, runtime as never, logger as never, false, false, undefined, false, true);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async (...args: unknown[]) => {
    assert.ok((args[6] as CanonicalTool[]).some(tool => tool.name === call.name));
    events.push("provider");
    const calls = [call, { id: "later", name: "contacts_search", input: {} }];
    return { response: { id: "response", stopReason: "tool_use" as const,
      content: calls.map(tool => ({ type: "tool_use" as const, ...tool })), toolCalls: calls },
      assistantClientId: null, provider: "openai" as const, providerModel: "fixture", reasoningSegments: [], assistantTiming: null };
  });
  const result = await Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
    modelReasoning: { providerModel: "fixture", reasoningLevel: "low" }, modelSelection: {}, environment,
    ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => { assert.ok(!events.includes("parked")); },
      beforeTool: async (directive: { tool: string }) => { assert.equal(directive.tool, call.name); events.push("intent"); },
      parkAutomationProposal: async (callId: string, clientId: string, proposal: unknown) => {
        assert.equal(callId, call.id); assert.match(clientId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(proposal, input); assert.equal(events.at(-1), "intent");
        events.push("parked"); return publicProposal;
      },
      executeAutomationTool: async () => { assert.fail("must not execute trailing calls"); },
      afterTool: async () => { assert.fail("must not finish an unanswered tool"); },
    },
  });
  assert.deepEqual(result, { status: "waiting_for_user" });
  assert.deepEqual(events, ["provider", "intent", "parked", "emitted", "waiting"]);
});

test("rejected activation records one tool error and the model can continue with a corrected draft", async t => {
  t.after(() => mock.restoreAll());
  const { DataRequestError } = await import('../personal-data/contracts.js');
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const service = new AgentService({} as never, { markThinking() {}, setEnvironment() {}, finishTurn() {}, emit() {} } as never,
    logger as never, false, false, undefined, false, true);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const results: Record<string, unknown>[] = [];
  Reflect.set(service, "transcriptWriter", {
    emitToolCall: () => ({ clientArgs: {} }),
    emitAutomationProposal: () => assert.fail("rejected request must not emit a proposal"),
    recordToolResult: async ({ execution, clientId }: { execution: { payload: Record<string, unknown> }; clientId: string }) => {
      results.push(execution.payload);
      return { payload: execution.payload, message: { message_id: clientId } };
    },
    recordFinalAssistant: async () => {},
  });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  let step = 0;
  const draftCall = { id: "correct-draft", name: "automations_create_draft", input: { name: "Contact note", instruction: "Read evidence" } };
  mock.method(runner, "invokeModel", async () => {
    const tool = [call, draftCall][step++];
    if (step === 2) assert.equal(results[0].error, "automation_proposal_conflict");
    return { response: { id: `response-${step}`, stopReason: tool ? "tool_use" : "end_turn",
      content: tool ? [{ type: "tool_use", ...tool }] : [{ type: "text", text: "Prepared a corrected draft." }],
      toolCalls: tool ? [tool] : [] }, assistantClientId: null, provider: "openai", providerModel: "fixture", reasoningSegments: [], assistantTiming: null } as never;
  });
  const intents: string[] = [], completed: string[] = [];
  const outcome = await Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture", modelReasoning: { providerModel: "fixture", reasoningLevel: "low" },
    modelSelection: {}, environment, ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => {},
      beforeTool: async (directive: { callId: string }) => { intents.push(directive.callId); },
      parkAutomationProposal: async () => { throw new DataRequestError(409, "automation_proposal_conflict", "Reload the draft"); },
      executeAutomationTool: async (name: string) => { assert.equal(name, draftCall.name); return { automation_id: "corrected" }; },
      afterTool: async (directive: { callId: string }) => { completed.push(directive.callId); },
    },
  });
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(intents, [call.id, draftCall.id]);
  assert.deepEqual(completed, intents);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].automation_id, "corrected");
});

test("agent parks existing-contact review before emitting and never executes trailing calls", async t => {
  const input = { automation_id: "rule", expected_version: 0, sources: { source_ids: [] }, search: "", max_contacts: 50, mode: "batched", exclude_previously_delivered: true };
  const call = { id: "bootstrap-call", name: "automations_request_existing_contacts", input };
  t.after(() => mock.restoreAll());
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const events: string[] = [];
  const publicProposal = { proposal_id: "bp_proposal", status: "pending", version: 0, definition: { name: "Contacts" } };
  const runtime = {
    markThinking() {}, setEnvironment() {},
    finishTurn() { events.push("finished"); },
    emit(_thread: string, event: { event: string; data: Record<string, unknown> }) {
      assert.equal(event.event, "agent.tool_call");
      assert.deepEqual(event.data.args, publicProposal);
      assert.ok(events.includes("parked"));
      events.push("emitted"); return "cursor";
    },
    setPendingUserQuestions(_thread: string, pending: { args: unknown }) {
      assert.deepEqual(pending.args, publicProposal); events.push("waiting");
    },
  };
  const service = new AgentService({} as never, runtime as never, logger as never, false, false, undefined, false, true, true);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async (...args: unknown[]) => {
    assert.ok((args[6] as CanonicalTool[]).some(tool => tool.name === call.name));
    events.push("provider");
    const calls = [call, { id: "later", name: "contacts_search", input: {} }];
    return { response: { id: "response", stopReason: "tool_use" as const,
      content: calls.map(tool => ({ type: "tool_use" as const, ...tool })), toolCalls: calls },
      assistantClientId: null, provider: "openai" as const, providerModel: "fixture", reasoningSegments: [], assistantTiming: null };
  });
  const result = await Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
    modelReasoning: { providerModel: "fixture", reasoningLevel: "low" }, modelSelection: {}, environment,
    ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => { assert.ok(!events.includes("parked")); },
      beforeTool: async (directive: { tool: string }) => { assert.equal(directive.tool, call.name); events.push("intent"); },
      parkAutomationProposal: async () => assert.fail("must not request activation"),
      parkBootstrapProposal: async (callId: string, clientId: string, proposal: unknown) => {
        assert.equal(callId, call.id); assert.match(clientId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(proposal, input); assert.equal(events.at(-1), "intent");
        events.push("parked"); return { kind: "proposal", proposal: publicProposal };
      },
      executeAutomationTool: async () => { assert.fail("must not execute trailing calls"); },
      afterTool: async () => { assert.fail("must not finish an unanswered tool"); },
    },
  });
  assert.deepEqual(result, { status: "waiting_for_user" });
  assert.deepEqual(events, ["provider", "intent", "parked", "emitted", "waiting"]);
});

for (const outcome of ["no_work", "invalid"] as const) test(`existing-contact ${outcome} completes one tool result and continues`, async t => {
  t.after(() => mock.restoreAll());
  const { DataRequestError } = await import("../personal-data/contracts.js");
  mock.method(db, "insert", () => ({ values: () => ({}) }) as never);
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({ insert: db.insert.bind(db) }));
  const input = { automation_id: "rule", expected_version: 0, sources: { source_ids: [] }, search: "", max_contacts: 50, mode: "batched", exclude_previously_delivered: true };
  const call = { id: "bootstrap", name: "automations_request_existing_contacts", input };
  const service = new AgentService({} as never, { markThinking() {}, setEnvironment() {}, finishTurn() {}, emit() {} } as never,
    logger as never, false, false, undefined, false, true, true);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const results: Record<string, unknown>[] = [];
  Reflect.set(service, "transcriptWriter", {
    emitToolCall: () => ({ clientArgs: {} }),
    emitBootstrapProposal: () => assert.fail("must not emit a pending review"),
    recordToolResult: async ({ execution, clientId }: { execution: { payload: Record<string, unknown> }; clientId: string }) => {
      results.push(execution.payload);
      return { payload: execution.payload, message: { message_id: clientId } };
    },
    recordFinalAssistant: async () => {},
  });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  let step = 0, intents = 0, completions = 0;
  mock.method(runner, "invokeModel", async () => {
    const first = step++ === 0;
    if (!first) assert.equal(results.length, 1);
    return { response: { id: `response-${step}`, stopReason: first ? "tool_use" : "end_turn",
      content: first ? [{ type: "tool_use", ...call }] : [{ type: "text", text: "No work scheduled." }],
      toolCalls: first ? [call] : [] }, assistantClientId: null, provider: "openai", providerModel: "fixture", reasoningSegments: [], assistantTiming: null } as never;
  });
  const result = await Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture", modelReasoning: { providerModel: "fixture", reasoningLevel: "low" },
    modelSelection: {}, environment, ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => {}, beforeTool: async () => { intents++; },
      parkAutomationProposal: async () => assert.fail("must not activate"),
      parkBootstrapProposal: async () => {
        if (outcome === "invalid") throw new DataRequestError(409, "bootstrap_review_stale", "Reload the rule");
        return { kind: "no_work", member_count: 0, automation_id: "rule" };
      },
      executeAutomationTool: async () => assert.fail("must not dispatch the selection twice"),
      afterTool: async () => { completions++; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(intents, 1); assert.equal(completions, 1);
  assert.equal(results[0].ok, outcome === "no_work");
  assert.deepEqual(results[0].args, input);
  if (outcome === "no_work") { assert.equal(results[0].outcome, "no_work"); assert.equal(results[0].member_count, 0); }
  else assert.equal(results[0].error, "bootstrap_review_stale");
});
