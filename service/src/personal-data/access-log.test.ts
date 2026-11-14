import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { AccessLog, countRecords, queryWindow } from "./access-log.js";
import { DataRequestError } from "./contracts.js";
import { DataGrants } from "./grants.js";
import { DataSources } from "./sources.js";

test("record counts and windows come from a result's shape, never its values", () => {
  assert.equal(countRecords({ items: [{ name: "Ada" }, { name: "Grace" }], next_cursor: null }), 2);
  assert.equal(countRecords({ places: [1, 2, 3], from: {} }), 3);
  assert.equal(countRecords({ location: null, stale: true }), 0);
  assert.equal(countRecords({ location: { kind: "visit" } }), 1);
  assert.equal(countRecords({ id: "contact", fields: {} }), 1);
  assert.equal(countRecords(null), 0);
  assert.deepEqual(queryWindow({ from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z", search: "Ada" }),
    { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") });
  assert.equal(queryWindow({ search: "Ada" }), undefined);
  assert.equal(queryWindow({ from: "not a date" }), undefined);
});

test("the access log lists, groups and names reads per owner, and shows what changed", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `access_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  for (const table of ["data_access_log", "agent_data_grant_history", "agent_data_grant", "data_owner_state", "data_source_setting",
    "data_source_setting_history", "data_installation_source_state", "data_installation", "data_app_key", "data_access_request", "data_source_request", "thread",
    "automation", "location_observation", "location_visit", "health_workout", "health_sleep_segment", "contact"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const log = new AccessLog(db), grants = new DataGrants(db), sources = new DataSources(db, grants, log);
  const thread = randomUUID(), deleted = randomUUID(), foreign = randomUUID();
  await db.insert(s.threadTable).values([
    { threadId: thread, budId: "bud", title: "Trip planning", createdByUserId: "alice" },
    { threadId: deleted, budId: "bud", title: "Gone", createdByUserId: "alice", deletedAt: new Date() },
    { threadId: foreign, budId: "bud", title: "Bob's thread", createdByUserId: "bob" }]);
  await db.insert(s.automationTable).values({ id: "auto-1", draft: { name: "Evening summary" }, createdByUserId: "alice", updatedByUserId: "alice" });
  await db.insert(s.dataAccessRequestTable).values({ id: "req-1", invocationId: "inv", threadId: thread, budId: "bud", callId: "call",
    proxiedSiteId: "site", definition: { app_label: "Week in review", data_access: { scopes: ["location.read"] } }, definitionHash: "hash",
    status: "approved", decisionRequest: {}, decisionIdempotencyKey: "decision", decidedByUserId: "alice", decidedAt: new Date(), createdByUserId: "alice", expiresAt: new Date(Date.now() + 86400_000) } as typeof s.dataAccessRequestTable.$inferInsert);
  await db.insert(s.dataAppKeyTable).values({ id: "key-1", requestId: "req-1", verificationHash: "v", status: "installed", ciphertextDigest: "d",
    setupExpiresAt: new Date(), installedAt: new Date("2026-11-10T09:00:00Z"), createdByUserId: "alice" });

  const agent = { kind: "agent" as const, ref: thread, threadId: thread, turnId: "turn-1" };
  await log.record({ owner: "alice", actor: agent, sources: ["location"], operation: "location_recent", recordCount: 1, policyVersion: 3 });
  // A two-source tool is one row per source.
  await log.record({ owner: "alice", actor: agent, sources: ["contacts", "location"], operation: "location_context", recordCount: 1,
    window: { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") } });
  await log.record({ owner: "alice", actor: agent, sources: ["location"], operation: "location_visits", outcome: "source_off" });
  await log.record({ owner: "alice", actor: { kind: "agent", ref: deleted, threadId: deleted }, sources: ["location"], operation: "location_recent", recordCount: 1 });
  await log.record({ owner: "alice", actor: { kind: "automation", ref: "auto-1", threadId: thread, turnId: "turn-2" }, sources: ["location"],
    operation: "trigger_evidence", recordCount: 1 });
  await log.record({ owner: "alice", actor: { kind: "app", ref: "key-1" }, sources: ["location"], operation: "timeline_query", recordCount: 12 });
  await log.record({ owner: "alice", actor: { kind: "processor", ref: "geoapify", threadId: thread, turnId: "turn-1" }, sources: ["location"],
    operation: "nearby_search", recordCount: 1 });
  await log.record({ owner: "alice", actor: { kind: "processor", ref: "geoapify" }, sources: ["location"], operation: "reverse_geocode", recordCount: 1 });
  await log.record({ owner: "bob", actor: { kind: "agent", ref: foreign, threadId: foreign }, sources: ["location"], operation: "location_recent", recordCount: 1 });
  await log.record({ owner: "alice", actor: agent, sources: [], operation: "nothing" });

  // The list: newest first, only the owner's, with names resolved from the owner's own rows.
  const all = await log.list("alice", {});
  assert.equal(all.items.length, 9);
  assert.equal(all.next_cursor, null);
  assert.ok(all.items.every((item, index) => index === 0 || all.items[index - 1].at >= item.at));
  const location = await log.list("alice", { source: "location" });
  assert.equal(location.items.length, 8);
  const refused = location.items.find(item => item.outcome === "source_off")!;
  assert.deepEqual([refused.operation, refused.record_count, refused.thread?.title, refused.thread?.exists], ["location_visits", null, "Trip planning", true]);
  const gone = location.items.find(item => item.thread?.id === deleted)!;
  assert.deepEqual([gone.thread?.title, gone.thread?.exists], [null, false], "a deleted conversation keeps its row and loses its link");
  assert.deepEqual((await log.list("alice", { actor_kind: "automation" })).items.map(item => [item.actor.label, item.operation, item.thread?.turn_id]),
    [["Evening summary", "trigger_evidence", "turn-2"]]);
  assert.deepEqual((await log.list("alice", { actor_kind: "app", actor_ref: "key-1" })).items.map(item => [item.actor.label, item.record_count]),
    [["Week in review", 12]]);
  assert.deepEqual((await log.list("alice", { actor_kind: "processor" })).items.map(item => item.actor.label), ["Geoapify", "Geoapify"]);
  const windowed = (await log.list("alice", { source: "contacts" })).items;
  assert.deepEqual(windowed.map(item => item.window), [{ from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") }]);
  // Pages don't overlap or skip.
  const first = await log.list("alice", { limit: "4" });
  const second = await log.list("alice", { limit: "4", cursor: first.next_cursor! });
  const third = await log.list("alice", { limit: "4", cursor: second.next_cursor! });
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(item => item.id), all.items.map(item => item.id));
  assert.equal(third.next_cursor, null);
  // Another owner sees only their own, and never a name from someone else's thread.
  const bobs = await log.list("bob", {});
  assert.deepEqual(bobs.items.map(item => item.thread?.title), ["Bob's thread"]);
  assert.equal((await log.list("bob", { actor_ref: thread })).items.length, 0);
  for (const query of [{ source: "photos" }, { actor_kind: "owner" }, { limit: "0" }, { cursor: "nope" }, { from: "x" }])
    await assert.rejects(log.list("alice", query), (error: unknown) => error instanceof DataRequestError && error.statusCode === 400);
  // No column holds content: only names of operations, counts and times.
  const raw = await pool.query(`select * from data_access_log where created_by_user_id = 'alice'`);
  assert.deepEqual(Object.keys(raw.rows[0]).sort(), ["actor_kind", "actor_ref", "at", "created_by_user_id", "id", "operation", "outcome",
    "policy_version", "record_count", "source", "tenant_id", "thread_id", "turn_id", "window_from", "window_to"]);

  // Recent access in the status document: grouped by actor, an agent's by conversation.
  const document = await sources.document("alice");
  const recent = document.sources.find(entry => entry.id === "location")!.recent_access;
  assert.deepEqual(recent.map(group => [group.actor.kind, group.actor.label, group.thread?.title ?? null, group.reads, group.refused]).sort(), [
    ["agent", null, "Trip planning", 2, 1], ["agent", null, null, 1, 0], ["app", "Week in review", null, 1, 0],
    ["automation", "Evening summary", null, 1, 0], ["processor", "Geoapify", null, 2, 0]].sort());
  assert.deepEqual(document.sources.find(entry => entry.id === "health")!.recent_access, []);
  const app = document.sources.find(entry => entry.id === "location")!.apps[0];
  assert.deepEqual([app.key_id, app.reads_last_week], ["key-1", 1]);
  assert.ok(app.last_read_at);
  // Older than a week: in the list, not in "recent".
  await pool.query(`update data_access_log set at = now() - interval '8 days' where actor_kind = 'app'`);
  assert.ok(!(await sources.document("alice")).sources.find(entry => entry.id === "location")!.recent_access.some(group => group.actor.kind === "app"));
  assert.equal((await log.list("alice", { actor_kind: "app" })).items.length, 1);
  // Without a log, the document still answers.
  assert.deepEqual((await new DataSources(db, grants).document("alice")).sources.map(entry => entry.recent_access), [[], [], []]);

  // What changed: the switch, the agent's permission (each version against the one before) and app keys.
  await sources.set("alice", "location", { enabled: true }, "ios");
  await grants.update("alice", { scopes: ["contacts.read"], history_days: 90, version: 0 });
  await grants.update("alice", { scopes: ["contacts.read", "location.read"], history_days: 90, version: 1 });
  await grants.update("alice", { scopes: ["contacts.read", "location.read"], history_days: 30, version: 2 });
  await grants.update("alice", { scopes: ["contacts.read"], history_days: 30, version: 3 });
  await sources.set("alice", "location", { enabled: false }, "web");
  await db.update(s.dataAppKeyTable).set({ status: "revoked", revokedAt: new Date() });
  const changes = (await log.changes("alice", "location")).changes;
  assert.ok(changes.every((change, index) => index === 0 || changes[index - 1].at >= change.at));
  assert.deepEqual(changes.map(change => change.kind === "switch" ? `switch ${change.enabled} ${change.by}` : change.kind === "agent" ? `agent ${change.allowed}`
    : change.kind === "agent_detail" ? `detail ${JSON.stringify(change.detail)}` : `app ${change.action} ${change.label}`).sort(), [
    "agent false", "agent true", "app approved Week in review", "app revoked Week in review", 'detail {"history_days":30}',
    "switch false web", "switch true ios"].sort());
  // Contacts: allowed from the first version; health was never allowed, so nothing to show.
  assert.deepEqual((await log.changes("alice", "contacts")).changes.map(change => [change.kind, change.allowed ?? change.detail]), [
    ["agent_detail", { history_days: 30, fields: ["names", "organization", "phones", "emails"] }], ["agent", true]]);
  assert.deepEqual((await log.changes("alice", "health")).changes, []);
  assert.deepEqual((await log.changes("bob", "location")).changes, []);
  await assert.rejects(log.changes("alice", "photos"), (error: unknown) => error instanceof DataRequestError && error.code === "unknown_source");
});
