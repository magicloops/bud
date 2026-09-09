import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceInvocationExecutor } from "./invocation-executor.js";
import type { Invocation } from "./invocation-repository.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import type { AgentExecutionHooks } from "./execution-lifecycle.js";

const invocation = { id: "inv", turnId: "turn", threadId: "thread", budId: "bud", createdByUserId: "owner",
  origin: "automation", model: "gpt-5.6-sol", reasoningEffort: "low" } as Invocation;
const environment = (online: boolean) => buildAgentEnvironmentSnapshot({ budId: "bud", online, lastSeenAt: null });

test("automation waits for its Bud while manual cloud chat remains available offline", async () => {
  const agent = { getEnvironmentForBud: async () => environment(false) } as never;
  const executor = new ServiceInvocationExecutor(agent, async () => ({ capabilities: {} }), () => true, false, undefined, async () => "ready");
  assert.equal(await executor.preflight(invocation), "waiting_for_bud");
  assert.equal(await executor.preflight({ ...invocation, origin: "human" }), "ready");
  const absent = new ServiceInvocationExecutor(agent, async () => null, () => true, false, undefined, async () => "ready");
  await assert.rejects(absent.preflight(invocation), /invocation_authority_lost/);
});

test("preflight preserves exact provider and rejects another Bud's local model", async () => {
  const agent = { getEnvironmentForBud: async () => environment(true) } as never;
  const executor = new ServiceInvocationExecutor(agent, async () => ({ capabilities: {} }), () => false, false, undefined, async () => "ready");
  assert.equal(await executor.preflight(invocation), "waiting_for_model");
  await assert.rejects(executor.preflight({ ...invocation, model: "bud-local:other:llama", reasoningEffort: "none" }), /model_bud_mismatch/);
  assert.equal(await executor.preflight({ ...invocation, model: "bud-local:bud:llama", reasoningEffort: "none" }), "waiting_for_model");
  assert.equal(await executor.preflight({ ...invocation, model: "ds4-deepseek-v4-flash" }), "waiting_for_model");
});

test("executor preserves invocation identity and fences tools if availability changes", async () => {
  let online = true;
  let guarded!: AgentExecutionHooks;
  const agent = {
    getEnvironmentForBud: async () => environment(online),
    startUserMessage: async (thread: string, options: { model: string; reservedTurnId: string; ownerUserId: string; executionHooks: AgentExecutionHooks }) => {
      assert.equal(thread, invocation.threadId);
      assert.equal(options.model, invocation.model);
      assert.equal(options.reservedTurnId, invocation.turnId);
      assert.equal(options.ownerUserId, invocation.createdByUserId);
      guarded = options.executionHooks;
      return { completion: Promise.resolve({ status: "succeeded" }) };
    },
  } as never;
  let dispatched = 0;
  const executor = new ServiceInvocationExecutor(agent, async () => ({ capabilities: {} }), () => true, false, undefined, async () => "ready");
  assert.deepEqual(await executor.execute(invocation, new AbortController().signal, {
    checkpoint: async () => {}, beforeTool: async () => { dispatched++; }, afterTool: async () => {},
  }), { status: "succeeded" });
  online = false;
  await assert.rejects(guarded.beforeTool({ type: "tool_call", tool: "contacts_search", callId: "call", args: {} }), /selected_execution_unavailable/);
  assert.equal(dispatched, 0);
});

test("healthy advertised local models are reconstructed after service restart", async () => {
  const capabilities = { llm: { servers: [{ id: "local", provider: "bud_local", healthy: true,
    request_mode: "openai_chat_completions", generation_path: "/v1/chat/completions",
    compatibility: ["openai_chat_completions"], models: [{ id: "fixture-local", validated: false }] }] } };
  const executor = new ServiceInvocationExecutor({ getEnvironmentForBud: async () => environment(true) } as never,
    async () => ({ capabilities }), provider => provider === "bud_local", false, undefined, async () => "ready");
  assert.equal(await executor.preflight({ ...invocation, model: "bud-local:bud:fixture-local", reasoningEffort: "none" }), "ready");
});

test("lease interruption releases pending waits and removes its listener after completion", async () => {
  const controller = new AbortController();
  let finish!: (value: { status: "canceled" }) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const completion = new Promise<{ status: "canceled" }>(resolve => { finish = resolve; });
  let interrupts = 0;
  const executor = new ServiceInvocationExecutor({
    getEnvironmentForBud: async () => environment(true),
    startUserMessage: async () => { started(); return { completion }; },
  } as never, async () => ({ capabilities: {} }), () => true, false, async threadId => {
    assert.equal(threadId, invocation.threadId);
    interrupts++;
    finish({ status: "canceled" });
  }, async () => "ready");
  const executing = executor.execute(invocation, controller.signal, {
    checkpoint: async () => {}, beforeTool: async () => {}, afterTool: async () => {},
  });
  await entered;
  controller.abort(new Error("lease_lost"));
  assert.deepEqual(await executing, { status: "canceled" });
  assert.equal(interrupts, 1);

  const completedController = new AbortController();
  await executor.execute(invocation, completedController.signal, {
    checkpoint: async () => {}, beforeTool: async () => {}, afterTool: async () => {},
  });
  completedController.abort();
  assert.equal(interrupts, 1, "completed invocation cannot interrupt later thread work");
});

test("automation policy defers paused work and rejects revoked authority before tools", async () => {
  let revoked = false;
  let guarded!: AgentExecutionHooks;
  const agent = {
    getEnvironmentForBud: async () => environment(true),
    startUserMessage: async (_thread: string, options: { executionHooks: AgentExecutionHooks }) => {
      guarded = options.executionHooks;
      return { completion: Promise.resolve({ status: "succeeded" }) };
    },
  } as never;
  const executor = new ServiceInvocationExecutor(agent, async () => ({ capabilities: {} }), () => true, false,
    undefined, async (_invocation, checkPause) => {
      if (revoked) throw new Error("data_permission_changed");
      return checkPause ? "retry_wait" : "ready";
    });
  assert.equal(await executor.preflight(invocation), "retry_wait");
  let dispatched = false;
  await executor.execute(invocation, new AbortController().signal, {
    checkpoint: async () => {}, beforeTool: async () => { dispatched = true; }, afterTool: async () => {},
  });
  revoked = true;
  await assert.rejects(guarded.beforeTool({ type: "tool_call", tool: "contacts_search", callId: "revoked", args: {} }), /data_permission_changed/);
  assert.equal(dispatched, false);
});


test("retired automation model fails explicitly without running or selecting a replacement", async () => {
  const executor = new ServiceInvocationExecutor({ getEnvironmentForBud: async () => environment(true) } as never,
    async () => ({ capabilities: {} }), () => true, false, undefined, async () => "ready");
  await assert.rejects(executor.preflight({ ...invocation, model: "gpt-5.5" }), { code: "invalid_model" });
});
