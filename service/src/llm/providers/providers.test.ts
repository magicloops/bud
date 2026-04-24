import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { CanonicalMessage, ModelConfig } from "../types.js";

const messages: CanonicalMessage[] = [
  {
    role: "user",
    content: "Test request",
  },
];

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const event of iterable) {
    void event;
    // Drain stream to force provider request creation.
  }
}

function emptyStream<T>(): AsyncIterable<T> {
  return (async function* stream() {
    // Empty fake provider stream.
  })();
}

test("OpenAI provider sends xhigh reasoning and omits reasoning for none", async () => {
  const provider = new OpenAIProvider("test-key");
  const capturedParams: Record<string, unknown>[] = [];
  const providerWithClient = provider as unknown as {
    client: {
      responses: {
        create(params: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
      };
    };
  };

  providerWithClient.client.responses.create = async (params) => {
    capturedParams.push(params);
    return emptyStream();
  };

  const xhighConfig: ModelConfig = {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: true,
      effort: "xhigh",
      summaryLevel: "auto",
    },
  };
  await drain(provider.invoke(messages, [], xhighConfig));

  const fastConfig: ModelConfig = {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  };
  await drain(provider.invoke(messages, [], fastConfig));

  assert.deepEqual(capturedParams[0].reasoning, {
    effort: "xhigh",
    summary: "auto",
  });
  assert.equal("reasoning" in capturedParams[1], false);
});

test("Anthropic provider lowers adaptive effort models without manual budgets", async () => {
  const provider = new AnthropicProvider("test-key");
  const capturedParams: Record<string, unknown>[] = [];
  const providerWithClient = provider as unknown as {
    client: {
      messages: {
        stream(params: Record<string, unknown>): AsyncIterable<unknown>;
      };
    };
  };

  providerWithClient.client.messages.stream = (params) => {
    capturedParams.push(params);
    return emptyStream();
  };

  await drain(provider.invoke(messages, [], {
    model: "claude-opus-4-7",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: true,
      effort: "xhigh",
    },
  }));

  await drain(provider.invoke(messages, [], {
    model: "claude-opus-4-6",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: true,
      effort: "max",
    },
  }));

  assert.deepEqual(capturedParams[0].thinking, {
    type: "adaptive",
    display: "omitted",
  });
  assert.deepEqual(capturedParams[0].output_config, {
    effort: "xhigh",
  });
  assert.equal("budget_tokens" in (capturedParams[0].thinking as Record<string, unknown>), false);

  assert.deepEqual(capturedParams[1].thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(capturedParams[1].output_config, {
    effort: "max",
  });
});

test("Anthropic provider keeps Haiku 4.5 on manual thinking budgets", async () => {
  const provider = new AnthropicProvider("test-key");
  let capturedParams: Record<string, unknown> | null = null;
  const providerWithClient = provider as unknown as {
    client: {
      messages: {
        stream(params: Record<string, unknown>): AsyncIterable<unknown>;
      };
    };
  };

  providerWithClient.client.messages.stream = (params) => {
    capturedParams = params;
    return emptyStream();
  };

  await drain(provider.invoke(messages, [], {
    model: "claude-haiku-4-5-20251001",
    maxOutputTokens: 64000,
    reasoning: {
      enabled: true,
      effort: "medium",
    },
  }));

  assert.ok(capturedParams);
  const haikuParams = capturedParams as Record<string, unknown>;
  assert.deepEqual(haikuParams.thinking, {
    type: "enabled",
    budget_tokens: 4096,
  });
  assert.equal("output_config" in haikuParams, false);
});
