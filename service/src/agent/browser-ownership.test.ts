import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { config } from "../config.js";
import { BrowserToolExecutor, type BrowserAgentContext } from "./browser-tool-executor.js";

test("browser SQL authority rejects foreign scope, deletion and unclaim, including late reads", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  t.after(() => pool.end());
  await db.transaction(async tx => {
    // Connection-private tables shadow the real names and disappear on commit.
    // No existing user, thread or browser record is touched.
    await tx.execute(sql`create temporary table bud (bud_id text primary key, created_by_user_id text) on commit drop`);
    await tx.execute(sql`create temporary table thread (thread_id uuid primary key, bud_id text, created_by_user_id text, deleted_at timestamptz) on commit drop`);
    const id = randomUUID();
    await tx.execute(sql`insert into bud values ('bud', 'alice'), ('other-bud', 'bob')`);
    await tx.execute(sql`insert into thread values (${id}, 'bud', 'alice', null)`);
    // Keep the production authorization implementation, binding only its SQL
    // connection to this isolated transaction (no mocked query/results).
    const select = t.mock.method(db, "select", tx.select.bind(tx));
    try {
      const context: BrowserAgentContext = { threadId: id, budId: "bud", ownerUserId: "alice", turnId: "turn", signal: new AbortController().signal };
      let dispatched = 0;
      let removeDuringRead = false;
      const executor = new BrowserToolExecutor({
        available: async () => true,
        park: async () => { throw new Error("unexpected park"); },
        execute: async () => {
          dispatched++;
          if (removeDuringRead) await tx.execute(sql`update thread set deleted_at = now()`);
          return { ok: true, outcome: "completed", data: { evidence: "fixture" } };
        },
      });
      const observe = { type: "tool_call", tool: "browser_exec", callId: "call", args: {code:"await browser.tabs.list()"} } as const;
      assert.equal((await executor.execute(context, observe)).result.ok, true);
      for (const invalid of [{ ownerUserId: "bob" }, { budId: "other-bud" }, { threadId: randomUUID() }]) {
        await assert.rejects(executor.execute({ ...context, ...invalid }, observe), /browser_not_found/);
      }
      assert.equal(dispatched, 1);
      await tx.execute(sql`update bud set created_by_user_id = null where bud_id = 'bud'`);
      await assert.rejects(executor.execute(context, observe), /browser_not_found/);
      await tx.execute(sql`update bud set created_by_user_id = 'alice' where bud_id = 'bud'`);
      removeDuringRead = true;
      await assert.rejects(executor.execute(context, observe), /browser_not_found/);
      assert.equal(dispatched, 2, "late evidence was withheld after dispatch");
      await assert.rejects(executor.available(context), /browser_not_found/);
      await assert.rejects(executor.execute(context, observe), /browser_not_found/);
      assert.equal(dispatched, 2, "deleted thread never dispatches another read");
    } finally { select.mock.restore(); }
  });
});
