import assert from "node:assert/strict";
import test from "node:test";
import { providerRegistry, type LLMProvider, type ModelConfig } from "../llm/index.js";
import {
  ThreadTitleService,
  normalizeGeneratedThreadTitle,
  resolveThreadTitleModel,
} from "./thread-title-service.js";

type TextContentResponse = {
  content: Array<{ type: string; text?: string }>;
};

function makeLogger() {
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
  } as never;
}

function makeProvider(name: string, supportedModels: readonly string[]): LLMProvider {
  return {
    name,
    supportedModels,
    invoke: async function* () {
      yield {
        type: "message_done",
        stop_reason: "end_turn",
      } as const;
    },
    supportsModel(model: string) {
      return supportedModels.includes(model);
    },
    getModelCapabilities() {
      return {
        supportsVision: false,
        maxContextTokens: 8192,
        maxOutputTokens: 1024,
        supportsStreaming: true,
        supportsTools: false,
        supportsJsonMode: false,
        supportsReasoning: false,
        supportsThinking: false,
        supportsInterleavedThinking: false,
      };
    },
  };
}

function resetTitleTestProviders(): void {
  providerRegistry.unregister("anthropic");
  providerRegistry.unregister("openai");
  providerRegistry.unregister("thread-title-default");
  providerRegistry.unregister("thread-title-fallback");
}

test("normalizeGeneratedThreadTitle trims labels and punctuation", () => {
  assert.equal(
    normalizeGeneratedThreadTitle('Title: "Fix OAuth Callback Flow."'),
    "Fix OAuth Callback Flow",
  );
});

test("normalizeGeneratedThreadTitle preserves longer titles", () => {
  assert.equal(
    normalizeGeneratedThreadTitle("Investigate missing session stream reconnection bug"),
    "Investigate missing session stream reconnection bug",
  );
});

test("normalizeGeneratedThreadTitle accepts short titles", () => {
  assert.equal(normalizeGeneratedThreadTitle("Bugfix"), "Bugfix");
  assert.equal(normalizeGeneratedThreadTitle("Assistant Introduction"), "Assistant Introduction");
});

test("collectResponse accumulates streamed title text deltas", async () => {
  const service = new ThreadTitleService({} as never, makeLogger());
  const collectResponse = Reflect.get(service, "collectResponse") as (
    stream: AsyncIterable<unknown>,
  ) => Promise<TextContentResponse>;

  async function* stream() {
    yield { type: "message_start", id: "resp_title_1" } as const;
    yield { type: "content_start", index: 0, content_type: "text" } as const;
    yield { type: "text_delta", index: 0, delta: "Fix" } as const;
    yield { type: "text_delta", index: 0, delta: " deploy" } as const;
    yield { type: "content_done", index: 0 } as const;
    yield { type: "message_done", stop_reason: "end_turn" } as const;
  }

  const response = await collectResponse(stream());
  assert.deepEqual(response.content, [{ type: "text", text: "Fix deploy" }]);
});

test("resolveThreadTitleModel uses Anthropic Haiku 4.5 when Anthropic is configured", () => {
  resetTitleTestProviders();
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);

  providerRegistry.register(provider);

  try {
    assert.equal(resolveThreadTitleModel(), "claude-haiku-4-5");
  } finally {
    resetTitleTestProviders();
  }
});

test("resolveThreadTitleModel does not fall back to OpenAI when Anthropic is unavailable", () => {
  resetTitleTestProviders();
  const provider = makeProvider("openai", ["gpt-5.5"]);

  providerRegistry.register(provider);

  try {
    assert.equal(resolveThreadTitleModel(), null);
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle invokes Anthropic Haiku 4.5", async () => {
  resetTitleTestProviders();
  const receivedConfigs: ModelConfig[] = [];
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);
  provider.invokeSync = async (_messages, _tools, modelConfig) => {
    receivedConfigs.push(modelConfig);
    return {
      id: "title-response",
      content: [{ type: "text", text: "Fix Deploy Script" }],
      stopReason: "end_turn",
    };
  };

  providerRegistry.register(provider);

  try {
    const service = new ThreadTitleService({} as never, makeLogger());
    const generateTitle = Reflect.get(service, "generateTitle").bind(service) as (
      firstUserMessage: string,
    ) => Promise<string | null>;

    assert.equal(await generateTitle("Fix the broken deploy script"), "Fix Deploy Script");
    assert.equal(receivedConfigs.length, 1);
    assert.equal(receivedConfigs[0].model, "claude-haiku-4-5-20251001");
    assert.equal(receivedConfigs[0].toolChoice, "none");
    assert.deepEqual(receivedConfigs[0].reasoning, { enabled: false });
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle returns null when Anthropic is not configured", async () => {
  resetTitleTestProviders();

  const service = new ThreadTitleService({} as never, makeLogger());
  const generateTitle = Reflect.get(service, "generateTitle").bind(service) as (
    firstUserMessage: string,
  ) => Promise<string | null>;

  assert.equal(await generateTitle("Fix the broken deploy script"), null);
});
