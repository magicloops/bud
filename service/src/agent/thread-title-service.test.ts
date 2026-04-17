import assert from "node:assert/strict";
import test from "node:test";
import { ThreadTitleService, normalizeGeneratedThreadTitle } from "./thread-title-service.js";

test("normalizeGeneratedThreadTitle trims labels and punctuation", () => {
  assert.equal(
    normalizeGeneratedThreadTitle('Title: "Fix OAuth Callback Flow."'),
    "Fix OAuth Callback Flow",
  );
});

test("normalizeGeneratedThreadTitle preserves longer titles", () => {
  assert.equal(
    normalizeGeneratedThreadTitle("Investigate missing session stream reconnection bug"),
    "Investigate missing session stream reconnection bug",
  );
});

test("normalizeGeneratedThreadTitle accepts short titles", () => {
  assert.equal(normalizeGeneratedThreadTitle("Bugfix"), "Bugfix");
  assert.equal(normalizeGeneratedThreadTitle("Assistant Introduction"), "Assistant Introduction");
});

test("collectResponse accumulates streamed title text deltas", async () => {
  const service = new ThreadTitleService({} as never, {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  } as never);

  async function* stream() {
    yield { type: "message_start", id: "resp_title_1" } as const;
    yield { type: "content_start", index: 0, content_type: "text" } as const;
    yield { type: "text_delta", index: 0, delta: "Fix" } as const;
    yield { type: "text_delta", index: 0, delta: " deploy" } as const;
    yield { type: "content_done", index: 0 } as const;
    yield { type: "message_done", stop_reason: "end_turn" } as const;
  }

  const response = await (service as any).collectResponse(stream());
  assert.deepEqual(response.content, [{ type: "text", text: "Fix deploy" }]);
});
