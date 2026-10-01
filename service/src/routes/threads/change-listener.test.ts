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
  await listener.close();
  assert.equal(losses, 1);
  await assert.rejects(listener.ready(), /stopped/);
});
