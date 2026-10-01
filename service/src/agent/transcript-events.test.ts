import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptEvents } from "./transcript-events.js";
import type { ThreadChange } from "../routes/threads/change-listener.js";

const hint: ThreadChange = { owner: "owner", thread_id: "thread", message_id: "message", kind: "message" };
test("publication loss fences an in-flight reload; failures force resync", async () => {
  const events: unknown[] = [];
  let invalidated = 0;
  let resolve!: (row: undefined) => void;
  const publisher = new TranscriptEvents({ emit: (...args: unknown[]) => events.push(args),
    invalidateReplay: () => invalidated++ } as never, () => new Promise(done => { resolve = done; }));
  publisher.changed(hint);
  publisher.lost(); resolve(undefined);
  await publisher.flush();
  assert.equal(invalidated, 1); assert.deepEqual(events, []);
  const failed = new TranscriptEvents({ invalidateReplay: () => invalidated++ } as never, async () => { throw new Error("database unavailable"); });
  failed.changed(hint); await failed.flush();
  assert.equal(invalidated, 2);
});

test("missing inserts and committed mutations invalidate rather than fabricate canonical messages", async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const publisher = new TranscriptEvents({ emit: (_id: string, event: typeof events[number]) => events.push(event),
    invalidateReplay: () => assert.fail("unexpected loss") } as never, async () => undefined);
  publisher.changed(hint); await publisher.flush();
  publisher.changed({ ...hint, kind: "transcript" }); await publisher.flush();
  assert.deepEqual(events, Array(2).fill({ event: "transcript.invalidated", data: { message_ids: ["message"] } }));
});
