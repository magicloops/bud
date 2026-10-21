import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { LocationQueries } from "./location.js";

test("visit reports merge into one visit, and recent picks the latest visit or point", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `location_visits_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  // Isolated copies keep fixture jobs away from the running development processor.
  for (const table of ["data_owner_state", "data_installation", "data_collection_epoch", "data_event", "data_processing_job",
    "location_observation", "location_visit", "location_visit_name", "place", "data_domain_event"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), queries = new LocationQueries(db);
  const upload = async (owner: string, values: Array<[string, Date, object]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, at, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: at.toISOString(), recorded_at: at.toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000);
  const visit = (key: string, arrival: Date | null, departure: Date | null, lat: number, accuracy: number) =>
    ["location.visit.v2", arrival ?? departure!, { visit_key: key, phase: departure ? "completed" : "arrived",
      arrival_at: arrival?.toISOString() ?? null, departure_at: departure?.toISOString() ?? null,
      coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: accuracy }] as [string, Date, object];
  const point = (at: Date, lat: number) => ["location.significant_change.v1", at,
    { coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: 300, speed_mps: -1, course_deg: -1, altitude_m: 0 }] as [string, Date, object];

  // Visit A: completed report arrives first, then the arrival report (out of order), less accurate.
  await upload("owner", [visit("a", ago(300), ago(240), 37.70, 20)]);
  await upload("owner", [visit("a", ago(300), null, 37.71, 80)]);
  // Visit B: arrival, then completed with a better coordinate.
  await upload("owner", [visit("b", ago(200), null, 37.72, 90), point(ago(150), 37.80)]);
  await upload("owner", [visit("b", ago(200), ago(120), 37.73, 15)]);
  // Visit C: still in progress. Visit D: an arrival from two days ago that never completed.
  await upload("owner", [visit("c", ago(30), null, 37.74, 25), visit("d", ago(60 * 48), null, 37.75, 25)]);
  // A v1 visit stands alone.
  await upload("owner", [["location.visit.v1", ago(400), { arrival_at: ago(400).toISOString(), departure_at: ago(350).toISOString(),
    coordinate: { lat: 37.76, lon: -122.4 }, horizontal_accuracy_m: 40 }]]);

  const window = { from: ago(60 * 72).toISOString(), to: new Date(now + 60_000).toISOString() };
  const all = await queries.visits("owner", window);
  assert.equal(all.items.length, 5, "two reports per visit become one visit each");
  const byKey = new Map(all.items.map(item => [item.visit_key, item]));
  const a = byKey.get("a")!, b = byKey.get("b")!;
  assert.deepEqual([a.state, a.coordinate.lat, a.horizontal_accuracy_m, a.duration_s], ["completed", 37.70, 20, 3600],
    "the completed report keeps its coordinate when a later arrival report is less accurate");
  assert.deepEqual([b.state, b.coordinate.lat, new Date(b.arrival_at!).getTime()], ["completed", 37.73, ago(200).getTime()],
    "the completed report replaces the arrival's coordinate");
  assert.equal(byKey.get("c")!.state, "in_progress");
  assert.equal(byKey.get("d")!.state, "end_unknown");
  assert.ok([...byKey.keys()].some(key => key.startsWith("v1:")));
  assert.equal(all.items[0].visit_key, "c", "newest first by default");
  const first = await queries.visits("owner", { ...window, limit: 2 });
  const second = await queries.visits("owner", { ...window, limit: 2, cursor: first.next_cursor! });
  assert.deepEqual(first.items.map(item => item.visit_key), ["c", "b"]);
  assert.equal(second.items[0].visit_key, "a");
  assert.ok(second.items[1].visit_key.startsWith("v1:"));
  await assert.rejects(queries.visits("owner", { ...window, order: "asc", cursor: first.next_cursor! }), { code: "invalid_cursor" });
  assert.equal((await queries.visits("other", window)).items.length, 0, "owners are isolated");

  // The in-progress visit is the latest location; it is fresh.
  const recent = await queries.recent("owner");
  assert.equal(recent.location?.kind, "visit");
  assert.equal((recent.location as { visit_key: string }).visit_key, "c");
  assert.equal(recent.stale, false);
  // History that ends before anything recorded hides it.
  assert.equal((await queries.recent("owner", { notBefore: new Date(now + 60_000) })).location, null);
  // Without visits, a point is the latest location, and an old one is stale.
  await upload("points", [point(ago(180), 37.9)]);
  const pointOnly = await queries.recent("points");
  assert.deepEqual([pointOnly.location?.kind, pointOnly.stale], ["point", true]);
  assert.equal((await queries.recent("nobody")).location, null);
  // A fix after the in-progress visit began is the latest location; near the visit, it says since when.
  const fix = (key: string, at: Date, lat: number) => ["location.fix.v1", at, { fix_key: key, reason: "foreground",
    coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: 10, speed_mps: 1, course_deg: 90, altitude_m: 0 }] as [string, Date, object];
  await upload("owner", [fix("fix:near", ago(5), 37.7401)]);
  const near = await queries.recent("owner");
  assert.equal(near.location?.kind, "fix");
  assert.equal((near.location as { within_visit?: { id: string } }).within_visit?.id, byKey.get("c")!.id);
  // A later fix away from it means iOS hasn't reported the departure yet: the fix wins, with its name.
  await upload("owner", [fix("fix:away", ago(2), 37.75), ["location.visit_named.v1", ago(1), { visit_key: "fix:away", source: "apple",
    named_at: ago(1).toISOString(), address: { short: "Market St", city: "San Francisco" }, place: null }]]);
  const moved = await queries.recent("owner");
  assert.equal((moved.location as { within_visit?: unknown }).within_visit, undefined, "away from the visit, no since");
  assert.deepEqual([moved.location?.kind, moved.location?.address?.short, moved.stale],
    ["fix", "Market St", false]);
  assert.ok(moved.age_seconds! >= 100 && moved.age_seconds! < 200);
  // Without a fix key, a fix is invalid and stored as nothing.
  await upload("owner", [["location.fix.v1", ago(1), { coordinate: { lat: 1, lon: 1 }, horizontal_accuracy_m: 10 }]]);
  // Timeline kind filter: points include fixes.
  const points = await queries.list("owner", { ...window, kind: "points" });
  assert.deepEqual([...new Set(points.items.map(item => item.kind))].sort(), ["fix", "significant_change"]);
  assert.equal(points.items.filter(item => item.kind === "fix").length, 2);
  assert.equal(points.items.find(item => item.visit_key === "fix:away")?.address?.short, "Market St");
});
