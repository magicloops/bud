import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import * as s from "../db/schema.js";
import { normalizeAskUserQuestionsRequest } from "./user-question-contracts.js";
import { createAgentQuestionRequest, sourceDeclines } from "./user-question-repository.js";

test("a source declined in a conversation isn't asked for again there", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `declines_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  const database = drizzle(pool, { schema: s });
  t.after(async () => {
    await pool.end();
    try { await admin.query(`drop schema if exists "${namespace}" cascade`); }
    finally { await admin.end(); }
  });
  await admin.query(`create schema "${namespace}"`);
  await admin.query(`create table "${namespace}"."agent_question_request" (like public."agent_question_request" including all)`);

  const thread = randomUUID(), other = randomUUID();
  const ask = (threadId: string, source: string, extra: unknown[] = [], turnId = "turn") => createAgentQuestionRequest({ threadId, turnId, callId: randomUUID(),
    clientId: randomUUID(), ownerUserId: "alice", database, request: normalizeAskUserQuestionsRequest({ questions: [
      { question_id: "access", kind: "source_access", label: "To answer", source: { id: source } }, ...extra] }) });
  // Answers are ordered by when they were given; keep the test's in step with the service's own.
  let clock = 0;
  const declinedSources = async (threadId: string, db: typeof database) => (await sourceDeclines(threadId, db)).map(decline => decline.source);
  const answer = (id: string, status: string, response: unknown) => database.update(s.agentQuestionRequestTable)
    .set({ status: status as "answered", clientResponse: response as Record<string, unknown>, answeredAt: new Date(clock = Math.max(Date.now(), clock + 1)) })
    .where(sql`${s.agentQuestionRequestTable.questionRequestId} = ${id}`);

  // Nothing declined: the request waits for the user.
  const first = await ask(thread, "location");
  assert.deepEqual([first.row.status, first.settled], ["pending", undefined]);
  assert.deepEqual(await declinedSources(thread, database), []);

  // Granted, skipped (a follow-up message superseded it) and still-pending answers aren't declines.
  await answer(first.row.questionRequestId, "answered", { answers: [{ question_id: "access", status: "answered",
    answer: { kind: "source_access", outcome: "granted", source: "location" } }] });
  const superseded = await ask(thread, "health");
  await answer(superseded.row.questionRequestId, "answered", { answers: [{ question_id: "access", status: "skipped", skip_reason: "user_skipped" }] });
  assert.deepEqual(await declinedSources(thread, database), []);

  // The user declines location.
  const second = await ask(thread, "location");
  await answer(second.row.questionRequestId, "answered", { answers: [{ question_id: "access", status: "answered",
    answer: { kind: "source_access", outcome: "declined", source: "location" } }] });
  assert.deepEqual(await declinedSources(thread, database), ["location"]);

  // Asking again in the same turn is answered at once, stored as answered, with no card.
  const again = await ask(thread, "location", [{ question_id: "sure", kind: "boolean", label: "Continue?" }]);
  assert.equal(again.row.status, "answered");
  assert.ok(again.row.answeredAt && again.row.clientResponseId);
  assert.equal(again.row.answeredByUserId, null, "the service answered, not the user");
  assert.deepEqual(again.settled?.responses.map(response => [response.status, response.answer ?? response.skip_reason]), [
    ["answered", { kind: "source_access", outcome: "declined", source: "location", asked: false }], ["skipped", "not_applicable"]]);
  assert.deepEqual(again.row.toolResult, again.settled);

  // Other sources and other conversations are still asked.
  assert.equal((await ask(thread, "health")).row.status, "pending");
  assert.equal((await ask(other, "location")).row.status, "pending");
  assert.deepEqual(await declinedSources(other, database), []);

  // A later turn (the user has spoken since) may ask again.
  const later = await ask(thread, "location", [], "turn-2");
  assert.deepEqual([later.row.status, later.settled], ["pending", undefined]);
  assert.deepEqual(await declinedSources(thread, database), ["location"]);
  // Declined again: refused for the rest of that turn too.
  await answer(later.row.questionRequestId, "answered", { answers: [{ question_id: "access", status: "answered",
    answer: { kind: "source_access", outcome: "declined", source: "location" } }] });
  assert.equal((await ask(thread, "location", [], "turn-2")).row.status, "answered");
  // Allowed in a third turn: the decline is lifted.
  const third = await ask(thread, "location", [], "turn-3");
  await answer(third.row.questionRequestId, "answered", { answers: [{ question_id: "access", status: "answered",
    answer: { kind: "source_access", outcome: "granted", source: "location" } }] });
  assert.deepEqual(await declinedSources(thread, database), []);
  assert.equal((await ask(thread, "location", [], "turn-3")).row.status, "pending");
});
