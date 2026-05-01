import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { canonicalBlockFromLedgerItem, recordLlmCall } from "./provider-ledger.js";

test("recordLlmCall persists all provider output items and cache metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: unknown[] = [];
  mock.method(db, "insert", () => ({
    values(values: unknown) {
      insertedValues.push(values);
      return {};
    },
  }) as never);

  await recordLlmCall({
    llmCallId: "llm-call-1",
    threadId: "thread-1",
    turnId: "turn-1",
    stepIndex: 0,
    provider: "openai",
    model: "gpt-5.5",
    requestMode: "openai_responses",
    providerResponseId: "resp-1",
    assistantMessageId: "message-1",
    output: [
      { type: "text", text: "visible text" },
      {
        type: "reasoning",
        text: "summary",
        providerData: {
          provider: "openai",
          payload: {
            id: "rs-1",
            type: "reasoning",
            encrypted_content: "opaque",
          },
        },
      },
      {
        type: "tool_use",
        id: "call-1",
        name: "terminal_send",
        input: { text: "pwd", submit: true },
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      reasoning_tokens: 4,
      cached_input_tokens: 12,
    },
  });

  assert.equal(insertedValues.length, 2);
  assert.deepEqual((insertedValues[0] as Record<string, unknown>).cacheMetadata, {
    openai_cached_input_tokens: 12,
  });

  const itemValues = insertedValues[1] as Array<Record<string, unknown>>;
  assert.deepEqual(
    itemValues.map((item) => item.kind),
    ["text", "reasoning", "tool_use"],
  );
  assert.equal(itemValues[0]?.visibility, "product_text");
  assert.equal(itemValues[0]?.messageId, "message-1");
  assert.deepEqual(itemValues[1]?.providerPayload, {
    id: "rs-1",
    type: "reasoning",
    encrypted_content: "opaque",
  });
  assert.equal(itemValues[2]?.toolCallId, "call-1");
});

test("canonicalBlockFromLedgerItem reconstructs redacted Anthropic thinking", () => {
  const block = canonicalBlockFromLedgerItem({
    kind: "reasoning_redacted",
    canonicalPayload: {
      type: "reasoning_redacted",
      providerData: {
        provider: "anthropic",
        payload: {
          type: "redacted_thinking",
          data: "canonical",
        },
      },
    },
    providerPayload: {
      type: "redacted_thinking",
      data: "provider",
    },
  } as never);

  assert.deepEqual(block, {
    type: "reasoning_redacted",
    providerData: {
      provider: "anthropic",
      payload: {
        type: "redacted_thinking",
        data: "provider",
      },
    },
  });
});
