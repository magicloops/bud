import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import "dotenv/config";
import { Pool } from "pg";

test("automation proposal migration binds reviews to owner, action and approved revision", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bud";
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname));
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = `automation_proposal_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("begin");
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(`create table "user" (id text primary key);
      create table automation (id text primary key, created_by_user_id text not null, unique(id,created_by_user_id));
      create table automation_revision (automation_id text, revision integer, created_by_user_id text, unique(automation_id,revision,created_by_user_id));
      create table agent_invocation (id text primary key, thread_id uuid, bud_id text, created_by_user_id text, unique(id,thread_id,bud_id,created_by_user_id));
      create table agent_invocation_action (invocation_id text,call_id text,unique(invocation_id,call_id))`);
    const migration = await readFile(new URL("../../drizzle/migrations/0033_natural_avengers.sql", import.meta.url), "utf8");
    await client.query(migration.replaceAll('"public".', `"${schema}".`).replaceAll('"auth"."user"', `"${schema}"."user"`));
    const thread = randomUUID();
    await client.query(`insert into "user" values ('a'),('b');
      insert into automation values ('rule-a','a'),('rule-b','b');
      insert into automation_revision values ('rule-a',1,'a'),('rule-b',1,'b');
      insert into agent_invocation_action values ('inv-a','call-a'),('inv-a','call-b')`);
    await client.query("insert into agent_invocation values ('inv-a',$1,'bud-a','a')", [thread]);
    const reject = async (query: string, values: unknown[], code: string) => {
      await client.query("savepoint rejected_write");
      await assert.rejects(client.query(query, values), (error: unknown) => {
        assert.equal((error as { code: string }).code, code); return true;
      });
      await client.query("rollback to savepoint rejected_write");
      await client.query("release savepoint rejected_write");
    };
    const insert = `insert into automation_proposal
      (id,automation_id,invocation_id,thread_id,bud_id,call_id,definition,draft_version,grant_version,expires_at,created_by_user_id)
      values ($1,$2,'inv-a',$3,$4,$5,'{}',0,1,now()+interval '1 day',$6)`;
    await client.query(insert, ["proposal-a", "rule-a", thread, "bud-a", "call-a", "a"]);
    await reject(insert, ["duplicate", "rule-a", thread, "bud-a", "call-a", "a"], "23505");
    await reject(insert, ["foreign-owner", "rule-b", thread, "bud-a", "call-b", "b"], "23503");
    await reject(insert, ["foreign-rule", "rule-b", thread, "bud-a", "call-b", "a"], "23503");
    await reject(insert, ["wrong-thread", "rule-a", randomUUID(), "bud-a", "call-b", "a"], "23503");
    await reject(insert, ["wrong-bud", "rule-a", thread, "bud-b", "call-b", "a"], "23503");
    await reject(insert, ["missing-intent", "rule-a", thread, "bud-a", "missing", "a"], "23503");
    for (const assignment of ["status='approved'", "status='declined'", "version=-1", "draft_version=-1", "grant_version=-1", "expires_at=created_at", "decision_request='{}'", "activated_revision=1"])
      await reject(`update automation_proposal set ${assignment} where id='proposal-a'`, [], "23514");
    const approve = `update automation_proposal set status='approved',version=1,activated_revision=$1,
      decision_request='{}',decision_idempotency_key='decision-a',decided_by_user_id=$2,decided_at=now() where id='proposal-a'`;
    await reject(approve, [2, "a"], "23503");
    await reject(approve, [1, "b"], "23514");
    await client.query(approve, [1, "a"]);
    await client.query(insert, ["proposal-b", "rule-a", thread, "bud-a", "call-b", "a"]);
    await reject(`update automation_proposal set status='declined',decision_request='{}',
      decision_idempotency_key='decision-a',decided_by_user_id='a',decided_at=now() where id='proposal-b'`, [], "23505");
    for (const status of ["expired", "stale", "canceled"])
      await client.query("update automation_proposal set status=$1 where id='proposal-b'", [status]);
    // Automatic cancellation needs no fabricated human decision; an explicit
    // cancellation may carry the complete owner-attributed retry receipt.
    await client.query(`update automation_proposal set decision_request='{}',decision_idempotency_key='cancel-b',
      decided_by_user_id='a',decided_at=now() where id='proposal-b'`);
  } finally {
    await client.query("rollback");
    client.release(); await pool.end();
  }
});
