import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { AutomationMatcher } from "./automation-matcher.js";
import { AutomationAdmission } from "./automation-admission.js";
import { checkAutomationPolicy } from "./automation-policy.js";
import { automationStartEvidence } from "./automation-contact-context.js";
import { Places } from "./places.js";
import { LocationQueries } from "./location.js";

test("visits at saved places publish arrival, departure and visit end once, match place rules, and start with visit evidence", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `automation_places_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  // Isolated copies keep fixture jobs and deliveries away from the running development workers.
  for (const table of ["data_owner_state", "data_installation", "data_collection_epoch", "data_event", "data_processing_job",
    "location_observation", "location_visit", "location_visit_name", "place", "place_presence", "place_presence_event",
    "health_workout", "data_domain_event",
    "automation", "automation_revision", "automation_delivery", "automation_bootstrap", "automation_bootstrap_member", "automation_bootstrap_group",
    "agent_invocation", "agent_invocation_action", "agent_data_grant", "bud", "thread", "message", "browser_handoff"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);

  const owner = "place-owner", budId = "bud", originThread = randomUUID();
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), places = new Places(db);
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000);
  const visit = (key: string, arrival: Date | null, departure: Date | null, lat: number, accuracy = 20) =>
    ["location.visit.v2", { visit_key: key, phase: departure ? "completed" : "arrived", arrival_at: arrival?.toISOString() ?? null,
      departure_at: departure?.toISOString() ?? null, coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: accuracy }] as [string, unknown];
  const upload = async (values: Array<[string, unknown]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: ago(0).toISOString(), recorded_at: ago(0).toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const visitId = async (key: string) => (await db.select().from(s.locationVisitTable).where(eq(s.locationVisitTable.visitKey, key)))[0].id;
  // Place events reach their visit through the presence change; visit.ended names it directly.
  const published = async () => (await db.select({ event: s.dataDomainEventTable, change: s.placePresenceEventTable })
    .from(s.dataDomainEventTable).leftJoin(s.placePresenceEventTable, eq(s.placePresenceEventTable.id, s.dataDomainEventTable.presenceEventId))
    .where(inArray(s.dataDomainEventTable.eventType, ["place.arrived", "place.departed", "visit.ended"]))
    .orderBy(s.dataDomainEventTable.publicationSequence))
    .map(({ event, change }) => ({ ...event, visitId: event.visitId ?? change?.visitId ?? null }));

  // Saved places; their geometry predates the fixture visits.
  const home = await places.create(owner, { name: "Home", latitude: 37.70, longitude: -122.4 }, "user");
  const gym = await places.create(owner, { name: "Gym", latitude: 37.80, longitude: -122.4, radius_m: 100 }, "agent");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) });
  await assert.rejects(places.create(owner, { name: "Tiny", latitude: 1, longitude: 1, radius_m: 10 }, "user"), { code: "invalid_place" });
  assert.equal((await places.list("someone-else")).items.length, 0, "owners are isolated");

  // Visit a: arrival at home (reported twice), then completion.
  await upload([visit("a", ago(30), null, 37.7003)]);
  await upload([visit("a", ago(30), null, 37.7003)]);
  let events = await published();
  assert.deepEqual(events.map(event => [event.eventType, event.placeId]), [["place.arrived", home.id]], "duplicate arrival reports publish once");
  await upload([visit("a", ago(30), ago(5), 37.7002)]);
  await upload([visit("a", ago(30), ago(5), 37.7002)]);
  // Visit b: completed-only report at the gym, 133 m from its center but within radius plus capped accuracy.
  await upload([visit("b", ago(100), ago(70), 37.8012, 150)]);
  // Visit c: a place saved during the visit is its baseline and never fires for it.
  await places.create(owner, { name: "Office", latitude: 37.90, longitude: -122.4 }, "user");
  await upload([visit("c", ago(20), ago(2), 37.90)]);
  // Visit d: far from everything.
  await upload([visit("d", ago(15), ago(1), 38.5)]);
  events = await published();
  const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map(visitId));
  const summary = (id: string) => events.filter(event => event.visitId === id).map(event => [event.eventType, event.placeId]);
  assert.deepEqual(summary(a), [["place.arrived", home.id], ["place.departed", home.id], ["visit.ended", null]]);
  assert.deepEqual(summary(b), [["place.arrived", gym.id], ["place.departed", gym.id], ["visit.ended", null]]);
  assert.deepEqual(summary(c), [["visit.ended", null]], "the office was saved after visit c began");
  assert.deepEqual(summary(d), [["visit.ended", null]]);
  assert.equal(new Set(events.map(event => event.publicationSequence)).size, events.length, "each publication has its own sequence");

  // Query results label visits with the places they're at.
  const listed = await new LocationQueries(db).visits(owner, { from: ago(200).toISOString(), to: ago(-1).toISOString() });
  const labels = new Map(listed.items.map(item => [item.visit_key, item.places.map(place => place.name)]));
  assert.deepEqual([labels.get("a"), labels.get("b"), labels.get("c"), labels.get("d")], [["Home"], ["Gym"], ["Office"], []]);

  // Rules, activated before matching. Contact rules never see visit events.
  await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.threadTable).values({ threadId: originThread, budId, createdByUserId: owner, modelId: "gpt-6-astra", reasoningEffort: "medium" });
  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner, version: 1,
    scopes: ["location.read", "contacts.read"], historyDays: 90 });
  const common = { name: "Places", instruction: "Note it.", bud_id: budId, model_mode: "inherit", origin_thread_id: originThread,
    model: "", reasoning_effort: "none", target: { mode: "new_thread" }, latest_start_seconds: 3600, max_invocations_per_day: 10,
    data_access: { scopes: ["location.read"], history_days: 30 } };
  const rule = async (id: string, definition: Record<string, unknown>) => {
    await db.insert(s.automationTable).values({ id, state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: owner, updatedByUserId: owner });
    await db.insert(s.automationRevisionTable).values({ automationId: id, revision: 1, definition, publicationBoundary: 0,
      grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  };
  const placeRule = (type: string, ids: string[], maxAge = 3600) => ({ ...common, event_type: type, place_trigger: { place_ids: ids }, max_event_age_seconds: maxAge });
  const endedRule = (ids: string[], minutes: number) => ({ ...common, event_type: "visit.ended",
    visit_filter: { place_ids: ids, min_duration_minutes: minutes }, max_event_age_seconds: 21600 });
  await rule("arrive-home", placeRule("place.arrived", [home.id]));
  await rule("arrive-stale", placeRule("place.arrived", [home.id], 300));
  await rule("leave-home", placeRule("place.departed", [home.id]));
  await rule("arrive-gym", placeRule("place.arrived", [gym.id], 604800));
  await rule("ended-any", endedRule([], 0));
  await rule("ended-gym-long", endedRule([gym.id], 60));
  await rule("contacts", { ...common, event_type: "contact.added", sources: { source_ids: [] }, data_access: { scopes: ["contacts.read"], history_days: 30 } });

  // Deleting the gym before matching suppresses its arrival rule.
  await places.delete(owner, gym.id);
  const matcher = new AutomationMatcher(db);
  while (await matcher.matchNext(owner)) { /* drain */ }
  const deliveries = async (automation: string) => (await db.select({ event: s.dataDomainEventTable, change: s.placePresenceEventTable,
    delivery: s.automationDeliveryTable }).from(s.automationDeliveryTable)
    .innerJoin(s.dataDomainEventTable, eq(s.dataDomainEventTable.id, s.automationDeliveryTable.domainEventId))
    .leftJoin(s.placePresenceEventTable, eq(s.placePresenceEventTable.id, s.dataDomainEventTable.presenceEventId))
    .where(eq(s.automationDeliveryTable.automationId, automation)))
    .map(({ event, change, delivery }) => ({ visitId: event.visitId ?? change?.visitId ?? null, delivery }));
  const outcomes = async (automation: string) => new Map((await deliveries(automation)).map(row =>
    [row.visitId, row.delivery.outcomeCode ?? row.delivery.status]));
  assert.deepEqual([...await outcomes("arrive-home")], [[a, "pending"]], "only rules for the event's place match");
  assert.deepEqual([...await outcomes("arrive-stale")], [[a, "event_too_old"]]);
  assert.deepEqual([...await outcomes("leave-home")], [[a, "pending"]]);
  assert.deepEqual([...await outcomes("arrive-gym")], [[b, "place_deleted"]]);
  const ended = await outcomes("ended-any");
  assert.deepEqual([ended.get(a), ended.get(b), ended.get(c), ended.get(d)], ["pending", "pending", "pending", "pending"]);
  assert.ok([...(await outcomes("ended-gym-long")).values()].every(code => code === "visit_filter_mismatch"));
  assert.equal((await deliveries("contacts")).length, 0);
  const [leave] = (await deliveries("leave-home")).map(row => row.delivery);
  const [departure] = await db.select({ at: s.locationVisitTable.departureAt }).from(s.locationVisitTable).where(eq(s.locationVisitTable.id, a));
  assert.ok(Math.abs(leave.latestStartAt.getTime() - (departure.at!.getTime() + 3600_000)) < 1000, "first start is bounded by departure plus maximum age");

  const admission = new AutomationAdmission(db);
  while (await admission.admitNext(owner)) { /* drain */ }
  const admitted = async (automation: string, visit: string) => (await deliveries(automation)).find(row => row.visitId === visit)!.delivery;
  const invocationFor = async (automation: string, visit: string) => {
    const delivery = await admitted(automation, visit);
    assert.equal(delivery.status, "admitted", automation);
    const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, delivery.invocationId!));
    const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
    return { invocation, input };
  };
  const arrived = await invocationFor("arrive-home", a);
  assert.match(arrived.input.content, /^Arrived at Home at [^\n]+\.\n\n/);
  assert.match(arrived.input.content, /\n---\nFor reference\. Don't mention these details unless the instruction asks for them\.\n- Triggered by the "[^"]+" automation \(ID arrive-home\)\.\n- Times are in UTC; the phone hasn't reported its time zone\./);
  assert.match(arrived.input.content, /^Arrived at Home at [^\n]+\.\n\nNote it\.\n\n---\n/);
  assert.equal(arrived.input.metadata?.automation_name, "Places");
  assert.deepEqual([arrived.input.metadata?.visit_id, arrived.input.metadata?.place_id], [a, home.id]);
  assert.match((await invocationFor("leave-home", a)).input.content, /^Left Home at [^\n]*, after 25 minutes there\./);
  assert.match((await invocationFor("ended-any", d)).input.content, /^A visit at a place ended at [^\n]*, after 14 minutes\./);
  assert.equal(await checkAutomationPolicy(arrived.invocation, true, db), "ready");

  const evidence = await db.transaction(tx => automationStartEvidence(tx, arrived.invocation));
  const json = JSON.parse(evidence!.slice(evidence!.indexOf("{")));
  assert.equal(json.visit.visit_id, a);
  assert.equal(json.place.name, "Home");
  assert.deepEqual(json.saved_places_at_visit.map((place: { name: string }) => place.name), ["Home"]);

  // Deleting the place after admission fails a later admission for it, and withdrawing location access stops runs at their policy check.
  await places.delete(owner, home.id);
  await db.update(s.automationDeliveryTable).set({ status: "pending", invocationId: null })
    .where(eq(s.automationDeliveryTable.automationId, "leave-home"));
  while (await admission.admitNext(owner)) { /* drain */ }
  const relisted = await admitted("leave-home", a);
  assert.deepEqual([relisted.status, relisted.outcomeCode], ["failed", "place_unavailable"]);
  await db.update(s.agentDataGrantTable).set({ scopes: ["contacts.read"], version: sql`${s.agentDataGrantTable.version} + 1` })
    .where(eq(s.agentDataGrantTable.createdByUserId, owner));
  await assert.rejects(checkAutomationPolicy(arrived.invocation, true, db), /data_permission_changed/);
});
