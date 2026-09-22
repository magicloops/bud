import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_TOOL_NAMES, BROWSER_CANONICAL_TOOLS, parseBrowserInput } from "./browser-tools.js";
import { BrowserToolExecutor, BrowserToolWait, type BrowserAgentBackend, type BrowserAgentContext } from "./browser-tool-executor.js";
import { buildToolArgs, toolNameForConversation, type ExecutedBrowserTool } from "./contracts.js";
import { AgentModelRunner } from "./model-runner.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { AgentService } from "./agent-service.js";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { db } from "../db/client.js";
import { providerRegistry, type CanonicalTool, type CanonicalMessage, type LLMProvider } from "../llm/index.js";
import { OpenAIProvider } from "../llm/providers/openai.js";

const logger = { info() {}, warn() {}, error() {} };
const context: BrowserAgentContext = { threadId: "thread", budId: "bud", ownerUserId: "alice", turnId: "turn", signal: new AbortController().signal };
const call = (tool: ExecutedBrowserTool["directive"]["tool"], args: Record<string, unknown> = {}): ExecutedBrowserTool["directive"] => ({ type: "tool_call", tool, args, callId: tool });
const backend = (overrides: Partial<BrowserAgentBackend> = {}): BrowserAgentBackend => ({
  available: async () => true,
  execute: async () => ({ ok: true, outcome: "completed", data: { fixture: true } }),
  park: async () => ({ handoff_id: "handoff", viewer_path: "/fixture/view" }), ...overrides,
});

test("browser catalog is explicitly composed and excluded offline; all five names replay", () => {
  const online = buildAgentEnvironmentSnapshot({ budId: "bud", online: true });
  assert.equal(resolveAgentToolsForEnvironment(online).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 0);
  assert.equal(resolveAgentToolsForEnvironment(online, { browser: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 4);
  assert.equal(resolveAgentToolsForEnvironment(online, { browser: true, browserHandoff: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 5);
  assert.equal(resolveAgentToolsForEnvironment({ ...online, mode: "bud_offline" }, { browser: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 0);
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const loader = new AgentConversationLoader();
  for (const name of BROWSER_TOOL_NAMES) {
    const input = name === "browser_request_handoff" ? { reason: "Sign in" } : name === "browser_act" ? { action: "click", reference: "1:2" } : {};
    const [directive] = runner.extractToolCalls({ id: "r", content: [], stopReason: "tool_use", toolCalls: [{ id: name, name, input }] });
    assert.equal(toolNameForConversation(directive.tool), name);
    assert.deepEqual(buildToolArgs(directive), input);
    const stored = Reflect.get(loader, "parseStoredToolDirective").call(loader, JSON.stringify({ tool: name, call_id: name, args: input }));
    assert.deepEqual(stored, directive);
  }
  assert.deepEqual(parseBrowserInput("browser_act", { action: "click", reference: "1:2", text: null, target_id: null, url: null }), { action: "click", reference: "1:2" });
  for (const args of [{ action: "evaluate", text: "anything" }, { action: "click", reference: "1", epoch: 2 }, { action: "click", reference: "1", text: "extra" }, { action: "navigate", url: "file:///tmp/private" }]) {
    assert.throws(() => parseBrowserInput("browser_act", args), /browser_invalid_arguments/);
  }
});

test("OpenAI encoding keeps all five strict schemas usable without mutating canonical definitions", async () => {
  const provider = new OpenAIProvider("fixture-key");
  let checked = false;
  Reflect.get(provider, "client").responses.create = async (request: any) => {
    checked = true;
    assert.deepEqual(request.tools.map((tool: any) => tool.name), [...BROWSER_TOOL_NAMES]);
    for (const tool of request.tools) {
      assert.equal(tool.strict, true);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
    }
    const action = request.tools.find((tool: any) => tool.name === "browser_act");
    assert.deepEqual(action.parameters.properties.reference.type, ["string", "null"]);
    return { id: "r", status: "completed", output: [] };
  };
  const original = structuredClone(BROWSER_CANONICAL_TOOLS);
  await provider.invokeSync([{ role: "user", content: "fixture" }], BROWSER_CANONICAL_TOOLS, { model: "gpt-6-astra" });
  assert.ok(checked);
  assert.deepEqual(BROWSER_CANONICAL_TOOLS, original);
});

test("execution withholds unauthorized/late evidence, rejects bad arguments and never recommends retrying unknown actions", async () => {
  let dispatched = 0;
  let owned = true;
  const executor = new BrowserToolExecutor(backend({ execute: async () => { dispatched++; owned = false; return { ok: true, outcome: "completed", data: { private: "not delivered" } }; } }), async c => owned && c.ownerUserId === "alice");
  await assert.rejects(executor.execute({ ...context, ownerUserId: "bob" }, call("browser_observe")), /not_found/);
  assert.equal(dispatched, 0);
  const invalid = await executor.execute(context, call("browser_act", { action: "evaluate" }));
  assert.equal(invalid.payload.error, "browser_invalid_arguments");
  assert.match(JSON.stringify(invalid.payload.data), /focus.*reference/);
  assert.equal(dispatched, 0);
  await assert.rejects(executor.execute(context, call("browser_observe")), /not_found/);
  const unknown = new BrowserToolExecutor(backend({ execute: async () => { throw new Error("sensitive transport contents"); } }), async () => true);
  const result = await unknown.execute(context, call("browser_act", { action: "click", reference: "1:2" }));
  assert.equal(result.payload.outcome, "unknown");
  assert.equal(result.result.retryable, false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive transport/);
  const abort = new AbortController();
  const canceled = new BrowserToolExecutor(backend({ execute: async () => { abort.abort(); return { ok: true, outcome: "completed" }; } }), async () => true);
  await assert.rejects(canceled.execute({ ...context, signal: abort.signal }, call("browser_observe")), { name: "AbortError" });
});

// The real model runner and transcript writer run; only provider networking and
// database I/O are fixtures. This validates boundaries, not durable DB recovery.
async function loopFixture(t: any, browser: BrowserToolExecutor, responses: Array<Array<{ name: string; input: Record<string, unknown> }> | ((messages: CanonicalMessage[]) => Array<{ name: string; input: Record<string, unknown> }>)>, live = false) {
  t.after(() => mock.restoreAll());
  const writes: any[] = [];
  mock.method(db, "execute", async () => [] as never);
  mock.method(db, "insert", () => ({ values: (values: any) => {
    writes.push(values);
    return { returning: async () => [{ ...values, messageId: `message-${writes.length}`, createdAt: new Date() }] };
  } }) as never);
  mock.method(db, "transaction", async (fn: any) => fn({ insert: db.insert.bind(db), execute: db.execute.bind(db), select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) }) }));
  mock.method(db, "update", () => ({ set: () => ({ where: async () => undefined }) }) as never);
  const runtime = new AgentRuntimeStateManager();
  const environment = buildAgentEnvironmentSnapshot({ budId: "bud", online: true });
  const service = new AgentService({} as never, runtime, logger as never, false, false, undefined, false, false, false, browser);
  Reflect.set(service, "refreshEnvironmentForProviderStep", async () => ({ snapshot: environment, sessionId: null }));
  Reflect.set(service, "compactConversationIfNeeded", async () => null);
  Reflect.set(service, "conversationLoader", { loadWithDiagnostics: async () => ({ messages: [], reconstruction: { mode: "canonical_only" } }) });
  const previous = providerRegistry.getProvider("openai");
  providerRegistry.unregister("openai");
  t.after(() => { providerRegistry.unregister("openai"); if (previous) providerRegistry.register(previous); });
  const requests: CanonicalMessage[][] = [];
  const liveModel = process.env.BUD_BROWSER_LIVE_MODEL ?? "gpt-5.6-luna";
  if (live) assert.ok(process.env.OPENAI_API_KEY, "live test requires OPENAI_API_KEY");
  const remote = live ? new OpenAIProvider(process.env.OPENAI_API_KEY!, { timeout: 30000 }) : null;
  const provider: LLMProvider = {
    name: "openai", supportedModels: ["browser-fixture"], supportsModel: () => true,
    getModelCapabilities: () => ({ supportsVision: false, supportsTools: true, supportsReasoning: false, maxContextTokens: 100000, maxOutputTokens: 1000 }) as never,
    async *invoke(messages, tools: CanonicalTool[], _config, signal) {
      requests.push(structuredClone(messages));
      assert.ok([0, browser.handoffAvailable ? 5 : 4].includes(tools.filter(tool => BROWSER_TOOL_NAMES.includes(tool.name as never)).length));
      if (remote) {
        assert.ok(requests.length <= 18, "live fixture exceeded provider-call budget");
        yield* remote.invoke(messages, tools.filter(tool => BROWSER_TOOL_NAMES.includes(tool.name as never)),
          { model: liveModel, maxOutputTokens: 2000, reasoning: { enabled: true, effort: "low" } },
          AbortSignal.any([t.signal, ...(signal ? [signal] : [])]));
        return;
      }
      yield { type: "message_start", id: `response-${requests.length}` };
      const next = responses[requests.length - 1];
      assert.ok(next, "unexpected extra model step");
      const calls = typeof next === "function" ? next(messages) : next;
      if (calls.length === 0) {
        yield { type: "content_start", index: 0, content_type: "text" };
        yield { type: "text_delta", index: 0, delta: "Fixture completed." };
        yield { type: "content_done", index: 0 };
        yield { type: "message_done", stop_reason: "end_turn" };
        return;
      }
      for (const [index, call] of calls.entries()) yield { type: "tool_use_done", index, id: `call-${requests.length}-${index}`, ...call };
      yield { type: "message_done", stop_reason: "tool_use" };
    },
  };
  providerRegistry.register(provider);
  const events: any[] = [];
  runtime.attachCallback("thread", event => events.push(event));
  runtime.startTurn("thread", "turn", environment);
  const run = (browserWaitParked?: () => void) => Reflect.get(service, "runAgentFlow").call(service, { ...context, sessionId: null,
    model: "browser-fixture", modelReasoning: { providerModel: "browser-fixture", reasoningLevel: "none", reasoning: { enabled: false } },
    modelSelection: { model: "browser-fixture", reasoningEffort: "none", source: "explicit_request" },
    environment, controller: new AbortController(), executionHooks: {
      browserWaitParked, checkpoint: async () => {}, beforeTool: async () => {}, afterTool: async () => {},
    } });
  const reload = (messages: CanonicalMessage[]) => Reflect.set(service, "conversationLoader", {
    loadWithDiagnostics: async () => ({ messages: structuredClone(messages), reconstruction: { mode: "canonical_only" } }),
  });
  return { run, requests, writes, events, runtime, reload };
}

test("canonical agent loop records results and parks before trailing calls or another model step", async t => {
  const applied: string[] = [];
  let parked: any;
  const executor = new BrowserToolExecutor(backend({
    execute: async (_context, name) => { applied.push(name); return { ok: true, outcome: "completed", data: { observed: "fixture page" } }; },
    park: async args => { parked = args; return { handoff_id: "handoff", viewer_path: "/fixture/view" }; },
  }), async c => c.threadId === "thread" && c.budId === "bud" && c.ownerUserId === "alice");
  const fixture = await loopFixture(t, executor, [[{ name: "browser_open", input: {} }, { name: "browser_observe", input: {} }],
    [{ name: "browser_request_handoff", input: { reason: "Enter the test OTP" } }, { name: "browser_close", input: {} }]]);
  assert.equal((await fixture.run()).status, "waiting_for_user");
  assert.deepEqual(applied, ["browser_open", "browser_observe"]);
  assert.equal(fixture.requests.length, 2);
  assert.match(JSON.stringify(fixture.requests[1]), /fixture page/);
  assert.equal(parked.directive.callId, "call-2-0");
  assert.equal(parked.remainingCalls[0].callId, "call-2-1");
  assert.ok(parked.llmCallId);
  const messages = fixture.writes.filter(row => row.role === "tool");
  assert.equal(messages.length, 2);
  assert.ok(messages.every(row => row.createdByUserId === "alice"));
  assert.equal(fixture.runtime.getSnapshot("thread").phase, "waiting_for_user");
  assert.equal(fixture.runtime.getSnapshot("thread").pending_tool?.name, "browser_request_handoff");
  assert.equal(fixture.events.filter(event => event.event === "agent.tool_result").length, 2);
});

test("admission wait preserves original call and pauses without trailing tools or final refusal", async t => {
  let parked=0, executions=0;
  const executor=new BrowserToolExecutor(backend({execute:async c=>{
    executions++;
    assert.ok(c.waitClientId);
    throw new BrowserToolWait({handoff_id:"handoff",viewer_path:"/browser/browser_01M2KFXEFBTPXR71B57JFBW9Z1",
      wait_kind:"return_control",invocation_id:"invocation",session_id:"browser_01M2KFXEFBTPXR71B57JFBW9Z1"});
  }}),async()=>true);
  const fixture=await loopFixture(t,executor,[[{name:"browser_observe",input:{}},{name:"browser_close",input:{}}]]);
  assert.equal((await fixture.run(()=>{parked++})).status,"waiting_for_user");
  assert.equal(parked,1); assert.equal(executions,1); assert.equal(fixture.requests.length,1);
  assert.equal(fixture.events.filter(e=>e.event==="agent.tool_result").length,0);
  const pending=fixture.runtime.getSnapshot("thread").pending_tool;
  assert.equal(pending?.name,"browser_observe"); assert.equal(pending?.call_id,"call-1-0");
  assert.equal(pending?.args.wait_kind,"return_control");
  assert.equal(fixture.runtime.getSnapshot("thread").phase,"waiting_for_user");
});

test("production handoff is paired as unsupported without parking the turn", async t => {
  const executor = new BrowserToolExecutor(backend({ park: undefined }), async () => true);
  const fixture = await loopFixture(t, executor, [[{ name: "browser_request_handoff", input: { reason: "Sign in" } }], []]);
  assert.equal((await fixture.run()).status, "succeeded");
  assert.ok(fixture.writes.some(row => row.role === "tool" && /browser_handoff_unavailable/.test(row.content)));
  assert.equal(fixture.runtime.getSnapshot("thread").phase, "idle");
});

test("private browser rejection returns to the model so chat can finish", async t => {
  const executor = new BrowserToolExecutor(backend({ execute: async () => ({
    ok: false, outcome: "rejected", error: "browser_private_or_paused",
  }) }), async () => true);
  const fixture = await loopFixture(t, executor, [[{ name: "browser_observe", input: {} }], []]);
  assert.equal((await fixture.run()).status, "succeeded");
  assert.match(JSON.stringify(fixture.requests[1]), /Return to agent/);
  assert.match(JSON.stringify(fixture.requests[1]), /continue chatting/);
  assert.equal(fixture.runtime.getSnapshot("thread").phase, "idle");
});

test("failed handoff does not publish waiting state or execute trailing calls", async t => {
  let executions = 0;
  const executor = new BrowserToolExecutor(backend({
    execute: async () => { executions++; throw new Error("should not execute"); },
    park: async () => { throw new Error("fixture_parking_failed"); },
  }), async () => true);
  const fixture = await loopFixture(t, executor, [[{ name: "browser_request_handoff", input: { reason: "Sign in" } }, { name: "browser_close", input: {} }]]);
  await assert.rejects(fixture.run(), /fixture_parking_failed/);
  assert.equal(executions, 0);
  assert.equal(fixture.requests.length, 1);
  assert.ok(!fixture.events.some(event => event.event === "agent.tool_call"));
  assert.equal(fixture.runtime.getSnapshot("thread").phase, "idle");
});
