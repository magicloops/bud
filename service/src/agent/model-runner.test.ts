import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  providerRegistry,
  type CanonicalStreamEvent,
  type CanonicalTool,
  type LLMProvider,
  type ModelCapabilities,
} from "../llm/index.js";
import { AgentModelResponseError, AgentModelRunner } from "./model-runner.js";

function createRuntime() {
  return {
    emit() {
      return "cursor_1";
    },
    setDraftAssistant() {
      // noop
    },
  };
}

function createLogger() {
  return {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  };
}

function createProvider(
  name: "anthropic" | "openai",
  supportedModels: string[],
  onInvoke?: (tools: CanonicalTool[]) => void,
  events?: CanonicalStreamEvent[],
): LLMProvider {
  const capabilities: ModelCapabilities = {
    supportsVision: true,
    supportsTools: true,
    supportsStreaming: true,
    supportsJsonMode: name === "openai",
    maxContextTokens: 128000,
    maxOutputTokens: 32000,
    supportsReasoning: name === "openai",
    supportsThinking: name === "anthropic",
    supportsInterleavedThinking: name === "anthropic",
  };

  return {
    name,
    supportedModels,
    async *invoke(_messages, tools): AsyncIterable<CanonicalStreamEvent> {
      onInvoke?.(tools);
      yield* (events ?? [
        { type: "message_start", id: "resp_test" },
        { type: "message_done", stop_reason: "end_turn" },
      ]);
    },
    supportsModel(model: string) {
      return name === "openai" ? model.startsWith("gpt-") : model.startsWith("claude-");
    },
    getModelCapabilities() {
      return capabilities;
    },
  };
}

function registerTestProviders(t: TestContext) {
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.register(
    createProvider("openai", [
      "gpt-5.4-2026-03-05",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.4-nano-2026-03-17",
      "gpt-5.5",
    ]),
  );
  providerRegistry.register(
    createProvider("anthropic", [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-haiku-4-5-20251001",
    ]),
  );

  t.after(() => {
    providerRegistry.unregister("openai");
    providerRegistry.unregister("anthropic");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
    }
  });
}

test("resolveReasoningEffort follows model-specific reasoning policies", (t) => {
  registerTestProviders(t);
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
    "none",
  );

  assert.equal(runner.resolveReasoningEffort("gpt-5.4", "xhigh"), "xhigh");
  assert.equal(runner.resolveReasoningEffort("claude-opus-4-6"), "high");
  assert.equal(runner.resolveReasoningEffort("claude-opus-4-7"), "xhigh");
  assert.throws(
    () => runner.resolveReasoningEffort("claude-sonnet-4-6", "xhigh"),
    /Reasoning effort xhigh is not supported/,
  );
});

test("invokeModel advertises only public wait modes and no timeout_ms", async (t) => {
  let capturedTools: CanonicalTool[] = [];
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.register(
    createProvider("openai", ["gpt-5.4-2026-03-05"], (tools) => {
      capturedTools = tools;
    }),
  );

  t.after(() => {
    providerRegistry.unregister("openai");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
    }
  });

  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  await runner.invokeModel(
    "thread_test",
    "turn_test",
    [{ role: "user", content: "hello" }],
    "gpt-5.4",
    runner.resolveModelReasoning("gpt-5.4"),
  );

  const sendTool = capturedTools.find((tool) => tool.name === "terminal_send");
  const observeTool = capturedTools.find((tool) => tool.name === "terminal_observe");
  const webViewOpenTool = capturedTools.find((tool) => tool.name === "web_view_open");
  const webViewCloseTool = capturedTools.find((tool) => tool.name === "web_view_close");
  const webViewListTool = capturedTools.find((tool) => tool.name === "web_view_list");
  const askUserQuestionsTool = capturedTools.find((tool) => tool.name === "ask_user_questions");
  assert.ok(sendTool);
  assert.ok(observeTool);
  assert.ok(webViewOpenTool);
  assert.ok(webViewCloseTool);
  assert.ok(webViewListTool);
  assert.ok(askUserQuestionsTool);

  const sendProperties = sendTool.parameters.properties as Record<string, unknown>;
  const observeProperties = observeTool.parameters.properties as Record<string, unknown>;
  assert.equal(sendProperties.timeout_ms, undefined);
  assert.equal(observeProperties.timeout_ms, undefined);
  assert.deepEqual(
    (sendProperties.wait_for as { enum?: unknown }).enum,
    ["none", "changed", "settled"],
  );
  assert.deepEqual(
    (observeProperties.wait_for as { enum?: unknown }).enum,
    ["none", "changed", "settled"],
  );
  assert.deepEqual(webViewOpenTool.parameters.required, ["target_port"]);
  const webViewOpenProperties = webViewOpenTool.parameters.properties as Record<string, unknown>;
  assert.match(
    (webViewOpenProperties.target_host as { description?: string }).description ?? "",
    /Defaults to localhost/,
  );
  assert.match(
    (webViewOpenProperties.target_host as { description?: string }).description ?? "",
    /preserve that exact host/,
  );
  const askProperties = askUserQuestionsTool.parameters.properties as Record<string, unknown>;
  const questionsSchema = askProperties.questions as { maxItems?: number; items?: { properties?: Record<string, unknown> } };
  assert.equal(questionsSchema.maxItems, 5);
  assert.deepEqual(
    (questionsSchema.items?.properties?.kind as { enum?: unknown }).enum,
    ["boolean", "single_choice", "multi_choice", "text", "number"],
  );
});

test("invokeModel carries provider diagnostics from message_done", async (t) => {
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.register(
    createProvider("openai", ["gpt-5.4-2026-03-05"], undefined, [
      { type: "message_start", id: "resp_test" },
      {
        type: "message_done",
        stop_reason: "end_turn",
        providerData: {
          provider: "openai",
          payload: {
            id: "resp_raw",
            output: [],
          },
        },
      },
    ]),
  );

  t.after(() => {
    providerRegistry.unregister("openai");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
    }
  });

  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const { response } = await runner.invokeModel(
    "thread_test",
    "turn_test",
    [{ role: "user", content: "hello" }],
    "gpt-5.4",
    runner.resolveModelReasoning("gpt-5.4"),
  );

  assert.equal(response.providerData?.provider, "openai");
  assert.deepEqual(response.providerData?.payload, {
    id: "resp_raw",
    output: [],
  });
});

test("invokeModel keeps text blocks around multiple tool calls", async (t) => {
  const previousOpenAI = providerRegistry.getProvider("openai");
  const previousAnthropic = providerRegistry.getProvider("anthropic");

  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");
  providerRegistry.register(
    createProvider("openai", ["gpt-5.4-2026-03-05"], undefined, [
      { type: "message_start", id: "resp_interleaved" },
      { type: "content_start", index: 0, content_type: "text" },
      { type: "text_delta", index: 0, delta: "before tool" },
      { type: "content_done", index: 0 },
      {
        type: "tool_use_done",
        index: 1,
        id: "call_observe",
        name: "terminal_observe",
        input: { view: "screen" },
      },
      { type: "content_start", index: 2, content_type: "text" },
      { type: "text_delta", index: 2, delta: "between tools" },
      { type: "content_done", index: 2 },
      {
        type: "tool_use_done",
        index: 3,
        id: "call_send",
        name: "terminal_send",
        input: { text: "pwd", submit: true },
      },
      { type: "message_done", stop_reason: "tool_use" },
    ]),
  );

  t.after(() => {
    providerRegistry.unregister("openai");
    if (previousOpenAI) {
      providerRegistry.register(previousOpenAI);
    }
    if (previousAnthropic) {
      providerRegistry.register(previousAnthropic);
    }
  });

  const runtime = createRuntime();
  const runner = new AgentModelRunner(
    runtime as never,
    createLogger() as never,
    false,
    false,
  );

  const { response, assistantClientId, provider, providerModel } = await runner.invokeModel(
    "thread_test",
    "turn_test",
    [{ role: "user", content: "hello" }],
    "gpt-5.4",
    runner.resolveModelReasoning("gpt-5.4"),
  );

  assert.equal(provider, "openai");
  assert.equal(providerModel, "gpt-5.4-2026-03-05");
  assert.ok(assistantClientId);
  assert.deepEqual(response.content, [
    { type: "text", text: "before tool" },
    {
      type: "tool_use",
      id: "call_observe",
      name: "terminal_observe",
      input: { view: "screen" },
    },
    { type: "text", text: "between tools" },
    {
      type: "tool_use",
      id: "call_send",
      name: "terminal_send",
      input: { text: "pwd", submit: true },
    },
  ]);
  assert.deepEqual(
    runner.extractToolCalls(response).map((directive) => directive.callId),
    ["call_observe", "call_send"],
  );
});

test("extractToolCall normalizes legacy keys arrays to canonical semantic key strings", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const directive = runner.extractToolCall({
    id: "resp_legacy_key",
    content: [],
    stopReason: "tool_use",
    toolCalls: [
      {
        id: "call_send_legacy",
        name: "terminal_send",
        input: {
          keys: ["C-c"],
        },
      },
    ],
  });

  assert.deepEqual(directive, {
    type: "tool_call",
    tool: "terminal.send",
    text: undefined,
    submit: false,
    key: "ctrl+c",
    observeAfterMs: undefined,
    waitFor: undefined,
    timeoutMs: undefined,
    callId: "call_send_legacy",
  });
});

test("extractToolCalls parses web view tool directives", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const directives = runner.extractToolCalls({
    id: "resp_web_view_tools",
    content: [],
    stopReason: "tool_use",
    toolCalls: [
      {
        id: "call_web_open",
        name: "web_view_open",
        input: {
          target_host: "localhost",
          target_port: 3000,
          path: "/dashboard",
          title: "Dashboard",
        },
      },
      {
        id: "call_web_close",
        name: "web_view_close",
        input: {
          proxied_site_id: "site_test",
          disable: true,
        },
      },
      {
        id: "call_web_list",
        name: "web_view_list",
        input: {},
      },
    ],
  });

  assert.deepEqual(directives, [
    {
      type: "tool_call",
      tool: "web_view.open",
      targetHost: "localhost",
      targetPort: 3000,
      path: "/dashboard",
      title: "Dashboard",
      callId: "call_web_open",
    },
    {
      type: "tool_call",
      tool: "web_view.close",
      proxiedSiteId: "site_test",
      disable: true,
      callId: "call_web_close",
    },
    {
      type: "tool_call",
      tool: "web_view.list",
      callId: "call_web_list",
    },
  ]);
});

test("extractToolCalls parses ask_user_questions directives", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const directives = runner.extractToolCalls({
    id: "resp_question_tools",
    content: [],
    stopReason: "tool_use",
    toolCalls: [
      {
        id: "call_questions",
        name: "ask_user_questions",
        input: {
          title: "Deploy",
          questions: [
            {
              question_id: "env",
              kind: "single_choice",
              label: "Environment?",
              choices: [
                { choice_id: "staging", label: "Staging" },
                { choice_id: "production", label: "Production" },
              ],
            },
          ],
        },
      },
    ],
  });

  assert.equal(directives.length, 1);
  assert.equal(directives[0]?.tool, "ask_user_questions");
  assert.equal(directives[0]?.callId, "call_questions");
  if (directives[0]?.tool === "ask_user_questions") {
    assert.equal(directives[0].request.schema, "ask_user_questions_request_v1");
    assert.equal(directives[0].request.questions[0]?.skippable, true);
  }
});

test("parseFinalResponse includes bounded model response diagnostics on empty output", () => {
  const runner = new AgentModelRunner(
    createRuntime() as never,
    createLogger() as never,
    false,
    false,
  );

  const providerPayload = {
    id: "resp_raw",
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
      },
    ],
  };

  assert.throws(
    () =>
      runner.parseFinalResponse({
        id: "resp_test",
        content: [
          {
            type: "reasoning",
            text: "",
            providerData: {
              provider: "openai",
              payload: {
                type: "reasoning",
                id: "rs_1",
                summary: [],
              },
            },
          },
        ],
        stopReason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          reasoning_tokens: 2,
        },
        toolCalls: [],
        providerData: {
          provider: "openai",
          payload: providerPayload,
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof AgentModelResponseError);
      assert.equal(err.code, "MODEL_EMPTY_RESPONSE");
      assert.match(err.message, /model returned no text or tool call/);
      assert.match(err.message, /resp_raw/);
      assert.equal(err.modelResponse.id, "resp_test");
      assert.equal(err.modelResponse.stopReason, "end_turn");

      const providerData = err.modelResponse.providerData as {
        provider: string;
        payload: { id: string; status: string };
      };
      assert.equal(providerData.provider, "openai");
      assert.equal(providerData.payload.id, "resp_raw");
      assert.equal(providerData.payload.status, "completed");

      return true;
    },
  );
});
