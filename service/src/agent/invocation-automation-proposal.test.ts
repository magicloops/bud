import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AutomationProposals, AUTOMATION_PROPOSAL_TOOL } from "../personal-data/automation-proposals.js";
import { Automations } from "../personal-data/automations.js";
import { DataGrants } from "../personal-data/grants.js";
import { InvocationRepository } from "./invocation-repository.js";
import { AutomationManagement } from "../personal-data/automation-management.js";

test("automation review parks atomically and resumes the same invocation with one durable result", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const isolated = "proposal_replay_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${isolated},public` });
  const db = drizzle(pool, { schema });
  const owner = "proposal-replay-" + randomUUID(), bud = "bud-" + randomUUID();
  try {
    await pool.query(`create schema "${isolated}"`);
    // Clone indexes/defaults but not FKs; migration tests separately exercise FK
    // invariants. Every public table is isolated from the live service worker.
    const tables = await pool.query("select tablename from pg_tables where schemaname='public'");
    for (const { tablename } of tables.rows) {
      assert.match(tablename, /^[a-zA-Z0-9_]+$/);
      await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
    }
    await db.insert(schema.budTable).values({ budId: bud, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
    const repo = new InvocationRepository(db), proposals = new AutomationProposals(db), rules = new Automations(db);
    await new DataGrants(db).update(owner, { version: 0, scopes: ["contacts.read"], history_days: 30 });
    const definition = { event_type: "contact.added", name: "Fixture", instruction: "Read evidence", sources: { source_ids: [] },
      bud_id: bud, model: "gpt-5.4", reasoning_effort: "low", target: { mode: "new_thread" },
      data_access: { scopes: ["contacts.read"], history_days: 30 }, latest_start_seconds: 86400, max_invocations_per_day: 5 };
    const setup = async () => {
      const thread = randomUUID();
      await db.insert(schema.threadTable).values({ threadId: thread, budId: bud, createdByUserId: owner });
      await repo.admit({ owner, threadId: thread, origin: "human", idempotencyKey: thread,
        text: "Create automation", model: "gpt-5.4", reasoningEffort: "low" });
      const lease = await repo.claim("fixture", owner); assert.ok(lease);
      await repo.start(lease);
      const rule = await rules.create(owner, definition);
      const input = { automation_id: rule.automation_id, expected_version: 0 };
      const callId = randomUUID(), clientId = randomUUID(), providerId = randomUUID();
      await repo.recordAction(lease, callId, AUTOMATION_PROPOSAL_TOOL);
      await db.insert(schema.llmCallTable).values({ llmCallId: providerId, threadId: thread, turnId: lease.turnId,
        stepIndex: 0, provider: "openai", model: "gpt-5.4", requestMode: "openai_responses", createdByUserId: owner });
      await db.insert(schema.llmCallItemTable).values([
        { id: callId, name: AUTOMATION_PROPOSAL_TOOL, input },
        { id: "later-" + callId, name: "terminal_send", input: { text: "echo reconsider" } },
      ].map((block, sequence) => ({ llmCallItemId: randomUUID(), llmCallId: providerId, threadId: thread,
        direction: "output", kind: "tool_use", sequence, toolCallId: block.id,
        canonicalPayload: { type: "tool_use", ...block }, createdByUserId: owner })));
      return { thread, lease, input, callId, clientId };
    };
    const first = await setup();
    const management = new AutomationManagement(db);
    const managementContext = { owner, invocationId: first.lease.id, workerId: first.lease.workerId!, fence: first.lease.fence, callId: "create-draft" };
    const draftInput = { name: "Agent draft", instruction: "Review this contact" };
    await assert.rejects(management.mutate(managementContext, "automations_create_draft", draftInput), /current management tool intent/);
    await repo.recordAction(first.lease, managementContext.callId, "automations_create_draft");
    const drafts = await Promise.all([management.mutate(managementContext, "automations_create_draft", draftInput),
      management.mutate(managementContext, "automations_create_draft", draftInput)]);
    assert.deepEqual(drafts[0], drafts[1]);
    const draft = drafts[0].draft as Record<string, unknown>;
    assert.equal(draft.bud_id, bud);
    assert.equal(draft.model, "gpt-5.4");
    assert.equal(draft.reasoning_effort, "low");
    assert.deepEqual(draft.target, { mode: "existing_thread", thread_id: first.thread });
    assert.deepEqual(draft.data_access, { scopes: ["contacts.read"], history_days: 30 });
    assert.equal(drafts[0].active_revision, null);
    await assert.rejects(management.mutate(managementContext, "automations_create_draft", { ...draftInput, name: "Changed retry" }), /different arguments/);
    await assert.rejects(management.mutate({ ...managementContext, fence: 0 }, "automations_create_draft", draftInput), /no longer owns/);
    await db.update(schema.agentInvocationTable).set({ origin: "automation" }).where(eq(schema.agentInvocationTable.id, first.lease.id));
    await assert.rejects(management.mutate(managementContext, "automations_create_draft", draftInput), /cannot manage standing work/);
    await db.update(schema.agentInvocationTable).set({ origin: "human" }).where(eq(schema.agentInvocationTable.id, first.lease.id));
    await repo.completeAction(first.lease, managementContext.callId, { message_id: "fixture" });
    const otherThread = randomUUID();
    await db.insert(schema.threadTable).values({ threadId: otherThread, budId: bud, createdByUserId: owner });
    for (const [callId, target, expected] of [
      ["null-target", null, { mode: "existing_thread", thread_id: first.thread }],
      ["new-target", { mode: "new_thread" }, { mode: "new_thread" }],
      ["other-target", { mode: "existing_thread", thread_id: otherThread }, { mode: "existing_thread", thread_id: otherThread }],
    ] as const) {
      await repo.recordAction(first.lease, callId, "automations_create_draft");
      const context = { ...managementContext, callId };
      const input = { ...draftInput, target, model: null, reasoning_effort: null };
      const created = await management.mutate(context, "automations_create_draft", input);
      assert.deepEqual((created.draft as Record<string, unknown>).target, expected);
      assert.equal((created.draft as Record<string, unknown>).model, "gpt-5.4");
      assert.equal((created.draft as Record<string, unknown>).reasoning_effort, "low");
      assert.equal(created.active_revision, null);
      assert.deepEqual(await management.mutate(context, "automations_create_draft", input), created);
      await repo.completeAction(first.lease, callId, { message_id: "fixture" });
    }
    // Isolated schema has no FKs: insert a foreign-owner row that even targets
    // this thread, ensuring list SQL filters ownership rather than just target.
    await db.insert(schema.automationTable).values({ id: "foreign-rule", createdByUserId: "foreign-owner", updatedByUserId: "foreign-owner",
      draft: { ...definition, target: { mode: "existing_thread", thread_id: first.thread } } });
    await repo.recordAction(first.lease, "list-scope", "automations_list");
    const listContext = { ...managementContext, callId: "list-scope" };
    for (const input of [{}, { scope: null }, { scope: "thread" }]) {
      const result = await management.read(listContext, "automations_list", input);
      assert.equal(result.scope, "thread");
      const items = result.items as Array<{ draft: { target: { thread_id?: string } } }>;
      assert.equal(items.length, 2);
      assert.ok(items.every(item => item.draft.target.thread_id === first.thread));
    }
    const all = await management.read(listContext, "automations_list", { scope: "all" });
    assert.equal(all.scope, "all");
    assert.equal((all.items as unknown[]).length, 5);
    await assert.rejects(management.read(listContext, "automations_list", { scope: "foreign" }), /tool arguments/);
    await assert.rejects(management.read(listContext, "automations_list", { thread_id: otherThread }), /tool arguments/);
    await assert.rejects(management.read({ ...listContext, owner: "foreign" }, "automations_list", { scope: "all" }), /no longer owns/);
    await repo.completeAction(first.lease, "list-scope", { message_id: "fixture" });
    assert.deepEqual((await rules.get(owner, first.input.automation_id)).draft.target, { mode: "new_thread" });
    await repo.recordAction(first.lease, "invalid-reasoning", "automations_create_draft");
    const beforeInvalid = (await rules.list(owner)).items.length;
    await assert.rejects(management.mutate({ ...managementContext, callId: "invalid-reasoning" },
      "automations_create_draft", { ...draftInput, reasoning_effort: "minimal" }),
      /model=gpt-5.4, reasoning_effort=minimal.*Omit model and reasoning_effort.*model=gpt-5.4, reasoning_effort=low/);
    assert.equal((await rules.list(owner)).items.length, beforeInvalid);
    await repo.completeAction(first.lease, "invalid-reasoning", { validation_failed: true });
    await repo.recordAction(first.lease, "edit-draft", "automations_update_draft");
    const edit = { automation_id: drafts[0].automation_id, expected_version: 0, definition: { ...draft, name: "Edited by agent" } };
    const edited = await management.mutate({ ...managementContext, callId: "edit-draft" }, "automations_update_draft", edit);
    assert.equal(edited.version, 1);
    assert.deepEqual(await management.mutate({ ...managementContext, callId: "edit-draft" }, "automations_update_draft", edit), edited);
    await repo.completeAction(first.lease, "edit-draft", { message_id: "fixture" });
    await repo.recordAction(first.lease, "pause-draft", "automations_pause");
    const pause = { automation_id: drafts[0].automation_id, expected_version: 1, cancel_pending: true, cancel_active: false };
    const paused = await management.mutate({ ...managementContext, callId: "pause-draft" }, "automations_pause", pause);
    assert.equal(paused.state, "paused");
    assert.equal(paused.version, 2);
    assert.deepEqual(await management.mutate({ ...managementContext, callId: "pause-draft" }, "automations_pause", pause), paused);
    await repo.completeAction(first.lease, "pause-draft", { message_id: "fixture" });
    await repo.recordAction(first.lease, "read-rule", "automations_get");
    const readContext = { ...managementContext, callId: "read-rule" };
    const readResult = await management.read(readContext, "automations_get", { automation_id: drafts[0].automation_id });
    assert.equal(readResult.state, "paused");
    await assert.rejects(management.read({ ...readContext, owner: "foreign" }, "automations_get", { automation_id: drafts[0].automation_id }), /no longer owns/);
    await assert.rejects(management.read({ ...readContext, callId: "unrecorded" }, "automations_get", { automation_id: drafts[0].automation_id }), /no longer owns/);
    await repo.completeAction(first.lease, "read-rule", { message_id: "fixture" });
    await assert.rejects(management.read(readContext, "automations_get", { automation_id: drafts[0].automation_id }), /no longer owns/);
    const failing = Object.create(db) as typeof db;
    failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => db.transaction(async tx => work(new Proxy(tx, {
      get(target, name) {
        if (name === "update") return (table: unknown) => {
          if (table === schema.agentInvocationActionTable) throw new Error("injected parking failure");
          return target.update(table as typeof schema.agentInvocationTable);
        };
        const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
      },
    })))) as typeof db.transaction;
    await repo.recordAction(first.lease, "receipt-rollback", "automations_create_draft");
    const beforeRollback = (await rules.list(owner)).items.length;
    await assert.rejects(new AutomationManagement(failing).mutate({ ...managementContext, callId: "receipt-rollback" },
      "automations_create_draft", draftInput), /injected parking failure/);
    assert.equal((await rules.list(owner)).items.length, beforeRollback, "rule creation rolls back if its receipt cannot persist");
    await repo.completeAction(first.lease, "receipt-rollback", { test_injected_failure: true });
    await assert.rejects(new InvocationRepository(failing).parkAutomationProposal(first.lease, first.callId, first.clientId, first.input), /injected parking failure/);
    assert.deepEqual((await proposals.list(owner)).items, []);
    const pending = await repo.parkAutomationProposal(first.lease, first.callId, first.clientId, first.input);
    const recovered = await new InvocationRepository(db).pendingAutomationProposalsForThread(owner, first.thread);
    assert.equal(recovered[0].client_id, first.clientId);
    assert.deepEqual(recovered[0].proposal, pending);
    assert.deepEqual(await repo.pendingAutomationProposalsForThread("foreign", first.thread), []);
    await assert.rejects(repo.heartbeat(first.lease), /lease_lost/);
    assert.equal(await repo.claim("still-pending", owner), null);
    await proposals.decide(owner, pending.proposal_id, { decision: "approve", expected_version: 0, idempotency_key: "approve" });
    assert.deepEqual(await repo.pendingAutomationProposalsForThread(owner, first.thread), []);
    await db.update(schema.agentInvocationTable).set({ latestStartAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, first.lease.id));
    const resumed = await new InvocationRepository(db).claim("resumed", owner); assert.ok(resumed);
    assert.equal(resumed.id, first.lease.id); assert.equal(resumed.turnId, first.lease.turnId);
    await repo.defer(resumed, "waiting_for_model", 1);
    const [waiting] = await db.select().from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.id, resumed.id));
    assert.equal(waiting.reservesThread, true);
    await db.update(schema.agentInvocationTable).set({ nextAttemptAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, resumed.id));
    const ready = await repo.claim("ready", owner); assert.ok(ready);
    await repo.start(ready);
    const restored = await repo.prepareQuestionContinuation(ready);
    assert.equal(restored.length, 2);
    assert.equal(restored[0].clientId, first.clientId);
    assert.equal(JSON.parse(restored[0].content).proposal.activated_revision, 1);
    assert.equal(JSON.parse(restored[0].content).ok, true);
    assert.match(restored[1].content, /not_executed_due_to_automation_review/);
    assert.deepEqual(await repo.prepareQuestionContinuation(ready), []);
    const ledger = await db.select().from(schema.llmCallItemTable).where(eq(schema.llmCallItemTable.threadId, first.thread));
    assert.equal(ledger.filter(item => item.direction === "input" && item.toolCallId === first.callId).length, 1);
    assert.equal(ledger.find(item => item.direction === "input" && item.toolCallId === first.callId)?.text, restored[0].content);
    await repo.finish(ready, "succeeded", "completed");
    for (const outcome of ["decline", "expire", "cancel", "stale"] as const) {
      const next = await setup();
      const proposal = await repo.parkAutomationProposal(next.lease, next.callId, next.clientId, next.input);
      if (outcome === "decline") await proposals.decide(owner, proposal.proposal_id, { decision: "decline", expected_version: 0, idempotency_key: outcome });
      if (outcome === "expire") await new AutomationProposals(db, () => new Date(Date.now() + 2 * 86400_000)).expireNext(owner);
      if (outcome === "stale") {
        await rules.update(owner, proposal.automation_id, { expected_version: 0, definition: { ...definition, name: "Changed" } });
        assert.equal((await proposals.get(owner, proposal.proposal_id)).status, "stale");
      }
      if (outcome === "cancel") {
        await repo.requestCancel(owner, next.lease.id);
        assert.equal((await proposals.get(owner, proposal.proposal_id)).status, "canceled");
        assert.equal(await repo.claim("canceled", owner), null);
        continue;
      }
      const continuation = await repo.claim("decision", owner); assert.ok(continuation);
      await repo.start(continuation);
      const messages = await repo.prepareQuestionContinuation(continuation);
      assert.equal(JSON.parse(messages[0].content).ok, false);
      assert.equal(JSON.parse(messages[0].content).proposal.activated_revision, null);
      await repo.finish(continuation, "succeeded", "completed");
    }
  } finally {
    await pool.query(`drop schema if exists "${isolated}" cascade`);
    await pool.end(); await defaultPool.end();
  }
});
