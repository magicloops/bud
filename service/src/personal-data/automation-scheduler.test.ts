import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import { AutomationAdmission } from "./automation-admission.js";
import { checkAutomationPolicy, loadAutomationDataCeiling } from "./automation-policy.js";
import { automationStartEvidence } from "./automation-contact-context.js";
import { Automations } from "./automations.js";

test("scheduled automations run the latest due window once and admit without contact evidence", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `automation_schedule_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  // Isolated copies keep fixture deliveries away from the running development worker.
  for (const table of ["automation", "automation_revision", "automation_delivery", "automation_bootstrap",
    "automation_bootstrap_group", "automation_bootstrap_member", "agent_invocation", "agent_invocation_action",
    "data_owner_state", "bud", "thread", "message", "agent_data_grant", "data_domain_event", "browser_handoff"]) {
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  }
  const owner = "schedule-owner", budId = "bud", originThread = randomUUID();
  await db.insert(s.dataOwnerStateTable).values({ createdByUserId: owner });
  await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.threadTable).values({ threadId: originThread, budId, createdByUserId: owner, modelId: "gpt-6-astra", reasoningEffort: "medium" });

  const now = new Date();
  const hhmm = (offsetMinutes: number) => new Date(now.getTime() - offsetMinutes * 60_000).toISOString().slice(11, 16);
  const window = (offsetMinutes: number) => { const value = new Date(now.getTime() - offsetMinutes * 60_000); value.setUTCSeconds(0, 0); return value; };
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const definition = (local_time: string, overrides: Record<string, unknown> = {}) => ({ event_type: "schedule", name: "Daily digest",
    instruction: "Summarize my day.", bud_id: budId, model_mode: "inherit", origin_thread_id: originThread, model: "", reasoning_effort: "none",
    target: { mode: "new_thread" }, schedule: { local_time, weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: "UTC" },
    data_access: { scopes: [], history_days: 30 }, latest_start_seconds: 3600, max_invocations_per_day: 5, ...overrides });
  const rule = async (id: string, value: Record<string, unknown>, state = "enabled", activatedAt = dayAgo) => {
    await db.insert(s.automationTable).values({ id, state, version: 1, activeRevision: 1, draft: value, createdByUserId: owner, updatedByUserId: owner });
    await db.insert(s.automationRevisionTable).values({ automationId: id, revision: 1, definition: value, publicationBoundary: 0,
      grantVersion: 0, activatedByUserId: owner, createdByUserId: owner, createdAt: activatedAt });
  };
  await rule("due", definition(hhmm(2)));
  await rule("late", definition(hhmm(5), { latest_start_seconds: 60 }));
  await rule("paused", definition(hhmm(2)), "paused");
  await rule("fresh", definition(hhmm(2)), "enabled", new Date(now.getTime() - 30_000));
  const deliveriesFor = (id: string) => db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, id));

  // Concurrent schedulers produce one delivery per window.
  const results = await Promise.all([0, 1].map(() => new AutomationScheduler(db, () => now, 0).scheduleDue()));
  assert.ok(results.includes(true));
  const [due] = await deliveriesFor("due");
  assert.equal((await deliveriesFor("due")).length, 1);
  assert.equal(due.scheduledFor!.toISOString(), window(2).toISOString());
  assert.equal(due.status, "pending");
  assert.equal(due.domainEventId, null);
  const [late] = await deliveriesFor("late");
  assert.equal(late.status, "expired");
  assert.equal(late.outcomeCode, "latest_start_elapsed");
  assert.equal((await deliveriesFor("paused")).length, 0, "paused rules create no deliveries");
  assert.equal((await deliveriesFor("fresh")).length, 0, "a window before activation never runs");
  const scheduler = new AutomationScheduler(db, () => now, 60_000);
  assert.equal(await scheduler.scheduleDue(), false, "an existing window is not recreated");
  assert.equal(await scheduler.scheduleDue(), false, "scans are throttled");

  // Admission needs no grant for a rule without data scopes and no contact evidence.
  assert.equal(await new AutomationAdmission(db).admitNext(owner), true);
  const [admitted] = await deliveriesFor("due");
  assert.equal(admitted.status, "admitted");
  const [invocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, admitted.invocationId!));
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, invocation.inputMessageId));
  assert.match(input.content, /^Scheduled run for [^\n]+\.\n\nSummarize my day\.\n\n---\nFor reference\./);
  assert.match(input.content, /- Triggered by the "Daily digest" automation/);
  assert.equal(input.metadata?.automation_name, "Daily digest");
  assert.match(input.content, /first scheduled run/);
  assert.match(input.content, /no personal-data access/);
  assert.equal(input.metadata?.scheduled_for, window(2).toISOString());
  assert.equal(input.metadata?.contact_id, undefined);
  assert.equal(await checkAutomationPolicy(invocation, true, db), "ready");
  await db.transaction(async tx => assert.equal(await automationStartEvidence(tx, invocation), null));
  await db.update(s.agentInvocationTable).set({ status: "running", workerId: "worker", leaseExpiresAt: new Date(Date.now() + 60_000) })
    .where(eq(s.agentInvocationTable.id, invocation.id));
  const ceiling = await loadAutomationDataCeiling(invocation.threadId, owner, invocation.turnId, db);
  assert.deepEqual(ceiling?.scopes, [], "data tools stay closed for a rule without scopes");
  await db.update(s.automationTable).set({ state: "paused" }).where(eq(s.automationTable.id, "due"));
  assert.equal(await checkAutomationPolicy(invocation, true, db), "retry_wait");

  // History reports the window; the next run is listed for enabled schedule rules.
  const repo = new Automations(db);
  const [entry] = (await repo.history(owner, "due")).items;
  assert.equal(new Date(entry.scheduled_for!).toISOString(), window(2).toISOString());
  const next = (await repo.get(owner, "late")).next_run_at;
  assert.ok(next && next > now && next.getTime() - now.getTime() <= 86_400_000);
  assert.equal((await repo.get(owner, "paused")).next_run_at, null);

  // Rules requesting data still require the approved grant version.
  await rule("scoped", definition(hhmm(1), { data_access: { scopes: ["location.read"], history_days: 7 } }));
  assert.equal(await new AutomationScheduler(db, () => now, 0).scheduleDue(), true);
  assert.equal(await new AutomationAdmission(db).admitNext(owner), true);
  const [scoped] = await deliveriesFor("scoped");
  assert.equal(scoped.status, "failed");
  assert.equal(scoped.outcomeCode, "data_permission_changed");

  // A previous admitted window is named for the next run.
  await db.update(s.automationTable).set({ state: "enabled" }).where(eq(s.automationTable.id, "due"));
  await db.update(s.automationRevisionTable).set({ definition: definition(hhmm(1)) })
    .where(and(eq(s.automationRevisionTable.automationId, "due"), eq(s.automationRevisionTable.revision, 1)));
  assert.equal(await new AutomationScheduler(db, () => now, 0).scheduleDue(), true);
  assert.equal(await new AutomationAdmission(db).admitNext(owner), true);
  const second = (await deliveriesFor("due")).find(row => row.id !== due.id)!;
  const [secondInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, second.invocationId!));
  const [secondInput] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, secondInvocation.inputMessageId));
  assert.match(secondInput.content, /previous scheduled run was for/);
  assert.equal(secondInput.metadata?.previous_scheduled_for, window(2).toISOString());
});
