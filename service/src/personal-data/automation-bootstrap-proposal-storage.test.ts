import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import "dotenv/config";
import { Pool } from "pg";

test("bootstrap proposal migration isolates review authority and binds frozen members", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bud";
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname));
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = `bootstrap_review_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("begin");
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    await client.query(`create table "user" (id text primary key);
      create table automation_revision (automation_id text, revision integer, created_by_user_id text, unique(automation_id,revision,created_by_user_id));
      create table agent_invocation (id text primary key, thread_id uuid, bud_id text, created_by_user_id text, unique(id,thread_id,bud_id,created_by_user_id));
      create table agent_invocation_action (invocation_id text,call_id text,unique(invocation_id,call_id));
      create table contact_revision (id text, created_by_user_id text, unique(id,created_by_user_id));
      create table automation_bootstrap (id text, created_by_user_id text, unique(id,created_by_user_id))`);
    const migration = await readFile(new URL("../../drizzle/migrations/0034_bored_butterfly.sql", import.meta.url), "utf8");
    await client.query(migration.replaceAll('"public".', `"${schema}".`).replaceAll('"auth"."user"', `"${schema}"."user"`));
    const thread = randomUUID();
    await client.query(`insert into "user" values ('a'),('b');
      insert into automation_revision values ('rule-a',1,'a'),('rule-b',1,'b');
      insert into agent_invocation_action values ('inv-a','call-a'),('inv-a','call-b');
      insert into contact_revision values ('contact-a','a'),('contact-b','b');
      insert into automation_bootstrap values ('receipt-a','a'),('receipt-b','b')`);
    await client.query("insert into agent_invocation values ('inv-a',$1,'bud-a','a')", [thread]);
    const reject = async (query: string, values: unknown[], code: string) => {
      await client.query("savepoint rejected_write");
      await assert.rejects(client.query(query, values), (error: unknown) => (error as { code: string }).code === code);
      await client.query("rollback to savepoint rejected_write");
      await client.query("release savepoint rejected_write");
    };
    const insert = `insert into automation_bootstrap_proposal
      (id,automation_id,revision,invocation_id,thread_id,bud_id,call_id,frozen,fingerprint,member_count,expires_at,created_by_user_id)
      values ($1,$2,1,'inv-a',$3,'bud-a',$4,'{}',repeat('a',64),1,now()+interval '1 day',$5)`;
    await client.query(insert, ["bp-a", "rule-a", thread, "call-a", "a"]);
    await reject(insert, ["duplicate", "rule-a", thread, "call-a", "a"], "23505");
    await reject(insert, ["foreign-rule", "rule-b", thread, "call-b", "a"], "23503");
    await reject(insert, ["foreign-context", "rule-b", thread, "call-b", "b"], "23503");
    await reject(insert, ["missing-action", "rule-a", thread, "missing", "a"], "23503");
    await client.query("insert into automation_bootstrap_proposal_member values ('bp-a',0,'contact-a','a',null)");
    await reject("insert into automation_bootstrap_proposal_member values ('bp-a',1,'contact-b','a',null)", [], "23503");
    await reject("insert into automation_bootstrap_proposal_member values ('bp-a',1,'contact-b','b',null)", [], "23503");
    await reject("insert into automation_bootstrap_proposal_member values ('bp-a',1,'contact-a','a',null)", [], "23505");
    for (const assignment of ["status='approved'", "status='declined'", "bootstrap_id='receipt-a'", "member_count=0", "member_count=1001", "fingerprint='bad'", "version=-1", "expires_at=created_at", "decision_request='{}'"])
      await reject(`update automation_bootstrap_proposal set ${assignment} where id='bp-a'`, [], "23514");
    const approve = `update automation_bootstrap_proposal set status='approved',bootstrap_id=$1,version=1,
      decision_request='{}',decision_idempotency_key='decision',decided_by_user_id=$2,decided_at=now() where id='bp-a'`;
    await reject(approve, ["receipt-b", "a"], "23503");
    await reject(approve, ["receipt-a", "b"], "23514");
    await client.query(approve, ["receipt-a", "a"]);
    assert.equal((await client.query("select to_regclass('automation_proposal') is null as isolated")).rows[0].isolated, true);
  } finally {
    await client.query("rollback");
    client.release(); await pool.end();
  }
});
