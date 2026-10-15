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
    "health_workout", "health_sleep_segment", "health_sample_deletion"])
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
    night("p1", "asleep_unspecified", "2026-09-01T03:00:00.000Z", "2026-09-01T12:00:00.000Z", "com.apple.health.phone"),
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
  await assert.rejects(queries.workouts(owner, { from: "2025-01-01T00:00:00Z", to: "2026-09-05T00:00:00Z" }), { code: "invalid_time_window" });
  assert.equal((await queries.workouts(other, window)).items.length, 1, "owners are isolated");

  const sleep = await queries.sleep(owner, { ...window, timezone: "America/New_York" });
  assert.equal(sleep.items.length, 1);
  const [monday] = sleep.items;
  assert.equal(monday.night_of, "2026-08-31");
  assert.equal(monday.source.bundle_id, "com.apple.health.watch", "the source with stage detail wins");
  assert.deepEqual(monday.other_sources.map(source => source.bundle_id), ["com.apple.health.phone"]);
  assert.equal(monday.asleep_minutes, 480);
  assert.deepEqual(monday.stage_minutes, { awake: 10, asleep_core: 240, asleep_deep: 60, asleep_rem: 180 });
  assert.equal(new Date(monday.sleep_end!).toISOString(), "2026-09-01T11:00:00.000Z");
  assert.equal((await queries.sleep(owner, { ...window, timezone: "Asia/Tokyo" })).items[0].night_of, "2026-09-01");
  await assert.rejects(queries.sleep(owner, { ...window, timezone: "Mars/Base" }), { code: "invalid_timezone" });
  const status = await queries.status(other);
  assert.ok(status.workouts_last_received_at);
  assert.equal(status.sleep_last_received_at, null);
});
