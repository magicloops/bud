import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
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
import { followUpRequests, settleFollowUps } from "./follow-ups.js";
import { classifyReading, DEPARTURE_SETTLE_MS, geometryRevision, parseRegionTransition, PlacePresence } from "./place-presence.js";

test("region transitions parse strictly", () => {
  const valid = { place_id: "01K00000000000000000000000", transition: "entered", occurred_at: "2026-10-19T09:00:00.000Z", initial: false,
    geometry_revision: "1760864400000" };
  assert.deepEqual(parseRegionTransition(valid), { placeId: valid.place_id, transition: "arrived", at: new Date(valid.occurred_at), initial: false,
    revision: "1760864400000", fix: null });
  const fix = { latitude: 37.7, longitude: -122.4, horizontal_accuracy_m: 8, occurred_at: "2026-10-19T09:00:03.000Z" };
  assert.deepEqual(parseRegionTransition({ ...valid, fix })?.fix, { latitude: 37.7, longitude: -122.4, accuracyM: 8, at: new Date(fix.occurred_at) });
  for (const patch of [{ place_id: "home" }, { transition: "inside" }, { initial: "no" }, { occurred_at: "soon" }, { geometry_revision: undefined },
    { fix: { ...fix, latitude: 91 } }, { fix: { ...fix, horizontal_accuracy_m: -1 } }, { fix: { ...fix, occurred_at: "soon" } }, { fix: "here" }])
    assert.equal(parseRegionTransition({ ...valid, ...patch }), null);
});

test("a reading is definitely inside, definitely outside or uncertain, against the place's own radius", () => {
  // Home and Office 117 m apart, each 50 m: the walk-test layout.
  const home = { id: "home", latitude: 37.749003, longitude: -122.416487, radiusM: 50 };
  const office = { id: "office", latitude: 37.749033, longitude: -122.417815, radiusM: 50 };
  const both = [home, office];
  const at = new Date();
  const north = (place: typeof home, metres: number, accuracyM: number) =>
    ({ latitude: place.latitude + metres / 111_195, longitude: place.longitude, accuracyM, at });
  assert.equal(classifyReading(north(home, 5, 10), home, both).state, "inside");
  assert.equal(classifyReading(north(home, 5, 10), office, both).state, "outside");
  // Walking past the Office 52 m from its centre (±5): not an arrival (October 24).
  assert.equal(classifyReading(north(office, 52, 5), office, both).state, "uncertain");
  assert.equal(classifyReading(north(office, 40, 8), office, both).state, "inside");
  assert.equal(classifyReading(north(office, 60, 15), office, both).state, "uncertain", "60 − 15 isn't beyond 50");
  assert.equal(classifyReading(north(office, 70, 15), office, both).state, "outside");
  // Between the two, a coarse reading that reaches both counts for neither as definitely inside.
  const between = { latitude: 37.749018, longitude: -122.417151, accuracyM: 60, at };
  assert.equal(classifyReading(between, home, both).state, "uncertain");
  // Inside one place's radius but a nearer place also contains it: uncertain, not inside.
  const overlapping = [{ ...home, radiusM: 100 }, { ...office, radiusM: 100 }];
  assert.equal(classifyReading(north(home, 5, 30), overlapping[1], overlapping).state, "uncertain");
  assert.equal(classifyReading(north(home, 5, 150), office, both).state, "unknown");
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
  const upload = async (values: Array<[string, unknown] | [string, unknown, Date]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload, at]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: (at ?? ago(0)).toISOString(), recorded_at: ago(0).toISOString(), actor: { user_id: owner, installation_id: "phone" },
      context: { time_zone: "America/Los_Angeles" }, payload }));
    // This test uploads more batches than the per-owner rate limit (60 a minute) allows.
    await db.update(s.dataOwnerStateTable).set({ requestCount: 0 });
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  // Geofences report the geometry revision they were installed for.
  const revisions = new Map<string, string>();
  const refreshRevisions = async () => {
    for (const row of await db.select().from(s.placeTable)) revisions.set(row.id, geometryRevision(row));
  };
  const region = (placeId: string, transition: "entered" | "exited", at: Date, initial = false, revision = revisions.get(placeId) ?? "0") =>
    ["location.region_transition.v1", { place_id: placeId, transition, occurred_at: at.toISOString(), initial,
      geometry_revision: revision }] as [string, unknown];
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
  await refreshRevisions();

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

  // Moving a place resets presence. A crossing of the old boundary is rejected however recent
  // (the phone may still have the old geofence); the new geofence's report from before the move
  // is only a baseline.
  const oldRevision = revisions.get(gym.id)!;
  await places.update(owner, gym.id, { latitude: 37.81, longitude: -122.4 });
  assert.equal(await state(gym.id), undefined);
  await upload([region(gym.id, "entered", ago(-1), false, oldRevision)]);
  assert.equal(await state(gym.id), undefined, "a report for the superseded geometry is ignored");
  await refreshRevisions();
  await upload([region(gym.id, "entered", ago(5))]);
  assert.equal((await changes()).length, 5, "the geofence report predates the move");
  assert.equal((await state(gym.id)).state, "inside");

  // Unknown places are ignored; malformed transitions are invalid.
  await upload([region("01K00000000000000000000000", "entered", ago(1)), ["location.region_transition.v1", { place_id: gym.id }]]);
  const jobs = await db.select({ status: s.dataProcessingJobTable.status, error: s.dataProcessingJobTable.errorCode })
    .from(s.dataProcessingJobTable).orderBy(asc(s.dataProcessingJobTable.id));
  assert.deepEqual(jobs.slice(-2).map(job => job.status).sort(), ["invalid", "processed"]);

  // A visit that ended before the current geofence stay began never links to it, so the
  // current visit doesn't look like a new stay (late-upload duplicate arrivals).
  const lab = await places.create(owner, { name: "Lab", latitude: 37.90, longitude: -122.4 }, "user");
  const park = await places.create(owner, { name: "Park", latitude: 38.00, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, lab.id));
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, park.id));
  await refreshRevisions();
  const at = async (placeId: string) => (await changes()).filter(change => change[1] === placeId).map(change => change.slice(0, 3));
  await upload([region(lab.id, "entered", ago(30))]);
  await upload([visit("l0", ago(90), ago(60), 37.90)]);
  // An old visit's arrival report arrives late (links), then its completion shows it ended earlier (unlinks).
  await upload([visit("l2", ago(200), null, 37.90)]);
  await upload([visit("l2", ago(200), ago(150), 37.90)]);
  await upload([visit("l1", ago(29), null, 37.90)]);
  assert.deepEqual(await at(lab.id), [["place.arrived", lab.id, "region"]], "one arrival for one stay");
  assert.equal((await state(lab.id)).visitId, (await db.select().from(s.locationVisitTable).where(eq(s.locationVisitTable.visitKey, "l1")))[0].id);

  // A 30-minute absence uploaded in one go, before the departure would settle, is a departure and
  // a return; a 1-minute absence is staying.
  await upload([region(park.id, "entered", ago(100), true)]);
  await upload([region(park.id, "exited", ago(60)), region(park.id, "entered", ago(30))]);
  await upload([region(park.id, "exited", ago(20)), region(park.id, "entered", ago(19))]);
  assert.deepEqual((await changes()).filter(change => change[1] === park.id).map(change => [change[0], change[3]]),
    [["place.departed", ago(60).getTime()], ["place.arrived", ago(30).getTime()]]);
  assert.equal((await state(park.id)).leavingAt, null);
  // The same when the re-entry is processed before the exit (separate uploads, reversed).
  const pier = await places.create(owner, { name: "Pier", latitude: 38.10, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, pier.id));
  await refreshRevisions();
  await upload([region(pier.id, "entered", ago(100), true)]);
  await upload([region(pier.id, "entered", ago(30))]);
  await upload([region(pier.id, "exited", ago(60))]);
  await upload([region(pier.id, "entered", ago(19))]);
  await upload([region(pier.id, "exited", ago(20))]);
  assert.deepEqual((await changes()).filter(change => change[1] === pier.id).map(change => [change[0], change[3]]),
    [["place.departed", ago(60).getTime()], ["place.arrived", ago(30).getTime()]]);
  assert.deepEqual([(await state(pier.id)).state, (await state(pier.id)).leavingAt], ["inside", null], "no false pending departure");

  // A completed visit confirming a pending geofence exit publishes at the earlier exit time.
  const cafe = await places.create(owner, { name: "Cafe", latitude: 38.20, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, cafe.id));
  await refreshRevisions();
  await upload([region(cafe.id, "entered", ago(100), true)]);
  await upload([visit("c1", ago(90), null, 38.20)]);
  await upload([region(cafe.id, "exited", ago(10))]);
  await upload([visit("c1", ago(90), ago(9), 38.20)]);
  assert.deepEqual((await changes()).filter(change => change[1] === cafe.id).map(change => [change[0], change[2], change[3]]),
    [["place.departed", "region", ago(10).getTime()]]);
  assert.deepEqual([(await state(cafe.id)).state, (await state(cafe.id)).since.getTime()], ["outside", ago(10).getTime()]);

  // Precise readings (Phase 7.1), with two places 117 m apart as in the walk tests.
  const north = await places.create(owner, { name: "North", latitude: 38.30, longitude: -122.4 }, "user");
  const south = await places.create(owner, { name: "South", latitude: 38.30 - 117 / 111_195, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, north.id));
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, south.id));
  await refreshRevisions();
  const reading = (lat: number, at: Date, accuracy = 8) => ({ latitude: lat, longitude: -122.4, horizontal_accuracy_m: accuracy, occurred_at: at.toISOString() });
  const confirmed = (placeId: string, transition: "entered" | "exited", at: Date, lat: number, initial = false) => {
    const [type, payload] = region(placeId, transition, at, initial);
    return [type, { ...(payload as object), fix: reading(lat, new Date(at.getTime() + 3000)) }] as [string, unknown];
  };
  const of = async (placeId: string) => (await changes()).filter(change => change[1] === placeId).map(change => [change[0], change[3]]);
  // Initial reports take their state from the reading: at North, South's geofence says inside.
  await upload([confirmed(north.id, "entered", ago(100), 38.30, true), confirmed(south.id, "entered", ago(100), 38.30, true)]);
  assert.deepEqual([(await state(north.id)).state, (await state(south.id)).state], ["inside", "outside"]);
  // A geofence entry for South while still at North is only approaching; nothing publishes.
  await upload([confirmed(south.id, "entered", ago(90), 38.30)]);
  assert.equal((await state(south.id)).approachingAt?.getTime(), ago(90).getTime());
  assert.deepEqual(await of(south.id), []);
  // An exit while the reading is still inside North is ignored.
  await upload([confirmed(north.id, "exited", ago(80), 38.30)]);
  assert.equal((await state(north.id)).leavingAt, null);
  // Walking to South: North's exit with a reading outside it departs, and the same reading,
  // definitely inside South, arrives there; South's own entry (sent twice) adds nothing.
  const atSouth = 38.30 - 117 / 111_195;
  await upload([confirmed(north.id, "exited", ago(60), atSouth)]);
  await upload([confirmed(south.id, "entered", ago(59), atSouth)]);
  await upload([confirmed(south.id, "entered", ago(59), atSouth)]);
  // The same reading confirms South, so North's departure publishes at once, at its exit time.
  assert.deepEqual(await of(north.id), [["place.departed", ago(60).getTime()]]);
  assert.deepEqual(await of(south.id), [["place.arrived", ago(60).getTime() + 3000]]);
  assert.equal((await state(south.id)).approachingAt, null, "the arrival ends the approach");
  const [settled] = await db.select().from(s.placePresenceEventTable).where(eq(s.placePresenceEventTable.placeId, north.id));
  assert.ok(settled.rawEventId, "a settled departure keeps its exit as evidence");
  // An approach that never arrives ends with the geofence exit.
  await upload([confirmed(north.id, "entered", ago(40), atSouth)]);
  assert.ok((await state(north.id)).approachingAt);
  await upload([confirmed(north.id, "exited", ago(39), atSouth)]);
  assert.equal((await state(north.id)).approachingAt, null);
  assert.deepEqual(await of(north.id), [["place.departed", ago(60).getTime()]]);
  // A reading too coarse to tell trusts the geofence.
  await upload([[region(north.id, "entered", ago(30))[0], { ...(region(north.id, "entered", ago(30))[1] as object), fix: reading(atSouth, ago(30), 150) }]]);
  assert.deepEqual((await of(north.id)).at(-1), ["place.arrived", ago(30).getTime()]);
  // A reading confirmed at South also shows North was left (its exit can lag by many minutes):
  // the departure publishes at once, at the reading's time, with no settle window.
  await upload([confirmed(south.id, "entered", ago(20), atSouth)]);
  assert.deepEqual([(await state(north.id)).state, (await state(north.id)).leavingAt], ["outside", null]);
  assert.deepEqual((await of(north.id)).at(-1), ["place.departed", ago(20).getTime() + 3000]);
  assert.equal((await state(south.id)).state, "inside", "South itself is unchanged");

  // Phase 7.2: the October 24 walk, with 50 m places 117 m apart. Home → past the Office
  // without stopping → home again; readings from fixes and points count too.
  const house = await places.create(owner, { name: "House", latitude: 38.40, longitude: -122.4, radius_m: 50 }, "user");
  const work = await places.create(owner, { name: "Work", latitude: 38.40 - 117 / 111_195, longitude: -122.4, radius_m: 50 }, "user");
  for (const id of [house.id, work.id]) await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, id));
  await refreshRevisions();
  const fromHouse = (metres: number) => 38.40 + metres / 111_195;
  const wake = (placeId: string, transition: "entered" | "exited", at: Date, lat: number, accuracy: number, initial = false,
    followUpId?: string) => {
    const [type, payload] = region(placeId, transition, at, initial);
    return [type, { ...(payload as object), fix: reading(lat, at, accuracy), ...(followUpId ? { follow_up_id: followUpId } : {}) }, at] as [string, unknown, Date];
  };
  const fix = (lat: number, at: Date, accuracy: number) => ["location.fix.v1", { fix_key: `fix:${randomUUID()}`, reason: "foreground",
    coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: accuracy }, at] as [string, unknown, Date];
  const point = (lat: number, at: Date, accuracy: number) => ["location.significant_change.v1", {
    coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: accuracy }, at] as [string, unknown, Date];
  const workCenter = 38.40 - 117 / 111_195;
  await upload([wake(house.id, "entered", ago(100), fromHouse(5), 10, true), wake(work.id, "entered", ago(100), fromHouse(5), 10, true)]);
  assert.deepEqual([(await state(house.id)).state, (await state(work.id)).state], ["inside", "outside"]);
  await upload([wake(house.id, "exited", ago(90), fromHouse(170), 16)]);
  assert.equal(await presence.settleDepartures(() => new Date(ago(90).getTime() + DEPARTURE_SETTLE_MS)), true);
  // Past the Office at 52 m (±5): approaching, not arrived.
  await upload([wake(work.id, "entered", ago(85), workCenter - 52 / 111_195, 5, false, "walk-past")]);
  assert.deepEqual([(await state(work.id)).state, (await state(work.id)).approachingAt?.getTime()], ["outside", ago(85).getTime()]);
  // Follow-ups the upload response settles, by follow-up ID: an approach still needs readings.
  const ask = async (placeId: string, transition: "entered" | "exited", followUpId: string = randomUUID(), revision = revisions.get(placeId)) =>
    (await settleFollowUps(owner, new Map([[followUpId, { placeId, revision: revision ?? "0", transition }]]), db))[followUpId];
  assert.equal(await ask(work.id, "entered", "walk-past"), "open");
  await upload([wake(work.id, "exited", ago(83), workCenter - 175 / 111_195, 17)]);
  assert.equal((await state(work.id)).approachingAt, null, "walking on ends the approach");
  assert.equal(await ask(work.id, "entered", "walk-past"), "settled", "walked past: its report is processed and nothing is pending");
  // A newer entry whose own report hasn't arrived yet stays open, though the earlier ones were processed.
  assert.equal(await ask(work.id, "entered", "next-entry"), "open");
  // A follow-up for a geometry that has since changed is settled.
  assert.equal(await ask(work.id, "entered", "old-geometry", "1"), "settled");
  // A follow-up reading can reach the service before its own geofence report: still open.
  const kiosk = await places.create(owner, { name: "Kiosk", latitude: 38.50, longitude: -122.4, radius_m: 50 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, kiosk.id));
  await refreshRevisions();
  assert.equal(await ask(kiosk.id, "entered"), "open");
  // Back towards home: the entry fires 70 m out (±16), then the fix when Bud opens, 5 m away, arrives.
  await upload([wake(house.id, "entered", ago(70), fromHouse(70), 16)]);
  assert.deepEqual([(await state(house.id)).state, Boolean((await state(house.id)).approachingAt)], ["outside", true]);
  await upload([fix(fromHouse(5), ago(68), 10)]);
  assert.equal(await ask(house.id, "entered"), "settled", "arrived");
  assert.equal(await ask(house.id, "exited"), "open", "inside with no departure wait: an exit still needs readings");
  assert.equal(await ask("01K00000000000000000000000", "entered"), "settled", "unknown place");
  const houseChanges = (await db.select().from(s.placePresenceEventTable).where(eq(s.placePresenceEventTable.placeId, house.id))
    .orderBy(asc(s.placePresenceEventTable.occurredAt))).map(row => [row.transition, row.source, row.occurredAt.getTime()]);
  assert.deepEqual(houseChanges, [["departed", "region", ago(90).getTime()], ["arrived", "reading", ago(68).getTime()]]);
  assert.deepEqual(await of(work.id), [], "no Office arrival for walking past");
  // A stale Office stay ends on a significant-change point at home (112 m away): confirmed at the
  // House, so the departure publishes at once. A replay of the point isn't stored again, and a
  // coarse point counts for nothing.
  await upload([wake(work.id, "entered", ago(60), workCenter, 5)]);
  await upload([point(fromHouse(5), ago(50), 10), point(fromHouse(5), ago(50), 10), point(workCenter, ago(49), 90)]);
  assert.deepEqual([(await state(work.id)).state, (await state(work.id)).leavingAt], ["outside", null]);
  assert.equal(await ask(work.id, "exited"), "settled");
  const points = await db.select().from(s.locationObservationTable).where(and(eq(s.locationObservationTable.kind, "significant_change"),
    eq(s.locationObservationTable.occurredAt, ago(50))));
  assert.equal(points.length, 1, "a replayed point is not a new observation");
  const [workLeft] = await db.select().from(s.placePresenceEventTable).where(and(eq(s.placePresenceEventTable.placeId, work.id),
    eq(s.placePresenceEventTable.transition, "departed")));
  assert.deepEqual([workLeft.source, workLeft.occurredAt.getTime()], ["reading", ago(50).getTime()]);
  // Both geofences fire near home (October 25, 2:28 PM): Work approaching from an uncertain
  // reading; a reading confirming the House settles Work's follow-up. Work stays approaching (a
  // hint for agents) until its geofence exits.
  await upload([wake(work.id, "entered", ago(46), workCenter + 55 / 111_195, 15, false, "way-home")]);
  assert.ok((await state(work.id)).approachingAt);
  assert.equal(await ask(work.id, "entered", "way-home"), "open");
  await upload([fix(fromHouse(5), ago(45), 10)]);
  assert.ok((await state(work.id)).approachingAt);
  assert.equal(await ask(work.id, "entered", "way-home"), "settled");
  // Readings arrive out of order: back at the House at ago(43) and confirmed inside again at
  // ago(42); then delayed readings from ago(42.5), definitely outside it and definitely inside
  // Work, can't publish a departure (the newer inside reading wins).
  await upload([wake(house.id, "entered", ago(43), fromHouse(5), 10)]);
  const houseEvents = async () => (await db.select().from(s.placePresenceEventTable).where(eq(s.placePresenceEventTable.placeId, house.id))).length;
  const before = await houseEvents();
  await upload([fix(fromHouse(5), ago(42), 10)]);
  await upload([fix(fromHouse(200), ago(42.5), 10), fix(workCenter, ago(42.5), 5)]);
  assert.deepEqual([(await state(house.id)).state, (await state(house.id)).leavingAt, await houseEvents()], ["inside", null, before]);
  // An outside reading starts a departure wait; while it's pending, a new entry's follow-up stays
  // open (the previous stay doesn't confirm the return). Then a geofence exit whose reading is
  // definitely inside cancels it, like any inside reading: no departure is published.
  await upload([fix(fromHouse(200), ago(41.8), 10)]);
  assert.equal((await state(house.id)).leavingAt?.getTime(), ago(41.8).getTime());
  assert.equal(await ask(house.id, "entered", "back-again"), "open");
  await upload([wake(house.id, "exited", ago(41.6), fromHouse(5), 10)]);
  assert.equal((await state(house.id)).leavingAt, null);
  await presence.settleDepartures(() => ago(0));
  assert.deepEqual([(await state(house.id)).state, await houseEvents()], ["inside", before]);
  assert.equal(await ask(house.id, "entered", "back-again"), "settled");
  // October 27: walking back past the house to the Office. The Office geofence fires while a
  // reading still puts the walker at the house; later readings inside the Office arrive it (its
  // approach isn't dropped), and the house departure publishes at once. A reading definitely
  // inside a place that isn't approaching arrives too (the fix when Bud opens).
  const corner = await places.create(owner, { name: "Corner", latitude: 38.60, longitude: -122.4, radius_m: 50 }, "user");
  const studio = await places.create(owner, { name: "Studio", latitude: 38.60 - 117 / 111_195, longitude: -122.4, radius_m: 50 }, "user");
  for (const id of [corner.id, studio.id]) await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) }).where(eq(s.placeTable.id, id));
  await refreshRevisions();
  const fromCorner = (metres: number) => 38.60 - metres / 111_195;
  await upload([wake(corner.id, "entered", ago(35), fromCorner(5), 10, true), wake(studio.id, "entered", ago(35), fromCorner(5), 10, true)]);
  await upload([wake(studio.id, "entered", ago(30), fromCorner(37), 10, false, "to-studio")]);
  await upload([fix(fromCorner(40), ago(29.8), 5)]);
  assert.ok((await state(studio.id)).approachingAt, "still approaching while confirmed at Corner");
  assert.equal(await ask(studio.id, "entered", "to-studio"), "settled", "its follow-up settles while confirmed at Corner");
  await upload([fix(fromCorner(117 - 22), ago(29.5), 5)]);
  const changesAt = async (id: string) => (await db.select().from(s.placePresenceEventTable).where(eq(s.placePresenceEventTable.placeId, id))
    .orderBy(asc(s.placePresenceEventTable.createdAt))).map(row => [row.transition, row.source, row.occurredAt.getTime()]);
  assert.deepEqual(await changesAt(studio.id), [["arrived", "reading", ago(29.5).getTime()]]);
  assert.deepEqual(await changesAt(corner.id), [["departed", "reading", ago(29.5).getTime()]], "confirmed at Studio: no settle wait");
  await upload([fix(fromCorner(3), ago(20), 12)]);
  assert.deepEqual((await changesAt(corner.id)).at(-1), ["arrived", "reading", ago(20).getTime()], "no approach needed");
  assert.deepEqual((await changesAt(studio.id)).at(-1), ["departed", "reading", ago(20).getTime()]);

  // CLMonitor re-delivers a report, once as initial and again as a transition: only the first counts.
  const [type, payload] = region(work.id, "entered", ago(40), true);
  const again = { ...(payload as object), initial: false, fix: reading(workCenter, ago(40), 5) };
  await upload([[type, { ...(payload as object), fix: reading(workCenter, ago(40), 5) }, ago(40)]]);
  await upload([[type, again, ago(40)]]);
  assert.deepEqual(await of(work.id), [["place.arrived", ago(60).getTime()], ["place.departed", ago(50).getTime()]],
    "the re-delivery is not an arrival");

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
  const southRule = { ...definition, name: "South", place_trigger: { place_ids: [south.id] } };
  await db.insert(s.automationTable).values({ id: "south", state: "enabled", version: 1, activeRevision: 1, draft: southRule, createdByUserId: owner, updatedByUserId: owner });
  await db.insert(s.automationRevisionTable).values({ automationId: "south", revision: 1, definition: southRule, publicationBoundary: 0,
    grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  while (await new AutomationMatcher(db).matchNext(owner)) { /* drain */ }
  while (await new AutomationAdmission(db).admitNext(owner)) { /* drain */ }
  const admitted = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, "welcome"));
  assert.equal(admitted.length, 3, "one delivery per published home arrival");
  const first = admitted.find(delivery => delivery.status === "admitted")!;
  const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, first.invocationId!));
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
  assert.match(input.content, /^Arrived at Home at [^\n]+\.\n\nSay hi\.\n\n---\n/);
  assert.match(input.content, /- Times are in America\/Los_Angeles, the phone's time zone\.\n- Detected by the phone's geofence/);
  const evidence = await db.transaction(tx => automationStartEvidence(tx, invocation));
  const json = JSON.parse(evidence!.slice(evidence!.indexOf("{")));
  assert.deepEqual([json.transition.source, json.place.name, json.visit], ["region", "Home", null]);
  const [southRun] = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, "south"));
  const [southInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, southRun.invocationId!));
  const [southInput] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, southInvocation.inputMessageId));
  assert.match(southInput.content, /- Detected from a precise reading 0 m from its centre \(±8 m\)\./);
  const southEvidence = await db.transaction(tx => automationStartEvidence(tx, southInvocation));
  assert.deepEqual(JSON.parse(southEvidence!.slice(southEvidence!.indexOf("{"))).transition.reading, { distance_m: 0, accuracy_m: 8 });
});
