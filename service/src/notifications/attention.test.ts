import assert from "node:assert/strict";
import test from "node:test";
import { countUnseenThreads, hasUnseenAttention, isMessageNewerThanWatermark } from "./attention.js";

test("message tuple comparison treats newer timestamps as newer", () => {
  assert.equal(
    isMessageNewerThanWatermark(
      new Date("2026-04-21T20:00:01.000Z"),
      "b",
      {
        createdAt: new Date("2026-04-21T20:00:00.000Z"),
        messageId: "a",
      },
    ),
    true,
  );
});

test("hasUnseenAttention is false when no attention message exists", () => {
  assert.equal(
    hasUnseenAttention({
      lastAttentionMessageId: null,
      lastAttentionMessageCreatedAt: null,
      lastSeenMessageId: null,
      lastSeenMessageCreatedAt: null,
    }),
    false,
  );
});

test("countUnseenThreads counts threads rather than messages", () => {
  const count = countUnseenThreads([
    {
      lastAttentionMessageId: "message-2",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T20:00:02.000Z"),
      lastSeenMessageId: "message-1",
      lastSeenMessageCreatedAt: new Date("2026-04-21T20:00:01.000Z"),
    },
    {
      lastAttentionMessageId: "message-4",
      lastAttentionMessageCreatedAt: new Date("2026-04-21T20:00:04.000Z"),
      lastSeenMessageId: "message-4",
      lastSeenMessageCreatedAt: new Date("2026-04-21T20:00:04.000Z"),
    },
  ]);

  assert.equal(count, 1);
});
