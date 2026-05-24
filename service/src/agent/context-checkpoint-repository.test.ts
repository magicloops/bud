import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import {
  getLatestCompletedContextCheckpoint,
  recordCompletedContextCheckpoint,
} from "./context-checkpoint-repository.js";

test("getLatestCompletedContextCheckpoint returns normalized replacement history", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "select", () => ({
    from() {
      return {
        where() {
          return {
            orderBy() {
              return {
                async limit() {
                  return [
                    {
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
                      summary: "Summary",
                      replacementHistory: [
                        {
                          role: "user",
                          content: [{ type: "text", text: "Checkpoint summary" }],
                        },
                        {
                          role: "not-valid",
                          content: "bad",
                        },
                      ],
                      compactedThroughMessageCreatedAt: null,
                      compactedThroughMessageId: null,
                      compactedThroughLlmCallCreatedAt: null,
                      compactedThroughLlmCallId: null,
                      inputTokensBefore: 100,
                      estimatedTokensAfter: 20,
                      error: null,
                      tenantId: null,
                      createdByUserId: "user-1",
                      createdAt: new Date("2026-05-23T10:00:00.000Z"),
                      completedAt: new Date("2026-05-23T10:00:01.000Z"),
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

  const checkpoint = await getLatestCompletedContextCheckpoint("thread-1");

  assert.ok(checkpoint);
  assert.equal(checkpoint.checkpointId, "checkpoint-1");
  assert.deepEqual(checkpoint.replacementHistory, [
    {
      role: "user",
      content: [{ type: "text", text: "Checkpoint summary" }],
    },
  ]);
});

test("recordCompletedContextCheckpoint stamps ownership and boundaries", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  const inserted: Record<string, unknown>[] = [];
  mock.method(db, "insert", () => ({
    values(values: Record<string, unknown>) {
      inserted.push(values);
      return {
        async returning() {
          return [
            {
              ...values,
              createdAt: new Date("2026-05-23T10:00:00.000Z"),
            },
          ];
        },
      };
    },
  }) as never);

  const checkpoint = await recordCompletedContextCheckpoint({
    threadId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
    trigger: "auto",
    reason: "context_limit",
    phase: "pre_turn",
    sourceProvider: "openai",
    sourceModel: "gpt-5.5",
    sourceReasoningEffort: "low",
    summary: "Summary",
    replacementHistory: [
      {
        role: "user",
        content: [{ type: "text", text: "Summary" }],
      },
    ],
    boundaries: {
      messageCreatedAt: new Date("2026-05-23T09:59:00.000Z"),
      messageId: "017dbb12-3865-44fc-8228-17bc55af2cd5",
      llmCallCreatedAt: new Date("2026-05-23T09:59:30.000Z"),
      llmCallId: "llm-call-1",
    },
    inputTokensBefore: 1000,
    estimatedTokensAfter: 100,
    ownerUserId: "user-1",
    tenantId: "tenant-1",
  });

  const insertedValue = inserted[0];
  assert.ok(insertedValue);
  assert.equal(insertedValue.createdByUserId, "user-1");
  assert.equal(insertedValue.tenantId, "tenant-1");
  assert.equal(insertedValue.status, "completed");
  assert.equal(insertedValue.compactedThroughLlmCallId, "llm-call-1");
  assert.deepEqual(checkpoint.replacementHistory, [
    {
      role: "user",
      content: [{ type: "text", text: "Summary" }],
    },
  ]);
});
