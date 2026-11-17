import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { config } from "../config.js";
import { decryptGoogleCredentials, encryptGoogleCredentials } from "../google/credentials.js";

test("Google account migration retains grants and pending consents and allows distinct accounts per user", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `google_migration_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  await pool.query(`create schema ${namespace}`);
  t.after(async () => {
    try { await pool.query(`drop schema ${namespace} cascade`); } finally { await pool.end(); }
  });
  async function migrate(filename: string) {
    const ddl = await readFile(new URL(`../../drizzle/migrations/${filename}`, import.meta.url), "utf8");
    await pool.query(ddl.replaceAll('"auth"."user"', '"fixture_user"'));
  }

  await pool.query("create table fixture_user(id text primary key); insert into fixture_user values ('a'), ('b'), ('c')");
  await migrate("0070_google_connections.sql");
  await migrate("0071_google_drive_write_lease.sql");
  const lease = await pool.query(`insert into google_drive_write_lease
    (file_key, holder, created_by_user_id, expires_at) values ('shared-file', 'writer', 'a', now() + interval '1 minute')
    returning *`);
  const key = randomBytes(32);
  const grants = [
    { owner: "a", subject: "work", status: "connected", data: { tokens: { refresh_token: "work-refresh" } } },
    { owner: "b", subject: "personal", status: "connecting", data: {
      tokens: { refresh_token: "personal-refresh" }, previousStatus: "connected" as const, verifier: "old-verifier",
    } },
  ];
  for (const { owner, subject, status, data } of grants) {
    const id = `existing-${owner}`;
    const ciphertext = encryptGoogleCredentials(data, JSON.stringify([owner, id, "client"]), key);
    await pool.query(`insert into google_connection
      (id, oauth_client_id, account_subject, created_by_user_id, granted_scopes, status, encrypted_credentials)
      values ($1, 'client', $2, $3, array['scope'], $4, $5)`, [id, subject, owner, status, ciphertext]);
  }
  await pool.query(`update google_connection set oauth_state_hash='old-state',
    oauth_session_hash='session', oauth_expires_at=now(), grant_epoch=3, refresh_lease_until=now() + interval '30 seconds' where status='connecting'`);
  await pool.query(`insert into google_connection (id, oauth_client_id, created_by_user_id, status)
    values ('empty', 'client', 'c', 'disconnected')`);
  const before = await pool.query("select * from google_connection order by id");
  await migrate("0072_multiple_google_accounts.sql");
  const after = await pool.query("select * from google_connection order by id");
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual((await pool.query("select * from google_drive_write_lease")).rows, lease.rows);
  for (const grant of grants) {
    const row = after.rows.find(row => row.created_by_user_id === grant.owner);
    assert.ok(row);
    assert.deepEqual(decryptGoogleCredentials(row.encrypted_credentials,
      JSON.stringify([row.created_by_user_id, row.id, row.oauth_client_id]), key), grant.data);
  }

  const addAccount = (id: string, owner: string, subject: string) => pool.query(`insert into google_connection
    (id, oauth_client_id, created_by_user_id, account_subject, status) values ($1, 'client', $2, $3, 'connected')`,
  [id, owner, subject]);
  await addAccount("new-a", "a", "personal"); // An owner can add a second identity, also used by another Bud user.
  await assert.rejects(addAccount("dup-a", "a", "work"), { code: "23505" });
  const pending = (id: string, state: string) => pool.query(`insert into google_connection
    (id, oauth_client_id, created_by_user_id, status, oauth_state_hash, oauth_session_hash, oauth_expires_at)
    values ($1, 'client', 'a', 'connecting', $2, 'session', now() + interval '10 minutes')`, [id, state]);
  await pending("first", "new-state-1");
  await pending("second", "new-state-2");
  await assert.rejects(pending("reused-state", "old-state"), { code: "23505" });
});
