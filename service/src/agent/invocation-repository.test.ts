import { AgentConversationLoader } from "./conversation-loader.js";
import { getCurrentContextCheckpointBoundary, recordCompletedContextCheckpoint } from "./context-checkpoint-repository.js";
import { findDanglingToolCalls } from "./restart-repair.js";
import { AgentService } from "./agent-service.js";
import { pool as servicePool } from "../db/client.js";
import { normalizeAskUserQuestionsRequest } from "./user-question-contracts.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { InvocationRepository } from "./invocation-repository.js";
import { generateMessageClientId } from "../db/message-client-id.js";

test("durable admission: atomic inputs, concurrency, stale fences and ambiguous effects", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const database = drizzle(pool, { schema });
  const owners = ["invocation-test-" + randomUUID(), "invocation-test-" + randomUUID()];
  const buds = owners.map(() => "bud-test-" + randomUUID());
  const threads = owners.map(() => randomUUID());
  t.after(async () => {
    try {
      await database.delete(schema.agentInvocationTable).where(inArray(schema.agentInvocationTable.createdByUserId, owners));
      await database.delete(schema.messageTable).where(inArray(schema.messageTable.threadId, threads));
      await database.delete(schema.threadTable).where(inArray(schema.threadTable.threadId, threads));
      await database.delete(schema.budTable).where(inArray(schema.budTable.budId, buds));
      await database.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
    } finally { await pool.end(); await servicePool.end(); }
  });
  await database.insert(schema.authUserTable).values(owners.map(id => ({ id, name: "Invocation fixture", email: `${id}@example.invalid`, emailVerified: false })));
  await database.insert(schema.budTable).values(owners.map((owner, i) => ({ budId: buds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: owner })));
  await database.insert(schema.threadTable).values(owners.map((owner, i) => ({ threadId: threads[i], budId: buds[i], createdByUserId: owner })));
  const repo = new InvocationRepository(database);
  // Execute the reviewed migration against empty representative parent tables
  // in an isolated schema. This catches FK ordering that metadata tests miss.
  const migration = await readFile(new URL("../../drizzle/migrations/0027_aspiring_triton.sql", import.meta.url), "utf8");
  await database.transaction(async tx => {
    const namespace = "invocation_migration_" + randomUUID().replaceAll("-", "");
    await tx.execute(sql`create schema ${sql.identifier(namespace)}`);
    await tx.execute(sql`set local search_path to ${sql.identifier(namespace)}`);
    await tx.execute(sql`create table thread (thread_id uuid primary key, bud_id text not null, created_by_user_id text)`);
    await tx.execute(sql`create table message (message_id uuid primary key, thread_id uuid not null, created_by_user_id text)`);
    await tx.execute(sql.raw(migration.replaceAll('"public".', `"${namespace}".`)));
    const reservationMigration = await readFile(new URL("../../drizzle/migrations/0028_blue_risque.sql", import.meta.url), "utf8");
    await tx.execute(sql.raw(reservationMigration));
    await tx.execute(sql`drop schema ${sql.identifier(namespace)} cascade`);
  });
  const input = { owner: owners[0], threadId: threads[0], origin: "human" as const,
    idempotencyKey: "human-one", clientId: generateMessageClientId(), text: "Hello",
    model: "fixture-model", reasoningEffort: "medium" };
  await assert.rejects(repo.admit({ ...input, owner: owners[1] }), /thread_not_found/);
  const admissions = await Promise.all([repo.admit(input), repo.admit(input)]);
  assert.equal(admissions.filter(a => !a.duplicate).length, 1);
  assert.equal(admissions[0].invocation.id, admissions[1].invocation.id);
  await assert.rejects(repo.admit({ ...input, text: "Changed retry" }), /admission_conflict/);
  assert.equal((await database.select().from(schema.messageTable).where(eq(schema.messageTable.threadId, threads[0]))).length, 1);

  const rolledBackThread = randomUUID();
  await assert.rejects(database.transaction(async tx => {
    await tx.insert(schema.threadTable).values({ threadId: rolledBackThread, budId: buds[0], createdByUserId: owners[0] });
    await repo.admitInTransaction(tx, { ...input, threadId: rolledBackThread,
      idempotencyKey: "delivery-rollback", clientId: generateMessageClientId() });
    throw new Error("delivery association failed");
  }), /delivery association failed/);
  assert.equal((await database.select().from(schema.threadTable).where(eq(schema.threadTable.threadId, rolledBackThread))).length, 0);
  assert.equal((await repo.listForThread(owners[0], rolledBackThread)).length, 0);
  assert.equal((await database.select().from(schema.messageTable).where(eq(schema.messageTable.threadId, rolledBackThread))).length, 0);

  // Fault after message insert proves input+invocation share a transaction.
  const failing = Object.create(database) as typeof database;
  failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(async tx => work(new Proxy(tx, {
    get(target, key) {
      if (key === "insert") return (table: unknown) => {
        if (table === schema.agentInvocationTable) throw new Error("injected admission failure");
        return target.insert(table as typeof schema.messageTable);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })))) as typeof database.transaction;
  await assert.rejects(new InvocationRepository(failing).admit({ ...input, idempotencyKey: "rollback", clientId: generateMessageClientId() }), /injected admission failure/);
  assert.equal((await database.select().from(schema.messageTable).where(eq(schema.messageTable.threadId, threads[0]))).length, 1);

  await repo.admit({ ...input, idempotencyKey: "human-two", clientId: generateMessageClientId() });
  const claims = await Promise.all([repo.claim("worker-a", owners[0]), repo.claim("worker-b", owners[0])]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  assert.equal(first.turnId, admissions[0].invocation.turnId);
  assert.equal(await repo.claim("worker-c", owners[0]), null);
  await database.update(schema.agentInvocationTable).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.agentInvocationTable.id, first.id));
  assert.equal(await repo.recoverExpired(owners[0]), 1);
  const retry = await repo.claim("worker-c", owners[0]);
  assert.ok(retry);
  assert.equal(retry.id, first.id);
  assert.ok(retry.fence > first.fence);
  await assert.rejects(repo.start(first), /lease_lost/);
  await repo.start(retry);
  await repo.recordAction(retry, "call-one", "terminal.send");
  await assert.rejects(repo.recordAction(retry, "call-one", "terminal.send"), /action_already_recorded/);
  await database.update(schema.agentInvocationTable).set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(schema.agentInvocationTable.id, retry.id));
  assert.equal(await repo.recoverExpired(owners[0]), 1);
  await assert.rejects(repo.completeAction(retry, "call-one", { command_id: "unknown" }), /lease_lost/);
  assert.equal(await repo.claim("worker-d", owners[0]), null, "needs_review must retain thread reservation");
  const [review] = await database.select().from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.id, retry.id));
  assert.equal(review.status, "needs_review");

  // A separate thread can proceed; completed work is never reclaimed.
  await repo.admit({ ...input, owner: owners[1], threadId: threads[1], clientId: generateMessageClientId() });
  const other = await repo.claim("worker-other", owners[1]);
  assert.ok(other);
  await repo.start(other);
  await repo.recordAction(other, "query", "contacts_search");
  await repo.completeAction(other, "query", { ok: true });
  await repo.finish(other, "succeeded", "completed");
  assert.equal(await repo.claim("worker-other", owners[1]), null);
  await repo.admit({ ...input, owner: owners[1], threadId: threads[1], idempotencyKey: "expired", clientId: generateMessageClientId(), latestStartAt: new Date(0) });
  assert.equal(await repo.claim("worker-other", owners[1]), null);
  const statuses = await database.select({ status: schema.agentInvocationTable.status }).from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.createdByUserId, owners[1]));
  assert.deepEqual(statuses.map(s => s.status).sort(), ["expired", "succeeded"]);
  await repo.admit({ ...input, owner: owners[1], threadId: threads[1], idempotencyKey: "offline", clientId: generateMessageClientId() });
  const offline = await repo.claim("worker-offline", owners[1]);
  assert.ok(offline);
  await repo.defer(offline, "waiting_for_model", 30);
  assert.equal(await repo.claim("worker-offline", owners[1]), null);
  await assert.rejects(repo.start(offline), /lease_lost/);
  await assert.rejects(repo.requestCancel(owners[0], offline.id), /invocation_not_found/);
  assert.equal((await repo.requestCancel(owners[1], offline.id))?.status, "canceled");

  const cancelInput = { ...input, owner: owners[1], threadId: threads[1], idempotencyKey: "cancel-running", clientId: generateMessageClientId() };
  await repo.admit(cancelInput);
  const cancelLease = await repo.claim("cancel-worker", owners[1]);
  assert.ok(cancelLease);
  await repo.start(cancelLease);
  assert.equal((await repo.requestCancel(owners[1], cancelLease.id))?.status, "running");
  await assert.rejects(repo.heartbeat(cancelLease), /invocation_canceled/);
  await assert.rejects(repo.recordAction(cancelLease, "must-not-dispatch", "terminal.send"), /invocation_canceled/);
  await repo.finish(cancelLease, "failed", "interrupted");
  assert.equal((await repo.requestCancel(owners[1], cancelLease.id))?.status, "canceled");

  await repo.admit({ ...cancelInput, idempotencyKey: "question", clientId: generateMessageClientId() });
  const asking = await repo.claim("question-worker", owners[1]);
  assert.ok(asking);
  await repo.start(asking);
  const [questionInputAtStart] = await database.select().from(schema.messageTable).where(eq(schema.messageTable.messageId, asking.inputMessageId));
  await repo.recordAction(asking, "ask-call", "ask_user_questions");
  const questionId = "question-" + randomUUID();
  const storedRequest = normalizeAskUserQuestionsRequest({ questions: [{ question_id: "continue", kind: "boolean", label: "Continue?" }] });
  await database.insert(schema.agentQuestionRequestTable).values({
    questionRequestId: questionId, threadId: asking.threadId, turnId: asking.turnId,
    callId: "ask-call", clientId: generateMessageClientId(), request: storedRequest as unknown as Record<string, unknown>, createdByUserId: owners[1],
  });
  const providerCallId = "provider-" + randomUUID();
  await database.insert(schema.llmCallTable).values({ llmCallId: providerCallId, threadId: asking.threadId, turnId: asking.turnId,
    stepIndex: 0, provider: "openai", model: "fixture", requestMode: "openai_responses", createdByUserId: owners[1] });
  await database.insert(schema.llmCallItemTable).values([
    { id: "ask-call", name: "ask_user_questions", input: storedRequest },
    { id: "later-command", name: "terminal_send", input: { text: "echo reconsider-me" } },
  ].map((block, sequence) => ({ llmCallItemId: randomUUID(), llmCallId: providerCallId, threadId: asking.threadId,
    direction: "output", kind: "tool_use", sequence, toolCallId: block.id, canonicalPayload: { type: "tool_use", ...block }, createdByUserId: owners[1] })));
  const legacyCallId = "legacy-" + randomUUID();
  const legacyToolId = "legacy-tool-" + randomUUID();
  await database.insert(schema.llmCallTable).values({ llmCallId: legacyCallId, threadId: asking.threadId,
    turnId: "legacy-turn-" + randomUUID(), stepIndex: 0, provider: "openai", model: "fixture",
    requestMode: "openai_responses", createdByUserId: owners[1] });
  await database.insert(schema.llmCallItemTable).values({ llmCallItemId: randomUUID(), llmCallId: legacyCallId,
    threadId: asking.threadId, direction: "output", kind: "tool_use", sequence: 0, toolCallId: legacyToolId,
    canonicalPayload: { type: "tool_use", id: legacyToolId, name: "terminal_send", input: { text: "echo legacy" } },
    createdByUserId: owners[1] });
  const dangling = await findDanglingToolCalls();
  assert.ok(dangling.some(call => call.toolCallId === legacyToolId), "legacy calls still use restart repair");
  assert.ok(!dangling.some(call => call.llmCallId === providerCallId), "durable calls must retain invocation-owned recovery");
  await database.delete(schema.llmCallTable).where(eq(schema.llmCallTable.llmCallId, legacyCallId));
  await repo.parkQuestion(asking, "ask-call", questionId);
  assert.equal((await repo.pendingQuestionsForThread(owners[1], asking.threadId))[0]?.request_id, questionId);
  assert.deepEqual(await repo.pendingQuestionsForThread(owners[0], asking.threadId), []);
  await assert.rejects(repo.heartbeat(asking), /lease_lost/);
  assert.equal(await repo.claim("question-worker", owners[1]), null);
  const queued = await repo.admit({ ...cancelInput, idempotencyKey: "behind-question", clientId: generateMessageClientId(), latestStartAt: new Date(0) });
  assert.equal(await repo.expireQueued(owners[1]), 1, "expiry must work behind a reserved thread");
  assert.equal((await repo.requestCancel(owners[1], queued.invocation.id))?.status, "expired");
  await database.update(schema.agentQuestionRequestTable).set({ status: "answered", toolResult: { answers: [] }, clientResponse: { schema: "ask_user_questions_response_v1", client_response_id: generateMessageClientId(), answers: [{ question_id: "continue", status: "answered", answer: { kind: "boolean", value: true } }] } })
    .where(eq(schema.agentQuestionRequestTable.questionRequestId, questionId));
  await database.update(schema.agentInvocationTable).set({ latestStartAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, asking.id));
  const [acceptedQuestion] = await database.select().from(schema.agentQuestionRequestTable).where(eq(schema.agentQuestionRequestTable.questionRequestId, questionId));
  const agent = new AgentService({} as never, {} as never, { info() {}, warn() {}, error() {} } as never, false, false, repo);
  const answerResult = await agent.submitQuestionResponse({ threadId: asking.threadId, questionRequestId: questionId,
    response: acceptedQuestion.clientResponse, answeredByUserId: owners[1] });
  assert.equal(answerResult.continuation, "durable_invocation");
  assert.equal(answerResult.invocationId, asking.id);
  await assert.rejects(agent.startUserMessage(asking.threadId), /durable_admission_required/);
  assert.deepEqual(await repo.listForThread(owners[0], asking.threadId), []);
  assert.equal(await repo.findByTurn(owners[0], asking.threadId, asking.turnId), null);
  const resumed = await repo.claim("new-process", owners[1]);
  assert.ok(resumed);
  assert.equal(resumed.id, asking.id);
  assert.equal(resumed.turnId, asking.turnId);
  assert.ok(resumed.fence > asking.fence);
  await repo.defer(resumed, "waiting_for_model", 30);
  const overtaking = await repo.admit({ ...cancelInput, idempotencyKey: "must-not-overtake", clientId: generateMessageClientId() });
  assert.equal(await repo.claim("other-worker", owners[1]), null, "model wait must retain the continuation reservation");
  await assert.rejects(async () => {
    await database.update(schema.agentInvocationTable).set({ reservesThread: true }).where(eq(schema.agentInvocationTable.id, overtaking.invocation.id));
  }, (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23505");
  await repo.requestCancel(owners[1], overtaking.invocation.id);
  assert.equal(await repo.expireQueued(owners[1]), 0, "a continuation is not a late first start");
  await database.update(schema.agentInvocationTable).set({ nextAttemptAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, asking.id));
  const continued = await repo.claim("new-process", owners[1]);
  assert.ok(continued, JSON.stringify({ invocation: await database.select().from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.id, asking.id)), actions: await database.select().from(schema.agentInvocationActionTable).where(eq(schema.agentInvocationActionTable.invocationId, asking.id)) }));
  await repo.start(continued);
  const [questionInputAtResume] = await database.select().from(schema.messageTable).where(eq(schema.messageTable.messageId, continued.inputMessageId));
  assert.equal(questionInputAtResume.metadata?.model_context_at, questionInputAtStart.metadata?.model_context_at, "resuming does not reorder the original input");
  const restored = await repo.prepareQuestionContinuation(continued);
  assert.equal(restored.length, 2);
  assert.match(restored[0].content, /ask_user_questions_tool_result_v1/);
  assert.match(restored[1].content, /not_executed_due_to_question/);
  assert.equal((await repo.prepareQuestionContinuation(continued)).length, 0);
  const replayResults = await database.select().from(schema.llmCallItemTable).where(eq(schema.llmCallItemTable.llmCallId, providerCallId));
  assert.equal(replayResults.filter(item => item.direction === "input").length, 2);
  const resumedConversation = await new AgentConversationLoader().loadWithDiagnostics(asking.threadId, { provider: "openai" });
  assert.ok(resumedConversation.sources.some(source => source.kind === "ledger" && source.llm_call_id === providerCallId));
  const resumedBlocks = resumedConversation.messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
  assert.equal(resumedBlocks.filter(block => block.type === "tool_use" && block.id === "ask-call").length, 1);
  assert.equal(resumedBlocks.filter(block => block.type === "tool_result" && block.tool_use_id === "ask-call").length, 1);

  await repo.finish(continued, "succeeded", "completed");

  await t.test("automation capacity spans workers without blocking humans or other Buds", async () => {
    const extraThreads = Array.from({ length: 4 }, () => randomUUID());
    const otherBud = "bud-test-" + randomUUID();
    buds.push(otherBud);
    threads.push(...extraThreads);
    await database.insert(schema.budTable).values({ budId: otherBud, name: "Other fixture", os: "test", arch: "test", createdByUserId: owners[1] });
    await database.insert(schema.threadTable).values(extraThreads.map((threadId, i) => ({
      threadId, budId: i === 3 ? otherBud : buds[1], createdByUserId: owners[1],
    })));
    const automationInput = { ...input, owner: owners[1], origin: "automation" as const };
    const automationRows = await Promise.all(extraThreads.slice(0, 2).map((threadId, i) => repo.admit({
      ...automationInput, threadId, idempotencyKey: `capacity-${i}`, clientId: generateMessageClientId(),
    })));
    const peer = new InvocationRepository(database);
    const race = await Promise.all([repo.claim("capacity-a", owners[1]), peer.claim("capacity-b", owners[1])]);
    assert.equal(race.filter(Boolean).length, 1);
    const reserved = race.find(Boolean)!;
    assert.equal(await peer.claim("capacity-c", owners[1]), null);
    await repo.defer(reserved, "waiting_for_model", 30);
    const replacement = await peer.claim("capacity-c", owners[1]);
    assert.ok(replacement);
    assert.notEqual(replacement.id, reserved.id, "unstarted availability waits release Bud capacity");
    await peer.start(replacement);
    await peer.recordAction(replacement, "ambiguous", "terminal.send");
    await peer.finish(replacement, "failed", "unknown_result");
    await database.update(schema.agentInvocationTable).set({ nextAttemptAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, reserved.id));
    assert.equal(await repo.claim("capacity-d", owners[1]), null, "review must retain its Bud slot");

    const human = await repo.admit({ ...input, owner: owners[1], threadId: extraThreads[2],
      idempotencyKey: "human-beside-automation", clientId: generateMessageClientId() });
    const humanLease = await peer.claim("capacity-human", owners[1]);
    assert.equal(humanLease?.id, human.invocation.id);
    await peer.finish(humanLease!, "succeeded", "completed");

    const independent = await repo.admit({ ...automationInput, threadId: extraThreads[3],
      idempotencyKey: "other-bud-capacity", clientId: generateMessageClientId() });
    const independentLease = await peer.claim("capacity-other-bud", owners[1]);
    assert.equal(independentLease?.id, independent.invocation.id, "full Buds must not starve other Buds");
    await peer.finish(independentLease!, "succeeded", "completed");
    assert.equal(automationRows.length, 2);
    assert.throws(() => new InvocationRepository(database, 0), /invalid_automation_concurrency/);
  });

  await t.test("queued input stays outside replay and survives an earlier checkpoint", async () => {
    const threadId = randomUUID();
    threads.push(threadId);
    await database.insert(schema.threadTable).values({ threadId, budId: buds[1], createdByUserId: owners[1] });
    const a = await repo.admit({ ...input, owner: owners[1], threadId, idempotencyKey: "context-a", clientId: generateMessageClientId(), text: "First instruction" });
    const b = await repo.admit({ ...input, owner: owners[1], threadId, idempotencyKey: "context-b", clientId: generateMessageClientId(), text: "Later instruction",
      metadata: { model_context_at: "2000-01-01T00:00:00Z" } });
    // Simulate clock skew / same-tick ordering: activation must advance past
    // prior visible context, not depend on admission UUID ordering.
    const priorAt = new Date(Date.now() + 1000);
    await database.insert(schema.messageTable).values({ threadId, clientId: generateMessageClientId(),
      role: "assistant", displayRole: "Bud", content: "Prior completed work", createdAt: priorAt, createdByUserId: owners[1] });
    const loader = new AgentConversationLoader();
    assert.doesNotMatch(JSON.stringify(await loader.load(threadId)), /First instruction|Later instruction/);
    const leaseA = await repo.claim("context-worker", owners[1]);
    assert.equal(leaseA?.id, a.invocation.id);
    await repo.start(leaseA!);
    const before = JSON.stringify(await loader.load(threadId));
    assert.match(before, /First instruction/);
    assert.doesNotMatch(before, /Later instruction/);
    const boundary = await getCurrentContextCheckpointBoundary(threadId);
    assert.equal(boundary.messageId, a.message.messageId);
    assert.ok(boundary.messageCreatedAt!.getTime() > priorAt.getTime());
    await recordCompletedContextCheckpoint({ threadId, trigger: "auto", reason: "context_limit", phase: "pre_turn",
      sourceProvider: "openai", sourceModel: "fixture", summary: "Earlier instruction handled",
      replacementHistory: [{ role: "user", content: "Earlier instruction handled" }], boundaries: boundary, ownerUserId: owners[1] });
    await repo.finish(leaseA!, "succeeded", "completed");
    const leaseB = await repo.claim("context-worker", owners[1]);
    assert.equal(leaseB?.id, b.invocation.id);
    await repo.start(leaseB!);
    const after = JSON.stringify(await loader.load(threadId));
    assert.match(after, /Later instruction/);
    assert.doesNotMatch(after, /First instruction/);
    const [stored] = await database.select().from(schema.messageTable).where(eq(schema.messageTable.messageId, b.message.messageId));
    assert.equal(stored.createdAt.getTime(), b.message.createdAt.getTime(), "UI transcript timestamps are unchanged");
    await repo.finish(leaseB!, "succeeded", "completed");
  });

  await t.test("automation input never becomes a system instruction", async () => {
    const threadId = randomUUID();
    threads.push(threadId);
    await database.insert(schema.threadTable).values({ threadId, budId: buds[0], createdByUserId: owners[0] });
    const admitted = await repo.admit({ ...input, threadId, origin: "automation", idempotencyKey: "automation-priority",
      clientId: generateMessageClientId(), text: "Imported contact text" });
    const leased = await repo.claim("automation-context-worker", owners[0]);
    assert.equal(leased?.id, admitted.invocation.id);
    await repo.start(leased!);
    const messages = await new AgentConversationLoader().load(threadId);
    assert.equal(messages.filter(message => message.role === "system").length, 1);
    const automation = messages.find(message => JSON.stringify(message.content).includes("Imported contact text"));
    assert.equal(automation?.role, "user");
    await repo.finish(leased!, "succeeded", "completed");
  });

  await t.test("owner review abandons uncertain work once without erasing its evidence", async () => {
    await assert.rejects(repo.abandonReviewed(owners[1], threads[0], review.id, review.updatedAt.toISOString()), /invocation_not_found/);
    await assert.rejects(repo.abandonReviewed(owners[0], threads[1], review.id, review.updatedAt.toISOString()), /invocation_not_found/);
    await assert.rejects(repo.abandonReviewed(owners[0], threads[0], review.id, new Date(0).toISOString()), /invocation_review_conflict/);
    const results = await Promise.all([0, 1].map(() => repo.abandonReviewed(owners[0], threads[0], review.id, review.updatedAt.toISOString())));
    assert.ok(results.every(row => row.status === "canceled" && !row.reservesThread));
    assert.equal(results[0].outcomeCode, "user_abandoned_after_review");
    assert.equal(results[0].canceledByUserId, owners[0]);
    const actions = await database.select().from(schema.agentInvocationActionTable)
      .where(eq(schema.agentInvocationActionTable.invocationId, review.id));
    assert.equal(actions.filter(row => row.kind === "owner_review").length, 1);
    assert.equal(actions.find(row => row.callId === "call-one")?.status, "intent", "uncertain effects remain uncertain");
    await assert.rejects(repo.recordAction(retry, "stale-dispatch", "terminal.send"), /lease_lost/);
    const next = await repo.claim("after-owner-review", owners[0]);
    assert.ok(next);
    assert.notEqual(next.id, review.id, "abandonment never replays the reviewed invocation");
    await assert.rejects(repo.abandonReviewed(owners[0], next.threadId, next.id, next.updatedAt.toISOString()), /invocation_review_conflict/);
    await repo.finish(next, "succeeded", "completed");
  });
});
