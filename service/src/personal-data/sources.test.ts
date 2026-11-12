import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { DataRequestError } from "./contracts.js";
import { DataGrants } from "./grants.js";
import { parseBatch } from "./parser.js";
import { PostgresIngestRepository } from "./repository.js";
import { DataSources, sourceOfEventType, sourcesOfScopes } from "./sources.js";

test("event types and scopes map to sources", () => {
  assert.equal(sourceOfEventType("location.visit.v2"), "location");
  assert.equal(sourceOfEventType("location.region_transition.v1"), "location");
  assert.equal(sourceOfEventType("health.sample_deleted.v1"), "health");
  assert.equal(sourceOfEventType("contacts.repair_scan.v2"), "contacts");
  assert.equal(sourceOfEventType("photos.asset.v1"), null, "a type outside every source isn't gated");
  assert.equal(sourceOfEventType("locations"), null);
  assert.deepEqual(sourcesOfScopes(["contacts.read", "location.read"]), ["location", "contacts"]);
});

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof DataRequestError);
  assert.equal(error.code, expected);
  return true;
};

test("switches default off, block reads and ingest, keep history, and phones report state", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `sources_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  for (const table of ["data_source_setting", "data_source_setting_history", "data_installation_source_state", "data_owner_state",
    "data_installation", "data_collection_epoch", "data_event", "data_processing_job", "agent_data_grant", "data_app_key",
    "data_access_request", "location_observation", "location_visit", "health_workout", "health_sleep_segment", "contact"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const sources = new DataSources(db, new DataGrants(db));

  // A new account: everything off.
  const fresh = await sources.document("owner");
  assert.deepEqual(fresh.sources.map(source => [source.id, source.enabled]), [["location", false], ["health", false], ["contacts", false]]);
  assert.deepEqual(fresh.sources[0].stored, { first_at: null, last_received_at: null, counts: { visits: 0, points: 0 } });
  await assert.rejects(sources.requireOn("owner", ["location.read"]), code("source_off"));

  // Turning one on affects that source and that owner only.
  const location = await sources.set("owner", "location", { enabled: true }, "ios");
  assert.equal(location.enabled, true);
  await sources.requireOn("owner", ["location.read"]);
  await assert.rejects(sources.requireOn("owner", ["location.read", "contacts.read"]), (error: unknown) => {
    assert.ok(error instanceof DataRequestError);
    assert.deepEqual(error.details, { source: "contacts" });
    return true;
  });
  await assert.rejects(sources.requireOn("other", ["location.read"]), code("source_off"));
  await assert.rejects(sources.set("owner", "photos", { enabled: true }, "ios"), code("unknown_source"));
  await assert.rejects(sources.set("owner", "location", { enabled: "yes" }, "ios"), code("invalid_source_setting"));

  // Ingest: an off source's events are rejected, not stored; others in the batch are kept.
  const repository = new PostgresIngestRepository(db, undefined, sources);
  const upload = async (types: string[]) => {
    const context = { userId: "owner", installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = types.map(type => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: "2026-11-11T10:00:00Z", recorded_at: "2026-11-11T10:00:00Z", actor: { user_id: "owner", installation_id: "phone" }, payload: {} }));
    return repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
  };
  const mixed = await upload(["location.fix.v1", "health.workout.v2", "contacts.record.v2", "photos.asset.v1"]);
  assert.equal(mixed.accepted_count, 2, "location (on) and a type outside every source");
  assert.deepEqual(mixed.rejected.map(rejection => [rejection.line, rejection.code, rejection.retryable]),
    [[2, "source_off", false], [3, "source_off", false]]);
  assert.equal(mixed.acked_event_ids.length, 2);
  assert.deepEqual((await db.select({ type: s.dataEventTable.eventType }).from(s.dataEventTable)).map(row => row.type).sort(),
    ["location.fix.v1", "photos.asset.v1"]);

  // Off again: reads and ingest stop; what was stored stays; the grant isn't touched.
  await new DataGrants(db).update("owner", { scopes: ["location.read"], version: 0, history_days: 30 });
  await sources.set("owner", "location", { enabled: false }, "web");
  await sources.set("owner", "location", { enabled: false }, "web");
  await assert.rejects(sources.requireOn("owner", ["location.read"]), code("source_off"));
  assert.equal((await upload(["location.fix.v1"])).rejected[0].code, "source_off");
  assert.equal((await db.select().from(s.dataEventTable)).length, 2);
  const after = (await sources.document("owner")).sources[0];
  assert.equal(after.enabled, false);
  assert.deepEqual(after.agent, { allowed: true, grant_version: 1, detail: { history_days: 30, location_precision: "as_collected" } });
  const changes = await db.select().from(s.dataSourceSettingHistoryTable).orderBy(s.dataSourceSettingHistoryTable.changedAt);
  assert.deepEqual(changes.map(change => [change.enabled, change.changedBy]), [[true, "ios"], [false, "web"]], "a repeat isn't a change");

  // A phone reports permission, including one that has never uploaded; a late older report doesn't win.
  const report = await sources.report("owner", "phone-b", { reported_at: "2026-11-11T18:04:00Z", sources: {
    location: { permission: "granted", level: "always", caveats: ["reduced_accuracy"] },
    health: { permission: "unknowable", asked_at: "2026-11-11T18:03:00Z" }, contacts: { permission: "not_asked" } } });
  assert.deepEqual(report, { reported: 3, enabled: { location: false, health: false, contacts: false } });
  await sources.report("owner", "phone-b", { reported_at: "2026-11-11T17:00:00Z", sources: { location: { permission: "denied" } } });
  await sources.report("owner", "phone", { reported_at: "2026-11-11T18:05:00Z", sources: { location: { permission: "denied" } } });
  const phones = (await sources.document("owner")).sources[0].installations;
  assert.deepEqual(phones.map(phone => [phone.installation_id, phone.permission, phone.level, phone.caveats, phone.last_received_at !== null]),
    [["phone", "denied", null, [], true], ["phone-b", "granted", "always", ["reduced_accuracy"], false]]);
  assert.deepEqual((await sources.document("other")).sources[0].installations, []);
  await assert.rejects(sources.report("owner", "phone", { reported_at: "2026-11-11T18:05:00Z",
    sources: { location: { permission: "granted", coordinate: { lat: 1, lon: 1 } } } }), code("invalid_source_state"));
  await assert.rejects(sources.report("owner", "phone", { reported_at: "soon", sources: {} }), code("invalid_source_state"));

  // Phase 2: what the latest-reporting phone says decides why a source may have nothing new.
  const [where, health, contacts] = await sources.collection("owner", ["location", "health", "contacts"]);
  assert.deepEqual([where.state, where.permission, where.phones], ["permission_denied", "denied", 2], "the 18:05 report, not the 18:04 one");
  assert.deepEqual([health.state, health.permission], ["ok", "unknowable"], "asked is as much as Health can say");
  assert.equal(contacts.state, "permission_not_asked");
  assert.equal((await sources.collection("other", ["location"]))[0].state, "no_phone_reporting");
  await sources.report("owner", "phone", { reported_at: "2026-11-11T18:06:00Z", sources: { location: { permission: "granted", level: "while_using" } } });
  assert.equal((await sources.collection("owner", ["location"]))[0].state, "while_using_only");
  await sources.report("owner", "phone", { reported_at: "2026-11-11T18:07:00Z",
    sources: { location: { permission: "granted", level: "always", caveats: ["reduced_accuracy"] } } });
  const notes = await sources.collectionNotes("owner", ["location.read", "health.read", "contacts.read"]);
  assert.deepEqual(notes.map(note => [note.source, note.state, "next_step" in note]),
    [["location", "reduced_accuracy", true], ["contacts", "permission_not_asked", true]], "health can collect: nothing to note");
  // Settling an access request reads what the service holds, never what a client claims.
  assert.deepEqual(await sources.access("owner", "location"),
    { enabled: false, agent_allowed: true, permission: "granted", level: "always", caveats: ["reduced_accuracy"] });
  assert.deepEqual(await sources.access("other", "location"), { enabled: false, agent_allowed: false, permission: null, level: null, caveats: [] });
  assert.equal(await sources.readingArrived("owner", "never-uploaded"), false);
});
