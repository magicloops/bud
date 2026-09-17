import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { config } from "../config.js";
import { BrowserControlRepository } from "./control-repository.js";
import { BrowserResourceRepository } from "./resource-repository.js";

// Exercise the migration against pre-change tables and use real row locks/CAS.
test("shared browser resource: owner, concurrent admission, private recovery, return and reset", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const schema = `browser_resource_test_${randomUUID().replaceAll("-", "")}`;
  const database = new Pool({ connectionString: config.databaseUrl, max: 4, options: `-c search_path=${schema}` });
  t.after(async () => { await database.query(`drop schema ${schema} cascade`); await database.end(); });
  await database.query(`create schema ${schema};
    create table bud(bud_id text primary key,created_by_user_id text,tenant_id text);
    create table thread(thread_id uuid primary key,bud_id text,created_by_user_id text,deleted_at timestamptz);
    create table browser_session(id text primary key,thread_id uuid,bud_id text,created_by_user_id text,
      desired_state text default 'open',state text default 'ready',closed_at timestamptz,updated_at timestamptz,
      created_at timestamptz default now(),generation text default 'gen',boot_id text default 'boot',
      control_epoch int default 1,sequence int default 0,invocation_id text,invocation_fence int,pending_until timestamptz);
    create table agent_invocation(id text primary key,created_by_user_id text,status text,cancel_requested_at timestamptz);
    create table browser_handoff(id text primary key,session_id text,invocation_id text,created_by_user_id text,
      status text default 'pending',returned_by_user_id text,resolved_at timestamptz);
    insert into bud values('bud','alice','tenant'),('other','bob',null);
    insert into browser_session(id,bud_id,created_by_user_id) values('legacy','bud','alice');`);
  for (const file of ["0044_dry_princess_powerful.sql", "0045_gorgeous_luke_cage.sql"]) {
    const migration = await readFile(new URL(`../../drizzle/migrations/${file}`, import.meta.url), "utf8");
    await database.query(migration.replaceAll('"public".', `"${schema}".`));
  }
  assert.equal((await database.query("select browser_id from browser_session where id='legacy'")).rows[0].browser_id, null,
    "migration must not silently relabel ephemeral profiles");
  const repo = new BrowserResourceRepository(database);
  await assert.rejects(repo.ensure("bob", "bud"), /not_found/);
  assert.equal(await repo.get("bob", "bud"), null);
  const opened = await Promise.all(Array.from({length:8}, () => repo.ensure("alice", "bud")));
  assert.equal(new Set(opened.map(r => r.id)).size, 1, "concurrent threads minted multiple profiles");
  let resource = opened[0];
  assert.equal(resource.tenant_id, "tenant");
  assert.equal(resource.created_by_user_id, "alice");
  const threadA = randomUUID(), threadB = randomUUID(), foreignThread = randomUUID();
  await database.query(`insert into thread values($1,'bud','alice',null),($2,'bud','alice',null),($3,'other','bob',null);
  `, [threadA,threadB,foreignThread]);
  await database.query(`insert into browser_session(id,thread_id,bud_id,created_by_user_id,browser_id) values
    ('a',$1,'bud','alice',$4),('b',$2,'bud','alice',$4),('foreign',$3,'other','bob',null)`, [threadA,threadB,foreignThread,resource.id]);
  await assert.rejects(database.query("update browser_session set browser_id=$1 where id='foreign'", [resource.id]), /foreign key/);
  const control = new BrowserControlRepository(database);
  const prepare = async (owner: string, bud: string, session: string, revision: number,
    operation: "pause" | "acquire" | "prepare_return" | "finish_return") => {
    await control.prepare(owner, session, "boot", revision, randomUUID(), {action:"control",operation},
      operation === "pause" ? "paused" : operation === "acquire" ? "human_private" : "resume_pending");
    return (await repo.get(owner,bud))!;
  };

  resource = await prepare("alice", "bud", "a", resource.revision, "pause");
  const racing = await Promise.allSettled([
    prepare("alice", "bud", "a", resource.revision, "acquire"),
    prepare("alice", "bud", "b", resource.revision, "acquire"),
  ]);
  assert.equal(racing.filter(r => r.status === "fulfilled").length, 1);
  resource = (await repo.get("alice", "bud"))!;
  assert.equal(resource.control_state, "human_private");
  assert.equal(resource.private_content, true);
  const controller = resource.control_session_id!;
  const beforeRestart = resource;
  await new BrowserResourceRepository(database).recover();
  resource = (await repo.ensure("alice", "bud"));
  assert.equal(resource.id, beforeRestart.id);
  assert.equal(resource.control_state, "paused");
  assert.equal(resource.private_content, true, "restart cleared private intent");
  assert.equal(await repo.failControl(beforeRestart), false, "late failure changed recovered authority");
  assert.ok(resource.control_epoch > beforeRestart.control_epoch);
  await assert.rejects(prepare("alice", "bud", controller === "a" ? "b" : "a", resource.revision, "prepare_return"), /control_conflict/);
  resource = await prepare("alice", "bud", controller, resource.revision, "prepare_return");
  await assert.rejects(repo.acknowledgeReturn(resource), /control_conflict/, "prepare acknowledgement unlocked browser");
  resource = await prepare("alice", "bud", controller, resource.revision, "finish_return");
  await database.query(`insert into agent_invocation values
    ('ia','alice','waiting_for_user',null),('ib','alice','waiting_for_user',null),
    ('cancel','alice','waiting_for_user',now()),('done','alice','succeeded',null);
    insert into browser_handoff(id,session_id,invocation_id,created_by_user_id) values
    ('ha','a','ia','alice'),('hb','b','ib','alice'),('hc','b','cancel','alice'),('hd','a','done','alice');`);
  const returnReceipt = resource;
  resource = await repo.acknowledgeReturn(resource);
  assert.equal(resource.private_content, false);
  assert.equal(resource.control_state, "agent");
  const waits = (await database.query("select id,status,returned_by_user_id from browser_handoff order by id")).rows;
  assert.deepEqual(waits.map(r => [r.id,r.status]), [["ha","returned"],["hb","returned"],["hc","canceled"],["hd","canceled"]]);
  assert.ok(waits.every(r => r.returned_by_user_id === "alice"));
  await assert.rejects(repo.acknowledgeReturn(returnReceipt), /revision_conflict/);

  await assert.rejects(async () => repo.requestLifecycle("alice", "bud", resource.revision, "reset"), /confirmation_required/);
  const reset = await repo.requestLifecycle("alice", "bud", resource.revision, "reset", true);
  assert.equal(reset.desired_state, "reset_pending");
  await repo.recover();
  assert.equal((await repo.get("alice", "bud"))!.desired_state, "reset_pending", "offline reset reported complete");
  await assert.rejects(prepare("alice", "bud", "a", reset.revision, "pause"), /not_found/);
  await assert.rejects(repo.acknowledgeLifecycle({...reset,lifecycle_request_id:"wrong"}), /stale_acknowledgement/);
  resource = await repo.acknowledgeLifecycle(reset);
  assert.equal(resource.desired_state, "stopped");
  assert.equal(resource.profile_generation, reset.profile_generation + 1);
  assert.equal((await database.query("select count(*)::int n from browser_session where browser_id=$1 and closed_at is null", [resource.id])).rows[0].n, 0);
  await assert.rejects(repo.acknowledgeLifecycle(reset), /revision_conflict/);
  assert.equal((await database.query("select closed_at from browser_session where id='foreign'")).rows[0].closed_at, null);

  // A re-claim must retire before identity reuse; restoring the same owner later
  // gets a new opaque profile identity rather than another account's old data.
  await database.query("update bud set created_by_user_id='bob' where bud_id='bud'");
  assert.equal(await repo.get("alice", "bud"), null);
  const bob = await repo.ensure("bob", "bud");
  assert.notEqual(bob.id, resource.id);
  await database.query("update bud set created_by_user_id='alice' where bud_id='bud'");
  const alice = await repo.ensure("alice", "bud");
  assert.notEqual(alice.id, resource.id);
  assert.notEqual(alice.id, bob.id);
  assert.equal((await database.query("select count(*)::int n from browser_resource where bud_id='bud' and retired_at is null")).rows[0].n, 1);
});
