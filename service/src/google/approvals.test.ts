import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { GoogleApprovals, canonicalGoogleArguments, parseGoogleApproval, serializeGoogleApproval, type GoogleApproval } from "./approvals.js";
import { GoogleConnections } from "./connections.js";
import { GoogleOAuth } from "./oauth.js";
import { registerGoogleRoutes } from "./routes.js";
import { googleFixture } from "./test-fixture.js";

const example = (): GoogleApproval => ({
  approval_id: "approval", thread_id: randomUUID(), invocation_id: "invocation", connection_id: "connection",
  service: "calendar", tool_name: "calendar_create_event", arguments_json: canonicalGoogleArguments({ summary: "Reviewed event", start: "2026-12-01T12:00:00Z" }),
  operation_id: "operation", account_subject: "google-alice", account_email: "alice@example.com", grant_id: "grant",
  status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
});

test("Google approval parsing and public projection fail closed on invalid persisted data", () => {
  const approval = example();
  assert.equal(canonicalGoogleArguments({ b: [{ y: 2, x: 1 }], a: 0 }), canonicalGoogleArguments({ a: 0, b: [{ x: 1, y: 2 }] }));
  assert.equal(parseGoogleApproval(approval), approval);
  for (const invalid of [null, {}, { ...approval, service: "admin" }, { ...approval, expires_at: "invalid" }, { ...approval, created_at: "invalid" }]) {
    assert.throws(() => parseGoogleApproval(invalid), /google_not_found/);
  }
  const exposed = serializeGoogleApproval(approval);
  for (const key of ["account_subject", "grant_id", "operation_id", "invocation_id", "connection_id"]) assert.equal(Object.hasOwn(exposed, key), false);
  assert.equal(exposed.account_email, "alice@example.com");
  assert.equal(exposed.arguments_json, approval.arguments_json);
});

test("Google approvals: PostgreSQL ownership, exact action, single-use decisions and browser policy", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `google_approval_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 6, application_name: namespace });
  await pool.query(`create schema "${namespace}"`);
  t.after(async () => { await pool.query(`drop schema "${namespace}" cascade`); await pool.end(); });
  // Use deployed table columns/defaults/checks without copying unrelated ownership FKs.
  // Missing cross-table FKs deliberately permit malformed owner fixtures to exercise every SQL guard.
  for (const table of ["bud", "thread", "agent_invocation", "agent_invocation_action"]) {
    await pool.query(`create table "${table}" (like public."${table}" including all)`);
  }
  await pool.query("create table fixture_user(id text primary key); insert into fixture_user values ('alice'),('bob')");
  const migration = await readFile(new URL("../../drizzle/migrations/0067_google_connections.sql", import.meta.url), "utf8");
  await pool.query(migration.replaceAll('"auth"."user"', `"${namespace}"."fixture_user"`));
  await pool.query("insert into bud (bud_id,name,os,arch,created_by_user_id) values ('a','fixture','test','test','alice'),('b','fixture','test','test','bob')");
  const database = drizzle(pool, { schema }), transport = googleFixture(), key = randomBytes(32);
  const manager = new GoogleConnections(transport.config, database, () => key, new GoogleOAuth(transport.config, transport.fetcher), transport.fetcher);
  const approvals = new GoogleApprovals(database);
  const oauthUrl = new URL(await manager.begin("alice", "alice-session"));
  transport.authorize(oauthUrl.href, "alice");
  await manager.finish("alice", "alice-session", new URLSearchParams({ state: oauthUrl.searchParams.get("state")!, code: "alice" }));
  const connection = (await manager.list("alice"))[0].connection_id;
  const seed = async (overrides: Partial<GoogleApproval> = {}) => {
    const id = randomUUID(), threadId = randomUUID(), invocationId = `iv_${id}`;
    const identity = await manager.writeContext("alice", connection);
    const approval: GoogleApproval = { ...example(), approval_id: `action_${id}`, thread_id: threadId, invocation_id: invocationId,
      operation_id: `operation_${id}`, connection_id: connection, ...identity, ...overrides };
    await pool.query("insert into thread (thread_id,bud_id,created_by_user_id) values ($1,'a','alice')", [threadId]);
    await pool.query(`insert into agent_invocation
      (id,turn_id,thread_id,bud_id,input_message_id,origin,idempotency_key,model,reasoning_effort,status,created_by_user_id,fence)
      values ($1,$2,$3,'a',$4,'human',$5,'fixture','low','waiting_for_user','alice',1)`,
      [invocationId, `turn_${id}`, threadId, randomUUID(), `fixture_${id}`]);
    await pool.query(`insert into agent_invocation_action (id,invocation_id,call_id,fence,kind,status,evidence,created_by_user_id)
      values ($1,$2,$3,1,'google_call','waiting_for_user',$4,'alice')`,
      [approval.approval_id, invocationId, `call_${id}`, { google_approval: approval, fixture: "preserve me" }]);
    return approval;
  };
  const expected = (approval: GoogleApproval) => ({ connection_id: approval.connection_id, service: approval.service,
    tool_name: approval.tool_name, arguments_json: approval.arguments_json });
  const identity = (approval: GoogleApproval) => ({ account_subject: approval.account_subject, grant_id: approval.grant_id });
  const approve = (approval: GoogleApproval) => approvals.decide("alice", approval.approval_id, "approved", identity(approval));
  const lookup = (approval: GoogleApproval) => approvals.approved("alice", approval.approval_id, approval.thread_id, approval.invocation_id, expected(approval));

  const app = Fastify();
  await registerGoogleRoutes(app, manager, async (request, reply) => {
    const owner = request.headers["x-test-owner"];
    if (typeof owner !== "string") { reply.code(401).send({ error: "unauthorized" }); return null; }
    return { userId: owner, sessionId: `${owner}-session`, email: null, authType: "cookie" };
  }, () => true, async () => null, approvals);
  t.after(() => app.close());
  const headers = { "x-test-owner": "alice", origin: config.betterAuthTrustedOrigins[0] };
  const routeGet = (approval: GoogleApproval, owner = "alice") => app.inject({ method: "GET", url: `/api/google/approvals/${approval.approval_id}`, headers: { "x-test-owner": owner } });
  const routeDecide = (approval: GoogleApproval, decision = "approved") => app.inject({ method: "POST", url: `/api/google/approvals/${approval.approval_id}/decision`, headers, payload: { decision } });

  await t.test("every resource owner and live thread is rechecked before reading or deciding", async () => {
    const approval = await seed();
    assert.equal((await routeGet(approval, "bob")).statusCode, 404);
    await assert.rejects(approvals.decide("bob", approval.approval_id, "approved", identity(approval)), /google_not_found/);
    const fixtures = [
      { table: "agent_invocation_action", key: "id", id: approval.approval_id },
      { table: "agent_invocation", key: "id", id: approval.invocation_id },
      { table: "thread", key: "thread_id", id: approval.thread_id },
      { table: "bud", key: "bud_id", id: "a" },
    ];
    for (const fixture of fixtures) {
      await pool.query(`update ${fixture.table} set created_by_user_id='bob' where ${fixture.key}=$1`, [fixture.id]);
      try {
        assert.equal((await routeGet(approval)).statusCode, 404, fixture.table);
        assert.equal((await routeDecide(approval)).statusCode, 404, fixture.table);
      } finally {
        await pool.query(`update ${fixture.table} set created_by_user_id='alice' where ${fixture.key}=$1`, [fixture.id]);
      }
    }
    await pool.query("update thread set deleted_at=now() where thread_id=$1", [approval.thread_id]);
    assert.equal((await routeGet(approval)).statusCode, 404);
    assert.equal((await routeDecide(approval)).statusCode, 404);
  });

  await t.test("browser decisions require authentication, same-origin cookies and narrow payloads", async () => {
    const approval = await seed(), url = `/api/google/approvals/${approval.approval_id}/decision`;
    assert.equal((await app.inject({ method: "GET", url: `/api/google/approvals/${approval.approval_id}` })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, payload: { decision: "approved" } })).statusCode, 401);
    for (const origin of [undefined, "https://attacker.example"]) {
      assert.equal((await app.inject({ method: "POST", url, headers: { "x-test-owner": "alice", ...(origin ? { origin } : {}) }, payload: { decision: "approved" } })).statusCode, 403);
    }
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { decision: "approved", arguments_json: "{}" } })).statusCode, 400);
    assert.equal((await routeDecide(approval, "allow_forever")).statusCode, 400);
    const response = await routeGet(approval);
    assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json().approval, JSON.parse(JSON.stringify(serializeGoogleApproval(approval))));
    for (const secret of [approval.account_subject, approval.grant_id, approval.operation_id, approval.invocation_id, approval.connection_id]) assert.ok(!response.body.includes(secret));
    assert.equal((await approvals.get("alice", approval.approval_id)).status, "pending");
  });

  await t.test("approval binds the exact action, original invocation, and current Google identity", async () => {
    const approval = await seed();
    await assert.rejects(lookup(approval), /google_approval_required/);
    await assert.rejects(approvals.consume("alice", approval, identity(approval)), /google_approval_required/);
    for (const changed of [{ ...identity(approval), account_subject: "other-subject" }, { ...identity(approval), grant_id: "other-grant" }]) {
      await assert.rejects(approvals.decide("alice", approval.approval_id, "approved", changed), /google_approval_connection_changed/);
    }
    await approve(approval);
    await assert.rejects(approvals.decide("alice", approval.approval_id, "approved", { ...identity(approval), grant_id: "reconnected" }), /google_approval_connection_changed/);
    await assert.rejects(approvals.approved("alice", approval.approval_id, randomUUID(), approval.invocation_id, expected(approval)), /google_not_found/);
    await assert.rejects(approvals.approved("alice", approval.approval_id, approval.thread_id, "other-invocation", expected(approval)), /google_not_found/);
    for (const change of [{ connection_id: "other-connection" }, { service: "unsupported" as GoogleApproval["service"] }, { tool_name: "calendar_delete_event" }, { arguments_json: "{}" }]) {
      await assert.rejects(approvals.approved("alice", approval.approval_id, approval.thread_id, approval.invocation_id, { ...expected(approval), ...change }), /google_approval_action_changed/);
    }
    for (const changed of [{ ...identity(approval), account_subject: "other-subject" }, { ...identity(approval), grant_id: "other-grant" }]) {
      await assert.rejects(approvals.consume("alice", approval, changed), /google_approval_connection_changed/);
    }
    await assert.rejects(approvals.consume("alice", { ...approval, operation_id: "other-operation" }, identity(approval)), /google_approval_action_changed/);
    assert.equal((await lookup(approval)).operation_id, approval.operation_id);
  });

  await t.test("decisions are idempotent and approval consumption is concurrent single use", async () => {
    const approval = await seed();
    const first = await approve(approval), again = await approve(approval);
    assert.deepEqual(again, first);
    await assert.rejects(approvals.decide("alice", approval.approval_id, "rejected"), /google_approval_already_decided/);
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => approvals.consume("alice", first, identity(first))));
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    for (const result of attempts) if (result.status === "rejected") assert.match(result.reason.message, /google_approval_required/);
    assert.equal((await approvals.get("alice", approval.approval_id)).status, "consumed");
    const persisted = (await pool.query("select evidence from agent_invocation_action where id=$1", [approval.approval_id])).rows[0].evidence;
    assert.equal(persisted.fixture, "preserve me"); assert.ok(persisted.google_approval.consumed_at);
    const rejected = await seed();
    await approvals.decide("alice", rejected.approval_id, "rejected");
    await approvals.decide("alice", rejected.approval_id, "rejected");
    await assert.rejects(approve(rejected), /google_approval_already_decided/);
    await assert.rejects(approvals.consume("alice", rejected, identity(rejected)), /google_approval_required/);
  });

  await t.test("expired approvals and pending, canceled or finished invocations never authorize dispatch", async () => {
    const expired = await seed({ expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await approvals.get("alice", expired.approval_id)).status, "expired");
    await assert.rejects(approve(expired), /google_approval_expired/);
    const expiredApproved = await seed({ status: "approved", expires_at: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(lookup(expiredApproved), /google_approval_expired/);
    await assert.rejects(approvals.consume("alice", expiredApproved, identity(expiredApproved)), /google_approval_expired/);
    for (const status of ["pending", "canceled", "succeeded", "failed", "expired", "needs_review"]) {
      const approval = await seed({ status: "approved" });
      await pool.query("update agent_invocation set status=$1 where id=$2", [status, approval.invocation_id]);
      assert.equal((await approvals.get("alice", approval.approval_id)).status, "expired");
      await assert.rejects(lookup(approval), /google_approval_inactive/);
      await assert.rejects(approvals.consume("alice", approval, identity(approval)), /google_approval_inactive/);
      assert.equal((await routeDecide(approval)).statusCode, 409);
    }
    const canceling = await seed({ status: "approved" });
    await pool.query("update agent_invocation set cancel_requested_at=now() where id=$1", [canceling.invocation_id]);
    await assert.rejects(approvals.consume("alice", canceling, identity(canceling)), /google_approval_inactive/);
  });

  await t.test("continuation deferrals retain valid approvals and cancellation serializes before consumption", async () => {
    for (const status of ["waiting_for_model", "waiting_for_bud", "retry_wait"]) {
      const approval = await seed({ status: "approved" });
      await pool.query("update agent_invocation set status=$1 where id=$2", [status, approval.invocation_id]);
      assert.equal((await approvals.get("alice", approval.approval_id)).status, "approved");
      assert.equal((await lookup(approval)).status, "approved");
    }
    const approval = await seed({ status: "approved" }), cancellation = await pool.connect();
    let attempt: Promise<void> | undefined;
    try {
      await cancellation.query("begin");
      await cancellation.query("select id from agent_invocation where id=$1 for update", [approval.invocation_id]);
      let settled = false;
      attempt = approvals.consume("alice", approval, identity(approval));
      void attempt.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline && !settled) {
        const result = await pool.query("select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [namespace]);
        if (result.rows[0].count > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(blocked, true, "consumption must wait for the invocation lock before touching the approval");
      await cancellation.query("update agent_invocation set cancel_requested_at=now() where id=$1", [approval.invocation_id]);
      await cancellation.query("commit");
      await assert.rejects(attempt, /google_approval_inactive/);
      const persisted = (await pool.query("select evidence from agent_invocation_action where id=$1", [approval.approval_id])).rows[0].evidence;
      assert.equal(persisted.google_approval.status, "approved");
    } finally {
      await cancellation.query("rollback"); cancellation.release();
      await attempt?.catch(() => {});
    }
  });

  await t.test("approval route enforces global disable and live connection policy before deciding", async () => {
    const approval = await seed(), previous = process.env.GOOGLE_WRITES_ENABLED;
    try {
      process.env.GOOGLE_WRITES_ENABLED = "false";
      const denied = await routeDecide(approval);
      assert.equal(denied.statusCode, 409); assert.equal(denied.json().error, "google_writes_disabled");
      assert.equal((await approvals.get("alice", approval.approval_id)).status, "pending");
      assert.equal((await routeDecide(approval, "rejected")).statusCode, 200);
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_WRITES_ENABLED; else process.env.GOOGLE_WRITES_ENABLED = previous;
    }
    const policyApproval = await seed();
    await manager.setPolicy("alice", connection, "calendar", "read_only");
    const denied = await routeDecide(policyApproval);
    assert.equal(denied.statusCode, 409); assert.equal(denied.json().error, "google_write_policy_read_only");
    await manager.setPolicy("alice", connection, "calendar", "ask_before_write");
    const stale = await routeDecide(policyApproval);
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, "google_approval_connection_changed");
    const current = await seed();
    assert.equal((await routeDecide(current)).statusCode, 200);
    assert.equal((await routeDecide(current)).statusCode, 200);
    assert.equal((await lookup(current)).status, "approved");
    // Consent and browser decisions only update state; they never execute a Google write.
    assert.equal(transport.calls.length, 0);
  });
});
