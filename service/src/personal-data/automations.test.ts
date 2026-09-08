import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerPersonalDataRoutes } from "./routes.js";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { Automations } from "./automations.js";
import { DataGrants } from "./grants.js";

test("automation drafts and activation preserve consent, ownership and immutable revisions", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });
  const users = ["automation-" + randomUUID(), "automation-" + randomUUID()];
  const threadIds = users.map(() => randomUUID());
  const budIds = users.map(() => "bud-" + randomUUID());
  t.after(async () => {
    try {
      for (const table of [schema.automationRevisionTable, schema.automationTable, schema.agentDataGrantTable,
        schema.dataOwnerStateTable, schema.threadTable, schema.budTable]) await db.delete(table).where(inArray(table.createdByUserId, users));
      await db.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, users));
    } finally { await pool.end(); }
  });
  await db.insert(schema.authUserTable).values(users.map(id => ({ id, name: "Fixture", email: id + "@example.invalid", emailVerified: false })));
  await db.insert(schema.budTable).values(users.map((id, i) => ({ budId: budIds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: id })));
  await db.insert(schema.threadTable).values(users.map((id, i) => ({ threadId: threadIds[i], budId: budIds[i], createdByUserId: id })));
  const repo = new Automations(db);
  const grants = new DataGrants(db);
  const definition = { event_type: "contact.added", name: "New contacts", instruction: "Read available evidence.",
    sources: { source_ids: [] }, bud_id: budIds[0], model: "gpt-5.4", reasoning_effort: "low",
    target: { mode: "new_thread" }, data_access: { scopes: ["contacts.read"], history_days: 30 },
    latest_start_seconds: 86400, max_invocations_per_day: 100 };
  const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
  await assert.rejects(repo.create(users[1], definition), code("automation_target_not_found"));
  await assert.rejects(repo.create(users[0], { ...definition, sources: { source_ids: ["foreign"] } }), code("automation_source_not_found"));
  const rule = await repo.create(users[0], definition);
  assert.equal(rule.state, "draft");
  assert.equal(rule.active_revision, null);
  assert.deepEqual((await repo.list(users[1])).items, []);
  assert.equal((await repo.list(users[0])).items[0].automation_id, rule.automation_id);
  await assert.rejects(repo.get(users[1], rule.automation_id), code("automation_not_found"));
  await assert.rejects(repo.history(users[1], rule.automation_id), code("automation_not_found"));
  assert.deepEqual(await repo.history(users[0], rule.automation_id), { items: [], next_cursor: null });
  await assert.rejects(repo.history(users[0], rule.automation_id, { limit: 101 }), code("invalid_automation_query"));
  const foreignCursor = Buffer.from(JSON.stringify({ owner: users[1], automation: rule.automation_id,
    before: "01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toString("base64url");
  await assert.rejects(repo.history(users[0], rule.automation_id, { cursor: foreignCursor }), code("invalid_automation_cursor"));
  const approval = { expected_version: 0, expected_grant_version: 0, acknowledge_standing_work: true };
  await assert.rejects(repo.activate(users[1], rule.automation_id, approval), code("automation_not_found"));
  await assert.rejects(repo.activate(users[0], rule.automation_id, approval), code("data_permission_required"));
  await grants.update(users[0], { version: 0, scopes: ["contacts.read"], history_days: 90 });
  await assert.rejects(repo.activate(users[0], rule.automation_id, approval), code("grant_conflict"));
  await db.update(schema.dataOwnerStateTable).set({ publicationSequence: 7 }).where(eq(schema.dataOwnerStateTable.createdByUserId, users[0]));
  const concurrent = await Promise.allSettled([0, 1].map(() => repo.activate(users[0], rule.automation_id, { ...approval, expected_grant_version: 1 })));
  assert.equal(concurrent.filter(row => row.status === "fulfilled").length, 1);
  const [revision] = await db.select().from(schema.automationRevisionTable).where(eq(schema.automationRevisionTable.automationId, rule.automation_id));
  assert.equal(revision.publicationBoundary, 7);
  assert.equal(revision.activatedByUserId, users[0]);
  const edited = await repo.update(users[0], rule.automation_id, { expected_version: 1, definition: { ...definition, instruction: "Changed draft" } });
  assert.equal(edited.active_revision, 1);
  const detail = await repo.get(users[0], rule.automation_id);
  assert.equal(detail.draft.instruction, "Changed draft");
  assert.equal(detail.active?.definition.instruction, definition.instruction);
  const [unchanged] = await db.select().from(schema.automationRevisionTable).where(eq(schema.automationRevisionTable.automationId, rule.automation_id));
  assert.equal(unchanged.definition.instruction, definition.instruction);
  await assert.rejects(repo.update(users[0], rule.automation_id, { expected_version: 1, definition }), code("automation_conflict"));
  // Context uses the immutable active target even when a saved draft changes it.
  const targeted = await repo.create(users[0], { ...definition, target: { mode: "existing_thread", thread_id: threadIds[0] } });
  await repo.activate(users[0], targeted.automation_id, { ...approval, expected_grant_version: 1 });
  await repo.update(users[0], targeted.automation_id, { expected_version: 1, definition });
  const context = await repo.list(users[0], { bud_id: budIds[0], thread_id: threadIds[0], state: "enabled" });
  assert.equal(context.context_filter, true);
  assert.deepEqual(context.items.map(item => item.automation_id), [targeted.automation_id]);
  assert.equal((context.items[0].active?.definition as { target: { mode: string } }).target.mode, "existing_thread");
  assert.equal((context.items[0].draft as { target: { mode: string } }).target.mode, "new_thread");
  assert.deepEqual((await repo.list(users[0], { bud_id: budIds[0], state: "draft" })).items, []);
  await assert.rejects(repo.list(users[1], { bud_id: budIds[0] }), code("automation_target_not_found"));
  await assert.rejects(repo.list(users[0], { bud_id: budIds[0], thread_id: threadIds[1] }), code("automation_target_not_found"));
  await assert.rejects(repo.list(users[0], { thread_id: threadIds[0] }));
  await grants.update(users[0], { version: 1, scopes: [], history_days: 90 });
  await assert.rejects(repo.activate(users[0], rule.automation_id, { ...approval, expected_version: 2, expected_grant_version: 2 }), code("data_permission_required"));

  const app = Fastify();
  await registerPersonalDataRoutes(app, { automations: repo, automationActivationEnabled: true,
    authenticate: async request => request.headers.authorization === "Bearer owner" ? { userId: users[0] }
      : request.headers.authorization === "Bearer other" ? { userId: users[1] } : null,
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
  });
  try {
    const headers = { authorization: "Bearer owner" };
    for (const [method, url] of [["POST", "/api/automations"], ["PUT", `/api/automations/${rule.automation_id}`],
      ["POST", `/api/automations/${rule.automation_id}/pause`]] as const) {
      assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 401);
    }
    const request = { method: "POST" as const, url: "/api/automations", headers,
      payload: { definition, idempotency_key: "stable-create" } };
    const creates = await Promise.all([app.inject(request), app.inject(request)]);
    assert.ok(creates.every(response => response.statusCode === 200));
    const created = creates[0].json();
    assert.equal(created.automation_id, creates[1].json().automation_id);
    assert.equal((await app.inject({ ...request, payload: { ...request.payload,
      definition: { ...definition, instruction: "Changed creation" } } })).statusCode, 409);
    assert.equal((await app.inject({ ...request, payload: { ...request.payload, owner: users[1] } })).statusCode, 400);
    const update = { method: "PUT" as const, url: `/api/automations/${created.automation_id}`, headers,
      payload: { expected_version: 0, definition: { ...definition, name: "Saved draft" } } };
    assert.equal((await app.inject({ ...update, headers: { authorization: "Bearer other" } })).statusCode, 404);
    assert.equal((await app.inject(update)).statusCode, 200);
    assert.equal((await app.inject(update)).statusCode, 409);
    assert.equal((await app.inject(request)).statusCode, 409, "creation retries cannot overwrite an edited rule");
    const pause = { method: "POST" as const, url: `/api/automations/${created.automation_id}/pause`, headers,
      payload: { expected_version: 1, cancel_pending: true, cancel_active: false } };
    assert.equal((await app.inject({ ...pause, headers: { authorization: "Bearer other" } })).statusCode, 404);
    const paused = await app.inject(pause);
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().state, "paused");
    assert.equal(paused.json().version, 2);
    assert.equal((await app.inject(pause)).statusCode, 409);
    const [stored] = await db.select().from(schema.automationTable).where(eq(schema.automationTable.id, created.automation_id));
    assert.equal(stored.createdByUserId, users[0]);
    assert.equal(stored.updatedByUserId, users[0]);
    assert.equal(stored.activeRevision, null);
    await grants.update(users[0], { version: 2, scopes: ["contacts.read"], history_days: 90 });
    const activate = { method: "POST" as const, url: `/api/automations/${created.automation_id}/activate`, headers,
      payload: { expected_version: 2, expected_grant_version: 3, acknowledge_standing_work: true } };
    assert.equal((await app.inject({ ...activate, headers: {} })).statusCode, 401);
    assert.equal((await app.inject({ ...activate, headers: { authorization: "Bearer other" } })).statusCode, 404);
    assert.equal((await app.inject({ ...activate, payload: { expected_version: 2, expected_grant_version: 3 } })).statusCode, 400);
    assert.equal((await app.inject({ ...activate, payload: { ...activate.payload, expected_grant_version: 2 } })).statusCode, 409);
    const activated = await app.inject(activate);
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().state, "enabled");
    assert.equal((await app.inject(activate)).statusCode, 409);
    const gated = Fastify();
    try {
      await registerPersonalDataRoutes(gated, { automations: repo, authenticate: async () => ({ userId: users[0] }),
        repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) } });
      assert.equal((await gated.inject(activate)).statusCode, 503);
      assert.equal((await gated.inject({ url: "/api/data/status" })).json().features.automation_activation, false);
    } finally { await gated.close(); }
  } finally { await app.close(); }
});
