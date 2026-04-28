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
