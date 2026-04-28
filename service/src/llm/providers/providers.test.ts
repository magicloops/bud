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

test("OpenAI provider preserves completed response payload for diagnostics", async () => {
  const provider = new OpenAIProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      responses: {
        create(): Promise<AsyncIterable<unknown>>;
      };
    };
  };

  providerWithClient.client.responses.create = async () =>
    (async function* stream() {
      yield {
        type: "response.created",
        response: {
          id: "resp_diag",
        },
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_diag",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "rs_diag",
              summary: [],
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 2,
          },
        },
      };
    })();

  const events = [];
  for await (const event of provider.invoke(messages, [], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  })) {
    events.push(event);
  }

  const done = events.find((event) => event.type === "message_done");
  assert.ok(done);
  assert.equal(done.providerData?.provider, "openai");

  const payload = done.providerData?.payload as { id: string; output: unknown[] };
  assert.equal(payload.id, "resp_diag");
  assert.deepEqual(payload.output, [
    {
      type: "reasoning",
      id: "rs_diag",
      summary: [],
    },
  ]);
});

test("OpenAI provider preserves function call name and call_id from streamed item metadata", async () => {
  const provider = new OpenAIProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      responses: {
        create(): Promise<AsyncIterable<unknown>>;
      };
    };
  };

  providerWithClient.client.responses.create = async () =>
    (async function* stream() {
      yield {
        type: "response.created",
        response: {
          id: "resp_tool",
        },
      };
      yield {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_tool",
          type: "function_call",
          call_id: "call_tool",
          name: "terminal_send",
        },
      };
      yield {
        type: "response.function_call_arguments.done",
        item_id: "fc_tool",
        output_index: 1,
        arguments: JSON.stringify({
          text: "pwd",
          submit: true,
          key: null,
          observe_after_ms: null,
          wait_for: "settled",
        }),
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_tool",
          status: "completed",
          usage: {
            input_tokens: 3,
            output_tokens: 2,
          },
        },
      };
    })();

  const events = [];
  for await (const event of provider.invoke(messages, [], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  })) {
    events.push(event);
  }

  const toolUseDone = events.find((event) => event.type === "tool_use_done");
  assert.ok(toolUseDone);
  assert.equal(toolUseDone.id, "call_tool");
  assert.equal(toolUseDone.name, "terminal_send");
  assert.deepEqual(toolUseDone.input, {
    text: "pwd",
    submit: true,
    key: null,
    observe_after_ms: null,
    wait_for: "settled",
  });
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
