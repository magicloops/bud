import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { GoogleApproval, GoogleApprovalProposal } from "../google/approvals.js";
import { InvocationRepository } from "./invocation-repository.js";

test("Google approvals park atomically, recover by owner, expire, and restore exactly once without executing", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const isolated = "google_approval_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${isolated},public` });
  const database = drizzle(pool, { schema });
  const owner = "google-approval-" + randomUUID(), budId = "bud-" + randomUUID();
  try {
    await pool.query(`create schema "${isolated}"`);
    for (const { tablename } of (await pool.query("select tablename from pg_tables where schemaname='public'")).rows) {
      assert.match(tablename, /^[a-zA-Z0-9_]+$/);
      await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
    }
    await database.insert(schema.budTable).values({ budId, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
    const repo = new InvocationRepository(database);
    const proposal: GoogleApprovalProposal = { connection_id: "connection", service: "calendar", tool_name: "calendar_create_event",
      arguments_json: '{"summary":"Approved event"}', operation_id: "private-operation", account_subject: "private-subject",
      account_email: "owner@example.test", grant_id: "private-grant" };
    const setup = async () => {
      const threadId = randomUUID(), callId = randomUUID(), clientId = randomUUID(), providerId = randomUUID();
      await database.insert(schema.threadTable).values({ threadId, budId, createdByUserId: owner });
      await repo.admit({ owner, threadId, origin: "human", idempotencyKey: threadId, text: "Create an event", model: "gpt-5.6-luna", reasoningEffort: "low" });
      const lease = await repo.claim("worker", owner); assert.ok(lease);
      await repo.start(lease);
      await repo.recordAction(lease, callId, "google_call");
      await database.insert(schema.llmCallTable).values({ llmCallId: providerId, threadId, turnId: lease.turnId,
        stepIndex: 0, provider: "openai", model: "gpt-5.6-luna", requestMode: "openai_responses", createdByUserId: owner });
      await database.insert(schema.llmCallItemTable).values([
        { id: callId, name: "google_call", input: { connection_id: proposal.connection_id, tool_name: proposal.tool_name, arguments_json: proposal.arguments_json } },
        { id: "later-" + callId, name: "terminal_send", input: { text: "echo should-not-execute" } },
      ].map((block, sequence) => ({ llmCallItemId: randomUUID(), llmCallId: providerId, threadId, direction: "output", kind: "tool_use",
        sequence, toolCallId: block.id, canonicalPayload: { type: "tool_use", ...block }, createdByUserId: owner })));
      return { threadId, callId, clientId, lease };
    };
    const first = await setup();
    await assert.rejects(repo.parkGoogleApproval({ ...first.lease, fence: first.lease.fence - 1 }, first.callId, first.clientId, proposal), /lease_lost/);
    await assert.rejects(repo.parkGoogleApproval(first.lease, "unrecorded", first.clientId, proposal), /action_not_pending/);
    const failing = Object.create(database) as typeof database;
    failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(tx => work(new Proxy(tx, {
      get(target, name) {
        if (name === "update") return (table: unknown) => {
          if (table === schema.agentInvocationTable) throw new Error("injected park failure");
          return target.update(table as typeof schema.agentInvocationActionTable);
        };
        const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
      },
    })))) as typeof database.transaction;
    await assert.rejects(new InvocationRepository(failing).parkGoogleApproval(first.lease, first.callId, first.clientId, proposal), /injected park failure/);
    assert.deepEqual(await repo.pendingGoogleApprovalsForThread(owner, first.threadId), []);
    await repo.heartbeat(first.lease);
    const review = await repo.parkGoogleApproval(first.lease, first.callId, first.clientId, proposal);
    assert.equal(review.status, "pending");
    assert.doesNotMatch(JSON.stringify(review), /private-operation|private-subject|private-grant/);
    const recovered = await new InvocationRepository(database).pendingGoogleApprovalsForThread(owner, first.threadId);
    assert.deepEqual(recovered[0].pending_tool.args.google_approval, review);
    assert.equal(recovered[0].pending_tool.client_id, first.clientId);
    assert.deepEqual(await repo.pendingGoogleApprovalsForThread("another-owner", first.threadId), []);
    assert.deepEqual(await repo.pendingGoogleApprovalsForThread(owner, randomUUID()), []);
    await assert.rejects(repo.heartbeat(first.lease), /lease_lost/);
    assert.equal(await repo.claim("before-decision", owner), null);
    const decide = async (approvalId: string, changes: Partial<GoogleApproval>) => {
      const [action] = await database.select().from(schema.agentInvocationActionTable).where(eq(schema.agentInvocationActionTable.id, approvalId));
      await database.update(schema.agentInvocationActionTable).set({ evidence: { ...action.evidence,
        google_approval: { ...action.evidence?.google_approval as GoogleApproval, ...changes } } })
        .where(eq(schema.agentInvocationActionTable.id, approvalId));
    };
    await decide(review.approval_id, { status: "approved", decided_at: new Date().toISOString() });
    const resumed = await repo.claim("resumed", owner); assert.ok(resumed);
    assert.equal(resumed.id, first.lease.id); assert.equal(resumed.turnId, first.lease.turnId);
    await repo.start(resumed);
    const messages = await repo.prepareQuestionContinuation(resumed);
    assert.equal(messages.length, 2);
    const result = JSON.parse(messages[0].content);
    assert.equal(messages[0].clientId, first.clientId);
    assert.equal(result.approval_id, review.approval_id);
    assert.equal(result.executed, false);
    assert.equal(result.ok, true);
    assert.equal(result.args.arguments_json, proposal.arguments_json);
    assert.doesNotMatch(messages[0].content, /private-operation|private-subject|private-grant/);
    assert.match(messages[1].content, /not_executed_due_to_permission/);
    assert.deepEqual(await repo.prepareQuestionContinuation(resumed), []);
    const [stored] = await database.select().from(schema.agentInvocationActionTable).where(eq(schema.agentInvocationActionTable.id, review.approval_id));
    assert.equal(stored.status, "completed");
    assert.equal((stored.evidence?.google_approval as GoogleApproval).operation_id, proposal.operation_id);
    await repo.finish(resumed, "succeeded", "fixture_finished");
    for (const outcome of ["rejected", "expired", "canceled"] as const) {
      const next = await setup();
      const pending = await repo.parkGoogleApproval(next.lease, next.callId, next.clientId, proposal);
      if (outcome === "canceled") {
        await repo.requestCancel(owner, next.lease.id);
        assert.deepEqual(await repo.pendingGoogleApprovalsForThread(owner, next.threadId), []);
        assert.equal(await repo.claim("canceled", owner), null);
        continue;
      }
      await decide(pending.approval_id, outcome === "expired" ? { expires_at: new Date(0).toISOString() }
        : { status: "rejected", decided_at: new Date().toISOString() });
      const continued = await repo.claim("decided", owner); assert.ok(continued);
      await repo.start(continued);
      const [message] = await repo.prepareQuestionContinuation(continued);
      const denied = JSON.parse(message.content);
      assert.equal(denied.approval_request.status, outcome);
      assert.equal(denied.approval_id, undefined);
      assert.equal(denied.executed, false);
      assert.equal(denied.ok, false);
      await repo.finish(continued, "succeeded", "fixture_finished");
    }
  } finally {
    await pool.query(`drop schema if exists "${isolated}" cascade`);
    await pool.end(); await defaultPool.end();
  }
});
