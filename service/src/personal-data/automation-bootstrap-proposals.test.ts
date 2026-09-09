import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { AutomationBootstrapProposals, BOOTSTRAP_PROPOSAL_TOOL } from "./automation-bootstrap-proposals.js";
import { Automations } from "./automations.js";
import { DataGrants } from "./grants.js";
import { PostgresIngestRepository } from "./repository.js";
import { ContactProcessor } from "./contact-processor.js";
import { parseBatch } from "./parser.js";
import { contactManifestDigest } from "./contacts.js";
import { InvocationRepository } from "../agent/invocation-repository.js";

test("existing-contact proposals capture once, preserve decisions and roll back failed approval", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `bootstrap_proposals_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 6 });
  try {
    await admin.query(`create schema ${namespace}`);
    // Isolate all work from the running development workers. FK enforcement is
    // covered by the generated-migration fixture, not these indexed table copies.
    const tables = await admin.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      await admin.query(`create table ${namespace}.${quoted} (like public.${quoted} including all)`);
    }
    const db = drizzle(pool, { schema: s });
    const owner = "fixture-owner", budId = "fixture-bud", threadId = randomUUID(), invocationId = randomUUID();
    await db.insert(s.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
    await db.insert(s.threadTable).values({ threadId, budId, createdByUserId: owner });
    const [message] = await db.insert(s.messageTable).values({ threadId, clientId: randomUUID(), role: "user", content: "Review existing contacts", createdByUserId: owner }).returning();
    await db.insert(s.agentInvocationTable).values({ id: invocationId, turnId: randomUUID(), threadId, budId, inputMessageId: message.messageId,
      origin: "human", idempotencyKey: "request", model: "gpt-5.6-luna", reasoningEffort: "low", status: "running", reservesThread: true,
      workerId: "fixture", fence: 1, leaseExpiresAt: new Date(Date.now() + 3600000), createdByUserId: owner });
    await new DataGrants(db).update(owner, { version: 0, scopes: ["contacts.read"], history_days: 30 });
    const automations = new Automations(db);
    const rule = await automations.create(owner, { event_type: "contact.added", name: "Existing", instruction: "Read contacts",
      sources: { source_ids: [] }, bud_id: budId, model: "gpt-5.6-luna", reasoning_effort: "low", target: { mode: "new_thread" },
      data_access: { scopes: ["contacts.read"], history_days: 30 }, latest_start_seconds: 86400, max_invocations_per_day: 5 });
    await automations.activate(owner, rule.automation_id, { expected_version: 0, expected_grant_version: 1, acknowledge_standing_work: true });
    const repo = new AutomationBootstrapProposals(db);
    const selection = { automation_id: rule.automation_id, expected_version: 1, sources: { source_ids: [] },
      search: "", max_contacts: 10, mode: "batched", exclude_previously_delivered: true };
    const intent = async (callId: string) => {
      await db.insert(s.agentInvocationActionTable).values({ id: randomUUID(), invocationId, callId, fence: 1,
        kind: BOOTSTRAP_PROPOSAL_TOOL, status: "intent", createdByUserId: owner });
      return { owner, invocationId, callId, workerId: "fixture", fence: 1 };
    };
    assert.equal((await repo.request(await intent("empty"), selection)).kind, "no_work");
    assert.equal((await db.select().from(s.automationBootstrapProposalTable)).length, 0);
    const installationId = randomUUID(), recordId = randomUUID(), now = new Date().toISOString();
    const common = { payload_version: 1, contact_store_id: randomUUID(), scan_id: randomUUID(), generation: 1, previous_generation: 0,
      scan_mode: "baseline", observed_at: now, previous_observed_at: null, time_basis: "observed", authorization: "3" };
    const envelope = (event_type: string, event_id: string, payload: object) => ({ schema_version: 1, event_type, event_id,
      occurred_at: now, recorded_at: now, actor: { user_id: owner, installation_id: installationId }, payload });
    const events = [envelope("contacts.record.v1", recordId, { ...common, source_contact_id: "Ada", change: "upsert", newly_observed: false,
      contact: { given_name: "Ada", family_name: "", organization: "", phones: [], emails: [] } }),
      envelope("contacts.scan.v1", randomUUID(), { ...common, expected_event_count: 1, event_ids_sha256: contactManifestDigest([recordId]) })];
    const context = { userId: owner, installationId, collectionEpoch: "legacy", batchId: randomUUID() };
    await new PostgresIngestRepository(db).persist(context, await parseBatch(Buffer.from(events.map(value => JSON.stringify(value)).join("\n")), "", context));
    const processor = new ContactProcessor(db);
    while (await processor.processNext(owner)) { /* fixture only */ }
    assert.equal(await processor.publishNext(false, owner), true);
    const requestContext = await intent("review");
    await assert.rejects(repo.request({ ...requestContext, fence: 0 }, selection), { code: "invocation_unavailable" });
    await assert.rejects(repo.request({ ...requestContext, callId: "missing" }, selection), { code: "bootstrap_proposal_intent_required" });
    await db.update(s.agentInvocationTable).set({ origin: "automation" }).where(eq(s.agentInvocationTable.id, invocationId));
    await assert.rejects(repo.request(requestContext, selection), { code: "automation_management_origin_denied" });
    await db.update(s.agentInvocationTable).set({ origin: "human" }).where(eq(s.agentInvocationTable.id, invocationId));
    const [a, b] = await Promise.all([repo.request(requestContext, selection), repo.request(requestContext, selection)]);
    assert.equal(a.kind, "proposal"); assert.equal(b.kind, "proposal");
    if (a.kind !== "proposal" || b.kind !== "proposal") throw new Error("missing_review");
    assert.equal(a.proposal.proposal_id, b.proposal.proposal_id);
    assert.equal(a.proposal.member_count, 1);
    await assert.rejects(repo.get("other", a.proposal.proposal_id), { code: "bootstrap_proposal_not_found" });
    const decision = { decision: "approve", expected_version: 0, idempotency_key: "approve" };
    const [approved, duplicate] = await Promise.all([repo.decide(owner, a.proposal.proposal_id, decision), repo.decide(owner, a.proposal.proposal_id, decision)]);
    assert.equal(approved.status, "approved"); assert.deepEqual(approved, duplicate);
    assert.deepEqual(await new AutomationBootstrapProposals(db).decide(owner, a.proposal.proposal_id, decision), approved);
    assert.equal((await db.select().from(s.automationBootstrapTable)).length, 1);
    assert.equal((await db.select().from(s.automationRevisionTable)).length, 1, "processing does not activate another revision");
    await assert.rejects(repo.decide(owner, a.proposal.proposal_id, { ...decision, decision: "decline" }), { code: "bootstrap_proposal_conflict" });
    assert.equal((await repo.request(await intent("excluded"), selection)).kind, "no_work");
    const repeated = { ...selection, exclude_previously_delivered: false };
    const makeReview = async (callId: string) => {
      const result = await repo.request(await intent(callId), repeated);
      if (result.kind !== "proposal") throw new Error("missing_review");
      return result.proposal;
    };
    const declined = await makeReview("decline");
    assert.equal((await repo.decide(owner, declined.proposal_id, { ...decision, decision: "decline", idempotency_key: "decline" })).status, "declined");
    const canceled = await makeReview("cancel");
    assert.equal((await repo.cancel(owner, canceled.proposal_id, { expected_version: 0, idempotency_key: "cancel" })).status, "canceled");
    await assert.rejects(repo.decide(owner, canceled.proposal_id, decision), { code: "bootstrap_proposal_conflict" });
    const expired = await makeReview("expiry");
    assert.equal((await new AutomationBootstrapProposals(db, () => new Date(Date.now() + 2 * 86400000)).get(owner, expired.proposal_id)).status, "expired");
    const abandoned = await makeReview("abandoned");
    await db.update(s.agentInvocationActionTable).set({ status: "completed" }).where(eq(s.agentInvocationActionTable.callId, "abandoned"));
    assert.equal((await repo.get(owner, abandoned.proposal_id)).status, "canceled");
    assert.equal((await db.select().from(s.automationBootstrapTable)).length, 1, "non-approval outcomes start no work");
    const next = await repo.request(await intent("rollback"), repeated);
    if (next.kind !== "proposal") throw new Error("missing_repeat_review");
    const failing = Object.create(db) as typeof db;
    failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => db.transaction(tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "update") return (table: unknown) => {
          if (table === s.automationBootstrapProposalTable) throw new Error("fixture_decision_failure");
          return target.update(table as typeof s.automationTable);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })))) as typeof db.transaction;
    await assert.rejects(new AutomationBootstrapProposals(failing).decide(owner, next.proposal.proposal_id,
      { ...decision, idempotency_key: "rollback" }), /fixture_decision_failure/);
    assert.equal((await db.select().from(s.automationBootstrapTable)).length, 1);
    assert.equal((await repo.get(owner, next.proposal.proposal_id)).status, "pending");
    await db.update(s.contactTable).set({ visible: false });
    assert.equal((await repo.decide(owner, next.proposal.proposal_id, { ...decision, idempotency_key: "stale" })).status, "stale");
    assert.equal((await db.select().from(s.automationBootstrapTable)).length, 1);

    const invocations = new InvocationRepository(db);
    const [lease] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, invocationId));
    await intent("empty-park");
    assert.equal((await invocations.parkBootstrapProposal(lease, "empty-park", randomUUID(), selection)).kind, "no_work");
    await invocations.heartbeat(lease);
    await db.update(s.contactTable).set({ visible: true });
    const callId = "parked-review", clientId = randomUUID(), providerId = randomUUID();
    await intent(callId);
    await db.insert(s.llmCallTable).values({ llmCallId: providerId, threadId, turnId: lease.turnId,
      stepIndex: 0, provider: "openai", model: "gpt-5.6-luna", requestMode: "openai_responses", createdByUserId: owner });
    await db.insert(s.llmCallItemTable).values([
      { id: callId, name: BOOTSTRAP_PROPOSAL_TOOL, input: repeated },
      { id: "trailing", name: "terminal_run", input: { command: "echo deferred" } },
    ].map((block, sequence) => ({ llmCallItemId: randomUUID(), llmCallId: providerId, threadId,
      direction: "output", kind: "tool_use", sequence, toolCallId: block.id,
      canonicalPayload: { type: "tool_use", ...block }, createdByUserId: owner })));
    const failingPark = Object.create(db) as typeof db;
    failingPark.transaction = ((work: (tx: unknown) => Promise<unknown>) => db.transaction(tx => work(new Proxy(tx, {
      get(target, key) {
        if (key === "update") return (table: unknown) => {
          if (table === s.agentInvocationActionTable) throw new Error("fixture_parking_failure");
          return target.update(table as typeof s.automationTable);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })))) as typeof db.transaction;
    const beforePark = (await db.select().from(s.automationBootstrapProposalTable)).length;
    await assert.rejects(new InvocationRepository(failingPark).parkBootstrapProposal(lease, callId, clientId, repeated), /fixture_parking_failure/);
    assert.equal((await db.select().from(s.automationBootstrapProposalTable)).length, beforePark);
    await invocations.heartbeat(lease);
    const parked = await invocations.parkBootstrapProposal(lease, callId, clientId, repeated);
    if (parked.kind !== "proposal") throw new Error("missing_parked_review");
    assert.equal((await repo.get(owner, parked.proposal.proposal_id)).status, "pending", "parking preserves action/fence authority");
    const recovered = await new InvocationRepository(db).pendingBootstrapProposalsForThread(owner, threadId);
    assert.equal(recovered[0].client_id, clientId);
    assert.deepEqual(recovered[0].proposal, parked.proposal);
    assert.deepEqual(await invocations.pendingBootstrapProposalsForThread("other", threadId), []);
    await assert.rejects(invocations.heartbeat(lease), /lease_lost/);
    assert.equal(await invocations.claim("pending", owner), null);
    await repo.decide(owner, parked.proposal.proposal_id, { ...decision, idempotency_key: "parked-approval" });
    assert.deepEqual(await invocations.pendingBootstrapProposalsForThread(owner, threadId), []);
    const resumed = await new InvocationRepository(db).claim("resumed", owner);
    assert.ok(resumed);
    assert.equal(resumed.id, lease.id); assert.equal(resumed.turnId, lease.turnId);
    await invocations.defer(resumed, "waiting_for_model", 1);
    const [waiting] = await db.select().from(s.agentInvocationTable).where(eq(s.agentInvocationTable.id, lease.id));
    assert.equal(waiting.reservesThread, true);
    await db.update(s.agentInvocationTable).set({ nextAttemptAt: new Date(0) }).where(eq(s.agentInvocationTable.id, lease.id));
    const ready = await invocations.claim("ready", owner); assert.ok(ready);
    await invocations.start(ready);
    const restored = await invocations.prepareQuestionContinuation(ready);
    assert.equal(restored.length, 2);
    assert.equal(restored[0].clientId, clientId);
    assert.equal(JSON.parse(restored[0].content).kind, "existing_contact_review");
    assert.equal(JSON.parse(restored[0].content).ok, true);
    assert.ok(JSON.parse(restored[0].content).proposal.bootstrap_id);
    assert.match(restored[1].content, /not_executed_due_to_automation_review/);
    assert.deepEqual(await invocations.prepareQuestionContinuation(ready), []);
    const ledger = await db.select().from(s.llmCallItemTable).where(eq(s.llmCallItemTable.toolCallId, callId));
    assert.equal(ledger.filter(item => item.direction === "input").length, 1);
    await invocations.recordAction(ready, "cancel-review", BOOTSTRAP_PROPOSAL_TOOL);
    const cancelPark = await invocations.parkBootstrapProposal(ready, "cancel-review", randomUUID(), repeated);
    if (cancelPark.kind !== "proposal") throw new Error("missing_cancel_review");
    await invocations.requestCancel(owner, ready.id);
    assert.equal((await repo.get(owner, cancelPark.proposal.proposal_id)).status, "canceled");
    await assert.rejects(repo.decide(owner, cancelPark.proposal.proposal_id,
      { ...decision, idempotency_key: "after-invocation-cancel" }), { code: "bootstrap_proposal_conflict" });
    assert.equal(await invocations.claim("canceled", owner), null);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists ${namespace} cascade`);
    await admin.end();
  }
});
