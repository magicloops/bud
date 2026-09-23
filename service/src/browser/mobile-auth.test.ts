import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { config } from "../config.js";
import { BrowserControlRepository } from "./control-repository.js";
import { BrowserResourceRepository } from "./resource-repository.js";
import { BrowserMobileAuth, scopedBrowserOperation } from "./mobile-auth.js";

test("mobile control scope excludes destructive and host-window operations", () => {
  for (const op of ["acquire", "renew", "release", "return", "recover", "reopen"]) assert.ok(scopedBrowserOperation(op));
  for (const op of ["close", "reset", "stop", "show_window", "hide_window", "unknown"]) assert.equal(scopedBrowserOperation(op), false);
});

test("mobile visit: one-use grant, persistent identity, owner/secret checks, expiry and revocation", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const schema = `mobile_visit_test_${randomUUID().replaceAll("-", "")}`;
  const database = new Pool({ connectionString: config.databaseUrl, max: 4, options: `-c search_path=${schema}` });
  t.after(async () => { await database.query(`drop schema ${schema} cascade`); await database.end(); });
  await database.query(`create schema ${schema};
    create table bud(bud_id text primary key,created_by_user_id text,tenant_id text,device_secret text,accent_color text,created_at timestamptz default now());
    create table thread(thread_id uuid primary key,bud_id text,created_by_user_id text,deleted_at timestamptz,unique(thread_id,bud_id,created_by_user_id));
    create table agent_invocation(id text primary key,thread_id uuid,bud_id text,created_by_user_id text,status text,cancel_requested_at timestamptz,unique(id,thread_id,bud_id,created_by_user_id));
    insert into bud values('bud','alice','tenant','secret');`);
  for (const file of ["0039_bud_browser.sql", "0040_browser_claim_retirement.sql", "0041_demonic_stephen_strange.sql"]) {
    const migration = await readFile(new URL(`../../drizzle/migrations/${file}`, import.meta.url), "utf8");
    await database.query(migration.replaceAll('"public".', `"${schema}".`));
  }
  const resource = await new BrowserResourceRepository(database).ensure("alice", "bud");
  const thread = randomUUID(), viewer = randomUUID();
  await database.query("insert into thread values($1,'bud','alice',null)", [thread]);
  await database.query(`insert into browser_session(id,thread_id,bud_id,created_by_user_id,browser_id,generation,boot_id,state)
    values('session',$1,'bud','alice',$2,'generation','boot','ready')`, [thread,resource.id]);
  const session = await new BrowserControlRepository(database).get("alice", "session");
  const auth = new BrowserMobileAuth(database);
  const grant = await auth.mint(session, viewer);
  const raced = await Promise.all([auth.redeem(grant.grant), auth.redeem(grant.grant)]);
  assert.equal(raced.filter(Boolean).length, 1);
  const redeemed = raced.find(Boolean)!;
  assert.equal((await auth.resolve(redeemed.token))?.viewer_id, viewer);
  const restarted = new BrowserMobileAuth(database);
  assert.equal((await restarted.resolve(redeemed.token))?.id, grant.visit_id);
  assert.equal(await restarted.refresh("bob", grant.visit_id, grant.grant), false);
  assert.equal(await restarted.refresh("alice", grant.visit_id, "wrong"), false);
  assert.equal(await restarted.refresh("alice", grant.visit_id, grant.grant), true);
  await auth.revoke("bob", grant.visit_id);
  assert.ok(await auth.resolve(redeemed.token));
  await database.query("update browser_resource set retired_at=now() where id=$1", [resource.id]);
  assert.equal(await auth.resolve(redeemed.token), null);
  await database.query("update browser_resource set retired_at=null where id=$1", [resource.id]);
  await database.query("update browser_viewer_visit set expires_at=now()-interval '1 second' where id=$1", [grant.visit_id]);
  assert.equal(await auth.resolve(redeemed.token), null);
  assert.equal(await auth.refresh("alice", grant.visit_id, grant.grant), false, "expired visits cannot revive");
  const second = await auth.mint(session, viewer);
  const secondToken = (await auth.redeem(second.grant))!.token;
  await auth.revoke("alice", second.visit_id);
  assert.equal(await auth.resolve(secondToken), null);
  const expired = await auth.mint(session, viewer);
  await database.query("update browser_viewer_visit set grant_expires_at=now()-interval '1 second' where id=$1", [expired.visit_id]);
  assert.equal(await auth.redeem(expired.grant), null);
});
