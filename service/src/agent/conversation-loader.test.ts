import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { AGENT_SYSTEM_PROMPT, AgentConversationLoader } from "./conversation-loader.js";
import type { AgentContextCheckpoint } from "./context-checkpoint-repository.js";

function createLoader(checkpoint: AgentContextCheckpoint | null = null): AgentConversationLoader {
  return new AgentConversationLoader({
    async getLatestCompletedCheckpoint() {
      return checkpoint;
    },
  });
}

test("system prompt documents only public wait_for modes", () => {
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /shell_ready/);
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /screen_stable/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"settled"/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"changed"/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"none"/);
  assert.match(AGENT_SYSTEM_PROMPT, /target_host:"localhost"/);
  assert.match(AGENT_SYSTEM_PROMPT, /Do not substitute 127\.0\.0\.1 for localhost/);
  assert.match(AGENT_SYSTEM_PROMPT, /the service defaults to localhost/);
});

test("system prompt scopes ask_user_questions usage policy", () => {
  assert.match(AGENT_SYSTEM_PROMPT, /Ask all currently needed user questions in one ask_user_questions call/);
  assert.match(AGENT_SYSTEM_PROMPT, /Do not ask multiple questions as a markdown list/);
  assert.match(AGENT_SYSTEM_PROMPT, /Never spill extra questions into markdown/);
  assert.match(AGENT_SYSTEM_PROMPT, /A normal markdown question is only for exactly one simple freeform answer/);
  assert.match(AGENT_SYSTEM_PROMPT, /convert it into ask_user_questions/);
  assert.match(AGENT_SYSTEM_PROMPT, /One-question prompts are fine for binary, choice, or constrained numeric decisions/);
  assert.match(AGENT_SYSTEM_PROMPT, /Never request passwords, API keys, tokens, private keys, or other secrets through ask_user_questions/);
  assert.match(AGENT_SYSTEM_PROMPT, /Every question is skippable, even when importance is "required"/);
});

test("load normalizes persisted tool rows and preserves preferred cwd context", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            async orderBy() {
              return [
                {
                  role: "user",
                  content: "List the files",
                  metadata: { preferred_cwd: "/repo" },
                },
                {
                  role: "reasoning",
                  content: "I need to inspect the directory listing.",
                  metadata: {
                    artifact_kind: "reasoning",
                    model_visible: false,
                    llm_call_id: "llm-call-1",
                  },
                },
                {
                  role: "tool",
                  content: JSON.stringify({
                    tool: "terminal.interrupt",
                    call_id: "call_interrupt_1",
                  }),
                  metadata: null,
                },
                {
                  role: "tool",
                  content: JSON.stringify({
                    tool: "terminal.observe",
                    call_id: "call_observe_1",
                    wait_for: "screen_stable",
                    view: "screen",
                    lines: 25,
                  }),
                  metadata: null,
                },
                {
                  role: "assistant",
                  content: "Done.",
                  metadata: null,
                },
              ];
            },
          };
        },
      };
    },
  }) as never);

  const loader = createLoader();
  const messages = await loader.load("thread-1");

  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages[1], {
    role: "user",
    content: [{ type: "text", text: "List the files\n\n[Preferred CWD: /repo]" }],
  });
  assert.deepEqual(messages[2], {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_interrupt_1",
        name: "terminal_send",
        input: { key: "ctrl+c" },
      },
    ],
  });
  assert.deepEqual(messages[4], {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "call_observe_1",
        name: "terminal_observe",
        input: { lines: 25, view: "screen", wait_for: "settled" },
      },
    ],
  });
  assert.deepEqual(messages.at(-1), {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
  });
  assert.equal(
    messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "text" && block.text.includes("directory listing")),
    ),
    false,
  );
});

test("load prefers same-provider ledger output over duplicate assistant product rows", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  let selectCalls = 0;
  mock.method(db, "select", () => {
    selectCalls += 1;

    if (selectCalls === 1) {
      return {
        from() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      messageId: "message-user-1",
                      role: "user",
                      content: "Inspect the terminal",
                      metadata: null,
                      createdAt: new Date("2026-04-30T10:00:00.000Z"),
                    },
                    {
                      messageId: "message-assistant-1",
                      role: "assistant",
                      content: "I will inspect first.",
                      metadata: { llm_call_id: "llm-call-1" },
                      createdAt: new Date("2026-04-30T10:00:01.000Z"),
                    },
                    {
                      messageId: "message-tool-1",
                      role: "tool",
                      content: JSON.stringify({
                        tool: "terminal.observe",
                        call_id: "call-observe-1",
                        view: "screen",
                      }),
                      metadata: { llm_call_id: "llm-call-1" },
                      createdAt: new Date("2026-04-30T10:00:02.000Z"),
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    return {
      from() {
        return {
          innerJoin() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [
                      {
                        llmCallId: "llm-call-1",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
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
                        llmCallId: "llm-call-1",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "gpt-5.5",
                        requestMode: "openai_responses",
                        itemKind: "tool_use",
                        itemDirection: "output",
                        itemSequence: 1,
                        canonicalPayload: {
                          type: "tool_use",
                          id: "call-observe-1",
                          name: "terminal_observe",
                          input: { view: "screen" },
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
    };
  });

  const loader = createLoader();
  const messages = await loader.load("thread-1", { provider: "openai" });

  assert.deepEqual(messages, [
    {
      role: "system",
      content: [{ type: "text", text: AGENT_SYSTEM_PROMPT }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Inspect the terminal" }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect first.", assistantPhase: "commentary" },
        {
          type: "tool_use",
          id: "call-observe-1",
          name: "terminal_observe",
          input: { view: "screen" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-observe-1",
          content: JSON.stringify({
            tool: "terminal.observe",
            call_id: "call-observe-1",
            view: "screen",
          }),
        },
      ],
    },
  ]);
});

test("load derives assistant phase from transcript metadata fallback", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            async orderBy() {
              return [
                {
                  role: "assistant",
                  content: "I will inspect first.",
                  metadata: { segment_kind: "intermediate" },
                },
                {
                  role: "assistant",
                  content: "Done.",
                  metadata: { assistant_phase: "final_answer", segment_kind: "final" },
                },
              ];
            },
          };
        },
      };
    },
  }) as never);

  const loader = createLoader();
  const messages = await loader.load("thread-1");

  assert.deepEqual(messages.slice(1), [
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect first.", assistantPhase: "commentary" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Done.", assistantPhase: "final_answer" }],
    },
  ]);
});

test("load prepends checkpoint replacement history and keeps visible transcript delta", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            async orderBy() {
              return [
                {
                  messageId: "message-user-after",
                  role: "user",
                  content: "Continue after checkpoint",
                  metadata: null,
                  createdAt: new Date("2026-05-23T10:01:00.000Z"),
                },
              ];
            },
          };
        },
      };
    },
  }) as never);

  const loader = createLoader({
    checkpointId: "checkpoint-1",
    threadId: "thread-1",
    trigger: "auto",
    reason: "context_limit",
    phase: "pre_turn",
    implementation: "local_summary",
    status: "completed",
    sourceProvider: "openai",
    sourceModel: "gpt-5.5",
    sourceReasoningEffort: "low",
    summary: "Earlier context summary.",
    replacementHistory: [
      {
        role: "system",
        content: [{ type: "text", text: "stale system prompt" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Checkpoint summary" }],
      },
    ],
    compactedThroughMessageCreatedAt: new Date("2026-05-23T10:00:00.000Z"),
    compactedThroughMessageId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
    compactedThroughLlmCallCreatedAt: null,
    compactedThroughLlmCallId: null,
    inputTokensBefore: 1000,
    estimatedTokensAfter: 100,
    error: null,
    tenantId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-05-23T10:00:01.000Z"),
    completedAt: new Date("2026-05-23T10:00:02.000Z"),
  });

  const { messages, reconstruction } = await loader.loadWithDiagnostics("thread-1");

  assert.deepEqual(messages, [
    {
      role: "system",
      content: [{ type: "text", text: AGENT_SYSTEM_PROMPT }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Checkpoint summary" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "Continue after checkpoint" }],
    },
  ]);
  assert.equal(reconstruction.checkpointApplied, true);
  assert.equal(reconstruction.checkpointId, "checkpoint-1");
  assert.equal(reconstruction.checkpointReplacementHistoryMessageCount, 1);
  assert.equal(
    reconstruction.compactedThroughMessageId,
    "017dbb12-3865-44fc-8228-17bc55af2cd5",
  );
});

test("loadWithDiagnostics marks provider switches as canonical fallback degradation", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  let selectCalls = 0;
  mock.method(db, "select", () => {
    selectCalls += 1;

    if (selectCalls === 1) {
      return {
        from() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      messageId: "message-user-1",
                      role: "user",
                      content: "Continue",
                      metadata: null,
                      createdAt: new Date("2026-04-30T10:00:00.000Z"),
                    },
                    {
                      messageId: "message-assistant-1",
                      role: "assistant",
                      content: "I checked it.",
                      metadata: { llm_call_id: "llm-call-anthropic" },
                      createdAt: new Date("2026-04-30T10:00:01.000Z"),
                    },
                    {
                      messageId: "message-tool-1",
                      role: "tool",
                      content: JSON.stringify({
                        tool: "terminal.observe",
                        call_id: "call-observe-1",
                        view: "screen",
                      }),
                      metadata: { llm_call_id: "llm-call-anthropic" },
                      createdAt: new Date("2026-04-30T10:00:02.000Z"),
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    if (selectCalls === 2) {
      return {
        from() {
          return {
            leftJoin() {
              return {
                async where() {
                  return [
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
                      itemDirection: "output",
                      itemVisibility: "product_text",
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    return {
      from() {
        return {
          innerJoin() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [];
                  },
                };
              },
            };
          },
        };
      },
    };
  });

  const loader = createLoader();
  const { messages, reconstruction } = await loader.loadWithDiagnostics("thread-1", {
    provider: "openai",
  });

  assert.deepEqual(messages.slice(1), [
    {
      role: "user",
      content: [{ type: "text", text: "Continue" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I checked it." }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-observe-1",
          name: "terminal_observe",
          input: { view: "screen" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-observe-1",
          content: JSON.stringify({
            tool: "terminal.observe",
            call_id: "call-observe-1",
            view: "screen",
          }),
        },
      ],
    },
  ]);
  assert.deepEqual(reconstruction, {
    mode: "canonical_fallback",
    targetProvider: "openai",
    degraded: true,
    degradedReasons: [
      "provider_switch_canonical_fallback",
      "missing_provider_ledger",
      "canonical_fallback_messages",
      "provider_only_items_omitted",
    ],
    sourceProviders: ["anthropic"],
    providerNativeCallCount: 0,
    providerNativeOutputItemCount: 0,
    canonicalFallbackMessageCount: 2,
    omittedProviderOnlyItemCount: 1,
    providerCallCounts: {
      anthropic: 1,
    },
    providerOnlyOutputItemCounts: {
      anthropic: 1,
    },
  });
});

test("loadWithDiagnostics keeps compatible Anthropic thinking replay provider-native", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  let selectCalls = 0;
  mock.method(db, "select", () => {
    selectCalls += 1;

    if (selectCalls === 1) {
      return {
        from() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      messageId: "message-user-1",
                      role: "user",
                      content: "Continue",
                      metadata: null,
                      createdAt: new Date("2026-04-30T10:00:00.000Z"),
                    },
                    {
                      messageId: "message-assistant-1",
                      role: "assistant",
                      content: "Visible plan.",
                      metadata: { llm_call_id: "llm-call-anthropic" },
                      createdAt: new Date("2026-04-30T10:00:01.000Z"),
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    if (selectCalls === 2) {
      return {
        from() {
          return {
            leftJoin() {
              return {
                async where() {
                  return [
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
                      itemDirection: "output",
                      itemVisibility: "product_text",
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    return {
      from() {
        return {
          innerJoin() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [
                      {
                        llmCallId: "llm-call-anthropic",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "claude-sonnet-4-6",
                        requestMode: "anthropic_messages",
                        itemKind: "reasoning",
                        itemDirection: "output",
                        itemSequence: 0,
                        canonicalPayload: {
                          type: "reasoning",
                          text: "Think first.",
                          providerData: {
                            provider: "anthropic",
                            payload: {
                              type: "thinking",
                              thinking: "Think first.",
                              signature: "sig-1",
                            },
                          },
                        },
                        providerPayload: {
                          type: "thinking",
                          thinking: "Think first.",
                          signature: "sig-1",
                        },
                      },
                      {
                        llmCallId: "llm-call-anthropic",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "claude-sonnet-4-6",
                        requestMode: "anthropic_messages",
                        itemKind: "text",
                        itemDirection: "output",
                        itemSequence: 1,
                        canonicalPayload: {
                          type: "text",
                          text: "Visible plan.",
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
    };
  });

  const loader = createLoader();
  const { messages, reconstruction } = await loader.loadWithDiagnostics("thread-1", {
    provider: "anthropic",
    targetModel: "claude-sonnet-4-6",
    targetReasoning: { enabled: true, effort: "medium", summaryLevel: "auto" },
  });

  assert.deepEqual(messages.slice(1), [
    {
      role: "user",
      content: [{ type: "text", text: "Continue" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Think first.",
          providerData: {
            provider: "anthropic",
            payload: {
              type: "thinking",
              thinking: "Think first.",
              signature: "sig-1",
            },
          },
        },
        { type: "text", text: "Visible plan." },
      ],
    },
  ]);
  assert.deepEqual(reconstruction, {
    mode: "provider_native",
    targetProvider: "anthropic",
    targetModel: "claude-sonnet-4-6",
    targetReasoning: { enabled: true, effort: "medium", summaryLevel: "auto" },
    degraded: false,
    degradedReasons: [],
    sourceProviders: ["anthropic"],
    providerNativeCallCount: 1,
    providerNativeOutputItemCount: 2,
    canonicalFallbackMessageCount: 0,
    omittedProviderOnlyItemCount: 0,
    providerCallCounts: {
      anthropic: 1,
    },
    providerOnlyOutputItemCounts: {
      anthropic: 1,
    },
  });
});

test("loadWithDiagnostics falls back when Anthropic thinking replay is incompatible", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  let selectCalls = 0;
  mock.method(db, "select", () => {
    selectCalls += 1;

    if (selectCalls === 1) {
      return {
        from() {
          return {
            where() {
              return {
                async orderBy() {
                  return [
                    {
                      messageId: "message-user-1",
                      role: "user",
                      content: "Continue",
                      metadata: null,
                      createdAt: new Date("2026-04-30T10:00:00.000Z"),
                    },
                    {
                      messageId: "message-assistant-1",
                      role: "assistant",
                      content: "Visible plan.",
                      metadata: { llm_call_id: "llm-call-anthropic" },
                      createdAt: new Date("2026-04-30T10:00:01.000Z"),
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    if (selectCalls === 2) {
      return {
        from() {
          return {
            leftJoin() {
              return {
                async where() {
                  return [
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
                      itemDirection: "output",
                      itemVisibility: "provider_only",
                    },
                    {
                      provider: "anthropic",
                      llmCallId: "llm-call-anthropic",
                      status: "completed",
                      itemDirection: "output",
                      itemVisibility: "product_text",
                    },
                  ];
                },
              };
            },
          };
        },
      };
    }

    return {
      from() {
        return {
          innerJoin() {
            return {
              where() {
                return {
                  async orderBy() {
                    return [
                      {
                        llmCallId: "llm-call-anthropic",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "claude-sonnet-4-6",
                        requestMode: "anthropic_messages",
                        itemKind: "reasoning",
                        itemDirection: "output",
                        itemSequence: 0,
                        canonicalPayload: {
                          type: "reasoning",
                          text: "Think first.",
                          providerData: {
                            provider: "anthropic",
                            payload: {
                              type: "thinking",
                              thinking: "Think first.",
                              signature: "sig-1",
                            },
                          },
                        },
                        providerPayload: {
                          type: "thinking",
                          thinking: "Think first.",
                          signature: "sig-1",
                        },
                      },
                      {
                        llmCallId: "llm-call-anthropic",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "claude-sonnet-4-6",
                        requestMode: "anthropic_messages",
                        itemKind: "reasoning_redacted",
                        itemDirection: "output",
                        itemSequence: 1,
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
                      },
                      {
                        llmCallId: "llm-call-anthropic",
                        createdAt: new Date("2026-04-30T10:00:01.000Z"),
                        model: "claude-sonnet-4-6",
                        requestMode: "anthropic_messages",
                        itemKind: "text",
                        itemDirection: "output",
                        itemSequence: 2,
                        canonicalPayload: {
                          type: "text",
                          text: "Visible plan.",
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
    };
  });

  const loader = createLoader();
  const { messages, reconstruction } = await loader.loadWithDiagnostics("thread-1", {
    provider: "anthropic",
    targetModel: "claude-haiku-4-5-20251001",
    targetReasoning: { enabled: false },
  });

  assert.deepEqual(messages.slice(1), [
    {
      role: "user",
      content: [{ type: "text", text: "Continue" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Visible plan." }],
    },
  ]);
  assert.deepEqual(reconstruction, {
    mode: "canonical_fallback",
    targetProvider: "anthropic",
    targetModel: "claude-haiku-4-5-20251001",
    targetReasoning: { enabled: false },
    degraded: true,
    degradedReasons: [
      "same_provider_incompatible_reasoning",
      "canonical_fallback_messages",
      "provider_only_items_omitted",
    ],
    sourceProviders: ["anthropic"],
    providerNativeCallCount: 0,
    providerNativeOutputItemCount: 0,
    canonicalFallbackMessageCount: 1,
    omittedProviderOnlyItemCount: 2,
    providerCallCounts: {
      anthropic: 1,
    },
    providerOnlyOutputItemCounts: {
      anthropic: 2,
    },
    sameProviderIncompatibleCallCount: 1,
    sameProviderIncompatibleOutputItemCount: 3,
  });
});
