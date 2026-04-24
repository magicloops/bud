import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  providerRegistry,
  type CanonicalStreamEvent,
  type LLMProvider,
  type ModelCapabilities,
} from "../llm/index.js";
import { AgentModelRunner } from "./model-runner.js";

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

function createProvider(name: "anthropic" | "openai", supportedModels: string[]): LLMProvider {
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
    async *invoke(): AsyncIterable<CanonicalStreamEvent> {
      // noop
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
