import { db } from "../db/client.js";
import { AgentService } from "./agent-service.js";
import type { CanonicalMessage, CanonicalResponse } from "../llm/index.js";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { AgentModelRunner } from "./model-runner.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { WebRetrievalToolExecutor } from "./web-retrieval-tool-executor.js";
import { buildAgentEnvironmentSnapshot } from "./environment.js";
import { resolveAgentToolsForEnvironment } from "./tool-definitions.js";
import { buildToolArgs, toolNameForConversation, type WebRetrievalToolCallDirective } from "./contracts.js";

const logger = { info() {}, warn() {}, error() {} };
test("web tools remain available offline and round-trip through canonical replay", () => {
  const offline = buildAgentEnvironmentSnapshot({ budId: "bud", online: false, lastSeenAt: null });
  const tools = resolveAgentToolsForEnvironment(offline, { webRetrieval: true });
  assert.ok(tools.some(t => t.name === "web_search"));
  assert.ok(tools.some(t => t.name === "web_read"));
  assert.ok(!tools.some(t => t.name === "terminal_send"));
  assert.ok(!resolveAgentToolsForEnvironment(offline, { webRetrieval: false }).some(t => t.name === "web_search"));
  const runner = new AgentModelRunner({} as never, logger as never, false, false);
  const loader = new AgentConversationLoader();
  for (const tool of ["web_search", "web_read"] as const) {
    const args = tool === "web_search" ? { query: "public documentation" } : { url_or_reference: "https://docs.firecrawl.dev/" };
    const [directive] = runner.extractToolCalls({ id: "response", stopReason: "tool_use", content: [], toolCalls: [{ id: "call", name: tool, input: args }] });
    assert.deepEqual(buildToolArgs(directive), args);
    assert.equal(toolNameForConversation(directive.tool), tool);
    assert.deepEqual(Reflect.get(loader, "parseStoredToolDirective").call(loader, JSON.stringify({ tool, call_id: "call", args })), directive);
  }
});
test("executor fails closed when disabled, sanitizes errors and withholds canceled results", async t => {
  const before = { flag: process.env.WEB_RETRIEVAL_ENABLED, key: process.env.FIRECRAWL_API_KEY };
  t.after(() => { for (const [name, value] of [["WEB_RETRIEVAL_ENABLED", before.flag], ["FIRECRAWL_API_KEY", before.key]])
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value; });
  const directive: WebRetrievalToolCallDirective = { type: "tool_call", tool: "web_search", callId: "call", args: { query: "docs" } };
  let called = false;
  const executor = new WebRetrievalToolExecutor({ execute: async () => { called = true; throw new Error("secret raw upstream response"); } });
  process.env.WEB_RETRIEVAL_ENABLED = "0";
  assert.equal((await executor.execute("thread", directive, "owner", undefined, "turn")).result.error, "web_unavailable");
  assert.equal(called, false);
  process.env.WEB_RETRIEVAL_ENABLED = "1"; process.env.FIRECRAWL_API_KEY = "fixture";
  const failure = await executor.execute("thread", directive, "owner", undefined, "turn");
  assert.equal(called, true); assert.doesNotMatch(JSON.stringify(failure), /secret raw/);
  const controller = new AbortController();
  const canceled = new WebRetrievalToolExecutor({ execute: async () => { controller.abort(); return { text: "late evidence" }; } });
  await assert.rejects(canceled.execute("thread", directive, "owner", controller.signal, "turn"));
});

test("agent loop delivers web evidence to the next model step and stamps its transcript owner", async t => {
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
      ? { id: "r1", stopReason: "tool_use", content: [{ type: "tool_use", id: "call-1", name: "web_search", input: { query: "docs" } }], toolCalls: [{ id: "call-1", name: "web_search", input: { query: "docs" } }] }
      : { id: "r2", stopReason: "end_turn", content: [{ type: "text", text: "Found web evidence." }] };
    if (invocations === 2) delivered = messages;
    return { response, assistantClientId: null, provider: "openai", providerModel: "fixture", reasoningSegments: [], assistantTiming: null };
  });
  Reflect.set(service, "webRetrievalToolExecutor", { execute: async (_thread: string, call: WebRetrievalToolCallDirective, owner: string) => {
    assert.equal(owner, "alice");
    return { directive: call, args: call.args, summary: "Searched the web", outputTruncationReason: null,
      result: { kind: "web_retrieval", ok: true }, payload: { tool: call.tool, call_id: call.callId, args: call.args, kind: "web_retrieval", ok: true, results: [{ title: "source evidence", url: "https://docs.firecrawl.dev/" }] } };
  } });
  let recorded = false;
  Reflect.set(service, "transcriptWriter", {
    emitToolCall: (_thread: string, _turn: string, call: WebRetrievalToolCallDirective) => ({ clientArgs: buildToolArgs(call) }),
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
  assert.match(JSON.stringify(delivered), /source evidence/);
  assert.match(JSON.stringify(ledger), /web_search/);
});
