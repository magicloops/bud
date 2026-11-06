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
    "contact_source", "contact_scan", "contact_scan_record", "location_visit_name", "location_visit", "place", "place_presence",
    "place_presence_event"])
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

  // Phase 11: the phone's names (Apple MapKit lookups) aren't stored; the service names the visit
  // with Geoapify, and the name joins to it by key.
  await upload("owner", [["location.visit_named.v1", new Date("2026-10-14T09:00:00.000Z"), { visit_key: "key", source: "apple",
    named_at: "2026-10-14T09:00:00.000Z", address: { full: "1 Main St, Oakland", short: "1 Main St", city: "Oakland" }, place: null }]]);
  assert.equal((await db.select().from(s.locationVisitNameTable)).length, 0, "the phone's name isn't kept");
  const bodies: Record<string, unknown> = {
    "/v1/geocode/reverse": { results: [{ formatted: "1 Main Street, San Francisco, CA 94105, United States of America",
      address_line1: "1 Main Street", city: "San Francisco", state_code: "CA", country: "United States", country_code: "us" }] },
    "/v2/places": { features: [{ properties: { name: "Blue Bottle Coffee", categories: ["catering.cafe"], lat: 37.7701, lon: -122.4201, distance: 15 } }] } };
  const geoapify = new Geoapify("key", new DailyCredits(10), async url => ({ ok: true, status: 200, json: async () => bodies[new URL(url).pathname] }));
  const naming = new VisitNaming(db, geoapify, () => new Date(visitAt.getTime() + 3600_000));
  assert.equal(await naming.nameNext(), true);
  assert.equal(await naming.nameNext(), false, "named once, until a later report");
  const [stored] = await db.select().from(s.locationVisitNameTable);
  assert.deepEqual([stored.source, stored.rawEventId], ["geoapify", null]);
  // Its completion is a later report (with the final coordinate): named again.
  await upload("owner", [["location.visit.v2", visitAt, { visit_key: "key", phase: "completed", arrival_at: visitAt.toISOString(),
    departure_at: new Date(visitAt.getTime() + 1800_000).toISOString(), coordinate, horizontal_accuracy_m: 20 }]]);
  assert.equal(await naming.nameNext(), true);
  assert.equal(await naming.nameNext(), false);
  const timeline = await new LocationQueries(db).list("owner", { from: "2026-10-14T00:00:00Z", to: "2026-10-15T00:00:00Z" });
  const visit = timeline.items.find(item => item.kind === "visit")!;
  assert.equal(visit.visit_key, "key");
  assert.equal(visit.address?.short, "1 Main Street, San Francisco");
  assert.equal((visit.place as { name: string }).name, "Blue Bottle Coffee");
  assert.equal(timeline.items.find(item => item.kind === "significant_change")!.place, null);
  assert.equal((await new LocationQueries(db).list("other", { from: "2026-10-14T00:00:00Z", to: "2026-10-15T00:00:00Z" })).items.length, 0);
});
