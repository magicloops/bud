import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "./client.js";
import * as schema from "./schema.js";
import { config } from "../config.js";
import { loadThreadSummaries } from "../routes/threads/summary-loader.js";
import { advanceThreadReadState, loadNotificationSummary } from "./thread-read-state.js";

test("read watermarks remain monotonic under concurrent requests; counts are owner scoped", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const owners = [0, 1].map(() => `read-test-${randomUUID()}`);
  const buds = owners.map(() => `bud-${randomUUID()}`);
  const threads: string[] = owners.map(() => randomUUID());
  t.after(async () => {
    try {
      await db.delete(schema.threadReadStateTable).where(inArray(schema.threadReadStateTable.userId, owners));
      await db.delete(schema.messageTable).where(inArray(schema.messageTable.threadId, threads));
      await db.delete(schema.threadTable).where(inArray(schema.threadTable.threadId, threads));
      await db.delete(schema.budTable).where(inArray(schema.budTable.budId, buds));
      await db.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
    } finally { await pool.end(); }
  });
  await db.insert(schema.authUserTable).values(owners.map(id => ({ id, name: "Read fixture", email: `${id}@example.invalid`, emailVerified: false })));
  await db.insert(schema.budTable).values(owners.map((owner, i) => ({ budId: buds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: owner })));
  await db.insert(schema.threadTable).values(owners.map((owner, i) => ({ threadId: threads[i], budId: buds[i], createdByUserId: owner })));
  const at = new Date("2026-09-30T00:00:00.000Z");
  const messages = Array.from({ length: 16 }, () => ({ messageId: randomUUID(), createdAt: at })).sort((a, b) => a.messageId.localeCompare(b.messageId));
  await db.insert(schema.messageTable).values(messages.map(m => ({ ...m, clientId: randomUUID(), threadId: threads[0], role: "assistant" as const, content: "fixture", createdByUserId: owners[0] })));
  const last = messages.at(-1)!;
  for (let i = 0; i < threads.length; i++) {
    await db.update(schema.threadTable).set({ lastAttentionMessageId: last.messageId, lastAttentionMessageCreatedAt: at }).where(eq(schema.threadTable.threadId, threads[i]));
  }
  assert.equal((await loadNotificationSummary(owners[0])).unseen_thread_count, 1);
  assert.equal((await loadNotificationSummary(owners[1])).unseen_thread_count, 1);
  // Highest ID first stresses a lower-ID request committing later at equal time.
  await Promise.all([...messages].reverse().map(m => advanceThreadReadState(owners[0], threads[0], m)));
  const stale = await advanceThreadReadState(owners[0], threads[0], messages[0]);
  assert.deepEqual(stale, { ok: true, updated: false, last_seen_message_id: last.messageId });
  assert.equal((await advanceThreadReadState(owners[0], threads[0], last)).updated, false);
  assert.equal((await loadNotificationSummary(owners[0])).unseen_thread_count, 0);
  assert.equal((await loadNotificationSummary(owners[1])).unseen_thread_count, 1);
  await db.update(schema.threadTable).set({ deletedAt: new Date() }).where(eq(schema.threadTable.threadId, threads[1]));
  assert.equal((await loadNotificationSummary(owners[1])).unseen_thread_count, 0);
  const tiedIds: string[] = Array.from({ length: 205 }, () => randomUUID()).sort().reverse();
  threads.push(...tiedIds);
  await db.insert(schema.threadTable).values(tiedIds.map(threadId => ({ threadId, budId: buds[0],
    createdByUserId: owners[0], createdAt: at, lastConversationAt: at, archived: true })));
  const seen: string[] = [];
  let cursor: import("../routes/threads/list-cursor.js").ThreadListCursor | null = null;
  for (;;) {
    const rows = await loadThreadSummaries(owners[0], { budId: buds[0], limit: 50, cursor });
    assert.ok(rows.length <= 50);
    seen.push(...rows.map(row => row.thread_id));
    if (rows.length < 50) break;
    const last = rows.at(-1)!;
    cursor = { v: 1, owner: owners[0], bud_id: buds[0], at: last.last_conversation_at.toISOString(), created: last.created_at.toISOString(), id: last.thread_id };
  }
  assert.equal(seen.length, 206);
  assert.equal(new Set(seen).size, 206);
  assert.deepEqual(seen.filter(id => tiedIds.includes(id)), tiedIds);
  assert.deepEqual(await loadThreadSummaries(owners[1], { budId: buds[0] }), []);

});
