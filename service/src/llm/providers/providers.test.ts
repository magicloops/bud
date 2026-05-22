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
  assert.deepEqual(capturedParams[0].include, ["reasoning.encrypted_content"]);
  assert.equal(capturedParams[0].parallel_tool_calls, false);
  assert.equal("reasoning" in capturedParams[1], false);
});

test("OpenAI provider recursively transforms nested tool schemas for strict mode", async () => {
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

  await drain(provider.invoke(messages, [
    {
      name: "ask_user_questions",
      description: "Ask structured questions",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                choices: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      choice_id: { type: "string" },
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["choice_id", "label"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
  ], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: { enabled: false },
  }));

  const tools = capturedParams[0].tools as Array<Record<string, unknown>>;
  const tool = tools[0];
  const parameters = tool.parameters as Record<string, unknown>;
  const questions = (parameters.properties as Record<string, unknown>).questions as Record<string, unknown>;
  const questionItem = questions.items as Record<string, unknown>;
  const questionProperties = questionItem.properties as Record<string, unknown>;
  const choices = questionProperties.choices as Record<string, unknown>;
  const choiceItem = choices.items as Record<string, unknown>;
  const choiceProperties = choiceItem.properties as Record<string, Record<string, unknown>>;

  assert.deepEqual(parameters.required, ["questions"]);
  assert.deepEqual(questionItem.required, ["label", "choices"]);
  assert.deepEqual(choices.type, ["array", "null"]);
  assert.deepEqual(choiceItem.required, ["choice_id", "label", "description"]);
  assert.deepEqual(choiceProperties.description.type, ["string", "null"]);
  assert.equal(choiceItem.additionalProperties, false);
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

test("OpenAI provider preserves text between multiple streamed tool calls", async () => {
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
      yield { type: "response.created", response: { id: "resp_multi_tool" } };
      yield {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text" },
      };
      yield {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "before tool",
      };
      yield {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
      };
      yield {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_first",
          type: "function_call",
          call_id: "call_first",
          name: "terminal_observe",
        },
      };
      yield {
        type: "response.function_call_arguments.done",
        item_id: "fc_first",
        output_index: 1,
        arguments: JSON.stringify({ view: "screen" }),
      };
      yield {
        type: "response.content_part.added",
        output_index: 2,
        content_index: 0,
        part: { type: "output_text" },
      };
      yield {
        type: "response.output_text.delta",
        output_index: 2,
        content_index: 0,
        delta: "between tools",
      };
      yield {
        type: "response.output_text.done",
        output_index: 2,
        content_index: 0,
      };
      yield {
        type: "response.output_item.added",
        output_index: 3,
        item: {
          id: "fc_second",
          type: "function_call",
          call_id: "call_second",
          name: "terminal_send",
        },
      };
      yield {
        type: "response.function_call_arguments.done",
        item_id: "fc_second",
        output_index: 3,
        arguments: JSON.stringify({ text: "pwd", submit: true }),
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_multi_tool",
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            input_tokens_details: {
              cached_tokens: 7,
            },
            output_tokens_details: {
              reasoning_tokens: 2,
            },
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

  const contentAndTools = events.filter((event) =>
    event.type === "text_delta" || event.type === "tool_use_done"
  );
  assert.deepEqual(
    contentAndTools.map((event) =>
      event.type === "text_delta" ? event.delta : event.id
    ),
    ["before tool", "call_first", "between tools", "call_second"],
  );

  const done = events.find((event) => event.type === "message_done");
  assert.ok(done);
  assert.deepEqual(done.usage, {
    input_tokens: 10,
    output_tokens: 5,
    reasoning_tokens: 2,
    cached_input_tokens: 7,
  });
});

test("OpenAI provider sends assistant history in canonical block order", async () => {
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

  await drain(provider.invoke([
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "summary",
          providerData: {
            provider: "openai",
            payload: {
              type: "reasoning",
              id: "rs_order",
            },
          },
        },
        { type: "text", text: "before", assistantPhase: "commentary" },
        {
          type: "tool_use",
          id: "call_first",
          name: "terminal_observe",
          input: { view: "screen" },
        },
        { type: "text", text: "between", assistantPhase: "commentary" },
        {
          type: "tool_use",
          id: "call_second",
          name: "terminal_send",
          input: { text: "pwd", submit: true },
        },
      ],
    },
  ], [], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  }));

  const input = capturedParams[0].input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.map((item) => {
      if (item.type === "message") {
        return `message:${item.content}:${item.phase ?? "none"}`;
      }
      if (item.type === "function_call") {
        return `tool:${item.call_id}`;
      }
      return `${item.type}:${item.id}`;
    }),
    [
      "reasoning:rs_order",
      "message:before:commentary",
      "tool:call_first",
      "message:between:commentary",
      "tool:call_second",
    ],
  );
});

test("OpenAI provider preserves streamed output message phase on text events", async () => {
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
      yield { type: "response.created", response: { id: "resp_phase_stream" } };
      yield {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_phase",
          type: "message",
          role: "assistant",
          phase: "commentary",
        },
      };
      yield {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text" },
      };
      yield {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "I will inspect first.",
      };
      yield {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
      };
      yield {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "msg_final_phase",
          type: "message",
          role: "assistant",
          phase: "final_answer",
        },
      };
      yield {
        type: "response.content_part.added",
        output_index: 1,
        content_index: 0,
        part: { type: "output_text" },
      };
      yield {
        type: "response.output_text.delta",
        output_index: 1,
        content_index: 0,
        delta: "Done.",
      };
      yield {
        type: "response.output_text.done",
        output_index: 1,
        content_index: 0,
      };
      yield {
        type: "response.completed",
        response: {
          id: "resp_phase_stream",
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

  const contentStarts = events.filter((event) => event.type === "content_start");
  assert.deepEqual(
    contentStarts.map((event) => event.assistantPhase),
    ["commentary", "final_answer"],
  );

  const textDeltas = events.filter((event) => event.type === "text_delta");
  assert.deepEqual(
    textDeltas.map((event) => event.assistantPhase),
    ["commentary", "final_answer"],
  );
});

test("OpenAI provider preserves non-streaming output message phase", async () => {
  const provider = new OpenAIProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      responses: {
        create(): Promise<Record<string, unknown>>;
      };
    };
  };

  providerWithClient.client.responses.create = async () => ({
    id: "resp_phase_sync",
    status: "completed",
    output: [
      {
        id: "msg_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "I will inspect first.",
          },
        ],
      },
      {
        id: "msg_final",
        type: "message",
        role: "assistant",
        phase: "final_answer",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Done.",
          },
        ],
      },
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
    },
  });

  const response = await provider.invokeSync(messages, [], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  });

  assert.deepEqual(response.content, [
    { type: "text", text: "I will inspect first.", assistantPhase: "commentary" },
    { type: "text", text: "Done.", assistantPhase: "final_answer" },
  ]);
});

test("OpenAI provider lowers final_answer assistant phase on replay", async () => {
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

  await drain(provider.invoke([
    {
      role: "assistant",
      content: [{ type: "text", text: "Done.", assistantPhase: "final_answer" }],
    },
  ], [], {
    model: "gpt-5.4-2026-03-05",
    maxOutputTokens: 128000,
    reasoning: {
      enabled: false,
    },
  }));

  const input = capturedParams[0].input as Array<Record<string, unknown>>;
  assert.deepEqual(input, [
    {
      type: "message",
      role: "assistant",
      content: "Done.",
      phase: "final_answer",
    },
  ]);
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

test("Anthropic provider ignores OpenAI assistant phase metadata", async () => {
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

  await drain(provider.invoke([
    {
      role: "assistant",
      content: [{ type: "text", text: "Prior note", assistantPhase: "commentary" }],
    },
  ], [], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
  }));

  assert.ok(capturedParams);
  const replayMessages = (capturedParams as Record<string, unknown>).messages as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(replayMessages, [
    {
      role: "assistant",
      content: [{ type: "text", text: "Prior note" }],
    },
  ]);
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

test("Anthropic provider omits tool_choice without tools and maps none when tools exist", async () => {
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
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
    toolChoice: "none",
  }));

  await drain(provider.invoke(messages, [
    {
      name: "terminal_send",
      description: "Send terminal input",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
    toolChoice: "none",
  }));

  assert.equal("tool_choice" in capturedParams[0], false);
  assert.deepEqual(capturedParams[1].tool_choice, { type: "none" });
});

test("Anthropic provider preserves signed thinking blocks for replay", async () => {
  const provider = new AnthropicProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      messages: {
        stream(params: Record<string, unknown>): AsyncIterable<unknown>;
      };
    };
  };

  providerWithClient.client.messages.stream = () => {
    const stream = (async function* stream() {
      yield {
        type: "message_start",
        message: {
          id: "msg_thinking",
        },
      };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "thinking",
        },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Check the terminal state.",
        },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "signature_delta",
          signature: "sig-part-1",
        },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "signature_delta",
          signature: "sig-part-2",
        },
      };
      yield {
        type: "content_block_stop",
        index: 0,
      };
      yield {
        type: "message_stop",
      };
    })() as unknown as AsyncIterable<unknown> & {
      finalMessage(): Promise<Record<string, unknown>>;
    };
    stream.finalMessage = async () => ({
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 6,
      },
    });
    return stream;
  };

  const events = [];
  for await (const event of provider.invoke(messages, [], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
  })) {
    events.push(event);
  }

  const thinking = events.find((event) => event.type === "reasoning_done");
  assert.ok(thinking);
  assert.deepEqual(thinking.block, {
    type: "reasoning",
    text: "Check the terminal state.",
    providerData: {
      provider: "anthropic",
      payload: {
        type: "thinking",
        thinking: "Check the terminal state.",
        signature: "sig-part-1sig-part-2",
      },
    },
  });

  const capturedParams: Record<string, unknown>[] = [];
  providerWithClient.client.messages.stream = (params) => {
    capturedParams.push(params);
    return emptyStream();
  };

  await drain(provider.invoke([
    {
      role: "assistant",
      content: [thinking.block],
    },
  ], [], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
  }));

  const replayMessages = capturedParams[0].messages as Array<{ content: unknown[] }>;
  assert.deepEqual(replayMessages[0]?.content, [
    {
      type: "thinking",
      thinking: "Check the terminal state.",
      signature: "sig-part-1sig-part-2",
    },
  ]);
});

test("Anthropic provider preserves text and tool-use provider order", async () => {
  const provider = new AnthropicProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      messages: {
        stream(): AsyncIterable<unknown>;
      };
    };
  };

  providerWithClient.client.messages.stream = () => {
    const stream = (async function* stream() {
      yield { type: "message_start", message: { id: "msg_order" } };
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before tool" },
      };
      yield { type: "content_block_stop", index: 0 };
      yield {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "terminal_observe",
        },
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ view: "screen" }),
        },
      };
      yield { type: "content_block_stop", index: 1 };
      yield {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text" },
      };
      yield {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "after tool" },
      };
      yield { type: "content_block_stop", index: 2 };
      yield { type: "message_stop" };
    })() as unknown as AsyncIterable<unknown> & {
      finalMessage(): Promise<Record<string, unknown>>;
    };
    stream.finalMessage = async () => ({
      stop_reason: "tool_use",
      usage: {
        input_tokens: 12,
        output_tokens: 6,
      },
    });
    return stream;
  };

  const events = [];
  for await (const event of provider.invoke(messages, [], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
  })) {
    events.push(event);
  }

  const contentAndTools = events.filter((event) =>
    event.type === "text_delta" || event.type === "tool_use_done"
  );
  assert.deepEqual(
    contentAndTools.map((event) =>
      event.type === "text_delta" ? event.delta : event.id
    ),
    ["before tool", "toolu_1", "after tool"],
  );
});

test("Anthropic provider preserves redacted thinking blocks and cache usage", async () => {
  const provider = new AnthropicProvider("test-key");
  const providerWithClient = provider as unknown as {
    client: {
      messages: {
        stream(): AsyncIterable<unknown>;
      };
    };
  };

  providerWithClient.client.messages.stream = () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_redacted",
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "redacted_thinking",
          data: "encrypted-thinking",
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "message_stop",
      },
    ];
    const stream = (async function* stream() {
      yield* events;
    })() as unknown as AsyncIterable<unknown> & {
      finalMessage(): Promise<Record<string, unknown>>;
    };
    stream.finalMessage = async () => ({
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 6,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 8,
      },
    });
    return stream;
  };

  const events = [];
  for await (const event of provider.invoke(messages, [], {
    model: "claude-sonnet-4-6",
    maxOutputTokens: 32000,
  })) {
    events.push(event);
  }

  const redacted = events.find((event) => event.type === "reasoning_redacted");
  assert.ok(redacted);
  assert.deepEqual(redacted.block, {
    type: "reasoning_redacted",
    providerData: {
      provider: "anthropic",
      payload: {
        type: "redacted_thinking",
        data: "encrypted-thinking",
      },
    },
  });

  const done = events.find((event) => event.type === "message_done");
  assert.ok(done);
  assert.deepEqual(done.usage, {
    input_tokens: 12,
    output_tokens: 6,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 8,
  });
});
