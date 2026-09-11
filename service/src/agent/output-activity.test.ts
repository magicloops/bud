import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { AgentModelRunner } from "./model-runner.js";
import { providerRegistry, type CanonicalStreamEvent, type LLMProvider } from "../llm/index.js";
import { transformChatCompletionsStream } from "../llm/providers/bud-local-chat.js";

const logger = { info() {}, warn() {}, error() {} };
const reasoning = { requestedModel: "gpt-5.6-luna", providerName: "openai", entry: null, providerModel: "gpt-5.6-luna", reasoningLevel: "medium" as const, reasoning: { enabled: true, effort: "medium" as const } };

test("activity reaches live listeners and replay before slow tool arguments finish", async (t) => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread", "turn");
  const initial = runtime.getSnapshot("thread").stream_cursor;
  const observed: string[] = [];
  runtime.attachCallback("thread", event => {
    if (event.event !== "agent.output_activity") return;
    const data = event.data as { state: string };
    const snapshot = runtime.getSnapshot("thread");
    assert.equal(snapshot.output_activity?.state, data.state);
    assert.equal(snapshot.stream_cursor, event.id);
    observed.push(data.state);
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const provider = {
    name: "openai", supportedModels: [], supportsModel: () => true, getModelCapabilities: () => ({ maxOutputTokens: 1000, maxContextTokens: 128000, supportsVision: false, supportsTools: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: true, supportsThinking: true, supportsInterleavedThinking: true }),
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: "content_start", index: 0, content_type: "text", assistantPhase: "commentary" };
      yield { type: "text_delta", index: 0, delta: "Looking up the contact." };
      yield { type: "content_done", index: 0 };
      yield { type: "tool_use_start", index: 1, id: "tool", name: "contacts_get" };
      ready();
      await held;
      yield { type: "tool_use_done", index: 1, id: "tool", name: "contacts_get", input: { contact_id: "c" } };
      yield { type: "message_done", stop_reason: "tool_use" };
    },
  } as LLMProvider;
  t.mock.method(providerRegistry, "getProviderForModel", () => provider);
  const runner = new AgentModelRunner(runtime, logger as never, false, false);
  const resultPromise = runner.invokeModel("thread", "turn", [], "gpt-5.6-luna", reasoning, undefined, [], undefined, { llmCallId: "llm" });
  await started;
  try {
    assert.deepEqual(observed, ["working", "text", "working"]);
    assert.equal(runtime.getSnapshot("thread").draft_assistant?.text, "Looking up the contact.");
    assert.equal(runtime.getSnapshot("thread").pending_tool, null);
    const replay: string[] = [];
    const attached = runtime.attachCallback("thread", event => replay.push(event.event), { afterCursor: initial });
    attached.detach();
    assert.ok(replay.includes("agent.output_activity"));
    assert.ok(!replay.includes("agent.message_done"));
  } finally { release(); }
  const result = await resultPromise;
  runner.completeAssistantDraft("thread", "turn", result, "intermediate");
  assert.equal(runtime.getSnapshot("thread").output_activity?.state, "working");
});

test("unknown text end stays quiet; productive transitions resume and stale closes cannot steal activity", async (t) => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread", "turn");
  const steps: Array<[CanonicalStreamEvent, string]> = [
    [{ type: "content_start", index: 0, content_type: "text" }, "working"],
    [{ type: "text_delta", index: 0, delta: " " }, "working"],
    [{ type: "text_delta", index: 0, delta: "Hello" }, "text"],
    [{ type: "content_done", index: 0 }, "awaiting_completion"],
    [{ type: "content_done", index: 0 }, "awaiting_completion"],
    [{ type: "reasoning_start", index: 1 }, "working"],
    [{ type: "text_delta", index: 2, delta: "More" }, "text"],
    [{ type: "content_done", index: 0 }, "text"],
    [{ type: "reasoning_done", index: 1, block: { type: "reasoning", text: "summary" } }, "text"],
    [{ type: "tool_use_start", index: 3, id: "call", name: "contacts_get" }, "working"],
    [{ type: "content_done", index: 2 }, "working"],
    [{ type: "text_delta", index: 2, delta: " resumed", assistantPhase: "final_answer" }, "text"],
    [{ type: "content_done", index: 2 }, "working"],
    [{ type: "message_done", stop_reason: "tool_use" }, "working"],
  ];
  const provider = {
    name: "anthropic", supportedModels: [], supportsModel: () => true, getModelCapabilities: () => ({ maxOutputTokens: 1000, maxContextTokens: 128000, supportsVision: false, supportsTools: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: true, supportsThinking: true, supportsInterleavedThinking: true }),
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      for (const [event, expected] of steps) {
        yield event;
        assert.equal(runtime.getSnapshot("thread").output_activity?.state, expected, event.type);
      }
    },
  } as LLMProvider;
  t.mock.method(providerRegistry, "getProviderForModel", () => provider);
  await new AgentModelRunner(runtime, logger as never, false, false).invokeModel("thread", "turn", [], "gpt-5.6-luna", reasoning);
});

test("local Chat Completions switches to working without an early text end", async (t) => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread", "turn");
  const raw = async function* () {
    yield JSON.stringify({ choices: [{ delta: { content: "Checking now" } }] });
    assert.equal(runtime.getSnapshot("thread").output_activity?.state, "text");
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "contacts_get", arguments: "{" } }] } }] });
    assert.equal(runtime.getSnapshot("thread").output_activity?.state, "working");
    yield JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] });
    yield "[DONE]";
  };
  t.mock.method(providerRegistry, "getProviderForModel", () => ({
    name: "bud_local", supportedModels: [], supportsModel: () => true, getModelCapabilities: () => ({ maxOutputTokens: 1000, maxContextTokens: 128000, supportsVision: false, supportsTools: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: true, supportsThinking: true, supportsInterleavedThinking: true }),
    invoke: () => transformChatCompletionsStream(raw()),
  }) as LLMProvider);
  await new AgentModelRunner(runtime, logger as never, false, false).invokeModel("thread", "turn", [], "gpt-5.6-luna", reasoning);
  assert.equal(runtime.getSnapshot("thread").output_activity?.state, "working");
});

test("final classification keeps suppression through persistence; error and handoffs clear activity", async (t) => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread", "turn");
  t.mock.method(providerRegistry, "getProviderForModel", () => ({
    name: "openai", supportedModels: [], supportsModel: () => true, getModelCapabilities: () => ({ maxOutputTokens: 1000, maxContextTokens: 128000, supportsVision: false, supportsTools: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: true, supportsThinking: true, supportsInterleavedThinking: true }),
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: "text_delta", index: 0, delta: "Final answer" };
      yield { type: "content_done", index: 0 };
      yield { type: "message_done", stop_reason: "end_turn" };
    },
  }) as LLMProvider);
  const runner = new AgentModelRunner(runtime, logger as never, false, false);
  const result = await runner.invokeModel("thread", "turn", [], "gpt-5.6-luna", reasoning);
  runner.completeAssistantDraft("thread", "turn", result, "final");
  runtime.clearDraftAssistant("thread");
  assert.equal(runtime.getSnapshot("thread").output_activity?.state, "awaiting_completion");
  runtime.finishTurn("thread");
  assert.equal(runtime.getSnapshot("thread").output_activity, null);
  runtime.startTurn("thread", "next");
  runtime.setOutputActivity("thread", "next", "new-call", "working", true);
  runtime.setOutputActivity("thread", "turn", result.llmCallId!, "text");
  runtime.setOutputActivity("thread", "next", "old-call", null);
  assert.equal(runtime.getSnapshot("thread").output_activity?.llm_call_id, "new-call");
  const cursor = runtime.getSnapshot("thread").stream_cursor;
  runtime.markThinking("thread", cursor);
  assert.equal(runtime.getSnapshot("thread").output_activity, null);
  assert.ok(runtime.getSnapshot("thread").stream_cursor > cursor);
  t.mock.method(providerRegistry, "getProviderForModel", () => ({
    name: "openai", supportedModels: [], supportsModel: () => true, getModelCapabilities: () => ({ maxOutputTokens: 1000, maxContextTokens: 128000, supportsVision: false, supportsTools: true, supportsStreaming: true, supportsJsonMode: false, supportsReasoning: true, supportsThinking: true, supportsInterleavedThinking: true }),
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      yield { type: "text_delta", index: 0, delta: "Partial" };
      throw new Error("provider disconnected");
    },
  }) as LLMProvider);
  await assert.rejects(runner.invokeModel("thread", "next", [], "gpt-5.6-luna", reasoning), /disconnected/);
  assert.equal(runtime.getSnapshot("thread").output_activity, null);
});
