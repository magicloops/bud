import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AutomationProposals, AUTOMATION_PROPOSAL_TOOL } from "./automation-proposals.js";
import { Automations } from "./automations.js";
import { DataGrants } from "./grants.js";
import { DataRequestError } from "./contracts.js";

test("automation proposals freeze review, atomically activate once and reject stale or abandoned authority", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const db = drizzle(pool, { schema });
  const owners = ["proposal-" + randomUUID(), "proposal-" + randomUUID()];
  const buds = owners.map(() => "bud-" + randomUUID());
  const thread = randomUUID(), invocation = randomUUID();
  t.after(async () => {
    try {
      for (const table of [schema.automationProposalTable, schema.automationRevisionTable, schema.automationTable,
        schema.agentInvocationActionTable, schema.agentInvocationTable, schema.messageTable, schema.threadTable,
        schema.agentDataGrantTable, schema.dataOwnerStateTable, schema.budTable])
        await db.delete(table).where(inArray(table.createdByUserId, owners));
      await db.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
    } finally { await pool.end(); await defaultPool.end(); }
  });
  await db.insert(schema.authUserTable).values(owners.map(id => ({ id, name: "Fixture", email: id + "@example.invalid", emailVerified: false })));
  await db.insert(schema.budTable).values(owners.map((owner, i) => ({ budId: buds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: owner })));
  await db.insert(schema.threadTable).values({ threadId: thread, budId: buds[0], createdByUserId: owners[0] });
  const [message] = await db.insert(schema.messageTable).values({ threadId: thread, clientId: randomUUID(), role: "user", content: "Create automation", createdByUserId: owners[0] }).returning();
  await db.insert(schema.agentInvocationTable).values({ id: invocation, turnId: randomUUID(), threadId: thread, budId: buds[0], inputMessageId: message.messageId,
    origin: "human", idempotencyKey: "fixture", model: "gpt-5.6-luna", reasoningEffort: "low", status: "running", reservesThread: true,
    workerId: "proposal-test", fence: 1, leaseExpiresAt: new Date(Date.now() + 3600_000), createdByUserId: owners[0] });
  const repo = new AutomationProposals(db), automations = new Automations(db), grants = new DataGrants(db);
  await grants.update(owners[0], { version: 0, scopes: ["contacts.read"], history_days: 30 });
  const definition = { event_type: "contact.added", name: "Fixture", instruction: "Read evidence", sources: { source_ids: [] },
    bud_id: buds[0], model: "gpt-5.6-luna", reasoning_effort: "low", target: { mode: "new_thread" },
    data_access: { scopes: ["contacts.read"], history_days: 30 }, latest_start_seconds: 86400, max_invocations_per_day: 5 };
  const context = { owner: owners[0], invocationId: invocation, workerId: "proposal-test", fence: 1, callId: "first" };
  const code = (expected: string) => (error: unknown) => { assert.ok(error instanceof DataRequestError); assert.equal(error.code, expected); return true; };
  const intent = async (callId: string) => {
    await db.insert(schema.agentInvocationActionTable).values({ id: randomUUID(), invocationId: invocation, callId, fence: 1,
      kind: AUTOMATION_PROPOSAL_TOOL, status: "intent", createdByUserId: owners[0] });
    return { ...context, callId };
  };
  const make = async (callId: string) => {
    const rule = await automations.create(owners[0], definition);
    return repo.request(await intent(callId), { automation_id: rule.automation_id, expected_version: 0 });
  };
  const rule = await automations.create(owners[0], definition);
  const request = { automation_id: rule.automation_id, expected_version: 0 };
  await assert.rejects(repo.request(context, request), code("automation_proposal_intent_required"));
  await intent("first");
  await assert.rejects(repo.request({ ...context, fence: 0 }, request), code("invocation_unavailable"));
  await assert.rejects(repo.request({ ...context, owner: owners[1] }, request), code("automation_proposal_not_found"));
  await db.update(schema.agentInvocationTable).set({ origin: "automation" }).where(eq(schema.agentInvocationTable.id, invocation));
  await assert.rejects(repo.request(context, request), code("automation_management_origin_denied"));
  await db.update(schema.agentInvocationTable).set({ origin: "human" }).where(eq(schema.agentInvocationTable.id, invocation));
  const requested = await Promise.all([repo.request(context, request), repo.request(context, request)]);
  const pending = requested[0];
  assert.equal(pending.proposal_id, requested[1].proposal_id);
  assert.equal((await automations.get(owners[0], rule.automation_id)).active_revision, null);
  await assert.rejects(repo.request(context, { ...request, expected_version: 1 }), code("automation_proposal_conflict"));
  await assert.rejects(repo.get(owners[1], pending.proposal_id), code("automation_proposal_not_found"));
  assert.deepEqual((await repo.list(owners[1])).items, []);
  const decision = { decision: "approve", expected_version: 0, idempotency_key: "approve-first" };
  await assert.rejects(repo.decide(owners[1], pending.proposal_id, decision), code("automation_proposal_not_found"));
  const approved = await Promise.all([repo.decide(owners[0], pending.proposal_id, decision), repo.decide(owners[0], pending.proposal_id, decision)]);
  assert.equal(approved[0].status, "approved");
  assert.deepEqual(approved[0], approved[1]);
  assert.equal((await db.select().from(schema.automationRevisionTable).where(eq(schema.automationRevisionTable.automationId, rule.automation_id))).length, 1);
  assert.deepEqual(await new AutomationProposals(db).decide(owners[0], pending.proposal_id, decision), approved[0], "restart preserves decision receipt");
  await assert.rejects(repo.decide(owners[0], pending.proposal_id, { ...decision, decision: "decline" }), code("automation_proposal_conflict"));

  assert.equal((await repo.get(owners[0], pending.proposal_id)).review_operation, "create");
  const destination = randomUUID();
  await db.insert(schema.threadTable).values({ threadId: destination, budId: buds[0], createdByUserId: owners[0], title: "Other workflow" });
  await automations.update(owners[0], rule.automation_id, { expected_version: 1,
    definition: { ...definition, target: { mode: "existing_thread", thread_id: destination } } });
  const replacement = await repo.request(await intent("replacement"), { automation_id: rule.automation_id, expected_version: 2 });
  const review = await repo.get(owners[0], replacement.proposal_id);
  assert.equal(review.review_operation, "update");
  assert.equal(review.destination_thread_title, "Other workflow");
  const replaced = await repo.decide(owners[0], replacement.proposal_id, { ...decision, idempotency_key: "replace" });
  assert.equal(replaced.review_operation, "update");
  assert.equal((await repo.get(owners[0], pending.proposal_id)).review_operation, "create", "old review keeps its operation after later activations");
  const fresh = await automations.create(owners[0], definition);
  await automations.update(owners[0], fresh.automation_id, { expected_version: 0, definition });
  const editedFresh = await repo.request(await intent("edited-fresh"), { automation_id: fresh.automation_id, expected_version: 1 });
  assert.equal((await repo.get(owners[0], editedFresh.proposal_id)).review_operation, "create", "draft edits do not imply prior activation");
  await repo.cancel(owners[0], editedFresh.proposal_id, { expected_version: 0, idempotency_key: "cancel-edited-fresh" });

  const race = await make("race");
  const raceResults = await Promise.allSettled([repo.decide(owners[0], race.proposal_id, { ...decision, idempotency_key: "race-approve" }),
    repo.decide(owners[0], race.proposal_id, { ...decision, decision: "decline", idempotency_key: "race-decline" })]);
  assert.equal(raceResults.filter(result => result.status === "fulfilled").length, 1);
  const raceState = await repo.get(owners[0], race.proposal_id);
  assert.equal(!!(await automations.get(owners[0], race.automation_id)).active_revision, raceState.status === "approved");

  const edited = await make("edited");
  await automations.update(owners[0], edited.automation_id, { expected_version: 0, definition: { ...definition, instruction: "Changed" } });
  assert.equal((await repo.decide(owners[0], edited.proposal_id, { ...decision, idempotency_key: "edited" })).status, "stale");
  assert.equal((await automations.get(owners[0], edited.automation_id)).active_revision, null);
  const permissionChanged = await make("grant");
  await grants.update(owners[0], { version: 1, scopes: ["contacts.read"], history_days: 90 });
  assert.equal((await repo.get(owners[0], permissionChanged.proposal_id)).status, "stale");

  const cancel = await make("cancel");
  const cancellation = { expected_version: 0, idempotency_key: "cancel" };
  assert.equal((await repo.cancel(owners[0], cancel.proposal_id, cancellation)).status, "canceled");
  assert.equal((await repo.cancel(owners[0], cancel.proposal_id, cancellation)).status, "canceled");
  await assert.rejects(repo.decide(owners[0], cancel.proposal_id, { ...decision, idempotency_key: "after-cancel" }), code("automation_proposal_conflict"));

  const atomic = await make("rollback");
  const failing = Object.create(db) as typeof db;
  failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => work(new Proxy(tx, {
    get(target, name) {
      if (name === "update") return (table: unknown) => {
        if (table === schema.automationProposalTable) throw new Error("injected proposal write failure");
        return target.update(table as typeof schema.automationTable);
      };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })))) as typeof db.transaction;
  await assert.rejects(new AutomationProposals(failing).decide(owners[0], atomic.proposal_id, { ...decision, idempotency_key: "rollback" }), /injected proposal write failure/);
  assert.equal((await repo.get(owners[0], atomic.proposal_id)).status, "pending");
  assert.equal((await automations.get(owners[0], atomic.automation_id)).active_revision, null, "activation rolls back with decision failure");

  const expired = await make("expiry");
  const future = new AutomationProposals(db, () => new Date(Date.now() + 2 * 86400_000));
  assert.equal(await future.expireNext(owners[1]), false);
  assert.equal((await future.get(owners[0], expired.proposal_id)).status, "expired");
  const abandoned = await make("abandoned");
  await db.update(schema.agentInvocationTable).set({ cancelRequestedAt: new Date() }).where(eq(schema.agentInvocationTable.id, invocation));
  assert.equal((await repo.decide(owners[0], abandoned.proposal_id, { ...decision, idempotency_key: "abandoned" })).status, "canceled");
  const page = await repo.list(owners[0], { limit: 1 });
  assert.ok(page.next_cursor);
  await assert.rejects(repo.list(owners[1], { cursor: page.next_cursor }), code("invalid_automation_proposal_cursor"));
  await assert.rejects(repo.list(owners[0], { cursor: page.next_cursor, pending_only: true }), code("invalid_automation_proposal_cursor"));
  assert.notEqual((await repo.list(owners[0], { cursor: page.next_cursor, limit: 1 })).items[0].proposal_id, page.items[0].proposal_id);
  assert.deepEqual((await repo.list(owners[0], { pending_only: true })).items, []);
});
