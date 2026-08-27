import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import {
  buildDanglingToolCallRepair,
  repairDanglingToolCalls,
  type DanglingToolCall,
} from "./restart-repair.js";

function createLogger() {
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

function danglingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    llmCallId: "llm_1",
    threadId: "11111111-1111-4111-8111-111111111111",
    toolCallId: "call_wait_1",
    canonicalPayload: { type: "tool_use", id: "call_wait_1", name: "terminal_wait", input: { until: "settled" } },
    turnId: "turn_1",
    threadOwnerUserId: "user-1",
    ...overrides,
  };
}

/** db.select chain returning `rows` from the dangling-call query. */
function mockSelect(rows: unknown[]) {
  mock.method(db, "select", () => ({
    from() {
      return {
        innerJoin() {
          return {
            innerJoin() {
              return {
                where() {
                  return {
                    orderBy() {
                      return Promise.resolve(rows);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  }) as never);
}

function mockMessageInsert(captured: Record<string, unknown>[]) {
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      captured.push(values);
      return {
        returning() {
          return Promise.resolve([{ messageId: `msg-${captured.length}` }]);
        },
      };
    },
  }) as never);
}

test("buildDanglingToolCallRepair: terminal.wait gets restart outcome, args, and terminal guidance", () => {
  const repair = buildDanglingToolCallRepair({
    llmCallId: "llm_1",
    threadId: "t",
    turnId: "turn_1",
    toolCallId: "call_wait_1",
    canonicalPayload: { type: "tool_use", id: "call_wait_1", name: "terminal_wait", input: { until: "settled" } },
    threadOwnerUserId: null,
  } satisfies DanglingToolCall);

  assert.equal(repair.tool, "terminal.wait");
  assert.equal(repair.payload.tool, "terminal.wait");
  assert.equal(repair.payload.call_id, "call_wait_1");
  assert.equal(repair.payload.until, "settled");
  assert.equal(repair.payload.kind, "wait");
  assert.equal(repair.payload.outcome, "interrupted");
  assert.equal(repair.payload.error, "server_restarted");
  assert.equal(repair.payload.code, "SERVER_RESTARTED");
  assert.equal(repair.payload.ok, false);
  assert.match(String(repair.payload.note), /kept running on the Bud/);
  assert.match(repair.summary, /service restart/);
});

test("buildDanglingToolCallRepair: non-terminal and unknown tools get the generic note", () => {
  const webView = buildDanglingToolCallRepair({
    llmCallId: "llm_1",
    threadId: "t",
    turnId: "turn_1",
    toolCallId: "call_wv",
    canonicalPayload: { type: "tool_use", id: "call_wv", name: "web_view_open", input: { target_port: 3000 } },
    threadOwnerUserId: null,
  });
  assert.equal(webView.tool, "web_view.open");
  assert.equal(webView.payload.kind, "web_view");
  assert.equal(webView.payload.target_port, 3000);
  assert.match(String(webView.payload.note), /re-issue it if it is still needed/);

  const unknown = buildDanglingToolCallRepair({
    llmCallId: "llm_1",
    threadId: "t",
    turnId: "turn_1",
    toolCallId: "call_x",
    canonicalPayload: { type: "tool_use", id: "call_x" },
    threadOwnerUserId: null,
  });
  assert.equal(unknown.tool, "unknown_tool");
  assert.equal("kind" in unknown.payload, false);
});

test("repairDanglingToolCalls persists the tool row, ledger item, and thread metadata per call", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockSelect([
    danglingRow(),
    danglingRow({
      llmCallId: "llm_1",
      toolCallId: "call_run_2",
      canonicalPayload: { type: "tool_use", id: "call_run_2", name: "terminal_run", input: { command: "sleep 5" } },
    }),
  ]);
  const insertedMessages: Record<string, unknown>[] = [];
  mockMessageInsert(insertedMessages);
  const ledgerItems: Record<string, unknown>[] = [];
  const threadMeta: Array<{ threadId: string; summary: string }> = [];

  const result = await repairDanglingToolCalls(createLogger(), {
    recordToolResultItem: async (args) => {
      ledgerItems.push(args as unknown as Record<string, unknown>);
    },
    recordThreadMeta: async (threadId: string, preview?: string | null) => {
      threadMeta.push({ threadId, summary: preview ?? "" });
    },
  });

  assert.deepEqual(result, { found: 2, repaired: 2 });
  assert.equal(insertedMessages.length, 2);
  assert.equal(insertedMessages[0]?.role, "tool");
  assert.equal(insertedMessages[0]?.createdByUserId, "user-1");
  const firstContent = JSON.parse(String(insertedMessages[0]?.content)) as Record<string, unknown>;
  assert.equal(firstContent.tool, "terminal.wait");
  assert.equal(firstContent.error, "server_restarted");
  const firstMetadata = insertedMessages[0]?.metadata as Record<string, unknown>;
  assert.equal(firstMetadata.turn_id, "turn_1");
  assert.equal(firstMetadata.server_restart_repair, true);

  assert.equal(ledgerItems.length, 2);
  assert.equal(ledgerItems[0]?.toolCallId, "call_wait_1");
  assert.equal(ledgerItems[0]?.messageId, "msg-1");
  // Two dangling calls on ONE llm_call: input sequences must not collide.
  assert.equal(ledgerItems[0]?.sequence, 0);
  assert.equal(ledgerItems[1]?.sequence, 1);
  assert.equal(threadMeta.length, 2);
  assert.match(threadMeta[0]!.summary, /service restart/);
});

test("repairDanglingToolCalls skips ask_user_questions rows defensively and continues past failures", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockSelect([
    danglingRow({
      toolCallId: "call_q",
      canonicalPayload: { type: "tool_use", id: "call_q", name: "ask_user_questions", input: {} },
    }),
    danglingRow({ toolCallId: "call_ok" }),
  ]);
  const insertedMessages: Record<string, unknown>[] = [];
  mockMessageInsert(insertedMessages);

  let ledgerCalls = 0;
  const result = await repairDanglingToolCalls(createLogger(), {
    recordToolResultItem: async () => {
      ledgerCalls += 1;
      if (ledgerCalls === 1) {
        throw new Error("db down");
      }
    },
    recordThreadMeta: async () => {
      // noop
    },
  });

  // The question row is filtered out (found excludes it); the surviving row's
  // ledger write fails once and is reported as found-but-not-repaired.
  assert.deepEqual(result, { found: 1, repaired: 0 });
});

test("repairDanglingToolCalls is a no-op when nothing dangles", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });
  mockSelect([]);
  let inserted = 0;
  mock.method(db, "insert", () => {
    inserted += 1;
    throw new Error("must not insert");
  });

  const result = await repairDanglingToolCalls(createLogger(), {
    recordToolResultItem: async () => {
      throw new Error("must not record");
    },
    recordThreadMeta: async () => {
      throw new Error("must not record");
    },
  });
  assert.deepEqual(result, { found: 0, repaired: 0 });
  assert.equal(inserted, 0);
});
