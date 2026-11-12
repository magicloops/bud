import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

test("new workouts publish once, match workout rules by filter, age and deletion, and start with workout evidence", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `automation_workout_${randomUUID().replaceAll("-", "")}`;
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
    "health_workout", "health_sleep_segment", "health_sample_deletion", "data_domain_event", "location_observation",
    "automation", "automation_revision", "automation_delivery", "automation_bootstrap", "automation_bootstrap_member", "automation_bootstrap_group",
    "agent_invocation", "agent_invocation_action", "agent_data_grant", "bud", "thread", "message", "browser_handoff"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);

  const owner = "workout-owner", budId = "bud", originThread = randomUUID();
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db);
  const now = Date.now(), iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const workout = (uuid: string, activity: string, minutes: number, endedMinutesAgo: number, mode = "incremental") => ["health.workout.v2", {
    hk_uuid: uuid, start_at: iso(endedMinutesAgo + minutes), end_at: iso(endedMinutesAgo), import_mode: mode,
    source: { name: "Apple Watch", bundle_id: "com.apple.health.watch" }, device: null, duration_s: minutes * 60,
    activity_type: activity, activity_type_raw: null, total_energy_kcal: 250, total_distance_m: 5000, indoor: false }] as [string, unknown];
  const deletion = (uuid: string) => ["health.sample_deleted.v1", { hk_uuid: uuid, sample_kind: "workout" }] as [string, unknown];
  const upload = async (values: Array<[string, unknown]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: iso(0), recorded_at: iso(0), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };
  const domainEvents = () => db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.eventType, "workout.completed"));

  await upload([workout("w0", "running", 30, 60 * 24 * 3, "baseline")]);
  assert.equal((await domainEvents()).length, 0, "the initial import never publishes");
  // A deletion that arrives before its sample (separate, earlier upload) suppresses publication.
  await upload([deletion("w3")]);
  await upload([workout("w1", "running", 30, 10), workout("w2", "walking", 10, 8), workout("w3", "running", 40, 5)]);
  await upload([workout("w1", "running", 30, 10)]);
  const published = await domainEvents();
  assert.equal(published.length, 2, "one event per new workout; re-uploads and deleted samples publish nothing");
  assert.ok(published.every(event => event.publicationSequence !== null && event.revisionId === null));

  // Rules activated before publication. Contact and schedule rules must not see workout events.
  await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.threadTable).values({ threadId: originThread, budId, createdByUserId: owner, modelId: "gpt-6-astra", reasoningEffort: "medium" });
  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner, version: 1,
    scopes: ["health.read", "location.read", "contacts.read"], historyDays: 90 });
  const common = { name: "After workouts", instruction: "Log it.", bud_id: budId, model_mode: "inherit", origin_thread_id: originThread,
    model: "", reasoning_effort: "none", target: { mode: "new_thread" }, latest_start_seconds: 3600, max_invocations_per_day: 10 };
  const rule = async (id: string, definition: Record<string, unknown>) => {
    await db.insert(s.automationTable).values({ id, state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: owner, updatedByUserId: owner });
    await db.insert(s.automationRevisionTable).values({ automationId: id, revision: 1, definition, publicationBoundary: 0,
      grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  };
  const workoutRule = (filter: object, maxAge: number, scopes: string[], historyDays = 30) => ({ ...common, event_type: "workout.completed",
    workout_filter: filter, max_event_age_seconds: maxAge, data_access: { scopes, history_days: historyDays } });
  await rule("runs", workoutRule({ activity_types: ["running"], min_duration_minutes: 20 }, 21600, ["health.read", "location.read"]));
  await rule("any", workoutRule({ activity_types: [], min_duration_minutes: 0 }, 21600, ["health.read"]));
  await rule("stale", workoutRule({ activity_types: [], min_duration_minutes: 0 }, 300, ["health.read"]));
  await rule("contacts", { ...common, event_type: "contact.added", sources: { source_ids: [] }, data_access: { scopes: ["contacts.read"], history_days: 30 } });
  await rule("daily", { ...common, event_type: "schedule", schedule: { local_time: "09:00", weekdays: [1], timezone: "UTC" }, data_access: { scopes: [], history_days: 30 } });

  const matcher = new AutomationMatcher(db);
  while (await matcher.matchNext(owner)) { /* drain */ }
  const [w1] = await db.select().from(s.healthWorkoutTable).where(eq(s.healthWorkoutTable.hkUuid, "w1"));
  const [w2] = await db.select().from(s.healthWorkoutTable).where(eq(s.healthWorkoutTable.hkUuid, "w2"));
  const eventFor = (workoutId: string) => published.find(event => event.workoutId === workoutId)!.id;
  const delivery = async (automation: string, workoutId: string) => (await db.select().from(s.automationDeliveryTable).where(and(
    eq(s.automationDeliveryTable.automationId, automation), eq(s.automationDeliveryTable.domainEventId, eventFor(workoutId)))))[0];
  assert.deepEqual([(await delivery("runs", w1.id)).status, (await delivery("runs", w2.id)).outcomeCode], ["pending", "workout_filter_mismatch"]);
  assert.deepEqual([(await delivery("any", w1.id)).status, (await delivery("any", w2.id)).status], ["pending", "pending"]);
  assert.deepEqual([(await delivery("stale", w1.id)).outcomeCode, (await delivery("stale", w2.id)).outcomeCode], ["event_too_old", "event_too_old"]);
  assert.equal((await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, "contacts"))).length, 0);
  assert.equal((await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, "daily"))).length, 0);

  // A deletion after matching makes that workout's run fail instead of starting.
  await upload([deletion("w2")]);
  await db.insert(s.locationObservationTable).values({ id: "01JZZZZZZZZZZZZZZZZZZZZZZZ", rawEventId: "raw", epochId: w1.epochId,
    kind: "significant_change", latitude: 37.77, longitude: -122.42, horizontalAccuracyM: 30,
    occurredAt: new Date(now - 25 * 60_000), receivedAt: new Date(now), createdByUserId: owner });
  const admission = new AutomationAdmission(db);
  while (await admission.admitNext(owner)) { /* drain */ }
  assert.deepEqual([(await delivery("any", w2.id)).status, (await delivery("any", w2.id)).outcomeCode], ["failed", "workout_evidence_unavailable"]);
  const admitted = await delivery("runs", w1.id);
  assert.equal(admitted.status, "admitted");
  const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, admitted.invocationId!));
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
  assert.match(input.content, /^Finished a 30-minute running workout at [^\n]+\.\n\n/);
  assert.match(input.content, /- Workout ID: /);
  assert.equal(input.metadata?.workout_id, w1.id);
  assert.equal(await checkAutomationPolicy(invocation, true, db), "ready");

  const evidence = await db.transaction(tx => automationStartEvidence(tx, invocation));
  const json = JSON.parse(evidence!.slice(evidence!.indexOf("{")));
  assert.equal(json.workout.workout_id, w1.id);
  assert.equal(json.location.observations.length, 1, "the rule with location access gets samples from during the workout");
  const anyRun = await delivery("any", w1.id);
  const [anyInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, anyRun.invocationId!));
  const withoutLocation = await db.transaction(tx => automationStartEvidence(tx, anyInvocation));
  assert.match(withoutLocation!, /does not have location access/);

  // A deletion after admission, before first start, stops the run at start (owner lock held by the caller).
  await upload([deletion("w1")]);
  await assert.rejects(db.transaction(tx => automationStartEvidence(tx, invocation)), { code: "workout_evidence_unavailable" });

  // Withdrawing the workouts health type stops admitted runs at their policy check.
  await db.update(s.agentDataGrantTable).set({ healthTypes: ["sleep"] }).where(eq(s.agentDataGrantTable.createdByUserId, owner));
  await assert.rejects(checkAutomationPolicy(invocation, true, db), /data_permission_changed/);

  // Boundaries: approved history limits the workout itself, and maximum age bounds the first start.
  await db.update(s.agentDataGrantTable).set({ healthTypes: ["workouts", "sleep"] }).where(eq(s.agentDataGrantTable.createdByUserId, owner));
  await rule("short", workoutRule({ activity_types: [], min_duration_minutes: 0 }, 604800, ["health.read"], 1));
  await upload([workout("w4", "running", 30, 60 * 48), workout("w5", "running", 20, 350)]);
  while (await matcher.matchNext(owner)) { /* drain */ }
  const [w4] = await db.select().from(s.healthWorkoutTable).where(eq(s.healthWorkoutTable.hkUuid, "w4"));
  const [w5] = await db.select().from(s.healthWorkoutTable).where(eq(s.healthWorkoutTable.hkUuid, "w5"));
  const refreshed = await domainEvents();
  const deliveryFor = async (automation: string, workoutId: string) => (await db.select().from(s.automationDeliveryTable).where(and(
    eq(s.automationDeliveryTable.automationId, automation),
    eq(s.automationDeliveryTable.domainEventId, refreshed.find(event => event.workoutId === workoutId)!.id))))[0];
  assert.equal((await deliveryFor("short", w4.id)).status, "pending", "two days old is within the seven-day maximum age");
  const tightened = await deliveryFor("any", w5.id);
  assert.equal(tightened.status, "pending");
  assert.ok(Math.abs(tightened.latestStartAt.getTime() - (w5.endAt.getTime() + 21600_000)) < 1000,
    "first start is bounded by the workout end plus maximum age, not publication plus latest_start_seconds");
  while (await admission.admitNext(owner)) { /* drain */ }
  const outside = await deliveryFor("short", w4.id);
  assert.deepEqual([outside.status, outside.outcomeCode], ["failed", "history_outside_grant"],
    "a workout older than the approved one-day history never reaches the agent");
});
