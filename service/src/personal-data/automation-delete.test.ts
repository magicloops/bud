import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { Automations } from "./automations.js";
import { AutomationBootstrap } from "./automation-bootstrap.js";
import { AutomationMatcher } from "./automation-matcher.js";
import { checkAutomationPolicy } from "./automation-policy.js";
import { registerPersonalDataRoutes } from "./routes.js";

test("deletion is owner-bound, atomic, retryable and terminal while retaining history", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `automation_delete_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const db = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  // Indexed isolated copies keep fixture work out of the running development worker.
  for (const table of ["automation", "automation_revision", "automation_delivery", "automation_bootstrap",
    "automation_bootstrap_group", "automation_bootstrap_member", "automation_proposal", "automation_bootstrap_proposal",
    "agent_invocation", "agent_invocation_action", "agent_question_request", "data_access_request", "data_owner_state",
    "bud", "thread", "message", "agent_data_grant", "data_domain_event", "contact_revision", "contact",
    "contact_source", "data_collection_epoch", "data_installation"]) {
    await admin.query(`create table "${namespace}"."${table}" (like public."${table}" including all)`);
  }
  await pool.query("alter table automation drop constraint automation_state_check");
  await pool.query("alter table automation add constraint automation_state_check check (state in ('draft','enabled','paused'))");
  await pool.query(await readFile(new URL("../../drizzle/migrations/0036_magical_ken_ellis.sql", import.meta.url), "utf8"));
  const owner = "delete-owner", other = "other-owner", now = new Date(), deadline = new Date(Date.now() + 86400000);
  const definition = { event_type: "contact.added", name: "Delete fixture", instruction: "Write a note.",
    sources: { source_ids: [] }, bud_id: "bud", model: "gpt-5.6-luna", reasoning_effort: "low",
    target: { mode: "new_thread" }, data_access: { scopes: ["contacts.read"], history_days: 30 },
    latest_start_seconds: 86400, max_invocations_per_day: 5 };
  await db.insert(s.dataOwnerStateTable).values([{ createdByUserId: owner }, { createdByUserId: other }]);
  await db.insert(s.budTable).values({ budId: "bud", name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.automationTable).values([
    { id: "rule", state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: owner, updatedByUserId: owner },
    { id: "other-rule", state: "enabled", version: 1, activeRevision: 1, draft: definition, createdByUserId: other, updatedByUserId: other },
  ]);
  await db.insert(s.automationRevisionTable).values({ automationId: "rule", revision: 1, definition,
    publicationBoundary: 0, grantVersion: 1, activatedByUserId: owner, createdByUserId: owner });
  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner,
    version: 1, scopes: ["contacts.read"], historyDays: 30 });
  await db.insert(s.dataInstallationTable).values({ id: "installation", installationId: "phone", createdByUserId: owner });
  await db.insert(s.dataCollectionEpochTable).values({ id: "epoch", installationId: "installation", collectionEpoch: "epoch", createdByUserId: owner });
  await db.insert(s.contactSourceTable).values({ id: "source", epochId: "epoch", storeId: "store", createdByUserId: owner });
  await db.insert(s.contactTable).values({ id: "contact", sourceId: "source", sourceContactId: "contact", fields: {}, generation: 1,
    firstObservedAt: now, observedAt: now, createdByUserId: owner });
  await db.insert(s.contactRevisionTable).values({ id: "evidence", contactId: "contact", scanId: "scan", fields: {}, visible: true,
    observedAt: now, createdByUserId: owner });
  const statuses = ["pending", "leased", "running", "waiting_for_user", "needs_review", "succeeded"] as const;
  for (const [index, status] of statuses.entries()) {
    const threadId = randomUUID(), messageId = randomUUID();
    await db.insert(s.threadTable).values({ threadId, budId: "bud", createdByUserId: owner });
    await db.insert(s.messageTable).values({ messageId, clientId: randomUUID(), threadId, role: "system", content: "Retained note",
      createdByUserId: owner, metadata: { model_context_at: index > 1 ? now.toISOString() : null } });
    await db.insert(s.agentInvocationTable).values({ id: status, turnId: status, threadId, budId: "bud", inputMessageId: messageId,
      origin: "automation", idempotencyKey: status, model: definition.model, reasoningEffort: definition.reasoning_effort,
      status, reservesThread: ["leased", "running", "waiting_for_user", "needs_review"].includes(status),
      workerId: ["leased", "running"].includes(status) ? "worker" : null,
      leaseExpiresAt: ["leased", "running"].includes(status) ? deadline : null, createdByUserId: owner });
    await db.insert(s.dataDomainEventTable).values({ id: status, revisionId: "evidence-" + status,
      eventType: "contact.added", status: "matched", publicationSequence: index + 1, createdByUserId: owner });
    // Only the running invocation needs a complete policy lineage for this fixture.
    if (status === "running") await db.update(s.dataDomainEventTable).set({ revisionId: "evidence" }).where(eq(s.dataDomainEventTable.id, status));
    await db.insert(s.automationDeliveryTable).values({ id: status, automationId: "rule", revision: 1, domainEventId: status,
      invocationId: status, status: "admitted", latestStartAt: deadline, createdByUserId: owner });
  }
  await db.insert(s.automationDeliveryTable).values([
    { id: "queued", automationId: "rule", revision: 1, domainEventId: "queued", latestStartAt: deadline, createdByUserId: owner },
    { id: "foreign", automationId: "other-rule", revision: 1, domainEventId: "foreign", latestStartAt: deadline, createdByUserId: other },
  ]);
  await db.insert(s.automationBootstrapTable).values({ id: "bootstrap", automationId: "rule", revision: 1, idempotencyKey: "bootstrap",
    request: {}, publicationBoundary: 0, memberCount: 2, groupSize: 1, latestStartAt: deadline, createdByUserId: owner });
  await db.insert(s.automationBootstrapGroupTable).values({ bootstrapId: "bootstrap", groupIndex: 0, createdByUserId: owner });
  await db.delete(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.id, "waiting_for_user"));
  await db.insert(s.automationBootstrapGroupTable).values({ bootstrapId: "bootstrap", groupIndex: 1,
    invocationId: "waiting_for_user", status: "admitted", createdByUserId: owner });
  const reviewContext = { invocationId: "human-review", threadId: randomUUID(), budId: "bud", callId: "review", createdByUserId: owner,
    createdAt: now, expiresAt: deadline };
  await db.insert(s.automationProposalTable).values({ ...reviewContext, id: "review", automationId: "rule",
    definition, draftVersion: 1, grantVersion: 1 });
  await db.insert(s.automationBootstrapProposalTable).values({ ...reviewContext, id: "bootstrap-review", automationId: "rule",
    revision: 1, frozen: {}, fingerprint: "a".repeat(64), memberCount: 1 });
  const repo = new Automations(db), bootstrap = new AutomationBootstrap(db);
  const [running] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, "running"));
  assert.equal(await checkAutomationPolicy(running, false, db), "ready");
  const app = Fastify(); t.after(() => app.close());
  await registerPersonalDataRoutes(app, { automations: repo,
    authenticate: async request => request.headers.authorization === "Bearer owner" ? { userId: owner }
      : request.headers.authorization === "Bearer other" ? { userId: other } : null,
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
  });
  const request = { method: "POST" as const, url: "/api/automations/rule/delete", headers: { authorization: "Bearer owner" }, payload: { expected_version: 1 } };
  for (const authorization of [undefined, "Bearer app-key"]) {
    assert.equal((await app.inject({ ...request, headers: authorization ? { authorization } : {} })).statusCode, 401);
  }
  assert.equal((await app.inject({ ...request, headers: { authorization: "Bearer other" } })).statusCode, 404);
  assert.equal((await app.inject({ ...request, payload: { expected_version: 0 } })).statusCode, 409);
  assert.equal((await app.inject({ ...request, payload: { ...request.payload, owner: other } })).statusCode, 400);
  assert.equal((await app.inject({ ...request, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ ...request, payload: { padding: "x".repeat(2048) } })).statusCode, 413);

  // Failure after cancellation writes rolls back the entire deletion transaction.
  await pool.query(`create function reject_delete() returns trigger language plpgsql as $$ begin
    if NEW.state = 'deleted' then raise exception 'fixture_delete_failure'; end if; return NEW; end $$`);
  await pool.query("create trigger reject_delete before update on automation for each row execute function reject_delete()");
  assert.equal((await app.inject(request)).statusCode, 503);
  assert.equal((await repo.get(owner, "rule")).state, "enabled");
  assert.equal((await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, "pending")))[0].status, "pending");
  assert.equal((await db.select().from(s.automationProposalTable))[0].status, "pending");
  await pool.query("drop trigger reject_delete on automation");

  const responses = await Promise.all([app.inject(request), app.inject(request)]);
  assert.ok(responses.every(response => response.statusCode === 200));
  assert.deepEqual(responses[0].json(), responses[1].json());
  assert.equal(responses[0].headers["cache-control"], "no-store");
  const deleted = responses[0].json();
  assert.equal(deleted.state, "deleted"); assert.equal(deleted.version, 2);
  assert.deepEqual((await repo.list(owner)).items, []);
  assert.equal((await db.select().from(s.automationProposalTable))[0].status, "stale");
  assert.equal((await db.select().from(s.automationBootstrapProposalTable))[0].status, "stale");
  assert.equal((await repo.list(other)).items.length, 1);
  const rows = await db.select().from(s.agentInvocationTable);
  for (const status of ["pending", "leased", "waiting_for_user"]) {
    const row = rows.find(row => row.id === status)!;
    assert.equal(row.status, "canceled"); assert.equal(row.reservesThread, false); assert.equal(row.canceledByUserId, owner);
  }
  const active = rows.find(row => row.id === "running")!;
  assert.equal(active.status, "running"); assert.equal(active.reservesThread, true); assert.ok(active.cancelRequestedAt);
  assert.equal(active.canceledByUserId, owner);
  assert.equal(rows.find(row => row.id === "needs_review")!.reservesThread, true);
  assert.equal(rows.find(row => row.id === "succeeded")!.status, "succeeded");
  assert.equal((await bootstrap.get(owner, "rule", "bootstrap")).status, "canceled");
  assert.equal((await db.select().from(s.automationBootstrapGroupTable).where(eq(s.automationBootstrapGroupTable.groupIndex, 0)))[0].status, "canceled");
  assert.equal((await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.id, "queued")))[0].status, "canceled");
  assert.equal((await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.id, "foreign")))[0].status, "pending");
  assert.equal((await repo.history(owner, "rule")).items.length, 6);
  assert.equal((await db.select().from(s.messageTable)).length, statuses.length);
  assert.equal((await db.select().from(s.threadTable)).length, statuses.length);
  assert.equal((await repo.get(owner, "rule")).active?.revision, 1);
  const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
  await assert.rejects(repo.update(owner, "rule", { expected_version: 2, definition }), code("automation_not_found"));
  await assert.rejects(repo.activate(owner, "rule", { expected_version: 2, expected_grant_version: 1, acknowledge_standing_work: true }), code("automation_not_found"));
  await assert.rejects(repo.pause(owner, "rule", { expected_version: 2, cancel_pending: false, cancel_active: false }), code("automation_not_found"));
  await assert.rejects(bootstrap.capture(owner, "rule", { expected_version: 2, idempotency_key: "new", acknowledge_existing_contacts: true,
    sources: { source_ids: [] }, search: "", max_contacts: 5, mode: "batched", exclude_previously_delivered: true,
    acknowledge_repeated_actions: false }), code("automation_not_found"));
  for (const checkPause of [false, true]) await assert.rejects(checkAutomationPolicy(running, checkPause, db), code("automation_authority_lost"));
  // A delayed event from before deletion must not recreate pending work.
  await db.update(s.dataDomainEventTable).set({ status: "pending" }).where(eq(s.dataDomainEventTable.id, "running"));
  await db.delete(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.id, "running"));
  assert.equal(await new AutomationMatcher(db).matchNext(owner), true);
  assert.equal((await db.select().from(s.automationDeliveryTable).where(and(eq(s.automationDeliveryTable.automationId, "rule"), eq(s.automationDeliveryTable.domainEventId, "running")))).length, 0);
  await db.insert(s.automationTable).values(Array.from({ length: 99 }, (_, i) => ({
    id: `draft-${i}`, draft: definition, createdByUserId: owner, updatedByUserId: owner,
  })));
  const replacement = await repo.create(owner, definition);
  assert.notEqual(replacement.automation_id, "rule");
  assert.equal((await repo.list(owner)).items.length, 100, "deleted rules free an inventory slot");
  await assert.rejects(repo.create(owner, definition), code("automation_limit_reached"));
});
