import test from "node:test";
import Fastify from "fastify";
import { registerPersonalDataRoutes } from "./routes.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { AutomationWorker } from "./automation-worker.js";
import { AutomationMatcher } from "./automation-matcher.js";
import { BootstrapAdmission } from "./bootstrap-admission.js";
import { AutomationBootstrap } from "./automation-bootstrap.js";
import { AutomationAdmission } from "./automation-admission.js";
import { checkAutomationPolicy, loadAutomationDataCeiling } from "./automation-policy.js";
import { Automations } from "./automations.js";
import { InvocationRepository } from "../agent/invocation-repository.js";
import { ContactProcessor } from "./contact-processor.js";
import { PostgresIngestRepository } from "./repository.js";
import { parseBatch } from "./parser.js";
import { ContactQueries } from "./contact-queries.js";
import { DataRequestError } from "./contracts.js";
import { contactManifestDigest } from "./contacts.js";

test("Postgres contact scans publish complete generations once, suppress baseline and rebuild actions", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema: s });
  const owner = "contacts-test-" + randomUUID();
  t.after(async () => {
    try {
      for (const table of [s.automationBootstrapGroupTable, s.automationBootstrapMemberTable, s.automationBootstrapTable, s.automationDeliveryTable, s.automationRevisionTable, s.automationTable, s.dataDomainEventTable, s.contactRevisionTable, s.contactTable, s.contactScanRecordTable, s.contactScanTable, s.contactSourceTable, s.dataProcessingJobTable, s.dataEventTable, s.dataCollectionEpochTable, s.dataInstallationTable, s.dataOwnerStateTable]) {
        await db.delete(table).where(eq(table.createdByUserId, owner));
      }
      for (const table of [s.agentInvocationTable, s.messageTable, s.threadTable, s.budTable, s.agentDataGrantTable]) {
        await db.delete(table).where(eq(table.createdByUserId, owner));
      }
      await db.delete(s.authUserTable).where(eq(s.authUserTable.id, owner));
    } finally { await pool.end(); }
  });
  await db.insert(s.authUserTable).values({ id: owner, name: "Contact fixture", email: owner + "@example.invalid", emailVerified: false });
  const repo = new PostgresIngestRepository(db);
  const processor = new ContactProcessor(db);
  const context = { userId: owner, installationId: randomUUID(), collectionEpoch: "legacy", batchId: randomUUID() };
  const storeId = randomUUID();
  const makeScan = (generation: number, sourceID: string) => {
    const common = { payload_version: 1, contact_store_id: storeId, scan_id: randomUUID(), generation, previous_generation: generation - 1,
      scan_mode: generation === 1 ? "baseline" : "incremental", observed_at: `2026-09-04T10:00:0${generation}.000Z`,
      previous_observed_at: generation === 1 ? null : `2026-09-04T10:00:0${generation - 1}.000Z`, time_basis: "observed", authorization: "3" };
    const eventID = randomUUID();
    const wrap = (type: string, id: string, payload: object) => ({ schema_version: 1, event_id: id, event_type: type, occurred_at: common.observed_at, recorded_at: common.observed_at, actor: { user_id: owner, installation_id: context.installationId }, payload });
    return [wrap("contacts.record.v1", eventID, { ...common, source_contact_id: sourceID, change: "upsert", newly_observed: generation > 1,
      contact: { given_name: sourceID, family_name: "", organization: "", phones: [], emails: [] } }),
      wrap("contacts.scan.v1", randomUUID(), { ...common, expected_event_count: 1, event_ids_sha256: contactManifestDigest([eventID]) })];
  };
  const upload = async (values: object[]) => {
    const batch = await parseBatch(Buffer.from(values.map(v => JSON.stringify(v)).join("\n")), "", context);
    await repo.persist(context, batch);
    while (await processor.processNext(owner)) { /* drain fixture only */ }
  };
  const baseline = makeScan(1, "a");
  const next = makeScan(2, "b");
  await upload(next);
  assert.equal(await processor.publishNext(false, owner), false, "missing predecessor must wait");
  await upload([baseline[1]]);
  assert.equal(await processor.publishNext(false, owner), false, "missing baseline member must wait");
  await upload([baseline[0]]);
  assert.equal(await processor.publishNext(false, owner), true);
  assert.equal((await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner))).length, 0);
  await Promise.all([processor.publishNext(false, owner), processor.publishNext(false, owner)]);
  assert.equal((await db.select().from(s.contactTable).where(eq(s.contactTable.createdByUserId, owner))).length, 2);
  assert.equal((await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner))).length, 1);
  await upload([...baseline, ...next]);
  assert.equal(await processor.publishNext(false, owner), false);
  assert.equal((await db.select().from(s.contactRevisionTable).where(eq(s.contactRevisionTable.createdByUserId, owner))).length, 2);
  const queries = new ContactQueries(db);
  const firstPage = await queries.list(owner, { limit: 1 });
  const sourceStatus = await repo.status(owner);
  assert.equal(sourceStatus.contact_sources.length, 1);
  assert.equal(sourceStatus.contact_sources[0].installation_id, context.installationId);
  assert.equal(sourceStatus.contact_sources[0].revoked, false);
  assert.equal((await repo.status(owner + "-other")).contact_sources.length, 0);
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.next_cursor);
  const secondPage = await queries.list(owner, { limit: 1, cursor: firstPage.next_cursor });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
  assert.equal((await queries.list(owner + "-other", {})).items.length, 0);
  await assert.rejects(queries.get(owner + "-other", firstPage.items[0].id), (e: unknown) => e instanceof DataRequestError && e.statusCode === 404);
  await assert.rejects(queries.history(owner + "-other", firstPage.items[0].id, {}), (e: unknown) => e instanceof DataRequestError && e.statusCode === 404);
  await assert.rejects(queries.list(owner + "-other", { cursor: firstPage.next_cursor }), (e: unknown) => e instanceof DataRequestError && e.code === "invalid_cursor");
  assert.equal((await queries.history(owner, firstPage.items[0].id, {})).items.length, 1);
  assert.equal((await queries.list(owner, { search: "a" })).items.length, 1);
  assert.equal((await queries.list(owner, { search: "%" })).items.length, 0);
  const policy = { observedSince: new Date("2026-09-04T10:00:01.500Z"), cursorBinding: "agents:1:30" };
  const permitted = await queries.list(owner, {}, policy);
  assert.deepEqual(permitted.items.map(row => row.fields.given_name), ["b"]);
  await assert.rejects(queries.get(owner, firstPage.items[0].id, policy), (e: unknown) => e instanceof DataRequestError && e.statusCode === 404);
  await assert.rejects(queries.list(owner, { cursor: firstPage.next_cursor }, policy), (e: unknown) => e instanceof DataRequestError && e.code === "invalid_cursor");
  assert.equal((await queries.history(owner, permitted.items[0].id, {}, policy)).items.length, 1);
  // A current contact may be recent while its older revisions fall outside consent.
  await db.update(s.contactRevisionTable).set({ observedAt: new Date("2026-09-01T00:00:00Z") }).where(eq(s.contactRevisionTable.contactId, permitted.items[0].id));
  assert.equal((await queries.history(owner, permitted.items[0].id, {}, policy)).items.length, 0);
  assert.equal((await queries.history(owner, permitted.items[0].id, {})).items.length, 1);
  const app = Fastify();
  await registerPersonalDataRoutes(app, { repository: repo, queries, authenticate: async request =>
    request.headers.authorization === "Bearer fixture-owner" ? { userId: owner } : request.headers.authorization === "Bearer fixture-other" ? { userId: owner + "-other" } : null });
  try {
    for (const url of ["/api/data/contacts", `/api/data/contacts/${firstPage.items[0].id}`, `/api/data/contacts/${firstPage.items[0].id}/history`]) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { authorization: "Bearer fixture-owner" } })).statusCode, 200);
    }
    assert.equal((await app.inject({ url: `/api/data/contacts/${firstPage.items[0].id}`, headers: { authorization: "Bearer fixture-other" } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/data/contacts/${firstPage.items[0].id}/history`, headers: { authorization: "Bearer fixture-other" } })).statusCode, 404);
    const foreignList = await app.inject({ url: "/api/data/contacts", headers: { authorization: "Bearer fixture-other" } });
    assert.deepEqual(foreignList.json().items, []);
  } finally { await app.close(); }
  await upload(makeScan(3, "c"));
  assert.equal(await processor.publishNext(true, owner), true);
  assert.equal((await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner))).length, 1);
  const [domain] = await db.select().from(s.dataDomainEventTable).where(eq(s.dataDomainEventTable.createdByUserId, owner));
  const [ownerState] = await db.select().from(s.dataOwnerStateTable).where(eq(s.dataOwnerStateTable.createdByUserId, owner));
  assert.equal(domain.publicationSequence, 1);
  assert.equal(ownerState.publicationSequence, 1, "baseline/replay/rebuild never advance live publication");
  const rule = randomUUID();
  const budId = "automation-bud-" + randomUUID();
  await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await db.insert(s.automationTable).values({ id: rule, draft: {}, createdByUserId: owner, updatedByUserId: owner });
  const ruleDefinition = { event_type: "contact.added", name: "Contacts", instruction: "First instruction",
    sources: { source_ids: [] }, bud_id: budId, model: "gpt-5.4", reasoning_effort: "low",
    target: { mode: "new_thread" }, data_access: { scopes: ["contacts.read"], history_days: 90 },
    latest_start_seconds: 86400, max_invocations_per_day: 1 };
  const revision = { automationId: rule, revision: 1, definition: ruleDefinition, publicationBoundary: 0, grantVersion: 0,
    activatedByUserId: owner, createdByUserId: owner };
  await assert.rejects(db.insert(s.automationRevisionTable).values({ ...revision, createdByUserId: owner + "-other" }),
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");
  await db.insert(s.automationRevisionTable).values(revision);
  const delivery = { id: randomUUID(), automationId: rule, revision: 1, domainEventId: domain.id,
    latestStartAt: new Date(), createdByUserId: owner };
  await db.insert(s.automationDeliveryTable).values(delivery);
  await assert.rejects(db.insert(s.automationDeliveryTable).values({ ...delivery, id: randomUUID() }),
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23505");
  await assert.rejects(db.insert(s.automationDeliveryTable).values({ ...delivery, id: randomUUID(), revision: 2 }),
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");

  // A delayed event stays with its publication-time revision after a later activation.
  await db.insert(s.automationRevisionTable).values({ ...revision, revision: 2, publicationBoundary: 1,
    definition: { ...ruleDefinition, instruction: "New instruction" } });
  await db.update(s.automationTable).set({ state: "enabled", activeRevision: 2, version: 2 }).where(eq(s.automationTable.id, rule));
  const matcher = new AutomationMatcher(db);
  await Promise.all([matcher.matchNext(owner), matcher.matchNext(owner)]);
  assert.equal(await matcher.matchNext(owner), false);
  let matched = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, rule));
  assert.equal(matched.length, 1, "retries and later revisions cannot duplicate an older event");
  assert.equal(matched[0].revision, 1);
  await upload(makeScan(4, "d"));
  assert.equal(await processor.publishNext(false, owner), true);
  // A development processor may briefly hold the owner lock. The matcher uses
  // SKIP LOCKED deliberately; assert eventual durable matching, not one poll.
  let processed = false;
  for (let attempt = 0; attempt < 20 && !processed; attempt++) {
    processed = await matcher.matchNext(owner);
    if (!processed) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(processed, true);
  matched = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, rule));
  assert.deepEqual(matched.map(row => row.revision).sort(), [1, 2]);
  assert.equal(matched.find(row => row.revision === 2)?.status, "pending");

  await db.insert(s.agentDataGrantTable).values({ createdByUserId: owner, updatedByUserId: owner,
    version: 0, scopes: ["contacts.read"], historyDays: 90 });
  await db.update(s.contactRevisionTable).set({ observedAt: new Date() }).where(eq(s.contactRevisionTable.createdByUserId, owner));
  const admission = new AutomationAdmission(db);
  assert.equal(await admission.admitNext(owner + "-other"), false);
  await db.update(s.automationTable).set({ state: "paused" }).where(eq(s.automationTable.id, rule));
  while (await admission.admitNext(owner)) { /* expire old delivery and defer paused work */ }
  matched = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, rule));
  assert.equal(matched.find(row => row.revision === 1)?.status, "expired");
  assert.equal(matched.find(row => row.revision === 2)?.outcomeCode, "automation_paused");
  assert.equal((await db.select().from(s.threadTable).where(eq(s.threadTable.createdByUserId, owner))).length, 0);
  await db.update(s.automationTable).set({ state: "enabled" }).where(eq(s.automationTable.id, rule));
  await db.update(s.automationDeliveryTable).set({ nextAttemptAt: new Date(0) }).where(eq(s.automationDeliveryTable.automationId, rule));
  await Promise.all([admission.admitNext(owner), new AutomationAdmission(db).admitNext(owner)]);
  const admitted = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.createdByUserId, owner));
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].model, "gpt-5.4");
  assert.equal(admitted[0].origin, "automation");
  const invocationRepository = new InvocationRepository(db);
  const automationRepository = new Automations(db);
  const deliveryHistory = await automationRepository.history(owner, rule);
  assert.equal(deliveryHistory.items.find(item => item.invocation_id === admitted[0].id)?.invocation?.thread_id, admitted[0].threadId);
  const lease = await invocationRepository.claim("pause-race-fixture", owner);
  assert.ok(lease);
  assert.equal(await checkAutomationPolicy(admitted[0], true, db), "ready");
  await assert.rejects(checkAutomationPolicy({ ...admitted[0], createdByUserId: owner + "-other" }, true, db), /automation_authority_lost/);
  await assert.rejects(checkAutomationPolicy({ ...admitted[0], model: "different" }, true, db), /automation_target_changed/);
  await db.update(s.automationTable).set({ state: "paused" }).where(eq(s.automationTable.id, rule));
  await assert.rejects(invocationRepository.start(lease), /automation_paused/);
  assert.equal(await checkAutomationPolicy(admitted[0], true, db), "retry_wait");
  assert.equal(await checkAutomationPolicy(admitted[0], false, db), "ready");
  await db.update(s.automationTable).set({ state: "enabled" }).where(eq(s.automationTable.id, rule));
  await invocationRepository.start(lease);
  const ceiling = await loadAutomationDataCeiling(lease.threadId, owner, lease.turnId, db);
  assert.deepEqual(ceiling?.scopes, ["contacts.read"]);
  assert.equal(ceiling?.historyDays, 90);
  assert.equal(ceiling?.grantVersion, 0);
  assert.ok(ceiling?.binding.includes(lease.id));
  const paused = await automationRepository.pause(owner, rule, { expected_version: 2, cancel_pending: true, cancel_active: false });
  assert.equal(paused.cancellation_requests, 0, "cancel pending must not cancel a started invocation");
  const activePaused = await automationRepository.pause(owner, rule, { expected_version: 3, cancel_pending: false, cancel_active: true });
  assert.equal(activePaused.cancellation_requests, 1);
  const [cancelRequested] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, lease.id));
  assert.equal(cancelRequested.status, "running");
  assert.equal(cancelRequested.reservesThread, true);
  assert.equal(cancelRequested.canceledByUserId, owner);
  await invocationRepository.finish(lease, "failed", "cancellation_acknowledged");
  await assert.rejects(loadAutomationDataCeiling(lease.threadId, owner, lease.turnId, db), { code: "automation_not_running" });
  await db.update(s.automationTable).set({ state: "enabled" }).where(eq(s.automationTable.id, rule));
  assert.equal(await admission.admitNext(owner), false);
  assert.equal((await db.select().from(s.threadTable).where(eq(s.threadTable.createdByUserId, owner))).length, 1);
  const [input] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, admitted[0].inputMessageId));
  assert.match(input.content, /New instruction/);
  assert.equal(input.metadata?.automation_id, rule);
  assert.equal(typeof input.metadata?.model_context_at, "string");
  await upload(makeScan(5, "e"));
  assert.equal(await processor.publishNext(false, owner), true);
  await matcher.matchNext(owner);
  await admission.admitNext(owner);
  matched = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, rule));
  const capped = matched.find(row => row.outcomeCode === "daily_work_limit");
  assert.ok(capped);
  const bootstrap = new AutomationBootstrap(db);
  const historical = { expected_version: (await automationRepository.get(owner, rule)).version,
    idempotency_key: "snapshot-one", acknowledge_existing_contacts: true,
    sources: { source_ids: [] }, search: "", max_contacts: 2, mode: "batched",
    exclude_previously_delivered: true, acknowledge_repeated_actions: false };
  const previewInput = { expected_version: historical.expected_version, expected_grant_version: 0, use_draft: false,
    sources: historical.sources, search: "", max_contacts: 2, mode: "batched", exclude_previously_delivered: true };
  const preview = await bootstrap.preview(owner, rule, previewInput);
  assert.equal(preview.member_count, 2);
  assert.equal(preview.snapshot_frozen, false);
  assert.equal((await db.select().from(s.automationBootstrapTable).where(eq(s.automationBootstrapTable.createdByUserId, owner))).length, 0,
    "preview must not persist requests or approve work");
  await assert.rejects(bootstrap.preview(owner + "-other", rule, previewInput), { code: "automation_not_found" });
  await assert.rejects(bootstrap.preview(owner, rule, { ...previewInput, expected_grant_version: 1 }), { code: "grant_conflict" });
  const reviewInput = { automation_id: rule, expected_version: historical.expected_version,
    sources: historical.sources, search: "", max_contacts: 2, mode: "batched", exclude_previously_delivered: true };
  const frozen = await db.transaction(tx => bootstrap.freezeReviewInTransaction(tx, owner, reviewInput));
  assert.equal(frozen.contact_revision_ids.length, 2);
  assert.equal(frozen.revision, 2);
  assert.equal(frozen.definition.instruction, "New instruction");
  await assert.rejects(db.transaction(tx => bootstrap.freezeReviewInTransaction(tx, owner + "-other", reviewInput)),
    { code: "automation_not_found" });
  await assert.rejects(db.transaction(tx => bootstrap.captureReviewedInTransaction(tx, owner + "-other", frozen, "foreign")),
    { code: "bootstrap_review_not_found" });
  const [reviewedContact] = await db.select().from(s.contactRevisionTable)
    .where(eq(s.contactRevisionTable.id, frozen.contact_revision_ids[0]));
  await assert.rejects(db.transaction(async tx => {
    await tx.update(s.contactTable).set({ visible: false }).where(eq(s.contactTable.id, reviewedContact.contactId));
    await bootstrap.captureReviewedInTransaction(tx, owner, frozen, "stale-member");
  }), { code: "bootstrap_review_stale" });
  // A surrounding human decision transaction must own the capture commit.
  // Failure after all members/groups are written leaves no queued work.
  await assert.rejects(db.transaction(async tx => {
    const tentative = await bootstrap.captureReviewedInTransaction(tx, owner, frozen, "reviewed-capture");
    assert.equal(tentative.member_count, 2);
    const inside = await tx.select().from(s.automationBootstrapGroupTable)
      .where(eq(s.automationBootstrapGroupTable.bootstrapId, tentative.bootstrap_id));
    assert.equal(inside.length, 1);
    const selected = await tx.select().from(s.automationBootstrapMemberTable)
      .where(eq(s.automationBootstrapMemberTable.bootstrapId, tentative.bootstrap_id));
    assert.deepEqual(selected.sort((a, b) => a.ordinal - b.ordinal).map(member => member.contactRevisionId), frozen.contact_revision_ids);
    await tx.update(s.contactTable).set({ visible: false }).where(eq(s.contactTable.id, reviewedContact.contactId));
    assert.deepEqual(await bootstrap.captureReviewedInTransaction(tx, owner, frozen, "reviewed-capture"), tentative,
      "accepted retries return original receipt before checking changed membership");
    throw new Error("fixture_decision_write_failed");
  }), /fixture_decision_write_failed/);
  for (const table of [s.automationBootstrapTable, s.automationBootstrapMemberTable, s.automationBootstrapGroupTable]) {
    assert.equal((await db.select().from(table).where(eq(table.createdByUserId, owner))).length, 0);
  }
  const snapshots = await Promise.all([bootstrap.capture(owner, rule, historical), bootstrap.capture(owner, rule, historical)]);
  assert.equal(snapshots[0].bootstrap_id, snapshots[1].bootstrap_id);
  assert.equal(snapshots[0].member_count, 2);
  assert.equal(snapshots[0].group_size, 25);
  const membership = await db.select().from(s.automationBootstrapMemberTable).where(eq(s.automationBootstrapMemberTable.bootstrapId, snapshots[0].bootstrap_id));
  assert.equal(membership.length, 2);
  const persistedGroups = await db.select().from(s.automationBootstrapGroupTable).where(eq(s.automationBootstrapGroupTable.bootstrapId, snapshots[0].bootstrap_id));
  assert.equal(persistedGroups.length, 1);
  assert.equal(persistedGroups[0].status, "pending");
  assert.equal(persistedGroups[0].invocationId, null);
  assert.equal(persistedGroups[0].createdByUserId, owner);
  await assert.rejects(db.insert(s.automationBootstrapGroupTable).values({ bootstrapId: snapshots[0].bootstrap_id,
    groupIndex: 1, createdByUserId: owner + "-other" }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");

  assert.deepEqual(await bootstrap.get(owner, rule, snapshots[0].bootstrap_id), snapshots[0]);
  const snapshotPage = await bootstrap.page(owner, rule, snapshots[0].bootstrap_id, { limit: 1 });
  assert.equal(snapshotPage.items.length, 1);
  assert.ok(snapshotPage.next_cursor);
  const snapshotTail = await bootstrap.page(owner, rule, snapshots[0].bootstrap_id, { limit: 1, cursor: snapshotPage.next_cursor });
  assert.equal(snapshotTail.items.length, 1);
  assert.equal(snapshotTail.next_cursor, null);
  assert.notEqual(snapshotPage.items[0].contact_revision_id, snapshotTail.items[0].contact_revision_id);
  await assert.rejects(bootstrap.get(owner + "-other", rule, snapshots[0].bootstrap_id), { code: "bootstrap_not_found" });
  await assert.rejects(bootstrap.page(owner, "other-rule", snapshots[0].bootstrap_id), { code: "bootstrap_not_found" });
  await assert.rejects(bootstrap.page(owner, rule, snapshots[0].bootstrap_id, { limit: 101 }), { code: "invalid_bootstrap_query" });
  await assert.rejects(bootstrap.capture(owner, rule, { ...historical, max_contacts: 1 }), { code: "bootstrap_conflict" });
  const remaining = await bootstrap.capture(owner, rule, { ...historical, idempotency_key: "snapshot-two", max_contacts: 100 });
  assert.equal(remaining.member_count, 1, "pending live and prior snapshot membership are excluded");
  const requestPage = await bootstrap.list(owner, rule, { limit: 1 });
  assert.equal(requestPage.items.length, 1);
  assert.ok(requestPage.next_cursor);
  const requestTail = await bootstrap.list(owner, rule, { limit: 1, cursor: requestPage.next_cursor });
  assert.notEqual(requestTail.items[0].bootstrap_id, requestPage.items[0].bootstrap_id);
  await assert.rejects(bootstrap.list(owner + "-other", rule), { code: "automation_not_found" });
  await assert.rejects(bootstrap.page(owner, rule, remaining.bootstrap_id, { cursor: snapshotPage.next_cursor }), { code: "invalid_bootstrap_cursor" });
  const repeat = await bootstrap.capture(owner, rule, { ...historical, idempotency_key: "explicit-repeat", max_contacts: 1,
    mode: "per_contact", exclude_previously_delivered: false, acknowledge_repeated_actions: true });
  assert.equal(repeat.member_count, 1);
  assert.equal(repeat.group_size, 1);
  const pagedRequest = await bootstrap.capture(owner, rule, { ...historical, idempotency_key: "group-pages", max_contacts: 3,
    mode: "per_contact", exclude_previously_delivered: false, acknowledge_repeated_actions: true });
  const groupPage = await bootstrap.progress(owner, rule, pagedRequest.bootstrap_id, { limit: 2 });
  assert.deepEqual(groupPage.counts, { pending: 3 });
  assert.equal(groupPage.settled, false);
  assert.equal(groupPage.items.length, 2);
  assert.equal(groupPage.next_after, 1);
  const groupTail = await bootstrap.progress(owner, rule, pagedRequest.bootstrap_id, { limit: 2, after: groupPage.next_after! });
  assert.equal(groupTail.items.length, 1);
  assert.equal(groupTail.items[0].group_index, 2);
  assert.equal(groupTail.next_after, null);
  await assert.rejects(bootstrap.progress(owner + "-other", rule, pagedRequest.bootstrap_id), { code: "bootstrap_not_found" });
  await assert.rejects(bootstrap.progress(owner, rule, pagedRequest.bootstrap_id, { limit: 101 }), { code: "invalid_bootstrap_query" });
  await bootstrap.cancel(owner, rule, pagedRequest.bootstrap_id);
  await upload(makeScan(6, "f"));
  assert.equal(await processor.publishNext(false, owner), true);
  const delayed = await bootstrap.capture(owner, rule, { ...historical, idempotency_key: "before-delayed-matcher", max_contacts: 100 });
  assert.equal(delayed.member_count, 1);
  await matcher.matchNext(owner);
  const delayedDeliveries = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, rule));
  assert.equal(delayedDeliveries.filter(row => row.outcomeCode === "bootstrap_snapshot_selected").length, 1);
  const retriedSnapshot = await bootstrap.capture(owner, rule, historical);
  assert.equal(retriedSnapshot.publication_boundary, snapshots[0].publication_boundary);
  assert.equal(retriedSnapshot.member_count, 2, "later contacts do not mutate retry membership");
  assert.deepEqual(await db.select().from(s.automationBootstrapMemberTable).where(eq(s.automationBootstrapMemberTable.bootstrapId, snapshots[0].bootstrap_id)), membership);
  // Combined activation/snapshot is one commit, and retries do not reactivate.
  const combinedRule = await automationRepository.create(owner, ruleDefinition);
  const draftPreview = await bootstrap.preview(owner, combinedRule.automation_id,
    { ...previewInput, expected_version: 0, use_draft: true, max_contacts: 100 });
  assert.equal(draftPreview.member_count, 6);
  assert.equal(draftPreview.revision, 1);
  assert.equal((await automationRepository.get(owner, combinedRule.automation_id)).active_revision, null);
  const activation = { expected_version: 0, expected_grant_version: 0, acknowledge_standing_work: true };
  const combinedRequest = { ...historical, expected_version: 0, idempotency_key: "combined", max_contacts: 100 };
  await assert.rejects(bootstrap.activateAndCapture(owner, combinedRule.automation_id, activation,
    { ...combinedRequest, sources: { source_ids: ["missing-source"] } }), { code: "automation_source_not_found" });
  const rolledBack = await automationRepository.get(owner, combinedRule.automation_id);
  assert.equal(rolledBack.active_revision, null);
  assert.equal(rolledBack.version, 0, "snapshot failure must roll back activation");
  const combined = await Promise.all([bootstrap.activateAndCapture(owner, combinedRule.automation_id, activation, combinedRequest),
    bootstrap.activateAndCapture(owner, combinedRule.automation_id, activation, combinedRequest)]);
  assert.deepEqual(combined[0], combined[1]);
  assert.equal(combined[0].member_count, 6);
  assert.equal((await automationRepository.get(owner, combinedRule.automation_id)).version, 1);
  const [combinedRevision] = await db.select().from(s.automationRevisionTable).where(eq(s.automationRevisionTable.automationId, combinedRule.automation_id));
  assert.equal(combinedRevision.publicationBoundary, combined[0].publication_boundary);
  await assert.rejects(bootstrap.capture(owner, combinedRule.automation_id, combinedRequest), { code: "bootstrap_conflict" });
  await upload(makeScan(7, "g"));
  assert.equal(await processor.publishNext(false, owner), true);
  await matcher.matchNext(owner);
  const combinedLive = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, combinedRule.automation_id));
  assert.equal(combinedLive.length, 1);
  assert.equal(combinedLive[0].status, "pending", "post-boundary contact remains live eligible");
  assert.deepEqual(await bootstrap.activateAndCapture(owner, combinedRule.automation_id, activation, combinedRequest), combined[0]);
  const bootstrapApp = Fastify();
  await registerPersonalDataRoutes(bootstrapApp, { repository: repo, automations: automationRepository, bootstrap,
    automationActivationEnabled: true, authenticate: async request => request.headers.authorization === "Bearer owner"
      ? { userId: owner } : request.headers.authorization === "Bearer other" ? { userId: owner + "-other" } : null });
  try {
    const receiptUrl = `/api/automations/${combinedRule.automation_id}/bootstrap/${combined[0].bootstrap_id}`;
    for (const url of [receiptUrl, receiptUrl + "/members", receiptUrl + "/progress", `/api/automations/${combinedRule.automation_id}/bootstrap`]) {
      assert.equal((await bootstrapApp.inject({ url })).statusCode, 401);
      assert.equal((await bootstrapApp.inject({ url, headers: { authorization: "Bearer other" } })).statusCode, 404);
      assert.equal((await bootstrapApp.inject({ url, headers: { authorization: "Bearer owner" } })).statusCode, 200);
    }
    const cancelUrl = `/api/automations/${rule}/bootstrap/${repeat.bootstrap_id}/cancel`;
    assert.equal((await bootstrapApp.inject({ method: "POST", url: cancelUrl })).statusCode, 401);
    assert.equal((await bootstrapApp.inject({ method: "POST", url: cancelUrl, headers: { authorization: "Bearer other" } })).statusCode, 404);
    const canceled = await bootstrapApp.inject({ method: "POST", url: cancelUrl, headers: { authorization: "Bearer owner" } });
    assert.equal(canceled.statusCode, 200);
    assert.equal(canceled.json().status, "canceled");
    const [canceledGroup] = await db.select().from(s.automationBootstrapGroupTable).where(eq(s.automationBootstrapGroupTable.bootstrapId, repeat.bootstrap_id));
    assert.equal(canceledGroup.status, "canceled");
    const previewUrl = `/api/automations/${combinedRule.automation_id}/bootstrap/preview`;
    const previewPayload = { ...previewInput, expected_version: 1 };
    assert.equal((await bootstrapApp.inject({ method: "POST", url: previewUrl, payload: previewPayload })).statusCode, 401);
    assert.equal((await bootstrapApp.inject({ method: "POST", url: previewUrl, payload: previewPayload, headers: { authorization: "Bearer other" } })).statusCode, 404);
    const previewResponse = await bootstrapApp.inject({ method: "POST", url: previewUrl, payload: previewPayload, headers: { authorization: "Bearer owner" } });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.json().member_count, 0);
    const combinedUrl = `/api/automations/${combinedRule.automation_id}/activate-and-bootstrap`;
    const payload = { activation, bootstrap: combinedRequest };
    assert.equal((await bootstrapApp.inject({ method: "POST", url: combinedUrl, payload })).statusCode, 401);
    assert.equal((await bootstrapApp.inject({ method: "POST", url: combinedUrl, payload, headers: { authorization: "Bearer other" } })).statusCode, 404);
    const response = await bootstrapApp.inject({ method: "POST", url: combinedUrl, payload, headers: { authorization: "Bearer owner" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().bootstrap_id, combined[0].bootstrap_id);
    assert.equal((await bootstrapApp.inject({ method: "POST", url: combinedUrl, payload: { ...payload, owner: "other" }, headers: { authorization: "Bearer owner" } })).statusCode, 400);
  } finally { await bootstrapApp.close(); }
  const disabledApp = Fastify();
  await registerPersonalDataRoutes(disabledApp, { repository: repo, automations: automationRepository, bootstrap,
    authenticate: async () => ({ userId: owner }) });
  try {
    for (const suffix of ["bootstrap", "activate-and-bootstrap"]) {
      const response = await disabledApp.inject({ method: "POST", url: `/api/automations/${combinedRule.automation_id}/${suffix}`, payload: {} });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, "automation_activation_unavailable");
    }
  } finally { await disabledApp.close(); }
  const bootstrapAdmission = new BootstrapAdmission(db);
  assert.equal(await bootstrapAdmission.admitNext(owner + "-other"), false);
  for (let attempt = 0; attempt < 20; attempt++) {
    const work = await Promise.all([bootstrapAdmission.admitNext(owner), new BootstrapAdmission(db).admitNext(owner)]);
    if (!work.some(Boolean)) break;
  }
  const admittedGroups = await db.select().from(s.automationBootstrapGroupTable).where(eq(s.automationBootstrapGroupTable.createdByUserId, owner));
  assert.equal(admittedGroups.filter(group => group.status === "admitted").length, 1);
  const admittedGroup = admittedGroups.find(group => group.bootstrapId === combined[0].bootstrap_id)!;
  assert.equal(admittedGroup.status, "admitted");
  assert.ok(admittedGroups.some(group => group.outcomeCode === "daily_work_limit"), "live and bootstrap admissions share the rule budget");
  const [bootstrapInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, admittedGroup.invocationId!));
  assert.equal(bootstrapInvocation.model, ruleDefinition.model);
  assert.equal(bootstrapInvocation.origin, "automation");
  const [bootstrapInput] = await db.select().from(s.messageTable).where(eq(s.messageTable.messageId, bootstrapInvocation.inputMessageId));
  assert.equal(bootstrapInput.metadata?.bootstrap_id, combined[0].bootstrap_id);
  assert.match(bootstrapInput.content, /Explicit processing of existing contacts/);
  assert.equal((await db.select().from(s.threadTable).where(eq(s.threadTable.createdByUserId, owner))).length, 2, "concurrent group retries allocate one thread");
  assert.equal(await checkAutomationPolicy(bootstrapInvocation, true, db), "ready");
  await assert.rejects(checkAutomationPolicy({ ...bootstrapInvocation, model: "foreign-model" }, true, db), /automation_target_changed/);
  await assert.rejects(checkAutomationPolicy({ ...bootstrapInvocation, createdByUserId: owner + "-other" }, true, db), /automation_authority_lost/);
  const bootstrapLease = await invocationRepository.claim("bootstrap-policy-fixture", owner);
  assert.equal(bootstrapLease?.id, bootstrapInvocation.id);
  assert.ok(bootstrapLease);
  await db.update(s.automationTable).set({ state: "paused" }).where(eq(s.automationTable.id, combinedRule.automation_id));
  assert.equal(await checkAutomationPolicy(bootstrapLease, true, db), "retry_wait");
  await assert.rejects(invocationRepository.start(bootstrapLease), /automation_paused/);
  await db.update(s.automationTable).set({ state: "enabled" }).where(eq(s.automationTable.id, combinedRule.automation_id));
  await invocationRepository.start(bootstrapLease);
  const bootstrapCeiling = await loadAutomationDataCeiling(bootstrapLease.threadId, owner, bootstrapLease.turnId, db);
  assert.deepEqual(bootstrapCeiling?.scopes, ["contacts.read"]);
  assert.equal(bootstrapCeiling?.historyDays, 90);
  assert.ok(bootstrapCeiling?.binding.includes(combinedRule.automation_id));
  await db.update(s.automationBootstrapTable).set({ status: "canceled" }).where(eq(s.automationBootstrapTable.id, combined[0].bootstrap_id));
  await assert.rejects(checkAutomationPolicy(bootstrapLease, false, db), /automation_authority_lost/);
  await db.update(s.automationBootstrapTable).set({ status: "pending" }).where(eq(s.automationBootstrapTable.id, combined[0].bootstrap_id));
  const pendingPause = await automationRepository.pause(owner, combinedRule.automation_id,
    { expected_version: 1, cancel_pending: true, cancel_active: false });
  assert.equal(pendingPause.cancellation_requests, 0, "queued-only pause preserves started bootstrap work");
  assert.equal(await checkAutomationPolicy(bootstrapLease, false, db), "ready");
  const oldRuleVersion = (await automationRepository.get(owner, rule)).version;
  await automationRepository.pause(owner, rule, { expected_version: oldRuleVersion, cancel_pending: true, cancel_active: false });
  const pausedGroups = await db.select().from(s.automationBootstrapGroupTable).where(eq(s.automationBootstrapGroupTable.bootstrapId, snapshots[0].bootstrap_id));
  assert.equal(pausedGroups[0].status, "canceled", "queued bootstrap groups follow rule cancellation");
  const activePause = await automationRepository.pause(owner, combinedRule.automation_id,
    { expected_version: pendingPause.version, cancel_pending: false, cancel_active: true });
  assert.equal(activePause.cancellation_requests, 1, "active rule cancellation includes bootstrap invocations");
  await db.update(s.agentDataGrantTable).set({ version: 1, scopes: [] }).where(eq(s.agentDataGrantTable.createdByUserId, owner));
  await assert.rejects(checkAutomationPolicy(admitted[0], false, db), /data_permission_changed/);
  await assert.rejects(checkAutomationPolicy(bootstrapLease, false, db), /data_permission_changed/);
  await assert.rejects(loadAutomationDataCeiling(bootstrapLease.threadId, owner, bootstrapLease.turnId, db), { code: "automation_not_running" });
  await assert.rejects(bootstrap.cancel(owner + "-other", combinedRule.automation_id, combined[0].bootstrap_id), { code: "bootstrap_not_found" });
  const canceledBootstrap = await bootstrap.cancel(owner, combinedRule.automation_id, combined[0].bootstrap_id);
  assert.equal(canceledBootstrap.status, "canceled");
  const [cancelingBootstrap] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, bootstrapLease.id));
  assert.equal(cancelingBootstrap.status, "running");
  assert.equal(cancelingBootstrap.reservesThread, true);
  assert.equal(cancelingBootstrap.canceledByUserId, owner);
  assert.deepEqual(await bootstrap.cancel(owner, combinedRule.automation_id, combined[0].bootstrap_id), canceledBootstrap);
  const cancelProgress = await bootstrap.progress(owner, combinedRule.automation_id, combined[0].bootstrap_id);
  assert.equal(cancelProgress.request_status, "canceled");
  assert.equal(cancelProgress.settled, false, "requested cancellation is not settled execution");
  assert.equal(cancelProgress.items[0].status, "running");
  assert.ok(cancelProgress.items[0].cancel_requested_at);
  assert.equal(cancelProgress.items[0].thread_id, bootstrapLease.threadId);
  await invocationRepository.finish(bootstrapLease, "failed", "data_permission_changed");
  const [finishedBootstrap] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, bootstrapLease.id));
  assert.equal(finishedBootstrap.status, "canceled");
  assert.equal(finishedBootstrap.reservesThread, false);
  const settledProgress = await bootstrap.progress(owner, combinedRule.automation_id, combined[0].bootstrap_id);
  assert.equal(settledProgress.settled, true);
  assert.deepEqual(settledProgress.counts, { canceled: 1 });
  await db.update(s.automationDeliveryTable).set({ status: "pending", nextAttemptAt: new Date(0) }).where(eq(s.automationDeliveryTable.id, capped.id));
  await admission.admitNext(owner);
  const [denied] = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.id, capped.id));
  assert.equal(denied.status, "failed");
  assert.equal(denied.outcomeCode, "data_permission_changed");
  assert.equal((await db.select().from(s.threadTable).where(eq(s.threadTable.createdByUserId, owner))).length, 2);
  await db.update(s.agentDataGrantTable).set({ version: 0, scopes: ["contacts.read"] }).where(eq(s.agentDataGrantTable.createdByUserId, owner));
  const afterCancellationPreview = await bootstrap.preview(owner, combinedRule.automation_id,
    { ...previewInput, expected_version: activePause.version, max_contacts: 100 });
  assert.equal(afterCancellationPreview.member_count, 1,
    "canceling a request must not make its already-admitted contacts eligible for default rerun");
  const scheduledRule = await automationRepository.create(owner, { ...ruleDefinition, name: "Scheduled fixture" });
  await automationRepository.activate(owner, scheduledRule.automation_id,
    { expected_version: 0, expected_grant_version: 0, acknowledge_standing_work: true });
  await upload(makeScan(8, "h"));
  assert.equal(await processor.publishNext(false, owner), true);
  let signal!: () => void;
  const delivered = new Promise<void>(resolve => { signal = resolve; });
  const pollingErrors: string[] = [];
  const scheduledWorker = new AutomationWorker({
    matchNext: () => matcher.matchNext(owner),
    admitLive: async () => {
      const progressed = await admission.admitNext(owner);
      const [delivery] = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, scheduledRule.automation_id));
      if (delivery?.invocationId) signal();
      return progressed;
    },
    admitBootstrap: () => bootstrapAdmission.admitNext(owner),
  }, code => pollingErrors.push(code), 25, 5);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  scheduledWorker.start();
  try {
    await Promise.race([delivered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("published event was not admitted")), 3000); })]);
  } finally { clearTimeout(deadline); await scheduledWorker.stop(); }
  assert.deepEqual(pollingErrors, []);
  const [scheduledDelivery] = await db.select().from(s.automationDeliveryTable).where(eq(s.automationDeliveryTable.automationId, scheduledRule.automation_id));
  assert.equal(scheduledDelivery.status, "admitted");
  const [scheduledInvocation] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, scheduledDelivery.invocationId!));
  assert.equal(scheduledInvocation.createdByUserId, owner);
  assert.equal(scheduledInvocation.model, ruleDefinition.model);

});
