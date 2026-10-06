import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { config } from "../../config.js";
import { ThreadChangeListener, type ThreadChange } from "./change-listener.js";

test("migration publishes committed summary, joined-row and transcript changes through one listener", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const schema = `changes_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}` });
  const listener = new ThreadChangeListener(database);
  t.after(async () => {
    await listener.close(); await database.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  await database.query(`CREATE TABLE thread(thread_id uuid, created_by_user_id text, title text, pinned boolean, archived boolean, updated_at timestamptz);
    CREATE TABLE bud(bud_id text,created_by_user_id text);
    CREATE TABLE thread_read_state(thread_id uuid,user_id text,last_seen_message_id uuid);
    CREATE TABLE terminal_session(thread_id uuid,created_by_user_id text,state text,closed_at timestamptz,updated_at timestamptz);
    CREATE TABLE message(message_id uuid,thread_id uuid,created_by_user_id text,content text,updated_at timestamptz);`);
  await database.query(await readFile(new URL("../../../drizzle/migrations/0049_thread_change_publication.sql", import.meta.url), "utf8"));
  // Real column names and types from the pushed local schema, so a renamed
  // column fails here instead of silently dropping hints. Constraints are
  // relaxed only to allow sparse fixture rows.
  const pendingTables = ["agent_question_request", "data_access_request", "automation_proposal",
    "automation_bootstrap_proposal", "browser_handoff", "agent_invocation", "agent_invocation_action"];
  for (const table of pendingTables) await database.query(`CREATE TABLE ${table} (LIKE public.${table})`);
  await database.query(`DO $$ DECLARE c record; BEGIN
    FOR c IN SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND is_nullable='NO' AND table_name = ANY('{${pendingTables.join(",")}}') LOOP
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', c.table_name, c.column_name);
    END LOOP; END $$`);
  await database.query(await readFile(new URL("../../../drizzle/migrations/0050_pending_request_notifications.sql", import.meta.url), "utf8"));
  const hints: ThreadChange[] = [];
  let losses = 0;
  listener.subscribe(hint => hints.push(hint), () => losses++);
  await Promise.all([listener.ready(), listener.ready()]);
  assert.equal(database.totalCount, 1, "coalesced startup keeps one checked-out LISTEN client");
  const id = randomUUID(), messageId = randomUUID();
  const settle = async () => {
    // A notification on the same channel is ordered after previous commits.
    const marker = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("notification timeout")); }, 3000);
      const unsubscribe = listener.subscribe(hint => {
        if (hint.owner === marker) { clearTimeout(timer); unsubscribe(); resolve(); }
      }, () => {});
      void database.query("select pg_notify('bud_thread_changes',$1)", [JSON.stringify({ schema, owner: marker, kind: "reset", thread_id: null, message_id: null })]).catch(reject);
    });
  };
  await database.query("insert into thread values($1,'owner','title',false,false,now())", [id]);
  await settle(); hints.length = 0;
  const transaction = await database.connect();
  await transaction.query("BEGIN");
  await transaction.query("update thread set pinned=true where thread_id=$1", [id]);
  await transaction.query("ROLLBACK"); transaction.release();
  await settle(); assert.equal(hints.filter(hint => hint.kind === "summary").length, 0);
  hints.length = 0;
  await database.query("update thread set pinned=true,archived=true where thread_id=$1", [id]);
  await database.query("insert into thread_read_state values($1,'owner',$2)", [id,messageId]);
  await database.query("insert into terminal_session values($1,'owner','ready',null,now())", [id]);
  await database.query("insert into message values($1,$2,'owner','content',now())", [messageId,id]);
  await settle();
  assert.equal(hints.filter(hint => hint.kind === "summary").length, 3);
  assert.ok(hints.some(hint => hint.kind === "message" && hint.message_id === messageId));
  assert.ok(hints.every(hint => !("content" in hint)), "notifications carry identities only");
  hints.length = 0;
  await database.query("update terminal_session set updated_at=now()");
  await database.query("update message set content='edited' where message_id=$1", [messageId]);
  await database.query("update thread set created_by_user_id='other' where thread_id=$1", [id]);
  await settle();
  assert.ok(hints.some(hint => hint.kind === "transcript"));
  assert.deepEqual(hints.filter(hint => hint.kind === "summary").map(hint => hint.owner).sort(), ["other","owner"]);
  hints.length = 0;
  for (const table of ["agent_question_request", "data_access_request", "automation_proposal", "automation_bootstrap_proposal", "browser_handoff"]) {
    await database.query(`insert into ${table}(thread_id,created_by_user_id,status) values($1,'other','pending')`, [id]);
    await settle();
    assert.ok(hints.some(h => h.kind === "pending" && h.owner === "other" && h.thread_id === id), table);
    hints.length = 0;
    const tx = await database.connect();
    await tx.query("BEGIN");
    await tx.query(`update ${table} set status='resolved'`);
    await tx.query("ROLLBACK"); tx.release();
    await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 0, `${table} rollback`);
    await database.query(`update ${table} set status='expired'`);
    await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 1, `${table} expiry`);
    hints.length = 0;
    await database.query(`delete from ${table}`);
    await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 1, `${table} deletion`);
    hints.length = 0;
  }
  await database.query("insert into agent_invocation(id,thread_id,created_by_user_id,status,reserves_thread) values('inv',$1,'other','waiting_for_user',true)", [id]);
  await settle(); hints.length = 0;
  // Ordinary tool progress never involves waiting_for_user and publishes nothing.
  await database.query("insert into agent_invocation_action(id,invocation_id,created_by_user_id,status) values('act','inv','other','intent')");
  await database.query("update agent_invocation_action set status='running',evidence='{\"k\":1}' where id='act'");
  await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 0, "ordinary action progress");
  await database.query("update agent_invocation_action set status='waiting_for_user' where id='act'");
  await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 1, "action parks"); hints.length = 0;
  await database.query("update agent_invocation set lease_expires_at=now()");
  await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 0);
  await database.query("update agent_invocation_action set status='completed'");
  await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 1); hints.length = 0;
  await database.query("update agent_invocation set reserves_thread=false,status='canceled'");
  await settle(); assert.equal(hints.filter(h => h.kind === "pending").length, 1);
  await listener.close();
  assert.equal(losses, 1);
  await assert.rejects(listener.ready(), /stopped/);
});
