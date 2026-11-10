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
import { DailyCredits, Geoapify } from "./geoapify.js";
import { VisitNaming } from "./visit-naming.js";

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
    "location_observation", "location_visit", "location_visit_name", "place", "place_presence", "place_presence_event", "data_domain_event"])
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
  // November 10: the arrival report was ±22 m and the completed one ±94 m, 34 m off. The completed
  // report still completes the visit, but the more accurate coordinate stays.
  await upload("cafe", [visit("brazil", ago(120), null, 37.75257, 22)]);
  await upload("cafe", [visit("brazil", ago(120), ago(107), 37.75249, 94)]);
  const [cafe] = (await queries.visits("cafe", window)).items;
  assert.deepEqual([cafe.state, cafe.coordinate.lat, cafe.horizontal_accuracy_m, cafe.duration_s], ["completed", 37.75257, 22, 13 * 60]);
  assert.equal(byKey.get("c")!.state, "in_progress");
  assert.deepEqual([byKey.get("d")!.state, byKey.get("d")!.left?.evidence, byKey.get("d")!.left?.by.getTime()],
    ["left", "later_visit", ago(400).getTime()], "a later visit elsewhere ends a two-day-old arrival");
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
  assert.ok(Math.abs(recent.age_seconds! - 1800) < 60, "age is since the arrival was observed, not now");
  // An eight-hour-old unfinished visit is old, and a fresh point 100 km away beats it.
  await upload("drifter", [visit("old", ago(480), null, 37.70, 30)]);
  const unfinished = await queries.recent("drifter");
  assert.deepEqual([unfinished.location?.kind, unfinished.stale], ["visit", true]);
  assert.ok(unfinished.age_seconds! >= 480 * 60 - 60);
  await upload("drifter", [point(ago(5), 38.60)]);
  const moved = await queries.recent("drifter");
  assert.deepEqual([moved.location?.kind, moved.stale, (moved.location as { within_visit?: unknown }).within_visit],
    ["point", false, undefined]);
  assert.ok(moved.age_seconds! < 400);
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
  // Phase 13 freshness: the fix and the open visit it's at, newest first; here since the visit's arrival, not moving.
  assert.deepEqual(near.recent_readings?.map(reading => [reading.kind, reading.speed_mps, reading.visit_id]),
    [["fix", 1, undefined], ["visit", undefined, byKey.get("c")!.id]]);
  assert.deepEqual([near.since?.getTime(), near.moving], [ago(30).getTime(), false]);
  assert.match(near.now_note!, /^Probably still here: a visit open for 30 minutes and the latest reading 5 minutes ago\.$/);
  // A later fix away from it means iOS hasn't reported the departure yet: the fix wins, with its name.
  // A fix taken when Bud opens is named by the service (Phase 11's naming worker, Geoapify).
  await upload("owner", [fix("fix:away", ago(2), 37.75)]);
  const geoapify = new Geoapify("key", new DailyCredits(100), async url => ({ ok: true, status: 200, json: async () =>
    new URL(url).pathname === "/v1/geocode/reverse" ? { results: [{ address_line1: "Market St", city: "San Francisco" }] } : { features: [] } }));
  const naming = new VisitNaming(db, geoapify);
  while (await naming.nameNext(5, "owner")) { /* drain */ }
  assert.equal((await db.select().from(s.locationVisitNameTable)).find(row => row.visitKey === "fix:near")?.source, "geoapify",
    "foreground fixes are named too");
  const away = await queries.recent("owner");
  assert.equal((away.location as { within_visit?: unknown }).within_visit, undefined, "away from the visit, no since");
  assert.deepEqual([away.location?.kind, away.location?.address?.short, away.stale],
    ["fix", "Market St, San Francisco", false]);
  assert.ok(away.age_seconds! >= 100 && away.age_seconds! < 200);
  // Two fixes a kilometre apart within 15 minutes: moving, here only since the newest.
  assert.deepEqual([away.recent_readings?.length, away.moving, away.since?.getTime()], [2, true, ago(2).getTime()]);
  assert.match(away.now_note!, /^Moving as of 2 minutes ago/);
  // Without a fix key, a fix is invalid and stored as nothing.
  await upload("owner", [["location.fix.v1", ago(1), { coordinate: { lat: 1, lon: 1 }, horizontal_accuracy_m: 10 }]]);
  // The fix 1 km away ends the open visit, with the nearby fix as the last sighting there.
  const c = (await queries.visits("owner", window)).items.find(item => item.visit_key === "c")!;
  assert.deepEqual([c.state, c.left?.evidence, c.left?.by.getTime(), c.left?.last_seen_at?.getTime(), c.left?.max_duration_s],
    ["left", "reading_elsewhere", ago(2).getTime(), ago(5).getTime(), 28 * 60]);

  // November 9 (Precita Park): iOS reports the arrival early, and the phone records it four minutes
  // later. A reading on the way there, after the reported arrival but before it was recorded,
  // doesn't end it; a reading there does count as a sighting; the next visit elsewhere ends it.
  const park = { lat: 37.74712, lon: -122.41282 }, home = { lat: 37.74909, lon: -122.41594 };
  const at = (lat: number, lon: number) => ({ coordinate: { lat, lon }, horizontal_accuracy_m: 19, speed_mps: -1, course_deg: -1, altitude_m: 0 });
  const report = (key: string, arrival: Date, recorded: Date, where: { lat: number; lon: number }, accuracy: number) => ({
    schema_version: 1, event_id: randomUUID(), event_type: "location.visit.v2", occurred_at: arrival.toISOString(),
    recorded_at: recorded.toISOString(), actor: { user_id: "walker", installation_id: "phone" },
    payload: { visit_key: key, phase: "arrived", arrival_at: arrival.toISOString(), departure_at: null,
      coordinate: where, horizontal_accuracy_m: accuracy } });
  const context = { userId: "walker", installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
  await repository.persist(context, await parseBatch(Buffer.from(JSON.stringify(report("park", ago(60), ago(56), park, 40))), "", context));
  while (await processor.processNext()) { /* drain */ }
  const onTheWay = ["location.fix.v1", new Date(ago(60).getTime() + 3000), { fix_key: "fix:way", reason: "follow_up",
    ...at(37.74901, -122.41452) }] as [string, Date, object];
  await upload("walker", [onTheWay, ["location.significant_change.v1", ago(52), at(37.74725, -122.41300)]]);
  const parkOpen = (await queries.visits("walker", window)).items[0];
  assert.deepEqual([parkOpen.state, parkOpen.left], ["in_progress", undefined], "the reading on the way there doesn't end it");
  await repository.persist({ ...context, batchId: randomUUID() },
    await parseBatch(Buffer.from(JSON.stringify(report("home", ago(37), ago(32), home, 3))), "", { ...context, batchId: randomUUID() }));
  while (await processor.processNext()) { /* drain */ }
  const [homeVisit, parkVisit] = (await queries.visits("walker", window)).items;
  assert.deepEqual([parkVisit.state, parkVisit.left?.evidence, parkVisit.left?.by.getTime(), parkVisit.left?.last_seen_at?.getTime(),
    parkVisit.left?.max_duration_s], ["left", "later_visit", ago(37).getTime(), ago(52).getTime(), 23 * 60]);
  assert.equal(homeVisit.state, "in_progress");
  const walkerNow = await queries.recent("walker");
  assert.deepEqual([walkerNow.location?.kind, (walkerNow.location as { state?: string }).state], ["visit", "in_progress"]);

  // Two unfinished visits at the same spot (iOS can split one stay), then one elsewhere: the
  // first isn't held open by the second, which counts as a sighting there.
  await upload("splitter", [visit("a1", ago(90), null, 37.80, 20), visit("a2", ago(70), null, 37.80, 20),
    visit("b", ago(40), null, 37.85, 20)]);
  const split = new Map((await queries.visits("splitter", window)).items.map(item => [item.visit_key, item]));
  assert.deepEqual([split.get("a1")!.state, split.get("a1")!.left?.evidence, split.get("a1")!.left?.by.getTime(),
    split.get("a1")!.left?.last_seen_at?.getTime()], ["left", "later_visit", ago(40).getTime(), ago(70).getTime()]);
  assert.deepEqual([split.get("a2")!.state, split.get("a2")!.left?.by.getTime()], ["left", ago(40).getTime()]);
  assert.equal(split.get("b")!.state, "in_progress");

  // Timeline kind filter: points include fixes.
  const points = await queries.list("owner", { ...window, kind: "points" });
  assert.deepEqual([...new Set(points.items.map(item => item.kind))].sort(), ["fix", "significant_change"]);
  assert.equal(points.items.filter(item => item.kind === "fix").length, 2);
  assert.equal(points.items.find(item => item.visit_key === "fix:away")?.address?.short, "Market St, San Francisco");
});
