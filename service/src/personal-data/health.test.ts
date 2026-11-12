import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { HealthQueries, parseHealthPayload } from "./health.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";

const sample = (overrides: Record<string, unknown> = {}) => ({ hk_uuid: "11111111-1111-4111-8111-111111111111",
  start_at: "2026-09-01T06:00:00.000Z", end_at: "2026-09-01T06:30:00.000Z", import_mode: "incremental",
  source: { name: "Apple Watch", bundle_id: "com.apple.health.watch" }, device: { name: "Apple Watch", model: "Watch" }, ...overrides });
const workout = (overrides: Record<string, unknown> = {}) => sample({ duration_s: 1800, activity_type: "running",
  activity_type_raw: 37, total_energy_kcal: 300, total_distance_m: 5000, indoor: false, ...overrides });

test("health payloads validate identity, times, source and kind-specific fields", () => {
  assert.equal(parseHealthPayload("health.workout.v2", workout())?.kind, "workout");
  assert.equal(parseHealthPayload("health.workout.v2", workout({ total_energy_kcal: null, indoor: null, activity_type_raw: null, device: null }))?.kind, "workout");
  assert.equal(parseHealthPayload("health.sleep_segment.v2", sample({ stage: "asleep_rem", value: 5 }))?.kind, "sleep_segment");
  assert.deepEqual(parseHealthPayload("health.sample_deleted.v1", { hk_uuid: "uuid", sample_kind: "workout" }),
    { kind: "deletion", hkUuid: "uuid", sampleKind: "workout" });
  for (const [type, payload] of [
    ["health.workout.v2", workout({ end_at: "2026-09-01T05:00:00.000Z" })],
    ["health.workout.v2", workout({ import_mode: "replay" })],
    ["health.workout.v2", workout({ duration_s: -1 })],
    ["health.workout.v2", workout({ source: { name: "Watch" } })],
    ["health.workout.v2", workout({ hk_uuid: "" })],
    ["health.sleep_segment.v2", sample({ stage: "dreaming", value: 9 })],
    ["health.sample_deleted.v1", { hk_uuid: "uuid", sample_kind: "heart_rate" }],
    ["health.workout.v1", workout()],
  ] as const) assert.equal(parseHealthPayload(type, payload), null, `${type} ${JSON.stringify(payload).slice(0, 60)}`);
});

test("health events project once per HealthKit UUID, honor deletions in any order and group sleep into nights", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `health_${randomUUID().replaceAll("-", "")}`;
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
    "health_workout", "health_sleep_segment", "health_sample_deletion", "data_domain_event"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);

  const owner = "health-owner", other = "health-other";
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), queries = new HealthQueries(db);
  const upload = async (user: string, values: Array<[string, unknown]>) => {
    const context = { userId: user, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: "2026-09-02T00:00:00.000Z", recorded_at: "2026-09-02T00:00:00.000Z", actor: { user_id: user, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const night = (uuid: string, stage: string, start: string, end: string, bundle = "com.apple.health.watch") =>
    ["health.sleep_segment.v2", sample({ hk_uuid: uuid, stage, value: 0, start_at: start, end_at: end, source: { name: bundle, bundle_id: bundle } })] as [string, unknown];

  await upload(owner, [
    ["health.workout.v2", workout()],
    ["health.workout.v2", workout({ hk_uuid: "22222222-2222-4222-8222-222222222222", activity_type: "walking", start_at: "2026-09-03T08:00:00.000Z", end_at: "2026-09-03T08:20:00.000Z" })],
    // Deleted before its sample arrives: the later upload must stay hidden.
    ["health.sample_deleted.v1", { hk_uuid: "33333333-3333-4333-8333-333333333333", sample_kind: "workout" }],
    ["health.workout.v2", { invalid: true }],
    // Monday night 23:00 to Tuesday 07:00 in New York, from the watch (stages) and the phone (unspecified).
    night("s1", "asleep_core", "2026-09-01T03:00:00.000Z", "2026-09-01T07:00:00.000Z"),
    night("s2", "asleep_deep", "2026-09-01T07:00:00.000Z", "2026-09-01T08:00:00.000Z"),
    night("s3", "asleep_rem", "2026-09-01T08:00:00.000Z", "2026-09-01T11:00:00.000Z"),
    night("s4", "awake", "2026-09-01T11:00:00.000Z", "2026-09-01T11:10:00.000Z"),
    night("p1", "asleep_unspecified", "2026-09-01T03:00:00.000Z", "2026-09-01T11:00:00.000Z", "com.apple.health.phone"),
    // Tuesday night, one source with overlapping unspecified and core samples over the same 8 hours.
    night("o1", "asleep_unspecified", "2026-09-02T03:00:00.000Z", "2026-09-02T11:00:00.000Z", "com.example.ring"),
    night("o2", "asleep_core", "2026-09-02T03:00:00.000Z", "2026-09-02T11:00:00.000Z", "com.example.ring"),
    // Wednesday night: a staged hour against eight unspecified hours from another source.
    night("h1", "asleep_core", "2026-09-03T03:00:00.000Z", "2026-09-03T04:00:00.000Z"),
    night("h2", "asleep_unspecified", "2026-09-03T03:00:00.000Z", "2026-09-03T11:00:00.000Z", "com.apple.health.phone"),
    // Thursday night: nine hours in bed (two overlapping in-bed samples) around eight hours asleep.
    night("b1", "in_bed", "2026-09-04T02:30:00.000Z", "2026-09-04T08:00:00.000Z", "com.example.bed"),
    night("b2", "in_bed", "2026-09-04T07:00:00.000Z", "2026-09-04T11:30:00.000Z", "com.example.bed"),
    night("b3", "asleep_core", "2026-09-04T03:00:00.000Z", "2026-09-04T11:00:00.000Z", "com.example.bed"),
  ]);
  await upload(owner, [["health.workout.v2", workout({ hk_uuid: "33333333-3333-4333-8333-333333333333" })],
    // A re-import updates the existing row without duplicating it or changing its first import mode.
    ["health.workout.v2", workout({ import_mode: "baseline", total_energy_kcal: 320 })]]);
  await upload(other, [["health.workout.v2", workout()]]);

  const jobs = await db.select().from(s.dataProcessingJobTable);
  assert.equal(jobs.filter(job => job.status === "invalid").length, 1);
  assert.equal(jobs.filter(job => job.status === "pending").length, 0);
  const window = { from: "2026-08-25T00:00:00Z", to: "2026-09-05T00:00:00Z" };
  const list = await queries.workouts(owner, window);
  assert.deepEqual(list.items.map(item => item.activity_type), ["running", "walking"]);
  assert.equal(list.items[0].total_energy_kcal, 320);
  assert.ok(list.coverage.last_received_at);
  assert.equal((await db.select().from(s.healthWorkoutTable)).filter(row => row.createdByUserId === owner).length, 3);
  assert.equal((await db.select().from(s.healthWorkoutTable)).find(row => row.createdByUserId === owner && row.hkUuid === "11111111-1111-4111-8111-111111111111")?.importMode, "incremental");
  assert.deepEqual((await queries.workouts(owner, { ...window, activity_type: "walking" })).items.length, 1);
  const first = await queries.workouts(owner, { ...window, limit: 1 });
  const second = await queries.workouts(owner, { ...window, limit: 1, cursor: first.next_cursor! });
  assert.equal(second.items[0].activity_type, "walking");
  await assert.rejects(queries.workouts(owner, { ...window, activity_type: "walking", cursor: first.next_cursor! }), { code: "invalid_cursor" });
  const newest = await queries.workouts(owner, { ...window, order: "desc", limit: 1 });
  assert.equal(newest.items[0].activity_type, "walking");
  assert.equal((await queries.workouts(owner, { ...window, order: "desc", limit: 1, cursor: newest.next_cursor! })).items[0].activity_type, "running");
  await assert.rejects(queries.workouts(owner, { ...window, order: "desc", cursor: first.next_cursor! }), { code: "invalid_cursor" });
  await assert.rejects(queries.workouts(owner, { from: "2025-01-01T00:00:00Z", to: "2026-09-05T00:00:00Z" }), { code: "invalid_time_window" });
  assert.equal((await queries.workouts(other, window)).items.length, 1, "owners are isolated");

  const sleep = await queries.sleep(owner, { ...window, timezone: "America/New_York" });
  const byNight = new Map(sleep.items.map(item => [item.night_of, item]));
  assert.deepEqual([...byNight.keys()], ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.ok(sleep.nights_without_records.includes("2026-08-25"));
  assert.match(sleep.selection_rule, /most sleep/);
  const monday = byNight.get("2026-08-31")!;
  assert.equal(monday.complete, true);
  assert.equal(monday.source.bundle_id, "com.apple.health.watch", "a staged source within 10% of the most sleep wins");
  assert.deepEqual(monday.sources.map(source => [source.bundle_id, source.asleep_minutes, source.has_stages, source.selected]),
    [["com.apple.health.watch", 480, true, true], ["com.apple.health.phone", 480, false, false]]);
  assert.equal(monday.asleep_minutes, 480);
  assert.deepEqual(monday.stage_minutes, { asleep_core: 240, asleep_deep: 60, asleep_rem: 180, awake: 10 });
  assert.equal(new Date(monday.sleep_end!).toISOString(), "2026-09-01T11:00:00.000Z");
  // Overlapping samples are merged: 8 hours of sleep, never 16, under the more specific stage.
  const tuesday = byNight.get("2026-09-01")!;
  assert.equal(tuesday.asleep_minutes, 480);
  assert.deepEqual(tuesday.stage_minutes, { asleep_core: 480 });
  // One staged hour does not beat eight unspecified hours.
  const wednesday = byNight.get("2026-09-02")!;
  assert.equal(wednesday.source.bundle_id, "com.apple.health.phone");
  assert.equal(wednesday.asleep_minutes, 480);
  // Time in bed is the union of in-bed samples, independent of sleep stages.
  const thursday = byNight.get("2026-09-03")!;
  assert.deepEqual([thursday.in_bed_minutes, thursday.asleep_minutes, thursday.stage_minutes],
    [540, 480, { asleep_core: 480, in_bed: 540 }]);
  // Nights are selected by their evening date, so a midnight start excludes the night before it.
  const fromMidnight = await queries.sleep(owner, { from: "2026-09-01T04:00:00Z", to: "2026-09-01T20:00:00Z", timezone: "America/New_York" });
  assert.deepEqual(fromMidnight.items.map(item => item.night_of), ["2026-09-01"]);
  // Approved history cuts a night: it is marked partial and only counts the visible part.
  const limited = await queries.sleep(owner, { from: "2026-08-31T12:00:00Z", to: "2026-08-31T20:00:00Z", timezone: "America/New_York" },
    { notBefore: new Date("2026-09-01T05:00:00Z") });
  assert.deepEqual([limited.items[0].complete, limited.items[0].partial_reasons, limited.items[0].asleep_minutes],
    [false, ["before_history_limit"], 360]);
  const during = await new HealthQueries(db, () => new Date("2026-09-01T10:00:00Z"))
    .sleep(owner, { from: "2026-08-31T12:00:00Z", to: "2026-08-31T20:00:00Z", timezone: "America/New_York" });
  assert.deepEqual(during.items[0].partial_reasons, ["in_progress"]);
  assert.equal((await queries.sleep(owner, { ...window, timezone: "Asia/Tokyo" })).items[0].night_of, "2026-09-01");
  await assert.rejects(queries.sleep(owner, { ...window, timezone: "Mars/Base" }), { code: "invalid_timezone" });
  const status = await queries.status(other);
  assert.ok(status.workouts_last_received_at);
  assert.equal(status.sleep_last_received_at, null);
});
