import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { Places } from "./places.js";

test("a completed visit ends the stay it confirmed even when its revised coordinate no longer matches", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `presence_visits_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  for (const table of ["data_owner_state", "data_installation", "data_collection_epoch", "data_event", "data_processing_job",
    "location_observation", "location_visit", "location_visit_name", "place", "place_presence", "place_presence_event", "data_domain_event"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  const owner = "visit-owner";
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), places = new Places(db);
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000);
  const upload = async (payload: unknown) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const line = JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: "location.visit.v2", occurred_at: ago(0).toISOString(),
      recorded_at: ago(0).toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload });
    await repository.persist(context, await parseBatch(Buffer.from(line), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const visit = (lat: number, departure: Date | null) => ({ visit_key: "v1", phase: departure ? "completed" : "arrived",
    arrival_at: ago(60).toISOString(), departure_at: departure?.toISOString() ?? null, coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: 10 });
  const home = await places.create(owner, { name: "Home", latitude: 37.70, longitude: -122.4, radius_m: 50 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) });
  await upload(visit(37.70, null));
  const state = async () => (await db.select().from(s.placePresenceTable).where(eq(s.placePresenceTable.placeId, home.id)))[0];
  assert.equal((await state()).state, "inside");
  // The completion report moved 80 m (seen on device): out of a 50 m place's reach.
  await upload(visit(37.70 + 80 / 111_195, ago(10)));
  assert.deepEqual([(await state()).state, (await state()).since.getTime()], ["outside", ago(10).getTime()]);
  const changes = await db.select().from(s.placePresenceEventTable).where(eq(s.placePresenceEventTable.placeId, home.id));
  assert.deepEqual(changes.map(change => change.transition).sort(), ["arrived", "departed"]);
});
