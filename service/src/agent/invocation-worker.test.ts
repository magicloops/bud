import { InvalidModelSelectionError } from "../llm/reasoning-policy.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { InvocationWorker } from "./invocation-worker.js";
import { InvocationError, type Invocation } from "./invocation-repository.js";
import type { AgentExecutionHooks } from "./execution-lifecycle.js";

const invocation = { id: "inv", threadId: "thread", createdByUserId: "owner", fence: 1, workerId: "worker" } as Invocation;
const directive = { type: "tool_call", tool: "contacts_search", callId: "call", args: {} } as const;
function repository(events: string[]) {
  return {
    recoverExpired: async () => { events.push("recover"); return 0; },
    expireQueued: async () => { events.push("expire"); return 0; },
    claim: async () => { events.push("claim"); return invocation; },
    heartbeat: async () => { events.push("fence"); },
    start: async () => { events.push("running"); },
    defer: async (_row: unknown, status: string) => { events.push(status); },
    recordAction: async () => { events.push("intent"); return {} as never; },
    parkQuestion: async () => { events.push("park"); },
    parkAppDataRequest: async () => { events.push("park_permission"); return { request_id: "request" } as never; },
    parkAutomationProposal: async () => { events.push("park_automation"); return { proposal_id: "proposal" } as never; },
    parkBootstrapProposal: async () => { events.push("park_bootstrap"); return { kind: "proposal", proposal: { proposal_id: "bp-proposal" } } as never; },
    prepareQuestionContinuation: async () => { events.push("restore"); return []; },
    completeAction: async (_row: unknown, _call: string, evidence: unknown) => { events.push("evidence"); assert.doesNotMatch(JSON.stringify(evidence), /private contact/); },
    finish: async (_row: unknown, status: string) => { events.push(status); },
  };
}

test("invocation worker fences dispatch and stores evidence before completion", async () => {
  const events: string[] = [];
  const worker = new InvocationWorker({
    preflight: async () => "ready",
    execute: async (_row, signal, hooks) => {
      assert.equal(signal.aborted, false);
      await hooks.checkpoint();
      await hooks.beforeTool(directive);
      events.push("dispatch");
      await hooks.afterTool(directive, { result: { kind: "personal_data" }, payload: { private: "private contact" } } as never, "message-id");
      return { status: "succeeded" };
    },
  }, repository(events));
  assert.equal(await worker.runOnce(), true);
  assert.ok(events.indexOf("intent") < events.indexOf("dispatch"));
  assert.ok(events.indexOf("dispatch") < events.indexOf("evidence"));
  assert.ok(events.indexOf("evidence") < events.indexOf("succeeded"));
});

test("unavailable selected model releases lease without execution or fallback", async () => {
  const events: string[] = [];
  const worker = new InvocationWorker({ preflight: async () => "waiting_for_model", execute: async () => { throw new Error("must not execute"); } }, repository(events));
  await worker.runOnce();
  assert.ok(events.includes("waiting_for_model"));
  assert.ok(!events.includes("running"));
  assert.ok(!events.includes("failed"));
});

test("lease loss aborts executor and prevents later dispatch", async () => {
  const events: string[] = [];
  const repo = repository(events);
  let owned = true;
  repo.heartbeat = async () => { if (!owned) throw new Error("lease_lost"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, signal, hooks: AgentExecutionHooks) => {
    owned = false;
    await assert.rejects(hooks.beforeTool(directive), /lease_lost/);
    assert.equal(signal.aborted, true);
    await assert.rejects(hooks.checkpoint(), /lease_lost/);
    throw new Error("lease_lost");
  } }, repo);
  await worker.runOnce();
  assert.ok(!events.includes("intent"));
  assert.ok(events.includes("needs_review"));
});

test("shutdown racing with claim does not launch newly claimed work", async () => {
  const events: string[] = [];
  const repo = repository(events);
  let release!: (row: Invocation) => void;
  let claimed!: () => void;
  const claimStarted = new Promise<void>(resolve => { claimed = resolve; });
  repo.claim = async () => { claimed(); return new Promise<Invocation>(resolve => { release = resolve; }); };
  const worker = new InvocationWorker({ preflight: async () => { throw new Error("must not preflight"); }, execute: async () => { throw new Error("must not execute"); } }, repo);
  const running = worker.runOnce();
  await claimStarted;
  await worker.stop();
  release(invocation);
  assert.equal(await running, true);
  assert.ok(!events.includes("running"));
  assert.ok(!events.includes("failed"));
});

test("a parked question releases the worker without completing or renewing its invocation", async () => {
  const events: string[] = [];
  const repo = repository(events);
  repo.heartbeat = async () => { assert.ok(!events.includes("park")); events.push("fence"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, _signal, hooks) => {
    const question = { ...directive, tool: "ask_user_questions", request: {} } as never;
    await hooks.beforeTool(question);
    assert.ok(hooks.parkQuestion);
    await hooks.parkQuestion(question, "question-id");
    return { status: "waiting_for_user" };
  } }, repo);
  await worker.runOnce();
  assert.equal(events.at(-1), "park");
  assert.ok(!events.includes("succeeded"));
  assert.ok(!events.includes("failed"));
});


test("pause winning after preflight defers without execution or failure", async () => {
  const events: string[] = [];
  const repo = repository(events);
  repo.start = async () => { throw new InvocationError("automation_paused"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async () => {
    events.push("executed"); return { status: "succeeded" };
  } }, repo);
  await worker.runOnce();
  assert.equal(events.at(-1), "retry_wait");
  assert.ok(!events.includes("executed"));
  assert.ok(!events.includes("failed"));
});

test("a parked app permission releases execution without renewing or completing", async () => {
  const events: string[] = [];
  const repo = repository(events);
  repo.heartbeat = async () => { assert.ok(!events.includes("park_permission")); events.push("fence"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, _signal, hooks) => {
    assert.ok(hooks.parkAppDataRequest);
    const request = await hooks.parkAppDataRequest("call", "client", {});
    assert.equal(request.request_id, "request");
    return { status: "waiting_for_user" };
  } }, repo);
  await worker.runOnce();
  assert.equal(events.at(-1), "park_permission");
  assert.ok(!events.includes("succeeded"));
  assert.ok(!events.includes("failed"));
});

test("a parked automation review releases execution without renewing or completing", async () => {
  const events: string[] = [];
  const repo = repository(events);
  repo.heartbeat = async () => { assert.ok(!events.includes("park_automation")); events.push("fence"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, _signal, hooks) => {
    assert.ok(hooks.parkAutomationProposal);
    const proposal = await hooks.parkAutomationProposal("call", "client", {});
    assert.equal(proposal.proposal_id, "proposal");
    return { status: "waiting_for_user" };
  } }, repo);
  await worker.runOnce();
  assert.equal(events.at(-1), "park_automation");
  assert.ok(!events.includes("succeeded"));
  assert.ok(!events.includes("failed"));
});

test("parked existing-contact review releases execution and binds the invocation context", async () => {
  const events: string[] = [];
  const repo = repository(events);
  let observed: unknown;
  const park = repo.parkBootstrapProposal;
  const boundRepo = { ...repo, parkBootstrapProposal: async (...args: unknown[]) => { observed = args; return park(); } };
  boundRepo.heartbeat = async () => { assert.ok(!events.includes("park_bootstrap")); events.push("fence"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, _signal, hooks) => {
    const result = await hooks.parkBootstrapProposal!("call", "client", { automation_id: "rule" });
    assert.equal(result.kind, "proposal");
    return { status: "waiting_for_user" };
  } }, boundRepo);
  await worker.runOnce();
  assert.deepEqual(observed, [invocation, "call", "client", { automation_id: "rule" }]);
  assert.equal(events.at(-1), "park_bootstrap");
  assert.ok(!events.includes("failed"));
  assert.ok(!events.includes("succeeded"));
});

for (const outcome of ["no_work", "validation_error"] as const) {
  test(`existing-contact ${outcome} retains renewal and ordinary completion`, async t => {
    const { DataRequestError } = await import("../personal-data/contracts.js");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const repo = repository(events);
    repo.parkBootstrapProposal = async () => {
      events.push(outcome);
      if (outcome === "validation_error") throw new DataRequestError(409, "bootstrap_review_stale", "Review again");
      return { kind: "no_work", member_count: 0, automation_id: "rule" } as never;
    };
    const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, signal, hooks) => {
      if (outcome === "no_work") assert.equal((await hooks.parkBootstrapProposal!("call", "client", {})).kind, "no_work");
      else await assert.rejects(hooks.parkBootstrapProposal!("call", "client", {}), DataRequestError);
      assert.equal(signal.aborted, false);
      const renewals = events.filter(event => event === "fence").length;
      t.mock.timers.tick(15_000);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(events.filter(event => event === "fence").length, renewals + 1);
      await hooks.afterTool(directive, { result: { kind: "automation" } } as never, "ordinary-result");
      return { status: "succeeded" };
    } }, repo);
    await worker.runOnce();
    assert.ok(events.indexOf("evidence") > events.indexOf(outcome));
    assert.equal(events.at(-1), "succeeded");
  });
}

test("automation execution hooks bind the current lease and choose read versus mutation", async () => {
  const events: string[] = [];
  const observed: unknown[] = [];
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, _signal, hooks) => {
    assert.ok(hooks.executeAutomationTool);
    await hooks.executeAutomationTool("automations_list", "read-call", {});
    await hooks.executeAutomationTool("automations_create_draft", "write-call", { name: "Draft", instruction: "Read evidence" });
    return { status: "succeeded" };
  } }, repository(events), () => {}, 4, {
    read: async (context, name, input) => { observed.push(["read", context, name, input]); return {}; },
    mutate: async (context, name, input) => { observed.push(["mutate", context, name, input]); return {}; },
  });
  await worker.runOnce();
  assert.deepEqual(observed, [
    ["read", { owner: "owner", invocationId: "inv", workerId: "worker", fence: 1, callId: "read-call" }, "automations_list", {}],
    ["mutate", { owner: "owner", invocationId: "inv", workerId: "worker", fence: 1, callId: "write-call" }, "automations_create_draft", { name: "Draft", instruction: "Read evidence" }],
  ]);
});

test("rejected automation parking retains a usable lease for the error result and later tools", async t => {
  const { DataRequestError } = await import('../personal-data/contracts.js');
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const repo = repository(events);
  repo.parkAutomationProposal = async () => { events.push("rejected"); throw new DataRequestError(409, "automation_proposal_conflict", "Reload draft"); };
  const worker = new InvocationWorker({ preflight: async () => "ready", execute: async (_row, signal, hooks) => {
    await assert.rejects(hooks.parkAutomationProposal!("call", "client", {}), DataRequestError);
    assert.equal(signal.aborted, false);
    const renewals = events.filter(event => event === "fence").length;
    t.mock.timers.tick(15_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(events.filter(event => event === "fence").length, renewals + 1);
    await hooks.checkpoint();
    await hooks.afterTool(directive, { result: { kind: "automation" } } as never, "error-result");
    return { status: "succeeded" };
  } }, repo);
  await worker.runOnce();
  assert.ok(events.indexOf("evidence") > events.indexOf("rejected"));
  assert.equal(events.at(-1), "succeeded");
});


test("unavailable model records an actionable failure before running", async () => {
  const events: string[] = [];
  let outcome: string | undefined;
  const repo = { ...repository(events), finish: async (_row: unknown, status: string, code?: string) => {
    events.push(status); outcome = code;
  } };
  await new InvocationWorker({
    preflight: async () => { throw new InvalidModelSelectionError("gpt-5.5"); },
    execute: async () => { throw new Error("must not execute"); },
  }, repo).runOnce();
  assert.equal(outcome, "invalid_model");
  assert.ok(!events.includes("running"));
});
