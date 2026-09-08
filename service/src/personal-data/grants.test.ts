import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { DataGrants } from "./grants.js";
import { DataRequestError } from "./contracts.js";

test("agent field choices persist with legacy defaults, owner isolation and version checks", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("CREATE TEMP TABLE agent_data_grant (LIKE public.agent_data_grant INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE data_owner_state (LIKE public.data_owner_state INCLUDING ALL)");
    const grants = new DataGrants(drizzle(client, { schema }));
    const legacy = ["names", "organization", "phones", "emails"];
    assert.deepEqual((await grants.get("alice")).fields, legacy);
    const original = await grants.update("alice", { scopes: ["contacts.read"], history_days: 90, version: 0 });
    assert.deepEqual(original.fields, legacy);
    await grants.verifyFieldSchema();
    await client.query("ALTER TABLE agent_data_grant DROP COLUMN contact_fields");
    await assert.rejects(grants.verifyFieldSchema());
    const migration = await readFile(new URL("../../drizzle/migrations/0035_flippant_killmonger.sql", import.meta.url), "utf8");
    await client.query(migration);
    await grants.verifyFieldSchema();
    const migrated = await grants.get("alice");
    assert.deepEqual(migrated.fields, legacy, "existing grants receive only legacy fields");
    assert.equal(migrated.version, original.version);
    assert.deepEqual(migrated.scopes, original.scopes);
    const expanded = await grants.update("alice", { scopes: ["contacts.read"], history_days: 90, version: 1,
      fields: ["postal_addresses", "urls"] });
    assert.deepEqual(expanded.fields, ["postal_addresses", "urls"]);
    const reloaded = new DataGrants(drizzle(client, { schema }));
    assert.deepEqual((await reloaded.get("alice")).fields, expanded.fields);
    const oldClient = await reloaded.update("alice", { scopes: [], history_days: 30, version: 2 });
    assert.deepEqual(oldClient.fields, expanded.fields);
    await assert.rejects(grants.require("alice", ["contacts.read"]));
    assert.deepEqual((await grants.get("bob")).fields, legacy);
    assert.deepEqual((await grants.get("bob")).scopes, []);
    for (const fields of [null, "urls", ["photos"], ["urls", "urls"], [17]]) {
      await assert.rejects(grants.update("alice", { scopes: [], history_days: 30, version: 3, fields }),
        (e: unknown) => e instanceof DataRequestError && e.code === "invalid_grant");
    }
    await assert.rejects(grants.update("alice", { scopes: ["contacts.read"], history_days: 30, version: 1, fields: legacy }),
      (e: unknown) => e instanceof DataRequestError && e.code === "grant_conflict");
    const empty = await grants.update("alice", { scopes: ["contacts.read"], history_days: 30, version: 3, fields: [] });
    assert.deepEqual(empty.fields, []);
    assert.equal(empty.version, 4);
    const rows = await client.query("SELECT created_by_user_id, updated_by_user_id, contact_fields FROM agent_data_grant");
    assert.deepEqual(rows.rows, [{ created_by_user_id: "alice", updated_by_user_id: "alice", contact_fields: [] }]);
  } finally {
    client.release(); await pool.end();
  }
});
