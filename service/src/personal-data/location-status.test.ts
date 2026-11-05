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

test("v2 visits project as visits and status reports location receipt and recency per owner", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `location_status_${randomUUID().replaceAll("-", "")}`;
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
    "location_observation", "health_workout", "health_sleep_segment", "health_sample_deletion", "data_domain_event",
    "contact_source", "contact_scan", "contact_scan_record", "location_visit_name", "location_visit", "place"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db);
  const upload = async (owner: string, values: Array<[string, Date, object]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, at, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: at.toISOString(), recorded_at: at.toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const visitAt = new Date("2026-10-14T08:00:00Z"), pointAt = new Date("2026-10-14T12:00:00Z");
  const coordinate = { lat: 37.77, lon: -122.42 };
  await upload("owner", [
    ["location.visit.v2", visitAt, { visit_key: "key", phase: "arrived", arrival_at: visitAt.toISOString(), departure_at: null,
      coordinate, horizontal_accuracy_m: 20 }],
    ["location.significant_change.v1", pointAt, { coordinate, horizontal_accuracy_m: 100, speed_mps: -1, course_deg: -1, altitude_m: 10 }],
  ]);
  const rows = await db.select().from(s.locationObservationTable);
  assert.deepEqual(rows.map(row => row.kind).sort(), ["significant_change", "visit"]);
  const status = (await repository.status("owner")) as { location: { last_received_at: Date | null; latest_visit_at: Date | null; latest_point_at: Date | null } };
  assert.equal(status.location.latest_visit_at?.toISOString(), visitAt.toISOString());
  assert.equal(status.location.latest_point_at?.toISOString(), pointAt.toISOString());
  assert.ok(status.location.last_received_at);
  const other = (await repository.status("other")) as typeof status;
  assert.deepEqual(other.location, { last_received_at: null, latest_visit_at: null, latest_point_at: null });

  // Names join to visits by key; a later lookup replaces an earlier one, an older one arriving late does not.
  const name = (namedAt: string, city: string) => ["location.visit_named.v1", new Date(namedAt), { visit_key: "key", source: "apple", named_at: namedAt,
    address: { full: `1 Main St, ${city}`, short: "1 Main St", city, city_with_context: city, region: "United States", region_code: "US" },
    place: { name: "Blue Bottle Coffee", category: "MKPOICategoryCafe", coordinate, distance_m: 15 } }] as [string, Date, object];
  await upload("owner", [name("2026-10-14T09:00:00.000Z", "Oakland")]);
  await upload("owner", [name("2026-10-14T10:00:00.000Z", "San Francisco")]);
  await upload("owner", [name("2026-10-14T09:30:00.000Z", "Berkeley")]);
  const timeline = await new LocationQueries(db).list("owner", { from: "2026-10-14T00:00:00Z", to: "2026-10-15T00:00:00Z" });
  const visit = timeline.items.find(item => item.kind === "visit")!;
  assert.equal(visit.visit_key, "key");
  assert.equal(visit.address?.city, "San Francisco");
  assert.equal((visit.place as { name: string }).name, "Blue Bottle Coffee");
  assert.equal(timeline.items.find(item => item.kind === "significant_change")!.place, null);
  assert.equal((await new LocationQueries(db).list("other", { from: "2026-10-14T00:00:00Z", to: "2026-10-15T00:00:00Z" })).items.length, 0);
});
