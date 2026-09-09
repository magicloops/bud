import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { automationModelResolver, resolveSavedAutomationModel } from "./automation-model.js";
import { automationDefinitionSchema } from "./automation-contracts.js";

test("retirement fallback preserves valid effort and adjusts unsupported effort", () => {
  assert.deepEqual(resolveSavedAutomationModel("gpt-5.5", "low", "gpt-6-astra"), {
    model: "gpt-6-astra", reasoning_effort: "low", fallback: true, reasoning_adjusted: false,
  });
  assert.equal(resolveSavedAutomationModel("gpt-5.5", "none", "gpt-6-astra").reasoning_effort, "medium");
  assert.equal(resolveSavedAutomationModel(null, null, "gpt-5.6-luna").reasoning_effort, "high");
  assert.throws(() => resolveSavedAutomationModel("retired-cloud", "low", "invalid-default"), { code: "default_model_unavailable" });
});

test("local model disappearance does not authorize cloud fallback", () => {
  for (const model of ["bud-local:owned:offline-model", "ds4-deepseek-v4-flash"]) {
    const result = resolveSavedAutomationModel(model, "low", "gpt-5.6-luna");
    assert.equal(result.model, model);
    assert.equal(result.fallback, false);
  }
});

test("owner-scoped inheritance and migration preserve original model evidence", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["bud", "thread", "automation", "automation_revision", "automation_proposal", "automation_bootstrap_proposal"]) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }
    const database = drizzle(client, { schema });
    const id = randomUUID(), foreignId = randomUUID();
    await database.insert(schema.budTable).values([{ budId: "owned", name: "Owned", os: "test", arch: "test", createdByUserId: "alice" }, { budId: "foreign", name: "Foreign", os: "test", arch: "test", createdByUserId: "bob" }]);
    await database.insert(schema.threadTable).values([{ threadId: id, budId: "owned", modelId: "gpt-6-astra", reasoningEffort: "medium", createdByUserId: "alice" }, { threadId: foreignId, budId: "foreign", modelId: "gpt-5.6-sol", createdByUserId: "bob" }]);
    const definition = automationDefinitionSchema.parse({ name: "Fixture", instruction: "Test", event_type: "contact.added", bud_id: "owned", sources: { source_ids: [] }, target: { mode: "existing_thread", thread_id: id }, model_mode: "inherit", model: "gpt-5.5", reasoning_effort: "none", data_access: { scopes: ["contacts.read"], history_days: 30 }, latest_start_seconds: 60, max_invocations_per_day: 5 });
    const resolve = await automationModelResolver(database, "alice", [definition]);
    assert.equal(resolve(definition).model, "gpt-6-astra");
    assert.equal(resolve(definition).source, "destination_thread");
    assert.equal(resolve({ ...definition, model_mode: "explicit" }).fallback_reason, "model_retired");
    assert.throws(() => resolve({ ...definition, target: { mode: "existing_thread", thread_id: foreignId } }), { code: "automation_target_not_found" });
    const newThread = { ...definition, target: { mode: "new_thread" as const }, origin_thread_id: id };
    assert.equal((await automationModelResolver(database, "alice", [newThread]))(newThread).source, "origin_thread");
    await client.query("UPDATE thread SET model_id='gpt-5.6-terra', reasoning_effort='low' WHERE thread_id=$1", [id]);
    assert.equal((await automationModelResolver(database, "alice", [definition]))(definition).model, "gpt-5.6-terra");
    assert.equal(resolve(definition).model, "gpt-6-astra", "a previously resolved snapshot remains unchanged");
    await client.query("UPDATE thread SET deleted_at=now() WHERE thread_id=$1", [id]);
    assert.equal((await automationModelResolver(database, "alice", [newThread]))(newThread).fallback_reason, "inheritance_source_unavailable");
    const legacy = { ...definition, model_mode: undefined };
    await database.insert(schema.automationTable).values({ id: "a", draft: legacy, state: "enabled", activeRevision: 1, version: 1, createdByUserId: "alice", updatedByUserId: "alice" });
    await database.insert(schema.automationRevisionTable).values({ automationId: "a", revision: 1, definition: legacy, publicationBoundary: 4, grantVersion: 1, activatedByUserId: "alice", createdByUserId: "alice" });
    await database.insert(schema.automationTable).values({ id: "paused", draft: { ...legacy, target: { mode: "new_thread" } }, state: "paused", version: 3, createdByUserId: "alice", updatedByUserId: "alice" });
    await database.insert(schema.automationProposalTable).values({ id: "proposal", automationId: "paused", invocationId: "human", threadId: id, budId: "owned", callId: "call", definition: legacy, draftVersion: 3, grantVersion: 1, createdByUserId: "alice", expiresAt: new Date(Date.now() + 3600000) });
    const migration = await readFile(new URL("../../drizzle/migrations/0038_automation_model_inheritance.sql", import.meta.url), "utf8");
    await client.query(migration);
    const rows = await client.query("SELECT draft FROM automation WHERE id='a'");
    assert.equal(rows.rows[0].draft.model_mode, "inherit");
    assert.equal(rows.rows[0].draft.model, "gpt-5.5");
    assert.equal(rows.rows[0].draft.origin_thread_id, null);
    const revision = await client.query("SELECT definition FROM automation_revision WHERE automation_id='a'");
    assert.equal(revision.rows[0].definition.model_mode, "inherit");
    const paused = (await client.query("SELECT draft, state FROM automation WHERE id='paused'")).rows[0];
    assert.equal(paused.draft.origin_thread_id, id);
    assert.equal(paused.draft.model_mode, "inherit");
    assert.equal(paused.state, "paused");
    assert.equal((await client.query("SELECT status FROM automation_proposal WHERE id='proposal'")).rows[0].status, "stale");
    await client.query(migration);
    assert.equal((await client.query("SELECT version FROM automation WHERE id='a'")).rows[0].version, 2, "migration is idempotent");
  } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
});
