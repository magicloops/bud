import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { providerRegistry, type LLMProvider } from "../llm/index.js";
import {
  ThreadTitleService,
  normalizeGeneratedThreadTitle,
  resolveThreadTitleModel,
} from "./thread-title-service.js";

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

  async function* stream() {
    yield { type: "message_start", id: "resp_title_1" } as const;
    yield { type: "content_start", index: 0, content_type: "text" } as const;
    yield { type: "text_delta", index: 0, delta: "Fix" } as const;
    yield { type: "text_delta", index: 0, delta: " deploy" } as const;
    yield { type: "content_done", index: 0 } as const;
    yield { type: "message_done", stop_reason: "end_turn" } as const;
  }

  const response = await (service as any).collectResponse(stream());
  assert.deepEqual(response.content, [{ type: "text", text: "Fix deploy" }]);
});

test("resolveThreadTitleModel prefers the configured default model when available", () => {
  const provider = makeProvider("thread-title-default", [
    providerRegistry.resolveModelAlias(config.defaultModel),
  ]);

  providerRegistry.register(provider);

  try {
    assert.equal(resolveThreadTitleModel(), config.defaultModel);
  } finally {
    providerRegistry.unregister(provider.name);
  }
});

test("resolveThreadTitleModel falls back to another registered model when preferred models are unavailable", () => {
  const provider = makeProvider("thread-title-fallback", ["gpt-5.2-2025-12-11"]);

  providerRegistry.register(provider);

  try {
    assert.equal(resolveThreadTitleModel(), "gpt-5.2-2025-12-11");
  } finally {
    providerRegistry.unregister(provider.name);
  }
});

test("generateTitle returns null when no providers are registered", async () => {
  providerRegistry.unregister("openai");
  providerRegistry.unregister("anthropic");

  const service = new ThreadTitleService({} as never, makeLogger());

  assert.equal(await (service as any).generateTitle("Fix the broken deploy script"), null);
});
