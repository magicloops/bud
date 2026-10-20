import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { AutomationMatcher } from "./automation-matcher.js";
import { AutomationAdmission } from "./automation-admission.js";
import { automationStartEvidence } from "./automation-contact-context.js";
import { Places } from "./places.js";
import { DEPARTURE_SETTLE_MS, parseRegionTransition, PlacePresence } from "./place-presence.js";

test("region transitions parse strictly", () => {
  const valid = { place_id: "01K00000000000000000000000", transition: "entered", occurred_at: "2026-10-19T09:00:00.000Z", initial: false };
  assert.deepEqual(parseRegionTransition(valid), { placeId: valid.place_id, transition: "arrived", at: new Date(valid.occurred_at), initial: false });
  for (const patch of [{ place_id: "home" }, { transition: "inside" }, { initial: "no" }, { occurred_at: "soon" }])
    assert.equal(parseRegionTransition({ ...valid, ...patch }), null);
});

test("geofences and visits share one presence state: one arrival, settled departures, baselines", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `place_presence_${randomUUID().replaceAll("-", "")}`;
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
    "location_observation", "location_visit", "location_visit_name", "place", "place_presence", "place_presence_event",
    "health_workout", "data_domain_event", "automation", "automation_revision", "automation_delivery", "automation_bootstrap",
    "automation_bootstrap_member", "automation_bootstrap_group", "agent_invocation", "agent_invocation_action", "agent_data_grant",
    "bud", "thread", "message", "browser_handoff"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);

  const owner = "presence-owner";
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), places = new Places(db);
  const presence = new PlacePresence(db);
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000);
  const upload = async (values: Array<[string, unknown]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: ago(0).toISOString(), recorded_at: ago(0).toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const region = (placeId: string, transition: "entered" | "exited", at: Date, initial = false) =>
    ["location.region_transition.v1", { place_id: placeId, transition, occurred_at: at.toISOString(), initial }] as [string, unknown];
  const visit = (key: string, arrival: Date, departure: Date | null, lat: number) => ["location.visit.v2", { visit_key: key,
    phase: departure ? "completed" : "arrived", arrival_at: arrival.toISOString(), departure_at: departure?.toISOString() ?? null,
    coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: 20 }] as [string, unknown];
  const changes = async () => (await db.select({ event: s.dataDomainEventTable, change: s.placePresenceEventTable })
    .from(s.dataDomainEventTable).innerJoin(s.placePresenceEventTable, eq(s.placePresenceEventTable.id, s.dataDomainEventTable.presenceEventId))
    .orderBy(asc(s.dataDomainEventTable.publicationSequence)))
    .map(({ event, change }) => [event.eventType, change.placeId, change.source, change.occurredAt.getTime()]);
  const state = async (placeId: string) => (await db.select().from(s.placePresenceTable).where(eq(s.placePresenceTable.placeId, placeId)))[0];

  const home = await places.create(owner, { name: "Home", latitude: 37.70, longitude: -122.4 }, "user");
  const gym = await places.create(owner, { name: "Gym", latitude: 37.80, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) });

  // Geofence entry publishes at once; the visit arriving later only links to the stay.
  await upload([region(home.id, "entered", ago(60))]);
  await upload([visit("h1", ago(62), null, 37.70)]);
  assert.deepEqual(await changes(), [["place.arrived", home.id, "region", ago(60).getTime()]]);
  assert.ok((await state(home.id)).visitId, "the visit is linked to the geofence stay");
  // Exit, then re-entry within the settle window: staying, nothing published.
  await upload([region(home.id, "exited", ago(50))]);
  await upload([region(home.id, "entered", ago(49))]);
  assert.equal((await state(home.id)).leavingAt, null);
  // The completed visit is a confirmed departure and publishes at once.
  await upload([visit("h1", ago(62), ago(40), 37.70)]);
  // A late exit after that changes nothing.
  await upload([region(home.id, "exited", ago(39))]);
  assert.deepEqual((await changes()).slice(1), [["place.departed", home.id, "visit", ago(40).getTime()]]);

  // Initial state never publishes; a real exit then waits for the settle window.
  await upload([region(gym.id, "entered", ago(30), true)]);
  assert.equal((await state(gym.id)).state, "inside");
  await upload([region(gym.id, "exited", ago(10))]);
  assert.equal(await presence.settleDepartures(() => new Date(ago(10).getTime() + DEPARTURE_SETTLE_MS - 1000)), false, "not yet settled");
  assert.equal(await presence.settleDepartures(() => new Date(ago(10).getTime() + DEPARTURE_SETTLE_MS)), true);
  assert.deepEqual((await changes()).slice(2), [["place.departed", gym.id, "region", ago(10).getTime()]]);
  assert.equal((await state(gym.id)).state, "outside");
  // An older transition arriving late is ignored.
  await upload([region(gym.id, "entered", ago(20))]);
  assert.equal((await changes()).length, 3);

  // Without geofences, visits alone drive presence (When In Use). A new visit at a place still
  // marked inside from another visit is a new stay whose departure was never reported.
  await upload([visit("h2", ago(30), null, 37.70)]);
  await upload([visit("h3", ago(20), null, 37.70)]);
  assert.deepEqual((await changes()).slice(3).map(change => change.slice(0, 3)),
    [["place.arrived", home.id, "visit"], ["place.arrived", home.id, "visit"]]);

  // Moving a place resets presence; a transition from before the move is only a baseline.
  await places.update(owner, gym.id, { latitude: 37.81, longitude: -122.4 });
  assert.equal(await state(gym.id), undefined);
  await upload([region(gym.id, "entered", ago(5))]);
  assert.equal((await changes()).length, 5, "the geofence report predates the move");
  assert.equal((await state(gym.id)).state, "inside");

  // Unknown places are ignored; malformed transitions are invalid.
  await upload([region("01K00000000000000000000000", "entered", ago(1)), ["location.region_transition.v1", { place_id: gym.id }]]);
  const jobs = await db.select({ status: s.dataProcessingJobTable.status, error: s.dataProcessingJobTable.errorCode })
    .from(s.dataProcessingJobTable).orderBy(asc(s.dataProcessingJobTable.id));
  assert.deepEqual(jobs.slice(-2).map(job => job.status).sort(), ["invalid", "processed"]);

  // A geofence arrival runs a place rule, says how it was detected and has no visit record.
  await db.insert(s.budTable).values({ budId: "bud", name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.threadTable).values({ threadId: randomUUID(), budId: "bud", createdByUserId: owner, modelId: "gpt-6-astra", reasoningEffort: "medium" });
  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner, version: 1, scopes: ["location.read"], historyDays: 90 });
  const definition = { name: "Welcome", instruction: "Say hi.", bud_id: "bud", model_mode: "inherit", model: "", reasoning_effort: "none",
    target: { mode: "new_thread" }, latest_start_seconds: 3600, max_invocations_per_day: 10, event_type: "place.arrived",
    place_trigger: { place_ids: [home.id] }, max_event_age_seconds: 604800, data_access: { scopes: ["location.read"], history_days: 30 } };
  await db.insert(s.automationTable).values({ id: "welcome", state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: owner, updatedByUserId: owner });
  await db.insert(s.automationRevisionTable).values({ automationId: "welcome", revision: 1, definition, publicationBoundary: 0,
    grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  while (await new AutomationMatcher(db).matchNext(owner)) { /* drain */ }
  while (await new AutomationAdmission(db).admitNext(owner)) { /* drain */ }
  const admitted = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, "welcome"));
  assert.equal(admitted.length, 3, "one delivery per published home arrival");
  const first = admitted.find(delivery => delivery.status === "admitted")!;
  const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, first.invocationId!));
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
  assert.match(input.content, /Arrived at Home at .*\nDetected by the phone's geofence/);
  const evidence = await db.transaction(tx => automationStartEvidence(tx, invocation));
  const json = JSON.parse(evidence!.slice(evidence!.indexOf("{")));
  assert.deepEqual([json.transition.source, json.place.name, json.visit], ["region", "Home", null]);
});
