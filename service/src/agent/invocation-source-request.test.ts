import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AccessLog } from "../personal-data/access-log.js";
import { DataGrants } from "../personal-data/grants.js";
import { DataSources } from "../personal-data/sources.js";
import { SourceRequests, SOURCE_REQUEST_TOOL } from "../personal-data/source-requests.js";
import { AgentConversationLoader } from "./conversation-loader.js";
import { InvocationRepository } from "./invocation-repository.js";
import { toolPresentation } from "./message-view.js";

test("a request for a data source parks the turn, is settled by the service and resumes it", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  // Its own schema, for this test and the service pool: a running dev service's worker claims
  // any owner's due invocations in the shared tables.
  const isolated = "source_request_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${isolated},public` });
  defaultPool.on("connect", client => { void client.query(`set search_path to "${isolated}", public`); });
  const database = drizzle(pool, { schema });
  const owner = "source-request-" + randomUUID(), other = "source-request-other-" + randomUUID();
  const bud = "bud-" + randomUUID();
  t.after(async () => {
    try {
      await pool.query(`drop schema if exists "${isolated}" cascade`);
      await pool.query(`delete from auth."user" where id = any($1)`, [[owner, other]]);
    }
    finally { await pool.end(); await defaultPool.end(); }
  });
  await pool.query(`create schema "${isolated}"`);
  for (const { tablename } of (await pool.query("select tablename from pg_tables where schemaname='public'")).rows) {
    assert.match(tablename, /^[a-zA-Z0-9_]+$/);
    await pool.query(`create table "${isolated}"."${tablename}" (like public."${tablename}" including all)`);
  }
  await database.insert(schema.authUserTable).values([owner, other].map(id => ({ id, name: "Fixture", email: `${id}@example.invalid`, emailVerified: false })));
  await database.insert(schema.budTable).values({ budId: bud, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  const repo = new InvocationRepository(database);
  const requests = new SourceRequests(database);
  const sources = new DataSources(database);
  const setup = async (input: Record<string, unknown>, thread = randomUUID()) => {
    await database.insert(schema.threadTable).values({ threadId: thread, budId: bud, createdByUserId: owner }).onConflictDoNothing();
    await repo.admit({ owner, threadId: thread, origin: "human", idempotencyKey: randomUUID(),
      text: "Where am I?", model: "fixture-model", reasoningEffort: "low" });
    const lease = await repo.claim("request-worker", owner); assert.ok(lease);
    await repo.start(lease);
    return { thread, lease, ...await call(thread, lease, input) };
  };
  const call = async (thread: string, lease: NonNullable<Awaited<ReturnType<typeof repo.claim>>>, input: Record<string, unknown>) => {
    const callId = randomUUID(), providerCallId = randomUUID(), clientId = randomUUID();
    await repo.recordAction(lease, callId, SOURCE_REQUEST_TOOL);
    await database.insert(schema.llmCallTable).values({ llmCallId: providerCallId, threadId: thread, turnId: lease.turnId,
      stepIndex: 0, provider: "openai", model: "fixture-model", requestMode: "openai_responses", createdByUserId: owner });
    await database.insert(schema.llmCallItemTable).values({ llmCallItemId: randomUUID(), llmCallId: providerCallId, threadId: thread,
      direction: "output", kind: "tool_use", sequence: 0, toolCallId: callId,
      canonicalPayload: { type: "tool_use", id: callId, name: SOURCE_REQUEST_TOOL, input }, createdByUserId: owner });
    return { callId, clientId };
  };
  const resume = async (lease: { id: string }) => {
    await database.update(schema.agentInvocationTable).set({ latestStartAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, lease.id));
    const resumed = await repo.claim("new-worker", owner); assert.ok(resumed);
    assert.equal(resumed.id, lease.id);
    await repo.start(resumed);
    return { resumed, restored: await repo.prepareQuestionContinuation(resumed) };
  };

  // An invalid request is refused before anything is stored.
  const first = await setup({ source: "location", purpose: "tell you where you are" });
  await assert.rejects(repo.parkSourceRequest(first.lease, first.callId, first.clientId, { source: "health", purpose: "x", level: "always" }),
    /location/);
  await assert.rejects(repo.parkSourceRequest(first.lease, first.callId, first.clientId, { source: "calendar", purpose: "x" }));

  // Parks, and the request is what a reopened conversation gets back.
  const parked = await repo.parkSourceRequest(first.lease, first.callId, first.clientId, { source: "location", purpose: "tell you where you are" });
  assert.equal(parked.kind, "request");
  assert.ok(parked.kind === "request");
  const id = parked.request.request_id;
  assert.match(id, /^dsr_/);
  assert.equal(parked.request.status, "pending");
  const pending = await repo.pendingSourceRequestsForThread(owner, first.thread);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].client_id, first.clientId);
  assert.equal(pending[0].turn_id, first.lease.turnId);
  assert.deepEqual(await repo.pendingSourceRequestsForThread(other, first.thread), []);
  assert.deepEqual(toolPresentation(SOURCE_REQUEST_TOOL, pending[0].request, true), { kind: "source_access", id, status: "pending" });
  assert.equal(await repo.claim("new-worker", owner), null, "the turn waits for the user");

  // One push, content-free, delayed, due only while nobody has seen the card.
  const pushes = await database.select().from(schema.pushNotificationOutboxTable).where(eq(schema.pushNotificationOutboxTable.userId, owner));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].kind, "human_input_requested");
  assert.equal(pushes[0].body, "Bud needs your input");
  assert.doesNotMatch(JSON.stringify(pushes[0]), /location|where you are/i);
  assert.deepEqual(pushes[0].payload.request_id, id);
  assert.ok(pushes[0].nextAttemptAt.getTime() > Date.now() + 5_000);
  assert.equal(await requests.pushDue(id), true);

  // Only the owner. Showing the card counts as seen.
  await assert.rejects(requests.get(other, id), /not found/i);
  await assert.rejects(requests.allow(other, id, "ios"), /not found/i);
  await assert.rejects(requests.respond(other, id, { outcome: "granted" }, "ios"), /not found/i);
  const shown = await requests.get(owner, id);
  assert.equal(shown.request.purpose, "tell you where you are");
  assert.equal(shown.source.id, "location");
  assert.equal(shown.source.enabled, false);
  assert.equal(shown.source.agent.allowed, false);
  assert.equal(await requests.pushDue(id), false);

  // One tap: the switch and the agent's permission together, each in its own history.
  const allowed = await requests.allow(owner, id, "ios");
  assert.equal(allowed.source.enabled, true);
  assert.equal(allowed.source.agent.allowed, true);
  assert.equal(allowed.request.status, "pending", "allowing doesn't answer the request");
  assert.deepEqual((await new DataGrants(database).get(owner)).scopes, ["location.read"]);
  await requests.allow(owner, id, "ios");
  assert.equal((await database.select().from(schema.dataSourceSettingHistoryTable)
    .where(eq(schema.dataSourceSettingHistoryTable.createdByUserId, owner))).length, 1, "a second tap changes nothing");

  // The answer is settled from what the service holds, and the same answer again is accepted.
  await assert.rejects(requests.respond(owner, id, { outcome: "maybe" }, "ios"), /outcome/);
  const answered = await requests.respond(owner, id, { outcome: "granted", reading_event_id: "missing-reading" }, "ios");
  assert.equal(answered.request.status, "granted");
  assert.deepEqual({ usable: answered.request.result?.usable, reading: answered.request.result?.reading, asked: answered.request.result?.asked },
    { usable: true, reading: "not_received", asked: true });
  await requests.respond(owner, id, { outcome: "granted" }, "ios");
  await assert.rejects(requests.respond(owner, id, { outcome: "declined" }, "ios"), /no longer open/);
  await assert.rejects(requests.allow(owner, id, "ios"), /no longer open/);
  assert.deepEqual(await repo.pendingSourceRequestsForThread(owner, first.thread), []);

  // The turn resumes with the settled result as the tool's answer, and replays paired.
  const { resumed, restored } = await resume(first.lease);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].clientId, first.clientId);
  const payload = JSON.parse(restored[0].content);
  assert.deepEqual({ tool: payload.tool, ok: payload.ok, outcome: payload.outcome, usable: payload.usable, kind: payload.kind },
    { tool: SOURCE_REQUEST_TOOL, ok: true, outcome: "granted", usable: true, kind: "source_access" });
  assert.deepEqual(toolPresentation(SOURCE_REQUEST_TOOL, payload), { kind: "source_access", id, status: "granted" });
  const replay = await new AgentConversationLoader().loadWithDiagnostics(first.thread, { provider: "openai" });
  const blocks = replay.messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
  assert.equal(blocks.filter(block => block.type === "tool_use" && block.id === first.callId).length, 1);
  assert.equal(blocks.filter(block => block.type === "tool_result" && block.tool_use_id === first.callId).length, 1);

  // Location in order still shows its card (a fresh reading); "Not now" is a decline that
  // changes no access, and a repeat in the same turn is answered at once with no card.
  const second = await call(first.thread, resumed, { source: "location", purpose: "tell you where you are" });
  const again = await repo.parkSourceRequest(resumed, second.callId, second.clientId, { source: "location", purpose: "tell you where you are" });
  assert.ok(again.kind === "request");
  await requests.respond(owner, again.request.request_id, { outcome: "declined" }, "web");
  assert.equal((await sources.access(owner, "location")).enabled, true, "a decline changes no access");
  const afterDecline = await resume(first.lease);
  assert.equal(JSON.parse(afterDecline.restored[0].content).outcome, "declined");
  const third = await call(first.thread, afterDecline.resumed, { source: "location", purpose: "try again" });
  const refused = await repo.parkSourceRequest(afterDecline.resumed, third.callId, third.clientId, { source: "location", purpose: "try again" });
  assert.deepEqual(refused.kind === "settled" && { outcome: refused.result.outcome, asked: refused.result.asked }, { outcome: "declined", asked: false });
  assert.equal((await database.select().from(schema.pushNotificationOutboxTable).where(eq(schema.pushNotificationOutboxTable.userId, owner))).length, 2,
    "no push for a request that was never shown");
  await repo.completeAction(afterDecline.resumed, third.callId, {});
  await repo.finish(afterDecline.resumed, "succeeded", "completed");

  // In a later turn the agent may ask again. A client can't report access that doesn't exist.
  const later = await setup({ source: "health", purpose: "check your sleep" }, first.thread);
  const health = await repo.parkSourceRequest(later.lease, later.callId, later.clientId, { source: "health", purpose: "check your sleep" });
  assert.ok(health.kind === "request");
  const lied = await requests.respond(owner, health.request.request_id, { outcome: "granted" }, "ios");
  assert.equal(lied.request.status, "unavailable");
  assert.equal(lied.request.result?.usable, false);
  const afterLie = await resume(later.lease);
  assert.equal(JSON.parse(afterLie.restored[0].content).ok, false);

  // With access in order and the phone allowed, nothing is asked.
  await new DataGrants(database).update(owner, { scopes: ["location.read", "health.read"], version: 1, history_days: 90 });
  await sources.set(owner, "health", { enabled: true }, "ios");
  await sources.report(owner, "phone-a", { reported_at: new Date().toISOString(), sources: { health: { permission: "unknowable" } } });
  const fourth = await call(first.thread, afterLie.resumed, { source: "health", purpose: "check your sleep" });
  const inOrder = await repo.parkSourceRequest(afterLie.resumed, fourth.callId, fourth.clientId, { source: "health", purpose: "check your sleep" });
  assert.deepEqual(inOrder.kind === "settled" && { outcome: inOrder.result.outcome, asked: inOrder.result.asked }, { outcome: "granted", asked: false });
  await repo.completeAction(afterLie.resumed, fourth.callId, {});
  await repo.finish(afterLie.resumed, "succeeded", "completed");

  // A follow-up message replaces an unanswered request: the waiting turn resumes with
  // `superseded` before the new message runs. It is not a decline.
  const open = await setup({ source: "contacts", purpose: "find a phone number" }, first.thread);
  const contacts = await repo.parkSourceRequest(open.lease, open.callId, open.clientId, { source: "contacts", purpose: "find a phone number" });
  assert.ok(contacts.kind === "request");
  await repo.admit({ owner, threadId: first.thread, origin: "human", idempotencyKey: randomUUID(),
    text: "Never mind", model: "fixture-model", reasoningEffort: "low" });
  assert.equal((await requests.get(owner, contacts.request.request_id)).request.status, "superseded");
  const superseded = await resume(open.lease);
  const told = JSON.parse(superseded.restored[0].content);
  assert.deepEqual({ outcome: told.outcome, ok: told.ok }, { outcome: "superseded", ok: false });
  await assert.rejects(requests.respond(owner, contacts.request.request_id, { outcome: "granted" }, "ios"), /no longer open/);

  // Changes lists what was asked and how it ended, never why.
  const changes = await new AccessLog(database).changes(owner, "location");
  const asked = changes.changes.filter(change => change.kind === "request");
  assert.deepEqual(asked.map(change => change.outcome).sort(), ["declined", "granted"]);
  assert.equal(asked[0].thread_id, first.thread);
  assert.doesNotMatch(JSON.stringify(changes), /where you are/);

  // Canceling the turn closes its request.
  await repo.finish(superseded.resumed, "succeeded", "completed");
  const next = await repo.claim("request-worker", owner); assert.ok(next);
  await repo.start(next);
  const last = await call(first.thread, next, { source: "location", purpose: "tell you where you are" });
  const canceled = await repo.parkSourceRequest(next, last.callId, last.clientId, { source: "location", purpose: "tell you where you are" });
  assert.ok(canceled.kind === "request");
  await repo.requestCancel(owner, next.id);
  assert.equal((await requests.get(owner, canceled.request.request_id)).request.status, "canceled");
});
