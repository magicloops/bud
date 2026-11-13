import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { db } from "../db/client.js";
import { AgentService } from "./agent-service.js";
import { AgentModelRunner } from "./model-runner.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { serializeGoogleApproval, type GoogleApprovalProposal } from "../google/approvals.js";

for (const scenario of ["parked", "park_failed", "missing_hook"] as const) {
test(`Google review ${scenario}: internal proposal never escapes or dispatches trailing calls`, async t => {
  t.after(() => mock.restoreAll());
  mock.method(db, "insert", () => ({ values: (value: unknown) => {
    assert.doesNotMatch(JSON.stringify(value), /private-subject|private-grant|private-operation/);
    return {};
  } }) as never);
  mock.method(db, "transaction", async (work: (tx: unknown) => Promise<unknown>) => work({ insert: db.insert.bind(db) }));
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: false });
  const input = { connection_id: "connection", tool_name: "calendar_create_event", arguments_json: '{"summary":"Reviewed event"}' };
  const proposal: GoogleApprovalProposal = { ...input, service: "calendar", operation_id: "private-operation",
    account_subject: "private-subject", account_email: "owner@example.test", grant_id: "private-grant" };
  const approval = serializeGoogleApproval({ ...proposal, approval_id: "approval", thread_id: "thread",
    invocation_id: "invocation", status: "pending", created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString() });
  const events: string[] = [];
  let clientId: string | undefined;
  const runtime = {
    markThinking() {}, setEnvironment() {}, setPendingTool() {},
    finishTurn() { assert.notEqual(scenario, "parked"); events.push("failed_finished"); },
    setLastError(_thread: string, value: unknown) {
      assert.notEqual(scenario, "parked");
      assert.doesNotMatch(JSON.stringify(value), /private-subject|private-grant|private-operation/);
    },
    emit(_thread: string, event: { event: string; data: { args: Record<string, unknown>; client_id: string; name: string } }) {
      assert.doesNotMatch(JSON.stringify(event.data), /private-subject|private-grant|private-operation/);
      if (event.event === "final") {
        assert.notEqual(scenario, "parked"); events.push("failed_final"); return "cursor";
      }
      assert.equal(event.event, "agent.tool_call");
      assert.equal(event.data.name, "google_call");
      assert.doesNotMatch(JSON.stringify(event.data), /private-subject|private-grant|private-operation/);
      if (event.data.args.google_approval) {
        assert.equal(events.at(-1), "parked");
        assert.deepEqual(event.data.args.google_approval, approval);
        assert.equal(event.data.client_id, clientId);
        events.push("review_emitted");
      } else { clientId = event.data.client_id; events.push("call_emitted"); }
      return "cursor";
    },
    setPendingUserQuestions(_thread: string, pending: { args: Record<string, unknown> }) {
      assert.deepEqual(pending.args.google_approval, approval); events.push("waiting");
    },
  };
  const service = new AgentService({} as never, runtime as never,
    { info() {}, warn() {}, error() {} } as never, false, false);
  Reflect.set(service, "getEnvironmentForThread", async () => environment);
  Reflect.set(service, "getContextTools", async () => []);
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  Reflect.set(service, "googleToolExecutor", { execute: async () => {
    events.push("checked_policy"); return { payload: { google_approval_proposal: proposal } };
  } });
  const runner = Reflect.get(service, "modelRunner") as AgentModelRunner;
  mock.method(runner, "resolveProviderName", () => "openai");
  mock.method(runner, "invokeModel", async () => {
    assert.ok(!events.includes("parked"));
    const calls = [{ id: "call", name: "google_call", input }, { id: "later", name: "google_call", input }];
    return { response: { id: "response", stopReason: "tool_use", content: calls.map(call => ({ type: "tool_use", ...call })),
      toolCalls: calls }, assistantClientId: null, reasoningSegments: [], assistantTiming: null } as never;
  });
  const run = () => Reflect.get(service, "runAgentFlow").call(service, {
    threadId: "thread", turnId: "turn", sessionId: null, model: "fixture",
    modelReasoning: { providerModel: "fixture", reasoningLevel: "low" }, modelSelection: {}, environment,
    ownerUserId: "owner", controller: new AbortController(), executionHooks: {
      checkpoint: async () => { assert.ok(!events.includes("parked")); },
      beforeTool: async (directive: { callId: string }) => { assert.equal(directive.callId, "call"); events.push("intent"); },
      ...(scenario === "missing_hook" ? {} : { parkGoogleApproval: async (callId: string, actualClientId: string, value: unknown) => {
        assert.equal(callId, "call"); assert.equal(actualClientId, clientId); assert.deepEqual(value, proposal);
        if (scenario === "park_failed") { events.push("park_failed"); throw new Error("stale_invocation_lease"); }
        events.push("parked"); return approval;
      } }),
      afterTool: async () => assert.fail("approval wait must not complete the tool"),
    },
  });
  if (scenario === "parked") {
    assert.deepEqual(await run(), { status: "waiting_for_user" });
    assert.deepEqual(events, ["call_emitted", "intent", "checked_policy", "parked", "review_emitted", "waiting"]);
  } else {
    await assert.rejects(run, scenario === "park_failed" ? /stale_invocation_lease/ : /google_approval_unavailable/);
    assert.deepEqual(events, ["call_emitted", "intent", "checked_policy", ...(scenario === "park_failed" ? ["park_failed"] : []), "failed_final", "failed_finished"]);
  }
});
}
