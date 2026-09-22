import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";
import { InvocationRepository } from "./invocation-repository.js";
import { serializeInvocation } from "./invocation-view.js";
import { invocationTimingTransaction, settledTurnTiming, subscribeTurnTimings, type TurnTiming } from "./invocation-timing.js";

const inv = schema.agentInvocationTable;
test("only settled, trustworthy totals are public", () => {
  const base = { turnId: "turn", threadId: "thread", status: "succeeded" as const, workDurationMs: 100, workStartedAt: null };
  assert.deepEqual(settledTurnTiming(base), { turn_id: "turn", work_duration_ms: 100 });
  for (const status of ["pending", "leased", "running", "waiting_for_user"] as const) assert.equal(settledTurnTiming({ ...base, status }), null);
  for (const workDurationMs of [null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(settledTurnTiming({ ...base, workDurationMs })?.work_duration_ms, null);
  }
  assert.equal(settledTurnTiming({ ...base, status: "needs_review" })?.work_duration_ms, null);
  assert.equal(settledTurnTiming({ ...base, workStartedAt: new Date() })?.work_duration_ms, null);
});

test("settled timing replays after final without changing execution state", () => {
  const runtime = new AgentRuntimeStateManager();
  runtime.startTurn("thread", "turn");
  const cursor = runtime.emit("thread", { event: "final", data: { turn_id: "turn", status: "succeeded" } });
  runtime.finishTurn("thread");
  const before = runtime.getSnapshot("thread");
  const timing = { turn_id: "turn", work_duration_ms: 95000 };
  runtime.emit("thread", { event: "agent.turn_timing", data: timing });
  const replay: unknown[] = [];
  const attached = runtime.attachCallback("thread", event => replay.push(event), { afterCursor: cursor });
  assert.equal(attached.status, "attached");
  assert.equal(replay.length, 1);
  assert.deepEqual((replay[0] as { data: unknown }).data, timing);
  assert.deepEqual(runtime.getSnapshot("thread"), before);
  attached.detach();
});

test("durable execution timing excludes waits, survives recovery and publishes after commit", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const isolated = "timing_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${isolated},public` });
  const db = drizzle(pool, { schema });
  const owner = randomUUID(), bud = randomUUID();
  const events: { threadId: string; timing: TurnTiming }[] = [];
  const unsubscribe = subscribeTurnTimings(db, (threadId, timing) => events.push({ threadId, timing }));
  try {
    await pool.query(`create schema "${isolated}"`);
    const tables = await pool.query("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      assert.match(tablename, /^[a-zA-Z0-9_]+$/);
      await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
    }
    // Exercise the deploy migration against pre-change storage, including defaults.
    await pool.query(`drop table "${isolated}".browser_handoff, "${isolated}".browser_session, "${isolated}".browser_resource;
      alter table agent_invocation drop column work_duration_ms, drop column work_started_at`);
    await pool.query(readFileSync(new URL('../../drizzle/migrations/0039_bud_browser.sql', import.meta.url), 'utf8')
      .replaceAll('"public".', `"${isolated}".`));
    const columns = await pool.query(`select column_default, is_nullable from information_schema.columns where table_schema=$1 and table_name='agent_invocation' and column_name in ('work_duration_ms','work_started_at')`, [isolated]);
    assert.equal(columns.rows.length, 2);
    assert.ok(columns.rows.every(row => row.column_default === null && row.is_nullable === 'YES'));
    await db.insert(schema.budTable).values({ budId: bud, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
    const repo = new InvocationRepository(db);
    const admit = async () => {
      const threadId = randomUUID();
      await db.insert(schema.threadTable).values({ threadId, budId: bud, createdByUserId: owner });
      return (await repo.admit({ owner, threadId, origin: "human", text: "Fixture", model: "fixture", reasoningEffort: "low", idempotencyKey: randomUUID() })).invocation;
    };
    const row = async (id: string) => (await db.select().from(inv).where(eq(inv.id, id)))[0];
    const elapsed = (id: string, seconds: number) => db.update(inv).set({ workStartedAt: sql`clock_timestamp() - ${seconds} * interval '1 second'` }).where(eq(inv.id, id));
    await t.test("queue and preflight are excluded; parked question accumulates two intervals", async () => {
      const admitted = await admit();
      assert.equal(admitted.workDurationMs, 0);
      let lease = (await repo.claim("worker", owner))!;
      await repo.defer(lease, "waiting_for_model", 1);
      assert.equal((await row(lease.id)).workStartedAt, null);
      await db.update(inv).set({ nextAttemptAt: new Date(0) }).where(eq(inv.id, lease.id));
      lease = (await repo.claim("worker", owner))!;
      await repo.start(lease);
      assert.equal(settledTurnTiming(await row(lease.id)), null);
      await repo.recordAction(lease, "question", "ask_user_questions");
      const questionId = randomUUID();
      await db.insert(schema.agentQuestionRequestTable).values({ questionRequestId: questionId,
        threadId: lease.threadId, turnId: lease.turnId, callId: "question", clientId: randomUUID(), createdByUserId: owner });
      await elapsed(lease.id, 2);
      await repo.parkQuestion(lease, "question", questionId);
      const parked = await row(lease.id);
      assert.ok(parked.workDurationMs! >= 2000 && parked.workDurationMs! < 3000);
      assert.equal(parked.workStartedAt, null);
      assert.equal(events.length, 0);
      await assert.rejects(repo.finish(lease, "succeeded", "stale"), /lease_lost/);
      // Complete the human decision, then use the normal claim/start boundaries.
      await db.update(schema.agentQuestionRequestTable).set({ status: "answered" }).where(eq(schema.agentQuestionRequestTable.questionRequestId, questionId));
      lease = (await repo.claim("worker", owner))!;
      assert.ok(lease);
      await repo.start(lease);
      await repo.completeAction(lease, "question", {});
      await elapsed(lease.id, 3);
      await repo.finish(lease, "succeeded", "completed");
      const done = await row(lease.id);
      assert.ok(done.workDurationMs! >= 5000 && done.workDurationMs! < 6500);
      assert.equal(done.workStartedAt, null);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], { threadId: done.threadId, timing: settledTurnTiming(done) });
      assert.equal(serializeInvocation(done).work_duration_ms, done.workDurationMs);
      assert.deepEqual(await repo.timingsForTurns(owner, done.threadId, [done.turnId, done.turnId]), [settledTurnTiming(done)]);
      assert.deepEqual(await repo.timingsForTurns(randomUUID(), done.threadId, [done.turnId]), []);
      assert.deepEqual(await repo.timingsForTurns(owner, randomUUID(), [done.turnId]), []);
      assert.deepEqual(await repo.timingsForTurns(owner, done.threadId, []), []);
    });
    await t.test("nested cancellation publishes only after outer commit; retries do not count twice", async () => {
      const pending = await admit();
      const count = events.length;
      await assert.rejects(invocationTimingTransaction(db, async tx => {
        await repo.requestCancelInTransaction(tx, owner, pending.id);
        assert.equal(events.length, count);
        throw new Error("rollback");
      }), /rollback/);
      assert.equal((await row(pending.id)).status, "pending");
      assert.equal(events.length, count);
      await repo.requestCancel(owner, pending.id);
      await repo.requestCancel(owner, pending.id);
      assert.equal(events.length, count + 1);
      assert.equal(events.at(-1)!.timing.work_duration_ms, 0);
    });
    await t.test("running cancel counts until acknowledgement; legacy totals remain unknown", async () => {
      for (const legacy of [false, true]) {
        const admitted = await admit();
        if (legacy) await db.update(inv).set({ workDurationMs: null }).where(eq(inv.id, admitted.id));
        const lease = (await repo.claim("worker", owner))!;
        await repo.start(lease);
        await elapsed(lease.id, 2);
        const before = events.length;
        await repo.requestCancel(owner, lease.id);
        assert.equal(events.length, before);
        await repo.finish(lease, "succeeded", "completed");
        const done = await row(lease.id);
        assert.equal(done.status, "canceled");
        assert.equal(legacy ? done.workDurationMs === null : done.workDurationMs! >= 2000, true);
      }
    });
    await t.test("expiry, failure and failed parks retain honest totals", async () => {
      const queued = await admit();
      await db.update(inv).set({ latestStartAt: new Date(0) }).where(eq(inv.id, queued.id));
      await repo.expireQueued(owner);
      assert.equal((await row(queued.id)).workDurationMs, 0);
      assert.equal(events.at(-1)!.timing.work_duration_ms, 0);

      await admit();
      let lease = (await repo.claim("worker", owner))!;
      await db.update(inv).set({ leaseExpiresAt: new Date(0) }).where(eq(inv.id, lease.id));
      await repo.recoverExpired(owner);
      assert.equal((await row(lease.id)).workDurationMs, 0);
      lease = (await repo.claim("worker", owner))!;
      await repo.start(lease);
      await elapsed(lease.id, 2);
      await assert.rejects(repo.parkQuestion(lease, "missing", randomUUID()));
      assert.equal((await row(lease.id)).status, "running");
      assert.ok((await row(lease.id)).workStartedAt);
      await repo.finish(lease, "failed", "provider_error");
      assert.ok((await row(lease.id)).workDurationMs! >= 2000);
      await elapsed(lease.id, 60); // Old writer left an interval on a terminal row.
      await repo.invalidateInterruptedTiming();
      assert.equal((await row(lease.id)).workDurationMs, null);
      assert.equal((await row(lease.id)).workStartedAt, null);
    });
    await t.test("startup preserves another healthy worker; expired execution is unknown", async () => {
      await admit();
      const lease = (await repo.claim("worker", owner))!;
      await repo.start(lease);
      await elapsed(lease.id, 2);
      await repo.invalidateInterruptedTiming();
      assert.ok((await row(lease.id)).workStartedAt);
      await db.update(inv).set({ leaseExpiresAt: new Date(0) }).where(eq(inv.id, lease.id));
      await repo.recoverExpired(owner);
      const interrupted = await row(lease.id);
      assert.equal(interrupted.status, "needs_review");
      assert.equal(interrupted.workDurationMs, null);
      assert.equal(interrupted.workStartedAt, null);
      assert.equal(events.at(-1)!.timing.work_duration_ms, null);
      await repo.requestCancel(owner, lease.id);
      assert.equal((await row(lease.id)).workDurationMs, null);
    });
  } finally {
    unsubscribe();
    await pool.query(`drop schema if exists "${isolated}" cascade`);
    await pool.end();
    await defaultPool.end();
  }
});
