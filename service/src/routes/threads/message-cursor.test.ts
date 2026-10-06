import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db, pool } from "../../db/client.js";
import { loadMessagePage } from "./message-loader.js";
import { decodeMessageCursor, encodeMessageCursor } from "./shared.js";

test("cursor preserves exact timestamp and rejects old, invalid and foreign boundaries", () => {
  const row = { threadId: randomUUID(), messageId: randomUUID(), cursorTimestamp: "2026-10-01T12:00:00.123456Z" };
  assert.equal(decodeMessageCursor(encodeMessageCursor(row), row.threadId)?.createdAt, row.cursorTimestamp);
  assert.equal(decodeMessageCursor(encodeMessageCursor(row), randomUUID()), null);
  for (const date of ["2026-02-30T00:00:00.123456Z", "2026-10-01T25:00:00.123456Z", "2026-10-01T00:00:00.123Z"]) {
    assert.equal(decodeMessageCursor(encodeMessageCursor({ ...row, cursorTimestamp: date })), null);
  }
  assert.equal(decodeMessageCursor(Buffer.from(JSON.stringify({ created_at: row.cursorTimestamp, message_id: row.messageId })).toString("base64url")), null);
  assert.equal(decodeMessageCursor("a".repeat(2049)), null);
});

test("PostgreSQL history pages preserve microseconds, ties, deletion and owner scope", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  t.after(() => pool.end());
  await db.transaction(async tx => {
    // Temporary shadow table: no application rows or foreign-key parents touched.
    await tx.execute(sql`create temporary table message (like public.message including defaults) on commit drop`);
    const thread = randomUUID();
    const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const times = ["123100", "123400", "123400", "123900", "124000"];
    for (const [i, id] of ids.entries()) {
      await tx.execute(sql`insert into message (message_id, client_id, thread_id, role, content, metadata, created_by_user_id, created_at)
        values (${id}::uuid, ${randomUUID()}::uuid, ${thread}::uuid, 'assistant', 'final', '{}'::jsonb, 'owner',
          ${`2026-10-01T12:00:00.${times[i]}Z`}::timestamptz)`);
    }
    const service = {} as never;
    for (const limit of [1, 2, 100]) {
      let page = await loadMessagePage("owner", thread, service, limit, null, null, tx);
      const backward = [...page.messages];
      while (page.page.has_more_before) {
        page = await loadMessagePage("owner", thread, service, limit, decodeMessageCursor(page.page.before_cursor!)!, null, tx);
        backward.unshift(...page.messages);
      }
      assert.deepEqual(backward.map(m => m.message_id), ids);
      const first = await loadMessagePage("owner", thread, service, 1, null,
        { threadId: thread, createdAt: "2026-10-01T12:00:00.000000Z", messageId: ids[0] }, tx);
      let forward = first;
      const found = [...first.messages];
      do {
        forward = await loadMessagePage("owner", thread, service, limit, null, decodeMessageCursor(forward.page.after_cursor!)!, tx);
        found.push(...forward.messages);
      } while (forward.page.has_more_after);
      assert.deepEqual(found.map(m => m.message_id), ids);
    }
    assert.equal((await loadMessagePage("other", thread, service, 100, null, null, tx)).messages.length, 0);
    assert.equal((await loadMessagePage("owner", randomUUID(), service, 100, null, null, tx)).messages.length, 0);
    const boundary = { threadId: thread, createdAt: "2026-10-01T12:00:00.123400Z", messageId: ids[2] };
    await tx.execute(sql`delete from message where message_id = ${ids[2]}::uuid`);
    assert.deepEqual((await loadMessagePage("owner", thread, service, 100, boundary, null, tx)).messages.map(m => m.message_id), ids.slice(0, 2));
  });
});
