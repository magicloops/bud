import assert from "node:assert/strict";
import test from "node:test";
import { providerRegistry, type CanonicalResponse, type CanonicalMessage, type LLMProvider, type ModelConfig } from "../llm/index.js";
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
        supportsTools: true,
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

test("normalizeGeneratedThreadTitle normalizes whitespace without guessing at formatting", () => {
  assert.equal(
    normalizeGeneratedThreadTitle('  Fix  OAuth\nCallback Flow.  '),
    "Fix OAuth Callback Flow.",
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

test("resolveThreadTitleModel falls back to Haiku when only Anthropic is registered", () => {
  resetTitleTestProviders();
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);

  providerRegistry.register(provider);

  try {
    assert.equal(resolveThreadTitleModel(), "claude-haiku-4-5");
  } finally {
    resetTitleTestProviders();
  }
});

test("resolveThreadTitleModel prefers GPT-5.6 Luna when OpenAI is registered", () => {
  resetTitleTestProviders();
  providerRegistry.register(makeProvider("openai", ["gpt-5.6-luna"]));
  providerRegistry.register(
    makeProvider("anthropic", ["claude-haiku-4-5-20251001"]),
  );

  try {
    assert.equal(resolveThreadTitleModel(), "gpt-5.6-luna");
  } finally {
    resetTitleTestProviders();
  }
});

test("resolveThreadTitleModel returns null when no title provider is registered", () => {
  resetTitleTestProviders();
  try {
    assert.equal(resolveThreadTitleModel(), null);
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle invokes GPT-5.6 Luna with reasoning disabled when OpenAI is registered", async () => {
  resetTitleTestProviders();
  const receivedConfigs: ModelConfig[] = [];
  const provider = makeProvider("openai", ["gpt-5.6-luna"]);
  provider.invokeSync = async (_messages, _tools, modelConfig) => {
    assert.equal(_tools.length, 1);
    assert.deepEqual(_tools[0].parameters, {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
      required: ["title"],
      additionalProperties: false,
    });
    receivedConfigs.push(modelConfig);
    return {
      id: "title-response",
      content: [{ type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Fix Deploy Script" } }],
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
    assert.equal(receivedConfigs[0].model, "gpt-5.6-luna");
    assert.deepEqual(receivedConfigs[0].toolChoice, { type: "tool", name: "submit_thread_title" });
    assert.equal(receivedConfigs[0].maxOutputTokens, 256);
    assert.deepEqual(receivedConfigs[0].reasoning, { enabled: false });
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle falls back to Anthropic Haiku 4.5 when OpenAI is absent", async () => {
  resetTitleTestProviders();
  const receivedConfigs: ModelConfig[] = [];
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);
  provider.invokeSync = async (_messages, _tools, modelConfig) => {
    assert.equal(_tools.length, 1);
    assert.deepEqual(_tools[0].parameters, {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
      required: ["title"],
      additionalProperties: false,
    });
    receivedConfigs.push(modelConfig);
    return {
      id: "title-response",
      content: [{ type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Fix Deploy Script" } }],
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
    assert.deepEqual(receivedConfigs[0].toolChoice, { type: "tool", name: "submit_thread_title" });
    assert.equal(receivedConfigs[0].maxOutputTokens, 256);
    assert.deepEqual(receivedConfigs[0].reasoning, { enabled: false });
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle rejects truncated plain-text output", async () => {
  resetTitleTestProviders();
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);
  provider.invokeSync = async () => ({
    id: "title-response",
    content: [
      {
        type: "text",
        text: "Five Questions About You\n\n1. What's your current profession or primary occupation?",
      },
    ],
    stopReason: "max_tokens",
  });

  providerRegistry.register(provider);

  try {
    const service = new ThreadTitleService({} as never, makeLogger());
    const generateTitle = Reflect.get(service, "generateTitle").bind(service) as (
      firstUserMessage: string,
    ) => Promise<string | null>;

    assert.equal(
      await generateTitle("Can you ask me 5 structured questions about myself?"),
      null,
    );
  } finally {
    resetTitleTestProviders();
  }
});

test("generateTitle wraps the first user message as text to summarize", async () => {
  resetTitleTestProviders();
  let receivedMessages: CanonicalMessage[] = [];
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);
  provider.invokeSync = async (messages) => {
    receivedMessages = messages;
    return {
      id: "title-response",
      content: [{ type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Five Questions About You" } }],
      stopReason: "end_turn",
    };
  };

  providerRegistry.register(provider);

  try {
    const service = new ThreadTitleService({} as never, makeLogger());
    const generateTitle = Reflect.get(service, "generateTitle").bind(service) as (
      firstUserMessage: string,
    ) => Promise<string | null>;

    const originalMessage = "Can you ask me 5 structured questions about myself?";
    assert.equal(await generateTitle(originalMessage), "Five Questions About You");
    assert.equal(receivedMessages.length, 2);
    assert.equal(receivedMessages[1]?.role, "user");
    assert.notEqual(receivedMessages[1]?.content, originalMessage);
    assert.match(String(receivedMessages[1]?.content), /Treat the message as text to summarize/);
    assert.match(String(receivedMessages[1]?.content), /<message>/);
    assert.match(String(receivedMessages[1]?.content), /Can you ask me 5 structured questions about myself\?/);
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


test("structured title validation rejects malformed and incomplete responses", async () => {
  resetTitleTestProviders();
  const provider = makeProvider("openai", ["gpt-5.6-luna"]);
  const call = { type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Valid Title" } } as const;
  let response: CanonicalResponse = { id: "test", content: [call], stopReason: "end_turn" };
  provider.invokeSync = async () => response;
  providerRegistry.register(provider);
  const service = new ThreadTitleService({} as never, makeLogger());
  const generate = Reflect.get(service, "generateTitle").bind(service);
  try {
    for (const input of [{}, { title: null }, { title: 1 }, { title: "  " },
      { title: "x".repeat(81) }, { title: "Valid", extra: true }]) {
      response = { id: "test", content: [{ ...call, input }], stopReason: "end_turn" };
      assert.equal(await generate("Summarize this"), null, JSON.stringify(input));
    }
    for (const stopReason of ["max_tokens", "error", "stop_sequence"] as const) {
      response = { id: "test", content: [call], stopReason };
      assert.equal(await generate("Summarize this"), null, stopReason);
    }
    for (const content of [[], [call, call], [{ ...call, name: "wrong" }],
      [{ type: "text" as const, text: '{"title":"Valid Title"}' }]]) {
      response = { id: "test", content, stopReason: "end_turn" };
      assert.equal(await generate("Summarize this"), null);
    }
    response = { id: "test", content: [{ ...call, input: { title: "x".repeat(80) } }], stopReason: "tool_use" };
    assert.equal(await generate("Summarize this"), "x".repeat(80));
  } finally {
    resetTitleTestProviders();
  }
});

test("stream-only providers require a completed structured response", async () => {
  resetTitleTestProviders();
  const provider = makeProvider("anthropic", ["claude-haiku-4-5-20251001"]);
  let complete = true;
  provider.invoke = async function* () {
    yield { type: "tool_use_done", index: 0, id: "t1", name: "submit_thread_title", input: { title: "Fix Deploy Script" } };
    if (complete) yield { type: "message_done", stop_reason: "tool_use" };
  };
  providerRegistry.register(provider);
  try {
    const service = new ThreadTitleService({} as never, makeLogger());
    const generate = Reflect.get(service, "generateTitle").bind(service);
    assert.equal(await generate("Fix deployment"), "Fix Deploy Script");
    complete = false;
    assert.equal(await generate("Fix deployment"), null);
  } finally {
    resetTitleTestProviders();
  }
});

for (const failure of ["provider_error", "invalid_output"] as const) {
  test(`title generation retries once after ${failure}`, async () => {
    resetTitleTestProviders();
    const provider = makeProvider("openai", ["gpt-5.6-luna"]);
    let calls = 0;
    let recover = true;
    provider.invokeSync = async () => {
      calls += 1;
      if (!recover || calls === 1) {
        if (failure === "provider_error") throw new Error("Provider unavailable");
        return { id: "bad", content: [], stopReason: "max_tokens" };
      }
      return {
        id: "good", stopReason: "end_turn",
        content: [{ type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Recovered Title" } }],
      };
    };
    providerRegistry.register(provider);
    try {
      const service = new ThreadTitleService({} as never, makeLogger());
      const generate = Reflect.get(service, "generateTitle").bind(service);
      assert.equal(await generate("Title this"), "Recovered Title");
      assert.equal(calls, 2);
      recover = false;
      calls = 0;
      assert.equal(await generate("Title this"), null);
      assert.equal(calls, 2);
    } finally {
      resetTitleTestProviders();
    }
  });
}

test("title timeout is 30 seconds per attempt with fresh signals and timer cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetTitleTestProviders();
  const provider = makeProvider("openai", ["gpt-5.6-luna"]);
  const signals: AbortSignal[] = [];
  let recover = true;
  provider.invokeSync = async (_messages, _tools, _config, signal) => {
    assert.ok(signal);
    signals.push(signal);
    if (recover && signals.length === 2) {
      return {
        id: "good", stopReason: "end_turn",
        content: [{ type: "tool_use", id: "t1", name: "submit_thread_title", input: { title: "Recovered Title" } }],
      };
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  providerRegistry.register(provider);
  try {
    const service = new ThreadTitleService({} as never, makeLogger());
    const generate = Reflect.get(service, "generateTitle").bind(service);
    const result = generate("Title this");
    t.mock.timers.tick(29_999);
    assert.equal(signals[0].aborted, false);
    assert.equal(signals.length, 1);
    t.mock.timers.tick(1);
    assert.equal(await result, "Recovered Title");
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], signals[1]);
    t.mock.timers.tick(30_000);
    assert.equal(signals[1].aborted, false, "successful attempt timer was cleared");

    signals.length = 0;
    recover = false;
    const exhausted = generate("Title this");
    t.mock.timers.tick(30_000);
    // Flush provider rejection and the generation catch before advancing retry time.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false);
    t.mock.timers.tick(30_000);
    assert.equal(await exhausted, null);
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, true);
  } finally {
    resetTitleTestProviders();
    t.mock.timers.reset();
  }
});
