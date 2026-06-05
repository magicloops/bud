import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import {
  buildRequestMode,
  canonicalBlockFromLedgerItem,
  loadProviderLedgerMessages,
  loadProviderLedgerThreadDiagnostics,
  recordLlmCall,
  recordLlmToolResultItem,
} from "./provider-ledger.js";

test("buildRequestMode maps providers to request modes", () => {
  assert.equal(buildRequestMode("openai"), "openai_responses");
  assert.equal(buildRequestMode("anthropic"), "anthropic_messages");
  assert.equal(buildRequestMode("ds4"), "ds4_openai_responses");
});

test("loadProviderLedgerMessages preserves historical ds4 chat request mode", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        innerJoin() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      llmCallId: "llm-call-ds4-chat",
                      createdAt: new Date("2026-06-02T10:00:00.000Z"),
                      model: "deepseek-v4-flash",
                      requestMode: "ds4_openai_chat",
                      itemKind: "text",
                      itemDirection: "output",
                      itemSequence: 0,
                      canonicalPayload: {
                        type: "text",
                        text: "Historical ds4 response.",
                      },
                      providerPayload: {},
                    },
                  ];
                },
              };
            },
          };
        },
      };
    },
  }) as never);

  const messages = await loadProviderLedgerMessages("thread-1", "ds4");

  assert.equal(messages[0]?.requestMode, "ds4_openai_chat");
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "Historical ds4 response." },
  ]);
});

test("recordLlmCall persists all provider output items and cache metadata", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const insertedValues: unknown[] = [];
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ insert: db.insert.bind(db) } as never)
  );
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
      { type: "text", text: "visible text", assistantPhase: "commentary" },
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
    reconstruction: {
      mode: "mixed_degraded",
      targetProvider: "openai",
      degraded: true,
      degradedReasons: ["provider_switch_canonical_fallback"],
      sourceProviders: ["openai", "anthropic"],
      providerNativeCallCount: 1,
      providerNativeOutputItemCount: 3,
      canonicalFallbackMessageCount: 2,
      omittedProviderOnlyItemCount: 1,
      providerCallCounts: {
        openai: 1,
        anthropic: 1,
      },
      providerOnlyOutputItemCounts: {
        anthropic: 1,
      },
    },
  });

  assert.equal(insertedValues.length, 2);
  assert.deepEqual((insertedValues[0] as Record<string, unknown>).cacheMetadata, {
    openai_cached_input_tokens: 12,
    reconstruction_mode: "mixed_degraded",
    reconstruction_degraded: true,
    reconstruction_target_provider: "openai",
    reconstruction_source_providers: ["openai", "anthropic"],
    reconstruction_provider_native_call_count: 1,
    reconstruction_provider_native_output_item_count: 3,
    reconstruction_canonical_fallback_message_count: 2,
    reconstruction_omitted_provider_only_item_count: 1,
    reconstruction_degraded_reasons: ["provider_switch_canonical_fallback"],
    reconstruction_provider_call_counts: {
      openai: 1,
      anthropic: 1,
    },
    reconstruction_provider_only_output_item_counts: {
      anthropic: 1,
    },
  });

  const itemValues = insertedValues[1] as Array<Record<string, unknown>>;
  assert.deepEqual(
    itemValues.map((item) => item.kind),
    ["text", "reasoning", "tool_use"],
  );
  assert.equal(itemValues[0]?.visibility, "product_text");
  assert.equal(itemValues[0]?.messageId, "message-1");
  assert.deepEqual(itemValues[0]?.canonicalPayload, {
    type: "text",
    text: "visible text",
    assistantPhase: "commentary",
  });
  assert.deepEqual(itemValues[1]?.providerPayload, {
    id: "rs-1",
    type: "reasoning",
    encrypted_content: "opaque",
  });
  assert.equal(itemValues[2]?.toolCallId, "call-1");
});

test("recordLlmCall rolls back call row when output item insertion fails", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const committedValues: unknown[] = [];
  mock.method(db, "transaction", async (callback: (tx: unknown) => Promise<unknown>) => {
    const stagedValues: unknown[] = [];
    const tx = {
      insert() {
        return {
          values(values: unknown) {
            if (Array.isArray(values)) {
              throw new Error("item insert failed");
            }
            stagedValues.push(values);
            return {};
          },
        };
      },
    };

    await callback(tx as never);
    committedValues.push(...stagedValues);
  });

  await assert.rejects(
    recordLlmCall({
      llmCallId: "llm-call-rollback",
      threadId: "thread-1",
      turnId: "turn-1",
      stepIndex: 0,
      provider: "openai",
      model: "gpt-5.5",
      requestMode: "openai_responses",
      output: [{ type: "text", text: "visible text" }],
    }),
    /item insert failed/,
  );

  assert.deepEqual(committedValues, []);
});

test("recordLlmToolResultItem persists ask_user_questions tool-result payloads for provider replay", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  let insertedValue: Record<string, unknown> | null = null;
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      insertedValue = values;
      return {};
    },
  }) as never);

  const payload = {
    tool: "ask_user_questions",
    call_id: "call-question",
    schema: "ask_user_questions_request_v1",
    request_id: "qr_test",
    kind: "user_questions",
    result: {
      schema: "ask_user_questions_tool_result_v1",
      request_id: "qr_test",
      responses: [],
      summary_markdown: "Question response",
    },
  };

  await recordLlmToolResultItem({
    llmCallId: "llm-call-1",
    threadId: "thread-1",
    sequence: 3,
    toolCallId: "call-question",
    content: JSON.stringify(payload),
    payload,
    messageId: "message-question-1",
    ownerUserId: "user-1",
  });

  const captured = insertedValue as Record<string, unknown> | null;
  assert.ok(captured);
  assert.equal(captured.llmCallId, "llm-call-1");
  assert.equal(captured.threadId, "thread-1");
  assert.equal(captured.direction, "input");
  assert.equal(captured.role, "user");
  assert.equal(captured.kind, "tool_result");
  assert.equal(captured.sequence, 3);
  assert.equal(captured.toolCallId, "call-question");
  assert.equal(captured.messageId, "message-question-1");
  assert.equal(captured.createdByUserId, "user-1");
  assert.deepEqual(captured.providerPayload, payload);
  assert.deepEqual(captured.canonicalPayload, {
    type: "tool_result",
    tool_use_id: "call-question",
    content: JSON.stringify(payload),
  });
});

test("loadProviderLedgerThreadDiagnostics summarizes provider-native and omitted provider-only items", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        leftJoin() {
          return {
            async where() {
              return [
                {
                  provider: "openai",
                  llmCallId: "llm-call-openai",
                  status: "completed",
                  itemDirection: "output",
                  itemVisibility: "provider_only",
                },
                {
                  provider: "openai",
                  llmCallId: "llm-call-openai",
                  status: "completed",
                  itemDirection: "output",
                  itemVisibility: "product_text",
                },
                {
                  provider: "anthropic",
                  llmCallId: "llm-call-anthropic",
                  status: "completed",
                  itemDirection: "output",
                  itemVisibility: "provider_only",
                },
                {
                  provider: "anthropic",
                  llmCallId: "llm-call-anthropic",
                  status: "completed",
                  itemDirection: "input",
                  itemVisibility: "tool",
                },
              ];
            },
          };
        },
      };
    },
  }) as never);

  const diagnostics = await loadProviderLedgerThreadDiagnostics("thread-1");

  assert.deepEqual(diagnostics, {
    providerCallCounts: {
      openai: 1,
      anthropic: 1,
    },
    outputItemCounts: {
      openai: 2,
      anthropic: 1,
    },
    providerOnlyOutputItemCounts: {
      openai: 1,
      anthropic: 1,
    },
  });
});

test("loadProviderLedgerThreadDiagnostics reports itemless and outputless completed calls", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        leftJoin() {
          return {
            async where() {
              return [
                {
                  provider: "openai",
                  llmCallId: "llm-call-itemless",
                  status: "completed",
                  itemDirection: null,
                  itemVisibility: null,
                },
                {
                  provider: "anthropic",
                  llmCallId: "llm-call-outputless",
                  status: "completed",
                  itemDirection: "input",
                  itemVisibility: "tool",
                },
              ];
            },
          };
        },
      };
    },
  }) as never);

  const diagnostics = await loadProviderLedgerThreadDiagnostics("thread-1");

  assert.deepEqual(diagnostics, {
    providerCallCounts: {
      openai: 1,
      anthropic: 1,
    },
    outputItemCounts: {},
    providerOnlyOutputItemCounts: {},
    itemlessCompletedCallCounts: {
      openai: 1,
    },
    outputlessCompletedCallCounts: {
      anthropic: 1,
    },
  });
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

test("canonicalBlockFromLedgerItem reconstructs text assistant phase", () => {
  const block = canonicalBlockFromLedgerItem({
    kind: "text",
    canonicalPayload: {
      type: "text",
      text: "Visible text",
      assistantPhase: "final_answer",
    },
    providerPayload: {},
  } as never);

  assert.deepEqual(block, {
    type: "text",
    text: "Visible text",
    assistantPhase: "final_answer",
  });
});

test("loadProviderLedgerMessages derives historical OpenAI assistant phases", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        innerJoin() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      llmCallId: "llm-call-tool",
                      createdAt: new Date("2026-05-22T10:00:00.000Z"),
                      model: "gpt-5.5",
                      requestMode: "openai_responses",
                      itemKind: "text",
                      itemDirection: "output",
                      itemSequence: 0,
                      canonicalPayload: {
                        type: "text",
                        text: "I will inspect first.",
                      },
                      providerPayload: {},
                    },
                    {
                      llmCallId: "llm-call-tool",
                      createdAt: new Date("2026-05-22T10:00:00.000Z"),
                      model: "gpt-5.5",
                      requestMode: "openai_responses",
                      itemKind: "tool_use",
                      itemDirection: "output",
                      itemSequence: 1,
                      canonicalPayload: {
                        type: "tool_use",
                        id: "call-observe",
                        name: "terminal_observe",
                        input: { view: "screen" },
                      },
                      providerPayload: {},
                    },
                    {
                      llmCallId: "llm-call-final",
                      createdAt: new Date("2026-05-22T10:00:01.000Z"),
                      model: "gpt-5.5",
                      requestMode: "openai_responses",
                      itemKind: "text",
                      itemDirection: "output",
                      itemSequence: 0,
                      canonicalPayload: {
                        type: "text",
                        text: "Done.",
                      },
                      providerPayload: {},
                    },
                  ];
                },
              };
            },
          };
        },
      };
    },
  }) as never);

  const messages = await loadProviderLedgerMessages("thread-1", "openai");

  assert.deepEqual(messages.map((message) => message.content), [
    [
      { type: "text", text: "I will inspect first.", assistantPhase: "commentary" },
      {
        type: "tool_use",
        id: "call-observe",
        name: "terminal_observe",
        input: { view: "screen" },
      },
    ],
    [{ type: "text", text: "Done.", assistantPhase: "final_answer" }],
  ]);
});
