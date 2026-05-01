import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { AGENT_SYSTEM_PROMPT, AgentConversationLoader } from "./conversation-loader.js";

test("system prompt documents only public wait_for modes", () => {
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /shell_ready/);
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /screen_stable/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"settled"/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"changed"/);
  assert.match(AGENT_SYSTEM_PROMPT, /wait_for:"none"/);
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

  const loader = new AgentConversationLoader();
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

  const loader = new AgentConversationLoader();
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
        { type: "text", text: "I will inspect first." },
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
