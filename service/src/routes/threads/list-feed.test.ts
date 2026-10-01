import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { ThreadListFeed, type ListEvent } from "./list-feed.js";
import { decodeThreadListCursor, encodeThreadListCursor } from "./list-cursor.js";

test("list snapshots fence stale buffered publications and changes during reads publish afterward", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ListEvent[] = [];
  let title = "old", loads = 0;
  const feed = new ThreadListFeed(async (owner, id) => {
    loads++; assert.equal(owner, "alice"); return { thread_id: id, title } as never;
  });
  const stop = feed.subscribe("alice", event => events.push(event));
  t.after(() => { stop(); feed.reset(); });
  for (let i = 0; i < 20; i++) feed.changed("alice", "thread");
  t.mock.timers.tick(250); await settle();
  assert.equal(loads, 1); assert.equal(events.length, 1);
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const snapshot = feed.snapshot("alice", async () => {
    await barrier; return { threads: [{ thread_id: "thread", title }] as never[] };
  });
  await settle();
  title = "current";
  feed.changed("alice", "thread"); t.mock.timers.tick(250);
  await settle(); assert.equal(events.length, 1, "publication waits behind canonical snapshot");
  release();
  const page = await snapshot; await settle();
  assert.equal(page.feed_checkpoint.sequence, 1);
  assert.equal(events[1].data.sequence, 2);
  assert.equal((events[1].data.thread as { title: string }).title, "current");
  assert.equal(events[1].data.epoch, page.feed_checkpoint.epoch);
  assert.equal(loads, 2);
});

test("notification loss invalidates an in-flight snapshot and unknown removals do not disclose IDs", async t => {
  const events: ListEvent[] = [];
  const feed = new ThreadListFeed(async () => null);
  const stop = feed.subscribe("alice", event => events.push(event));
  t.after(() => { stop(); feed.reset(); });
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const snapshot = feed.snapshot("alice", async () => { await barrier; return { threads: [] }; });
  await settle(); feed.reset(); release();
  await assert.rejects(snapshot, /continuity_lost/);
  assert.equal(events[0].event, "resync_required");
  assert.equal(events[0].data.thread_id, undefined);
});

test("list cursor binds exact millisecond tuple to owner and filter scope", () => {
  const row = { last_conversation_at: new Date("2026-09-30T01:02:03.004Z"),
    created_at: new Date("2026-09-29T01:02:03.004Z"), thread_id: "11111111-1111-4111-8111-111111111111" };
  const encoded = encodeThreadListCursor("alice", "bud", row);
  assert.equal(decodeThreadListCursor(encoded, "alice", "bud")?.at, row.last_conversation_at.toISOString());
  assert.equal(decodeThreadListCursor(encoded, "bob", "bud"), null);
  assert.equal(decodeThreadListCursor(encoded, "alice"), null);
  for (const value of ["!", "a".repeat(2049), Buffer.from('{"v":2}').toString("base64url")]) assert.equal(decodeThreadListCursor(value, "alice"), null);
});
