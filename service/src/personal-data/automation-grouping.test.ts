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
import { AutomationMatcher } from "./automation-matcher.js";
import { AutomationAdmission } from "./automation-admission.js";
import { checkAutomationPolicy } from "./automation-policy.js";
import { automationStartEvidence } from "./automation-contact-context.js";
import { Places } from "./places.js";

test("location triggers for one conversation combine into one timeline run, one run at a time", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `automation_grouping_${randomUUID().replaceAll("-", "")}`;
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
    "health_workout", "data_domain_event",
    "automation", "automation_revision", "automation_delivery", "automation_bootstrap", "automation_bootstrap_member", "automation_bootstrap_group",
    "agent_invocation", "agent_invocation_action", "agent_data_grant", "bud", "thread", "message", "browser_handoff"])
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);

  const owner = "grouping-owner", budId = "bud", thread = randomUUID();
  const repository = new PostgresIngestRepository(db), processor = new ContactProcessor(db), places = new Places(db);
  const now = Date.now(), ago = (minutes: number) => new Date(now - minutes * 60_000);
  const visit = (key: string, arrival: Date, departure: Date | null, lat: number) => ["location.visit.v2", { visit_key: key,
    phase: departure ? "completed" : "arrived", arrival_at: arrival.toISOString(), departure_at: departure?.toISOString() ?? null,
    coordinate: { lat, lon: -122.4 }, horizontal_accuracy_m: 20 }] as [string, unknown];
  const upload = async (values: Array<[string, unknown]>) => {
    const context = { userId: owner, installationId: "phone", collectionEpoch: "legacy", batchId: randomUUID() };
    const lines = values.map(([type, payload]) => JSON.stringify({ schema_version: 1, event_id: randomUUID(), event_type: type,
      occurred_at: ago(0).toISOString(), recorded_at: ago(0).toISOString(), actor: { user_id: owner, installation_id: "phone" }, payload }));
    await repository.persist(context, await parseBatch(Buffer.from(lines.join("\n")), "", context));
    while (await processor.processNext()) { /* drain */ }
  };

  const home = await places.create(owner, { name: "Home", latitude: 37.70, longitude: -122.4 }, "user");
  const office = await places.create(owner, { name: "Office", latitude: 37.71, longitude: -122.4 }, "user");
  await db.update(s.placeTable).set({ geometryChangedAt: ago(1000) });
  await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.threadTable).values({ threadId: thread, budId, createdByUserId: owner, modelId: "gpt-6-astra", reasoningEffort: "medium" });
  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner, version: 1, scopes: ["location.read"], historyDays: 90 });
  const common = { instruction: "", bud_id: budId, model_mode: "inherit", origin_thread_id: thread, model: "", reasoning_effort: "none",
    target: { mode: "existing_thread", thread_id: thread }, latest_start_seconds: 3600, max_invocations_per_day: 10,
    data_access: { scopes: ["location.read"], history_days: 30 }, max_event_age_seconds: 21600 };
  const rule = async (id: string, definition: Record<string, unknown>) => {
    await db.insert(s.automationTable).values({ id, state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: owner, updatedByUserId: owner });
    await db.insert(s.automationRevisionTable).values({ automationId: id, revision: 1, definition, publicationBoundary: 0,
      grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  };
  await rule("leave-home", { ...common, name: "Leave Home", instruction: "Say I left home.", event_type: "place.departed", place_trigger: { place_ids: [home.id] } });
  await rule("ended", { ...common, name: "Visit ended", instruction: "Say where I was.", event_type: "visit.ended",
    visit_filter: { place_ids: [], min_duration_minutes: 0 } });
  await rule("arrive-office", { ...common, name: "Arrive at Office", instruction: "Say I arrived.", event_type: "place.arrived",
    place_trigger: { place_ids: [office.id] } });
  // Same conversation, but different data access: never shares a run.
  await rule("arrive-office-weekly", { ...common, name: "Office log", instruction: "Log it.", event_type: "place.arrived",
    place_trigger: { place_ids: [office.id] }, data_access: { scopes: ["location.read"], history_days: 7 } });

  // Left home (a completed visit), then arrived at the Office: all published together.
  await upload([visit("h", ago(90), ago(20), 37.70), visit("o", ago(10), null, 37.71)]);
  const matcher = new AutomationMatcher(db), admission = new AutomationAdmission(db);
  while (await matcher.matchNext(owner)) { /* drain */ }
  const delivery = async (id: string) => (await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, id)))[0];
  // Hold the differently-scoped delivery back for now, so the order is deterministic.
  const weeklyId = (await delivery("arrive-office-weekly")).id;
  await db.update(s.automationDeliveryTable).set({ nextAttemptAt: ago(-60) }).where(eq(s.automationDeliveryTable.id, weeklyId));
  while (await admission.admitNext(owner)) { /* drain */ }
  const grouped = await Promise.all(["leave-home", "ended", "arrive-office"].map(delivery));
  assert.deepEqual(grouped.map(row => row.status), ["admitted", "admitted", "admitted"]);
  assert.equal(new Set(grouped.map(row => row.invocationId)).size, 1, "one run for the three");
  // Due now, while the run is queued: it waits (different data access, so its own run, next).
  await db.update(s.automationDeliveryTable).set({ nextAttemptAt: ago(1) }).where(eq(s.automationDeliveryTable.id, weeklyId));
  while (await admission.admitNext(owner)) { /* drain */ }
  const weekly = await delivery("arrive-office-weekly");
  assert.deepEqual([weekly.status, weekly.outcomeCode], ["pending", "location_run_in_progress"]);

  const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, grouped[0].invocationId!));
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
  assert.match(input.content, /^Since the last update:\n- Left Home at [^\n]+\.\n- A visit at [^\n]+ ended at [^\n]+\.\n- Arrived at Office at [^\n]+\.\n\n/,
    "in the order things happened");
  assert.match(input.content, /\n\nFor "Leave Home": Say I left home\.\nFor "Visit ended": Say where I was\.\nFor "Arrive at Office": Say I arrived\.\n\n---\n/);
  assert.match(input.content, /- Triggered by the "Leave Home", "Visit ended" and "Arrive at Office" automations \(IDs leave-home, ended, arrive-office\)\./);
  assert.equal((input.content.match(/Times are in UTC/g) ?? []).length, 1, "shared reference lines once");
  assert.deepEqual([input.metadata?.automation_name, (input.metadata?.automation_names as string[]).length, (input.metadata?.delivery_ids as string[]).length],
    ["Leave Home, Visit ended and Arrive at Office", 3, 3]);
  const evidence = await db.transaction(tx => automationStartEvidence(tx, invocation));
  const json = JSON.parse(evidence!.slice(evidence!.indexOf("{")));
  assert.deepEqual(json.events.map((entry: { trigger: string }) => entry.trigger), ["place.departed", "visit.ended", "place.arrived"]);

  // Every rule in the run is checked at start: one paused holds it, one deleted ends it.
  assert.equal(await checkAutomationPolicy(invocation, true, db), "ready");
  await db.update(s.automationTable).set({ state: "paused" }).where(eq(s.automationTable.id, "ended"));
  assert.equal(await checkAutomationPolicy(invocation, true, db), "retry_wait");
  await db.update(s.automationTable).set({ state: "deleted" }).where(eq(s.automationTable.id, "ended"));
  await assert.rejects(checkAutomationPolicy(invocation, true, db), { code: "automation_authority_lost" });

  // Once the run is over, what waited forms the next run.
  await db.update(s.agentInvocationTable).set({ status: "succeeded" }).where(eq(s.agentInvocationTable.id, invocation.id));
  await db.update(s.automationDeliveryTable).set({ nextAttemptAt: ago(1) }).where(eq(s.automationDeliveryTable.id, weekly.id));
  while (await admission.admitNext(owner)) { /* drain */ }
  const next = await delivery("arrive-office-weekly");
  assert.equal(next.status, "admitted");
  assert.notEqual(next.invocationId, invocation.id);
  const [nextInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, next.invocationId!));
  const [nextInput] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, nextInvocation.inputMessageId));
  assert.match(nextInput.content, /^Arrived at Office at [^\n]+\.\n\nLog it\./, "a run of one keeps the single-event form");
});
