import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_TOOL_NAMES, BROWSER_REPL_TOOLS, isBrowserToolName, parseBrowserInput } from "./browser-tools.js";
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

test("browser catalog is explicitly composed and excluded offline; REPL tools replay", () => {
  const online = buildAgentEnvironmentSnapshot({ budId: "bud", online: true });
  assert.equal(resolveAgentToolsForEnvironment(online).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 0);
  assert.equal(resolveAgentToolsForEnvironment(online, { browser: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 1);
  assert.equal(resolveAgentToolsForEnvironment(online, { browser: true, browserHandoff: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 2);
  assert.equal(resolveAgentToolsForEnvironment({ ...online, mode: "bud_offline" }, { browser: true }).filter(t => BROWSER_TOOL_NAMES.includes(t.name as never)).length, 0);
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const loader = new AgentConversationLoader();
  for (const name of BROWSER_TOOL_NAMES) {
    const input = name === "browser_exec" ? {code:"console.log(1)"} : name === "browser_request_handoff" ? { reason: "Sign in" } : {};
    const [directive] = runner.extractToolCalls({ id: "r", content: [], stopReason: "tool_use", toolCalls: [{ id: name, name, input }] });
    assert.equal(toolNameForConversation(directive.tool), name);
    assert.deepEqual(buildToolArgs(directive), input);
    const stored = Reflect.get(loader, "parseStoredToolDirective").call(loader, JSON.stringify({ tool: name, call_id: name, args: input }));
    assert.deepEqual(stored, directive);
  }

});

test("OpenAI encoding keeps both strict schemas usable without mutating canonical definitions", async () => {
  const provider = new OpenAIProvider("fixture-key");
  let checked = false;
  Reflect.get(provider, "client").responses.create = async (request: any) => {
    checked = true;
    assert.deepEqual(request.tools.map((tool: any) => tool.name), BROWSER_REPL_TOOLS.map(t => t.name));
    for (const tool of request.tools) {
      assert.equal(tool.strict, true);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
    }
    return { id: "r", status: "completed", output: [] };
  };
  const original = structuredClone(BROWSER_REPL_TOOLS);
  await provider.invokeSync([{ role: "user", content: "fixture" }], BROWSER_REPL_TOOLS, { model: "gpt-6-astra" });
  assert.ok(checked);
  assert.deepEqual(BROWSER_REPL_TOOLS, original);
});

test("execution withholds unauthorized/late evidence, rejects bad arguments and never recommends retrying unknown actions", async () => {
  let dispatched = 0;
  let owned = true;
  const executor = new BrowserToolExecutor(backend({ execute: async () => { dispatched++; owned = false; return { ok: true, outcome: "completed", data: { private: "not delivered" } }; } }), async c => owned && c.ownerUserId === "alice");
  await assert.rejects(executor.execute({ ...context, ownerUserId: "bob" }, call("browser_exec", {code:"await browser.tabs.list()"})), /not_found/);
  assert.equal(dispatched, 0);
  const invalid = await executor.execute(context, call("browser_exec", { action: "evaluate" }));
  assert.equal(invalid.payload.error, "browser_invalid_arguments");
  assert.match(JSON.stringify(invalid.payload.data), /code: JavaScript/);
  assert.equal(dispatched, 0);
  await assert.rejects(executor.execute(context, call("browser_exec", {code:"await browser.tabs.list()"})), /not_found/);
  const unknown = new BrowserToolExecutor(backend({ execute: async () => { throw new Error("sensitive transport contents"); } }), async () => true);
  const result = await unknown.execute(context, call("browser_exec", { code: "await handle.click()" }));
  assert.equal(result.payload.outcome, "unknown");
  assert.equal(result.result.retryable, false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive transport/);
  const abort = new AbortController();
  const canceled = new BrowserToolExecutor(backend({ execute: async () => { abort.abort(); return { ok: true, outcome: "completed" }; } }), async () => true);
  await assert.rejects(canceled.execute({ ...context, signal: abort.signal }, call("browser_exec", {code:"await browser.tabs.list()"})), { name: "AbortError" });
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
      assert.ok([0, (browser.handoffAvailable ? 2 : 1)].includes(tools.filter(tool => BROWSER_TOOL_NAMES.includes(tool.name as never)).length));
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
  const fixture = await loopFixture(t, executor, [[{ name: "browser_exec", input: {code:"await browser.tabs.open()"} }, { name: "browser_exec", input: {code:"await browser.tabs.list()"} }],
    [{ name: "browser_request_handoff", input: { reason: "Enter the test OTP" } }, { name: "browser_exec", input: {code:"await tab.close()"} }]]);
  assert.equal((await fixture.run()).status, "waiting_for_user");
  assert.deepEqual(applied, ["browser_exec", "browser_exec"]);
  assert.equal(fixture.requests.length, 2);
  assert.match(JSON.stringify(fixture.requests[1]), /fixture page/);
  assert.equal(parked.directive.callId, "call-2-0");
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
  const fixture=await loopFixture(t,executor,[[{name:"browser_exec",input:{code:"await browser.tabs.list()"}},{name:"browser_exec",input:{code:"await tab.close()"}}]]);
  assert.equal((await fixture.run(()=>{parked++})).status,"waiting_for_user");
  assert.equal(parked,1); assert.equal(executions,1); assert.equal(fixture.requests.length,1);
  assert.equal(fixture.events.filter(e=>e.event==="agent.tool_result").length,0);
  const pending=fixture.runtime.getSnapshot("thread").pending_tool;
  assert.equal(pending?.name,"browser_exec"); assert.equal(pending?.call_id,"call-1-0");
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
  const fixture = await loopFixture(t, executor, [[{ name: "browser_exec", input: {code:"await browser.tabs.list()"} }], []]);
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
  const fixture = await loopFixture(t, executor, [[{ name: "browser_request_handoff", input: { reason: "Sign in" } }, { name: "browser_exec", input: {code:"await tab.close()"} }]]);
  await assert.rejects(fixture.run(), /fixture_parking_failed/);
  assert.equal(executions, 0);
  assert.equal(fixture.requests.length, 1);
  assert.ok(!fixture.events.some(event => event.event === "agent.tool_call"));
  assert.equal(fixture.runtime.getSnapshot("thread").phase, "idle");
});


test("REPL is the only catalog in development and production, ignoring retired env values", t => {
  const mode=process.env.BUD_BROWSER_TOOL_MODE, env=process.env.NODE_ENV;
  t.after(()=>{ if(mode===undefined) delete process.env.BUD_BROWSER_TOOL_MODE; else process.env.BUD_BROWSER_TOOL_MODE=mode;
    if(env===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=env; });
  delete process.env.BUD_BROWSER_TOOL_MODE; process.env.NODE_ENV='development';
  const online=buildAgentEnvironmentSnapshot({budId:'bud',online:true});
  const names=()=>resolveAgentToolsForEnvironment(online,{browser:true,browserHandoff:true}).filter(t=>BROWSER_TOOL_NAMES.includes(t.name as never)).map(t=>t.name);
  assert.deepEqual(names(), BROWSER_REPL_TOOLS.map(t=>t.name));
  process.env.BUD_BROWSER_TOOL_MODE='tools'; assert.deepEqual(names(),BROWSER_REPL_TOOLS.map(t=>t.name));
  process.env.BUD_BROWSER_TOOL_MODE='repl'; assert.deepEqual(names(),BROWSER_REPL_TOOLS.map(t=>t.name));
  assert.deepEqual(parseBrowserInput('browser_exec',{code:'console.log(1)'}),{code:'console.log(1)'});
  assert.throws(()=>parseBrowserInput('browser_exec',{code:'🐱'.repeat(16385)}));
  assert.throws(()=>parseBrowserInput('browser_exec',{code:'1',owner_user_id:'other'}));
  process.env.NODE_ENV='production'; assert.deepEqual(names(),BROWSER_REPL_TOOLS.map(t=>t.name));
});


test("REPL cells reach the next provider step and transcript without local page data", async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bud-agent-output-'));
  const child = spawn(process.env.BUD_BROWSER_NODE ?? process.execPath,
    [fileURLToPath(new URL('../../../bud/browser-helper/repl-worker.mjs', import.meta.url)), directory],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(async () => { child.kill(); await rm(directory, {recursive:true, force:true}); });
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value)+'\n');
  let calls = 0;
  const executor = new BrowserToolExecutor(backend({ execute: async (_context, name, args) => {
    assert.equal(name, 'browser_exec'); assert.equal(typeof args.code, 'string'); calls++;
    const cell_id = String(calls);
    send({type:'execute', cell_id, code:args.code});
    while (true) {
      const next = await lines.next();
      assert.equal(next.done, false, 'worker exited');
      const message = JSON.parse(next.value!);
      if (message.type === 'result') {
        assert.equal(message.ok, true, message.error);
        return {ok:true, outcome:'completed', data:{...message, execution_state:'completed', runtime_generation:'runtime'}};
      }
      // Full source data enters the actual worker; only selected output may leave.
      const data = message.command.action === 'open' ? {target_id:'owned'} :
        {nodes:[{name:'Selected story'},{name:'Retained detail'},{name:'UNEMITTED_SOURCE_DATA'}]};
      send({type:'operation_result', cell_id, operation_id:message.operation_id, ok:true, data});
    }
  } }), async () => true);
  const fixture = await loopFixture(t, executor, [
    [{ name: 'browser_exec', input: {code: 'var page = await browser.tabs.open("https://example.com"); var snapshot = await page.snapshot(); snapshot.nodes[0].name;'} }],
    messages => { assert.match(JSON.stringify(messages), /Selected story/); return [{name:'browser_exec',input:{code:'console.log(snapshot.nodes[1].name)'}}]; },
    messages => { assert.match(JSON.stringify(messages), /Retained detail/); return []; },
  ]);
  assert.equal((await fixture.run()).status, 'succeeded');
  assert.equal(calls, 2);
  const nextContext = JSON.stringify(fixture.requests[2]);
  assert.equal(nextContext.match(/Selected story/g)?.length, 1);
  assert.equal(nextContext.match(/Retained detail/g)?.length, 1);
  assert.doesNotMatch(nextContext, /UNEMITTED_SOURCE_DATA/);
  const written = fixture.writes.filter(row => row.role === 'tool');
  assert.equal(written.length, 2);
  assert.ok(written.every(row => row.createdByUserId === 'alice' && /browser_exec/.test(row.content)));
});

// Historical recognition does not make a retired name executable.
test("retired names are rejected before executor backend dispatch", async () => {
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  let dispatched = 0;
  const executor = new BrowserToolExecutor(backend({execute: async () => {
    dispatched++; throw Error("must not dispatch");
  }}), async () => true);
  for (const name of ["browser_open", "browser_observe", "browser_act", "browser_close"]) {
    assert.equal(isBrowserToolName(name), false);
    assert.throws(() => parseBrowserInput(name as never, {}), /browser_invalid_arguments/);
    assert.deepEqual(runner.extractToolCalls({id:"r",content:[],stopReason:"tool_use",toolCalls:[{id:name,name,input:{}}]}), []);
    await executor.execute(context, call(name as never));
  }
  assert.equal(dispatched, 0);
});
