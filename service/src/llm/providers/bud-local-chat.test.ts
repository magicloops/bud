import assert from "node:assert/strict";
import test from "node:test";
import {
  BudLocalChatCompletionsProvider,
  toChatMessages,
  transformChatCompletionsStream,
} from "./bud-local-chat.js";
import type { CanonicalMessage, CanonicalStreamEvent } from "../types.js";

async function* fromChunks(chunks: unknown[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? chunk : JSON.stringify(chunk);
  }
}

async function collect(
  stream: AsyncIterable<CanonicalStreamEvent>,
): Promise<CanonicalStreamEvent[]> {
  const events: CanonicalStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function delta(payload: Record<string, unknown>, finish: string | null = null) {
  return { id: "chatcmpl-1", choices: [{ delta: payload, finish_reason: finish }] };
}

test("structured reasoning_content and reasoning deltas map to the reasoning stream", async () => {
  const events = await collect(
    transformChatCompletionsStream(
      fromChunks([
        delta({ reasoning_content: "think a" }),
        delta({ reasoning: " and b" }),
        delta({ content: "answer" }),
        delta({}, "stop"),
        "[DONE]",
      ]),
    ),
  );

  const reasoningDeltas = events
    .filter((e) => e.type === "reasoning_delta")
    .map((e) => (e.type === "reasoning_delta" ? e.delta : ""));
  assert.deepEqual(reasoningDeltas, ["think a", " and b"]);
  const done = events.find((e) => e.type === "reasoning_done");
  assert.equal(
    done?.type === "reasoning_done" ? done.block.type === "reasoning" && done.block.text : "",
    "think a and b",
  );
  const textDeltas = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e.type === "text_delta" ? e.delta : ""));
  assert.deepEqual(textDeltas, ["answer"]);
  // Reasoning closes before text opens.
  const reasoningDoneAt = events.findIndex((e) => e.type === "reasoning_done");
  const contentStartAt = events.findIndex((e) => e.type === "content_start");
  assert.ok(reasoningDoneAt < contentStartAt);
  const messageDone = events.at(-1);
  assert.equal(messageDone?.type, "message_done");
  assert.equal(messageDone?.type === "message_done" ? messageDone.stop_reason : "", "end_turn");
});

test("inline <think> blocks are extracted into reasoning even when split across chunks", async () => {
  const events = await collect(
    transformChatCompletionsStream(
      fromChunks([
        delta({ content: "<thi" }),
        delta({ content: "nk>secret plan" }),
        delta({ content: " continues</thi" }),
        delta({ content: "nk>  visible answer" }),
        delta({}, "stop"),
        "[DONE]",
      ]),
    ),
  );

  const reasoning = events
    .filter((e) => e.type === "reasoning_delta")
    .map((e) => (e.type === "reasoning_delta" ? e.delta : ""))
    .join("");
  assert.equal(reasoning, "secret plan continues");
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e.type === "text_delta" ? e.delta : ""))
    .join("");
  assert.equal(text, "visible answer");
});

test("content without think tags flows straight to text", async () => {
  const events = await collect(
    transformChatCompletionsStream(
      fromChunks([delta({ content: "plain" }), delta({ content: " text" }), delta({}, "stop"), "[DONE]"]),
    ),
  );
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e.type === "text_delta" ? e.delta : ""))
    .join("");
  assert.equal(text, "plain text");
  assert.equal(events.some((e) => e.type === "reasoning_start"), false);
});

test("tool call deltas accumulate into tool_use events and force tool_use stop", async () => {
  const events = await collect(
    transformChatCompletionsStream(
      fromChunks([
        delta({
          tool_calls: [
            { index: 0, id: "call_1", function: { name: "terminal.run", arguments: "" } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
        delta({}, "tool_calls"),
        {
          id: "chatcmpl-1",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        "[DONE]",
      ]),
    ),
  );

  const start = events.find((e) => e.type === "tool_use_start");
  assert.equal(start?.type === "tool_use_start" ? start.name : "", "terminal.run");
  const done = events.find((e) => e.type === "tool_use_done");
  assert.deepEqual(done?.type === "tool_use_done" ? done.input : {}, { cmd: "ls" });
  const messageDone = events.at(-1);
  assert.equal(messageDone?.type === "message_done" ? messageDone.stop_reason : "", "tool_use");
  assert.deepEqual(
    messageDone?.type === "message_done" ? messageDone.usage : undefined,
    { input_tokens: 10, output_tokens: 5 },
  );
});

test("length finish reason maps to max_tokens", async () => {
  const events = await collect(
    transformChatCompletionsStream(
      fromChunks([delta({ content: "cut" }, "length"), "[DONE]"]),
    ),
  );
  const messageDone = events.at(-1);
  assert.equal(messageDone?.type === "message_done" ? messageDone.stop_reason : "", "max_tokens");
});

test("reasoning replay is turn-scoped: only the in-flight tool loop keeps it", () => {
  const messages: CanonicalMessage[] = [
    { role: "system", content: "be useful" },
    { role: "user", content: "earlier question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "OLD turn reasoning" },
        { type: "text", text: "earlier answer" },
      ],
    },
    { role: "user", content: "current question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "current turn reasoning" },
        { type: "tool_use", id: "call_9", name: "terminal.run", input: { cmd: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_9", content: "file.txt" }],
    },
  ];

  const chat = toChatMessages(messages);
  assert.deepEqual(
    chat.map((m) => m.role),
    ["system", "user", "assistant", "user", "assistant", "tool"],
  );
  // Completed turn drops reasoning.
  assert.equal(chat[2].reasoning_content, undefined);
  assert.equal(chat[2].content, "earlier answer");
  // In-flight turn (after the last real user message) replays it.
  assert.equal(chat[4].reasoning_content, "current turn reasoning");
  assert.equal(chat[4].tool_calls?.[0].function.name, "terminal.run");
  assert.equal(chat[4].tool_calls?.[0].function.arguments, '{"cmd":"ls"}');
  // Tool results become role:"tool" messages (not user turn boundaries).
  assert.equal(chat[5].role, "tool");
  assert.equal(chat[5].tool_call_id, "call_9");
  assert.equal(chat[5].content, "file.txt");
});

test("buildRequest targets the served model id and wires tools", () => {
  const provider = new BudLocalChatCompletionsProvider();
  const request = provider.buildRequest(
    [{ role: "user", content: "hi" }],
    [{ name: "t", description: "d", parameters: { type: "object" } }],
    { model: "bud-local:b_01ABC:llama-3.3-70b", maxOutputTokens: 2048 },
  );
  assert.equal(request.model, "llama-3.3-70b");
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.stream, true);
  assert.equal(request.stream_options.include_usage, true);
  assert.equal(request.tools?.[0].function.name, "t");
  assert.equal(request.tool_choice, "auto");
});
