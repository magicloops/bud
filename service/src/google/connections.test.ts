import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { GoogleConnections } from "./connections.js";
import { GoogleOAuth } from "./oauth.js";
import { registerGoogleRoutes } from "./routes.js";
import { googleFixture } from "./test-fixture.js";
import { GOOGLE_SERVICES, serviceScopes, type GoogleSelection } from "./config.js";
import { decryptGoogleCredentials, encryptGoogleCredentials } from "./credentials.js";

test("owned Google grants: callback binding, expiry, replay, partial consent, refresh and disconnect", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `google_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 4 });
  await pool.query(`create schema ${namespace}`);
  t.after(async () => { await pool.query(`drop schema ${namespace} cascade`); await pool.end(); });
  await pool.query("create table fixture_user(id text primary key); insert into fixture_user values ('alice'),('bob'),('carol'),('dave')");
  const migration = await readFile(new URL("../../drizzle/migrations/0067_google_connections.sql", import.meta.url), "utf8");
  await pool.query(migration.replaceAll('"auth"."user"', `"${namespace}"."fixture_user"`));
  const database = drizzle(pool, { schema }), fixture = googleFixture(), key = randomBytes(32);
  const factory = () => new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, fixture.fetcher), fixture.fetcher);
  let manager = factory();
  async function connect(owner: string) {
    const authorization = await manager.begin(owner, `${owner}-session`), url = new URL(authorization);
    fixture.authorize(authorization, owner);
    const params = new URLSearchParams({ state: url.searchParams.get("state")!, code: owner });
    await assert.rejects(manager.finish(owner === "alice" ? "bob" : "alice", `${owner}-session`, params), /google_invalid_oauth_state/);
    await assert.rejects(manager.finish(owner, "wrong-session", params), /google_invalid_oauth_state/);
    await manager.finish(owner, `${owner}-session`, params);
    await assert.rejects(manager.finish(owner, `${owner}-session`, params), /google_invalid_oauth_state/);
    return (await manager.list(owner))[0].connection_id;
  }
  const alice = await connect("alice"), bob = await connect("bob");
  manager = factory();
  const request = { method: "GET" as const, path: "/users/me/calendarList" }, signal = new AbortController().signal;
  await assert.rejects(manager.call("bob", alice, request, signal, async () => {}), /google_not_found/);
  await assert.rejects(manager.disconnect("bob", alice), /google_not_found/);
  for (const [owner, id] of [["alice", alice], ["bob", bob]]) await manager.call(owner, id, request, signal, async () => {});
  assert.deepEqual(fixture.calls.map(call => call.owner), ["alice", "bob"]);
  const stored = (await pool.query("select * from google_connection where id=$1", [bob])).rows[0];
  assert.ok(stored.encrypted_credentials.startsWith("v1.")); assert.equal(stored.oauth_state_hash, null);
  const aad = JSON.stringify(["bob", bob, fixture.config.clientId]);
  const credentials = decryptGoogleCredentials(stored.encrypted_credentials, aad, key);
  credentials.tokens!.expiry_date = Date.now() - 1000;
  await pool.query("update google_connection set encrypted_credentials=$1 where id=$2", [encryptGoogleCredentials(credentials, aad, key), bob]);
  await manager.call("bob", bob, request, signal, async () => {});
  manager = factory(); await manager.call("bob", bob, request, signal, async () => {});
  assert.equal(fixture.refreshCount, 1);

  // One explicit selection grants only the requested scopes and supports genuine read-only credentials.
  const connectSelected = async (owner: string, selections: GoogleSelection[]) => {
    const url = new URL(await manager.begin(owner, `${owner}-session`, undefined, selections));
    assert.equal(url.searchParams.get("include_granted_scopes"), "true");
    assert.deepEqual(new Set(url.searchParams.get("scope")!.split(" ")),
      new Set(selections.flatMap(selection => serviceScopes(selection.service, selection.access))));
    fixture.authorize(url.href, owner);
    await manager.finish(owner, `${owner}-session`, new URLSearchParams({ state: url.searchParams.get("state")!, code: owner }));
    return (await manager.list(owner))[0];
  };
  const readSelections = GOOGLE_SERVICES.map(service => ({ service, access: "read_only" as const }));
  const readOnly = await connectSelected("carol", readSelections);
  assert.equal(readOnly.calendar_access, true); assert.equal(readOnly.calendar_write_access, false);
  assert.equal(readOnly.write_policy.calendar, "read_only");
  let dispatches = 0;
  const beforeWrite = async () => { dispatches++; };
  const write = { method: "POST" as const, path: "/calendars/primary/events", body: { summary: "reviewed" } };
  await manager.call("carol", readOnly.connection_id, { method: "POST", path: "/freeBusy", body: {} }, signal, async () => {});
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_calendar_write_permissions_required/);
  await assert.rejects(manager.setPolicy("carol", readOnly.connection_id, "calendar", "ask_before_write"), /google_calendar_write_permissions_required/);
  await assert.rejects(manager.setPolicy("bob", readOnly.connection_id, "calendar", "read_only"), /google_not_found/);
  assert.equal(dispatches, 0);
  const canceledUpgrade = new URL(await manager.begin("carol", "carol-session"));
  await assert.rejects(manager.finish("carol", "carol-session", new URLSearchParams({ state: canceledUpgrade.searchParams.get("state")!, error: "access_denied" })), /google_consent_canceled/);
  assert.equal((await manager.list("carol"))[0].calendar_access, true);
  await connectSelected("carol", [{ service: "calendar", access: "read_write" }]);
  const originalGrant = await manager.writeContext("carol", readOnly.connection_id);
  await manager.call("carol", readOnly.connection_id, write, signal, async (phase, context) => {
    assert.equal(phase, "dispatch"); assert.deepEqual(context, originalGrant); dispatches++;
  });
  await manager.setPolicy("carol", readOnly.connection_id, "calendar", "read_only");
  assert.equal((await manager.list("carol"))[0].calendar_write_access, true);
  assert.equal((await manager.list("carol"))[0].write_policy.calendar, "read_only");
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_write_policy_read_only/);
  await manager.call("carol", readOnly.connection_id, request, signal, async () => {});
  await manager.setPolicy("carol", readOnly.connection_id, "calendar", "ask_before_write");
  const restoredGrant = await manager.writeContext("carol", readOnly.connection_id);
  assert.notEqual(restoredGrant.grant_id, originalGrant.grant_id);
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite, "calendar", { access: "read" }), /google_invalid_request/);
  const previousWrites = process.env.GOOGLE_WRITES_ENABLED;
  const restoreWrites = () => { if (previousWrites === undefined) delete process.env.GOOGLE_WRITES_ENABLED; else process.env.GOOGLE_WRITES_ENABLED = previousWrites; };
  try {
    process.env.GOOGLE_WRITES_ENABLED = "false";
    await manager.call("carol", readOnly.connection_id, request, signal, async () => {});
    await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_writes_disabled/);
    await assert.rejects(manager.writeContext("carol", readOnly.connection_id), /google_writes_disabled/);
    process.env.GOOGLE_WRITES_ENABLED = "true";
    const countBefore = fixture.calls.length;
    await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, async () => {
      process.env.GOOGLE_WRITES_ENABLED = "false";
    }), /google_writes_disabled/);
    assert.equal(fixture.calls.length, countBefore);
  } finally { restoreWrites(); }
  assert.equal(dispatches, 1);
  // Refresh narrowing scopes fences a previously writable token before approval consumption.
  const carolStored = (await pool.query("select encrypted_credentials from google_connection where id=$1", [readOnly.connection_id])).rows[0];
  const carolAad = JSON.stringify(["carol", readOnly.connection_id, fixture.config.clientId]);
  const carolData = decryptGoogleCredentials(carolStored.encrypted_credentials, carolAad, key);
  carolData.tokens!.expiry_date = Date.now() - 1000;
  await pool.query("update google_connection set encrypted_credentials=$1 where id=$2", [encryptGoogleCredentials(carolData, carolAad, key), readOnly.connection_id]);
  fixture.refreshedScopes(serviceScopes("calendar", "read_only"));
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_calendar_write_permissions_required/);
  fixture.refreshedScopes();
  assert.equal((await manager.list("carol"))[0].calendar_write_access, false);
  await manager.call("carol", readOnly.connection_id, request, signal, async () => {});
  assert.equal(dispatches, 1);
  // Disconnect/reconnect changes the identity generation even for the same Google subject.
  await manager.disconnect("carol", readOnly.connection_id);
  await connectSelected("carol", [{ service: "calendar", access: "read_write" }]);
  assert.notEqual((await manager.writeContext("carol", readOnly.connection_id)).grant_id, restoredGrant.grant_id);
  // A partial combined grant can connect the accepted service without granting the declined ones.
  fixture.grantOnly(serviceScopes("calendar", "read_only"));
  const partial = await connectSelected("dave", GOOGLE_SERVICES.map(service => ({ service, access: "read_write" })));
  fixture.grantOnly();
  assert.equal(partial.calendar_access, true); assert.equal(partial.calendar_write_access, false);
  assert.equal(partial.write_policy.calendar, "read_only");

  const app = Fastify();
  let deletedThread = false;
  await registerGoogleRoutes(app, manager, async (request, reply) => {
    const owner = request.headers["x-test-owner"];
    if (typeof owner !== "string") { reply.code(401).send({ error: "unauthorized" }); return null; }
    return { userId: owner, sessionId: `${owner}-session`, email: null, authType: "cookie" };
  }, () => true, async (actor, threadId) => !deletedThread && threadId === `${actor.userId}-thread`
    ? { threadId, budId: `${actor.userId}-bud` } : null);
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/api/google/connection" })).statusCode, 401);
  const inventory = await app.inject({ method: "GET", url: "/api/google/connection", headers: { "x-test-owner": "alice" } });
  assert.equal(inventory.json().connections.length, 1); assert.ok(!inventory.body.includes("encrypted_credentials"));
  assert.equal((await app.inject({ method: "DELETE", url: `/api/google/connection/${alice}`, headers: { "x-test-owner": "alice", origin: "https://attacker.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/google/connection/${alice}`, headers: { "x-test-owner": "bob", origin: config.betterAuthTrustedOrigins[0] } })).statusCode, 404);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const active = manager.call("alice", alice, request, signal, async () => { started(); await held; });
  await entered;
  const disconnected = manager.disconnect("alice", alice);
  release(); await active; await disconnected;
  await assert.rejects(manager.call("alice", alice, request, signal, async () => {}), /google_reconnect_required/);
  assert.equal((await pool.query("select encrypted_credentials from google_connection where id=$1", [alice])).rows[0].encrypted_credentials, null);
  const headers = { "x-test-owner": "alice", origin: config.betterAuthTrustedOrigins[0] };
  for (const payload of [{ thread_id: "bob-thread" }, { thread_id: "missing-thread" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers, payload })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { return_url: "https://attacker.example" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers: { ...headers, origin: "https://attacker.example" }, payload: { thread_id: "alice-thread" } })).statusCode, 403);
  const start = async (thread_id?: string) => {
    const response = await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { thread_id } });
    assert.equal(response.statusCode, 200);
    const url = new URL(response.json().authorization_url);
    fixture.authorize(url.href, "alice");
    return url.searchParams.get("state")!;
  };
  const callback = async (state: string, error?: string) => {
    const response = await app.inject({ method: "GET", url: `/api/google/callback?${new URLSearchParams({ state, ...(error ? { error } : { code: "alice" }) })}`, headers });
    assert.equal(response.statusCode, 303);
    return new URL(response.headers.location!);
  };
  const state = await start("alice-thread");
  // Restarted process recovers encrypted return context without browser storage.
  assert.equal(await factory().finish("alice", "alice-session", new URLSearchParams({ state, code: "alice" })), "alice-thread");
  assert.equal((await callback(state)).pathname, "/settings"); // replay cannot recover return context
  let target = await callback(await start("alice-thread"));
  assert.equal(target.href, "https://bud.example/alice-bud/alice-thread?google=connected");
  target = await callback(await start("alice-thread"), "access_denied");
  assert.equal(target.href, "https://bud.example/alice-bud/alice-thread?google=failed");
  assert.equal((await callback(await start())).pathname, "/settings"); // no stale chat return
  const deletedState = await start("alice-thread"); deletedThread = true;
  assert.equal((await callback(deletedState)).pathname, "/settings");
  assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { thread_id: "alice-thread" } })).statusCode, 404);
  deletedThread = false;
  let auth = new URL(await manager.begin("alice", "alice-session"));
  await pool.query("update google_connection set oauth_expires_at=now()-interval '1 second' where id=$1", [alice]);
  await assert.rejects(manager.finish("alice", "alice-session", new URLSearchParams({ state: auth.searchParams.get("state")!, code: "alice" })), /google_invalid_oauth_state/);
  auth = new URL(await manager.begin("alice", "alice-session"));
  await assert.rejects(manager.finish("alice", "alice-session", new URLSearchParams({ state: auth.searchParams.get("state")!, error: "access_denied" })), /google_consent_canceled/);
  assert.equal((await manager.list("alice"))[0].status, "connected");
  auth = new URL(await manager.begin("alice", "alice-session")); fixture.authorize(auth.href, "alice"); fixture.partialScopes();
  await assert.rejects(manager.finish("alice", "alice-session", new URLSearchParams({ state: auth.searchParams.get("state")!, code: "alice" })), /google_calendar_permissions_required/);
  assert.equal((await manager.list("alice"))[0].calendar_access, true);
  target = await callback(await start("alice-thread"));
  assert.equal(target.href, "https://bud.example/alice-bud/alice-thread?google=permissions_required");
  const encrypted = (await pool.query("select encrypted_credentials from google_connection where id=$1", [alice])).rows[0].encrypted_credentials;
  const finalCredentials = decryptGoogleCredentials(encrypted, JSON.stringify(["alice", alice, fixture.config.clientId]), key);
  assert.equal(finalCredentials.returnThreadId, undefined);
  assert.equal(finalCredentials.verifier, undefined);
});
