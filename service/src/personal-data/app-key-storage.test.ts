import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import "dotenv/config";
import { Pool } from "pg";

test("checked-in app-key migration enforces owner/context, dedupe and handoff state", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  const connectionString = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bud";
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname), "Local test database required");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const schema = `app_key_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("begin");
    await client.query(`create schema "${schema}"`);
    await client.query(`set local search_path to "${schema}"`);
    // Minimal pre-migration dependencies deliberately omit the new unique keys;
    // executing the actual SQL catches the generated FK ordering regression.
    await client.query(`create table "user" (id text primary key);
      create table agent_invocation (id text primary key, thread_id uuid not null, bud_id text not null, created_by_user_id text not null);
      create table agent_invocation_action (invocation_id text not null, call_id text not null, unique(invocation_id, call_id));
      create table proxied_site (proxied_site_id text primary key, bud_id text not null, created_by_user_id text not null)`);
    const migration = await readFile(new URL("../../drizzle/migrations/0032_flat_wilson_fisk.sql", import.meta.url), "utf8");
    await client.query(migration.replaceAll('"public".', `"${schema}".`).replaceAll('"auth"."user"', `"${schema}"."user"`));
    const thread = randomUUID();
    await client.query(`insert into "user" values ('owner-a'), ('owner-b');
      insert into agent_invocation_action values ('inv-a','call-a'), ('inv-a','call-b');
      insert into proxied_site values ('site-a','bud-a','owner-a'), ('site-b','bud-b','owner-b')`);
    await client.query("insert into agent_invocation values ('inv-a',$1,'bud-a','owner-a')", [thread]);
    const reject = async (query: string, values: unknown[], code: string) => {
      await client.query("savepoint rejected_write");
      await assert.rejects(client.query(query, values), (error: unknown) => {
        assert.equal((error as { code: string }).code, code); return true;
      });
      await client.query("rollback to savepoint rejected_write");
      await client.query("release savepoint rejected_write");
    };
    const insert = `insert into data_access_request (id,invocation_id,thread_id,bud_id,call_id,proxied_site_id,definition,definition_hash,expires_at,created_by_user_id)
      values ($1,'inv-a',$2,$3,$4,$5,'{}','fixture',now()+interval '1 day',$6)`;
    await client.query(insert, ["request-a", thread, "bud-a", "call-a", "site-a", "owner-a"]);
    await reject(insert, ["request-duplicate", thread, "bud-a", "call-a", "site-a", "owner-a"], "23505");
    await reject(insert, ["request-foreign", thread, "bud-a", "call-b", "site-a", "owner-b"], "23503");
    await reject(insert, ["request-wrong-thread", randomUUID(), "bud-a", "call-b", "site-a", "owner-a"], "23503");
    await reject(insert, ["request-wrong-site", thread, "bud-a", "call-b", "site-b", "owner-a"], "23503");
    await reject(insert, ["request-no-intent", thread, "bud-a", "missing", "site-a", "owner-a"], "23503");
    await reject("update data_access_request set status='approved' where id='request-a'", [], "23514");
    await client.query(`update data_access_request set status='approved', version=1, decision_request='{}',
      decision_idempotency_key='decision-a',decided_by_user_id='owner-a',decided_at=now() where id='request-a'`);
    await reject("update data_access_request set decided_by_user_id='owner-b' where id='request-a'", [], "23514");
    const insertKey = `insert into data_app_key (id,request_id,verification_hash,encrypted_envelope,ciphertext_digest,setup_expires_at,created_by_user_id)
      values ($1,'request-a','fixture',$2,'digest',now()+interval '1 day',$3)`;
    await reject(insertKey, ["key-foreign", '{"ciphertext":"fixture"}', "owner-b"], "23503");
    await reject(insertKey, ["key-no-envelope", null, "owner-a"], "23514");
    await client.query(insertKey, ["key-a", '{"ciphertext":"fixture"}', "owner-a"]);
    await reject(insertKey, ["key-duplicate", '{"ciphertext":"fixture"}', "owner-a"], "23505");
    await reject("update data_app_key set status='installed', encrypted_envelope=null where id='key-a'", [], "23514");
    await client.query("update data_app_key set status='installed', encrypted_envelope=null, installed_at=now() where id='key-a'");
    await reject("update data_app_key set status='revoked' where id='key-a'", [], "23514");
    await reject("update data_app_key set status='revoked',revoked_at=now(),revoked_by_user_id='owner-b' where id='key-a'", [], "23514");
    await client.query("update data_app_key set status='revoked',revoked_at=now(),revoked_by_user_id='owner-a' where id='key-a'");
    const columns = await client.query("select column_name from information_schema.columns where table_schema=$1 and table_name='data_app_key'", [schema]);
    assert.equal(columns.rows.some(row => ["secret", "credential", "private_key", "raw_key"].includes(row.column_name)), false);
  } finally {
    await client.query("rollback");
    client.release(); await pool.end();
  }
});
