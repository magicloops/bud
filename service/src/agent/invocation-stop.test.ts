import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { InvocationRepository } from "./invocation-repository.js";

test("Stop releases uncertain work without a second acknowledgement", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const isolated = "stop_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${isolated},public` });
  const db = drizzle(pool, { schema });
  const owner = randomUUID(), bud = randomUUID();
  try {
    await pool.query(`create schema "${isolated}"`);
    const tables = await pool.query("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      assert.match(tablename, /^[a-zA-Z0-9_]+$/);
      await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
    }
    await db.insert(schema.budTable).values({ budId: bud, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
    const repo = new InvocationRepository(db);
    for (const mode of ["finish", "expiry", "unexpected"] as const) {
      await t.test(mode, async () => {
        const threadId = randomUUID();
        await db.insert(schema.threadTable).values({ threadId, budId: bud, createdByUserId: owner });
        const input = { owner, threadId, origin: "human" as const, text: "Fixture", model: "fixture", reasoningEffort: "low" };
        await repo.admit({ ...input, idempotencyKey: randomUUID() });
        const lease = await repo.claim("worker", owner); assert.ok(lease);
        await repo.start(lease);
        await repo.recordAction(lease, "unfinished", "terminal.send");
        const questionId = randomUUID(), requestId = randomUUID();
        await db.insert(schema.agentQuestionRequestTable).values({ questionRequestId: questionId,
          threadId, turnId: lease.turnId, callId: "question", clientId: randomUUID(), createdByUserId: owner });
        await db.insert(schema.dataAccessRequestTable).values({ id: requestId, invocationId: lease.id,
          threadId, budId: bud, callId: "permission", proxiedSiteId: "fixture", definition: {},
          definitionHash: "fixture", expiresAt: new Date(Date.now() + 60000), createdByUserId: owner });
        const next = await repo.admit({ ...input, idempotencyKey: randomUUID() });
        await assert.rejects(repo.requestCancel("foreign", lease.id), /invocation_not_found/);
        if (mode !== "unexpected") {
          const requested = await repo.requestCancel(owner, lease.id);
          assert.equal(requested.status, "running");
          assert.equal(requested.reservesThread, true);
          assert.equal(await repo.claim("too-soon", owner), null);
          await assert.rejects(repo.recordAction(lease, "after-stop", "terminal.send"), /invocation_canceled/);
        }
        if (mode === "finish") {
          await repo.finish(lease, "needs_review", "execution_interrupted");
        } else {
          await db.update(schema.agentInvocationTable).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, lease.id));
          await repo.recoverExpired(owner);
        }
        let row = (await repo.listForThread(owner, threadId)).find(row => row.id === lease.id)!;
        if (mode === "unexpected") {
          assert.equal(row.status, "needs_review");
          assert.equal(row.reservesThread, true);
          assert.equal(await repo.claim("paused", owner), null);
          row = await repo.requestCancel(owner, row.id);
        }
        assert.equal(row.status, "canceled");
        assert.equal(row.reservesThread, false);
        assert.equal(row.canceledByUserId, owner);
        const [question] = await db.select().from(schema.agentQuestionRequestTable).where(eq(schema.agentQuestionRequestTable.questionRequestId, questionId));
        const [request] = await db.select().from(schema.dataAccessRequestTable).where(eq(schema.dataAccessRequestTable.id, requestId));
        assert.equal(question.status, "canceled");
        assert.equal(request.status, "canceled");
        assert.equal((await repo.requestCancel(owner, row.id)).status, "canceled");
        const [intent] = await db.select().from(schema.agentInvocationActionTable).where(eq(schema.agentInvocationActionTable.invocationId, lease.id));
        assert.equal(intent.status, "intent", "Stop does not invent successful completion");
        await assert.rejects(repo.recordAction(lease, "stale", "terminal.send"), /lease_lost/);
        const following = await repo.claim("following", owner);
        assert.equal(following?.id, next.invocation.id);
        await repo.finish(following!, "succeeded", "completed");
      });
    }
  } finally {
    await pool.query(`drop schema if exists "${isolated}" cascade`);
    await pool.end();
    await defaultPool.end();
  }
});
