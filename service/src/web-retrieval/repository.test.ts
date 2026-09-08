import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { RetrievalRepository } from "./repository.js";
import { WebRetrieval } from "./retrieval.js";
import type { Page, RetrievalContext } from "./contracts.js";

test("PostgreSQL ownership, durable budgets, replay, pagination, cancellation and cleanup", async () => {
  const namespace = `web_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}` });
  try {
    await admin.query(`create schema "${namespace}"`);
    for (const table of ["bud", "thread", "agent_invocation", "agent_invocation_action"])
      await pool.query(`create table "${table}" (like public."${table}" including all)`);
    const migration = await readFile(new URL("../../drizzle/migrations/0037_huge_wendigo.sql", import.meta.url), "utf8");
    await pool.query(migration.replaceAll('"public".', `"${namespace}".`));
    await pool.query("insert into bud (bud_id,name,os,arch,created_by_user_id) values ('a','fixture','test','test','alice'),('b','fixture','test','test','bob')");
    const threads = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query("insert into thread (thread_id,bud_id,created_by_user_id) values ($1,'a','alice'),($2,'a','alice'),($3,'b','bob')", threads);
    const context: RetrievalContext = { owner: "alice", threadId: threads[0], turnId: "turn", callId: "search" };
    const repository = new RetrievalRepository(drizzle(pool, { schema }));
    let reads = 0, searches = 0;
    const backend = { name: "fixture", search: async () => { searches++; return [{ url: "https://docs.firecrawl.dev/", title: "Docs", snippet: "Evidence" }]; },
      read: async (): Promise<Page> => { reads++; return { url: "https://docs.firecrawl.dev/", title: "Docs", text: "a🙂bc", fetched_at: new Date().toISOString(), freshness: "origin_requested", truncated: false }; } };
    const retrieval = new WebRetrieval({ search: backend, read: backend }, repository);
    const search = await retrieval.execute("web_search", { query: "docs" }, context);
    assert.equal(searches, 1);
    assert.deepEqual(await new WebRetrieval({ search: backend, read: backend }, new RetrievalRepository(drizzle(pool, { schema })))
      .execute("web_search", { query: "docs" }, context), search);
    assert.equal(searches, 1);
    const resultRef = (search.results as { reference_id: string }[])[0].reference_id;
    const page = await retrieval.execute("web_read", { url_or_reference: resultRef, length: 2 }, { ...context, callId: "read" });
    assert.equal(page.text, "a🙂"); assert.equal(page.next_start, 2);
    const tail = await retrieval.execute("web_read", { url_or_reference: page.reference_id, start: 2 }, { ...context, callId: "page" });
    assert.equal(tail.text, "bc"); assert.equal(reads, 1);
    for (const denied of [{ ...context, owner: "bob" }, { ...context, threadId: threads[1] }, { ...context, owner: "bob", threadId: threads[2] }])
      await assert.rejects(retrieval.execute("web_read", { url_or_reference: page.reference_id }, denied));
    await repository.reserve({ ...context, callId: "interrupted" }, "fingerprint", "fixture");
    await assert.rejects(repository.reserve({ ...context, callId: "interrupted" }, "fingerprint", "fixture"), { code: "outcome_unknown" });
    const reservations = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => repository.reserve({ ...context, callId: `budget${i}` }, `${i}`, "fixture")));
    assert.equal(reservations.filter(r => r.status === "fulfilled").length, 7);
    assert.equal((await pool.query("select count(*)::int as n from web_retrieval_request")).rows[0].n, 10);
    await pool.query("update web_retrieval_artifact set expires_at=now()-interval '1 second'");
    await assert.rejects(retrieval.execute("web_read", { url_or_reference: page.reference_id }, context), { code: "reference_unavailable" });
    await repository.cleanup();
    assert.equal((await pool.query("select count(*)::int as n from web_retrieval_artifact")).rows[0].n, 0);
    assert.equal((await pool.query("select count(*)::int as n from web_retrieval_request")).rows[0].n, 10);
    // Durable authorization requires a live intent with the current fence.
    const durable = { ...context, turnId: "durable", callId: "call" };
    await pool.query("insert into agent_invocation (id,turn_id,thread_id,bud_id,input_message_id,origin,idempotency_key,model,reasoning_effort,status,worker_id,lease_expires_at,created_by_user_id,fence) values ('iv','durable',$1,'a',$2,'human','fixture','model','low','running','worker',now()+interval '1 minute','alice',1)", [threads[0], randomUUID()]);
    await assert.rejects(repository.authorize(durable), { code: "execution_changed" });
    await pool.query("insert into agent_invocation_action (id,invocation_id,call_id,fence,kind,created_by_user_id) values ('action','iv','call',1,'web_search','alice')");
    const reserved = await repository.reserve(durable, "durable", "fixture");
    await pool.query("update agent_invocation set cancel_requested_at=now() where id='iv'");
    await assert.rejects(repository.complete(durable, reserved.id, reserved.authority, "search", "fixture", { results: [] }), { code: "execution_changed" });
    assert.equal((await pool.query("select count(*)::int as n from web_retrieval_artifact")).rows[0].n, 0);
  } finally {
    await pool.end();
    await admin.query(`drop schema if exists "${namespace}" cascade`);
    await admin.end();
  }
});
