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
import { decryptGoogleCredentials, encryptGoogleCredentials } from "./credentials.js";
import { GOOGLE_SERVICES, serviceScopes, type GoogleService, type GoogleSelection } from "./config.js";
import { DRIVE_TOOLS } from "./drive.js";

test("owned Google grants: callback binding, expiry, replay, partial consent, refresh and disconnect", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `google_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 4 });
  await pool.query(`create schema ${namespace}`);
  t.after(async () => { await pool.query(`drop schema ${namespace} cascade`); await pool.end(); });
  await pool.query("create table fixture_user(id text primary key); insert into fixture_user values ('alice'),('bob'),('carol'),('dave'),('erin')");
  const migration = await readFile(new URL("../../drizzle/migrations/0070_google_connections.sql", import.meta.url), "utf8");
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
  const grantService = async (service: GoogleService, code = "alice", error?: string) => {
    const url = new URL(await manager.begin("alice", "alice-session", undefined, [{ service, access: "read_write" }]));
    assert.equal(url.searchParams.get("login_hint"), "alice@example.com");
    fixture.authorize(url.href, code);
    // Existing Calendar stays usable during incremental consent.
    await manager.call("alice", alice, { method: "GET", path: "/users/me/calendarList" }, new AbortController().signal, async () => {});
    return manager.finish("alice", "alice-session", new URLSearchParams({ state: url.searchParams.get("state")!, ...(error ? { error } : { code }) }));
  };
  await assert.rejects(grantService("gmail", "alice", "access_denied"), /google_consent_canceled/);
  assert.equal((await manager.list("alice"))[0].status, "connected");
  assert.equal((await manager.list("alice"))[0].gmail_access, false);
  await assert.rejects(grantService("gmail", "another-account"), /google_account_mismatch/);
  assert.equal((await manager.list("alice"))[0].email, "alice@example.com");
  fixture.partialScopes();
  await assert.rejects(grantService("drive"), /google_calendar_permissions_required/);
  assert.equal((await manager.list("alice"))[0].calendar_access, true);
  fixture.partialScopes(false); fixture.omitRefresh();
  await grantService("gmail"); await grantService("drive");
  assert.equal((await manager.list("alice"))[0].gmail_access, true);
  assert.equal((await manager.list("alice"))[0].drive_access, true);
  assert.equal((await manager.list("alice"))[0].calendar_access, true);
  fixture.omitRefresh(false); fixture.calls.length = 0;
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
  for (const service of ["gmail", "drive"] as const) {
    const scoped = { method: "GET" as const, path: service === "gmail" ? "/messages" : "/files" };
    // Another account's scopes do not confer access on Bob's Calendar-only row.
    await assert.rejects(manager.call("bob", bob, scoped, signal, async () => {}, service), new RegExp(`google_${service}_permissions_required`));
    await manager.call("alice", alice, scoped, signal, async () => {}, service);
    assert.equal(new URL(fixture.calls.at(-1)!.url).pathname, service === "gmail" ? "/gmail/v1/users/me/messages" : "/drive/v3/files");
  }
  let fileVersion = "123", fileType = "text/plain";
  const requests: Request[] = [];
  const driveManager = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, fixture.fetcher), async (input, init) => {
    const req = new Request(input, init); requests.push(req);
    assert.equal(req.headers.get("authorization"), "Bearer alice");
    return Response.json(req.method === "GET" ? { id: "file", version: fileVersion, mimeType: fileType } : { id: "file", version: "124" });
  });
  const patch = DRIVE_TOOLS.find(tool => tool.name === "drive_update_file")!.prepare({ file_id: "file", expected_version: "123", content: "test" }, "operation");
  const phases: (string | undefined)[] = [];
  await driveManager.call("alice", alice, patch, signal, async phase => { phases.push(phase); }, "drive");
  assert.deepEqual(phases, ["preflight", "dispatch"]);
  assert.deepEqual(requests.map(req => req.method), ["GET", "PATCH"]);
  assert.match(requests[1].url, /\/upload\/drive\/v3\/files\/file/);
  assert.ok(Buffer.from(await requests[1].arrayBuffer()).includes(Buffer.from("test")));
  requests.length = 0; fileVersion = "124";
  await assert.rejects(driveManager.call("alice", alice, patch, signal, async () => {}, "drive"), /google_file_changed/);
  assert.deepEqual(requests.map(req => req.method), ["GET"]);
  requests.length = 0; fileVersion = "123"; fileType = "application/vnd.google-apps.document";
  await assert.rejects(driveManager.call("alice", alice, patch, signal, async () => {}, "drive"), /google_native_content_update_unsupported/);
  assert.deepEqual(requests.map(req => req.method), ["GET"]);

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
  // A partial response must not replace established tokens, even when that service is selected again.
  const established = await connectSelected("erin", [{ service: "calendar", access: "read_write" }]);
  fixture.grantOnly(serviceScopes("gmail", "read_write"));
  await assert.rejects(connectSelected("erin", [{ service: "calendar", access: "read_write" }, { service: "gmail", access: "read_write" }]), /google_calendar_permissions_required/);
  assert.equal((await manager.list("erin"))[0].access.gmail, "none");
  fixture.grantOnly(serviceScopes("calendar", "read_only"));
  await assert.rejects(connectSelected("erin", [{ service: "calendar", access: "read_write" }]), /google_calendar_permissions_required/);
  assert.equal((await manager.list("erin"))[0].access.calendar, "read_write");
  // An explicit read-only selection can intentionally reduce the existing capability.
  await connectSelected("erin", [{ service: "calendar", access: "read_only" }]);
  assert.equal((await manager.list("erin"))[0].access.calendar, "read_only");
  fixture.grantOnly();
  await manager.revokeService("erin", established.connection_id, "calendar");
  const readSelections = GOOGLE_SERVICES.map(service => ({ service, access: "read_only" as const }));
  const readOnly = await connectSelected("carol", readSelections);
  assert.equal(readOnly.calendar_access, true); assert.equal(readOnly.calendar_write_access, false);
  assert.equal(readOnly.access.calendar, "read_only");
  for (const service of ["gmail", "drive"] as const) {
    assert.equal(readOnly[`${service}_access`], true); assert.equal(readOnly[`${service}_write_access`], false);
    await manager.call("carol", readOnly.connection_id, { method: "GET", path: service === "gmail" ? "/messages" : "/files" }, signal, async () => {}, service);
    await assert.rejects(manager.call("carol", readOnly.connection_id,
      { method: "POST", path: service === "gmail" ? "/messages/send" : "/files", body: {} }, signal,
      async () => { assert.fail("read-only access reached dispatch"); }, service), new RegExp(`google_${service}_write_permissions_required`));
  }
  let dispatches = 0;
  const beforeWrite = async () => { dispatches++; };
  const write = { method: "POST" as const, path: "/calendars/primary/events", body: { summary: "reviewed" } };
  await manager.call("carol", readOnly.connection_id, { method: "POST", path: "/freeBusy", body: {} }, signal, async () => {});
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_calendar_write_permissions_required/);
  await assert.rejects(manager.revokeService("bob", readOnly.connection_id, "calendar"), /google_not_found/);
  assert.equal(dispatches, 0);
  const canceledUpgrade = new URL(await manager.begin("carol", "carol-session"));
  await assert.rejects(manager.finish("carol", "carol-session", new URLSearchParams({ state: canceledUpgrade.searchParams.get("state")!, error: "access_denied" })), /google_consent_canceled/);
  assert.equal((await manager.list("carol"))[0].access.calendar, "read_only");
  await connectSelected("carol", [{ service: "calendar", access: "read_write" }]);
  assert.equal((await manager.list("carol"))[0].access.calendar, "read_write");
  await manager.call("carol", readOnly.connection_id, write, signal, async phase => {
    assert.equal(phase, "dispatch"); dispatches++;
  }, "calendar", { access: "write" });
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite, "calendar", { access: "read" }), /google_invalid_request/);
  // Google combines previous scopes, but a fresh read-only task may never inherit old write access.
  await connectSelected("carol", [{ service: "calendar", access: "read_only" }]);
  assert.equal((await manager.list("carol"))[0].access.calendar, "read_only");
  const broadScopes = (await pool.query("select granted_scopes from google_connection where id=$1", [readOnly.connection_id])).rows[0].granted_scopes;
  assert.ok(broadScopes.includes("https://www.googleapis.com/auth/calendar.events"));
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_calendar_write_permissions_required/);
  await manager.call("carol", readOnly.connection_id, request, signal, async () => {});

  // Revocation invalidates an already-issued OAuth flow as well as local provider access.
  const pending = new URL(await manager.begin("carol", "carol-session", "carol-thread"));
  fixture.authorize(pending.href, "carol");
  await manager.revokeService("carol", readOnly.connection_id, "calendar");
  await assert.rejects(manager.finish("carol", "carol-session", new URLSearchParams({ state: pending.searchParams.get("state")!, code: "carol" })), /google_invalid_oauth_state/);
  assert.equal((await manager.list("carol"))[0].access.calendar, "none");
  const revoked = (await pool.query("select * from google_connection where id=$1", [readOnly.connection_id])).rows[0];
  assert.equal(revoked.oauth_state_hash, null); assert.equal(revoked.oauth_session_hash, null); assert.equal(revoked.oauth_expires_at, null);
  const revokedData = decryptGoogleCredentials(revoked.encrypted_credentials,
    JSON.stringify(["carol", readOnly.connection_id, fixture.config.clientId]), key);
  assert.equal(revokedData.serviceAccess?.calendar, "none"); assert.equal(revokedData.verifier, undefined);
  assert.equal(revokedData.returnThreadId, undefined); assert.equal(revokedData.requestedSelections, undefined);
  await assert.rejects(manager.call("carol", readOnly.connection_id, request, signal, beforeWrite), /google_calendar_permissions_required/);
  // Consent for a different service must leave the revoked Calendar disabled even with its scopes in the token.
  await connectSelected("carol", [{ service: "drive", access: "read_write" }]);
  manager = factory();
  assert.equal((await manager.list("carol"))[0].access.calendar, "none");
  assert.equal((await manager.list("carol"))[0].access.gmail, "read_only");
  assert.equal((await manager.list("carol"))[0].access.drive, "read_write");
  await assert.rejects(manager.call("carol", readOnly.connection_id, request, signal, beforeWrite), /google_calendar_permissions_required/);
  await manager.call("carol", readOnly.connection_id, { method: "GET", path: "/files" }, signal, async () => {}, "drive");
  await manager.revokeService("carol", readOnly.connection_id, "gmail");
  await manager.revokeService("carol", readOnly.connection_id, "drive");
  const revokedLast = (await pool.query("select * from google_connection where id=$1", [readOnly.connection_id])).rows[0];
  assert.equal(revokedLast.status, "disconnected"); assert.equal(revokedLast.encrypted_credentials, null);
  assert.equal(revokedLast.account_subject, null); assert.equal(revokedLast.account_email, null);
  assert.deepEqual(revokedLast.granted_scopes, []);
  await assert.rejects(manager.call("carol", readOnly.connection_id, request, signal, beforeWrite), /google_reconnect_required/);
  // Even a completely fresh connection only enables the selected Bud service and access.
  const freshRead = await connectSelected("carol", [{ service: "calendar", access: "read_only" }]);
  assert.equal(freshRead.access.calendar, "read_only");
  assert.equal(freshRead.access.gmail, "none"); assert.equal(freshRead.access.drive, "none");
  await assert.rejects(manager.call("carol", readOnly.connection_id, write, signal, beforeWrite), /google_calendar_write_permissions_required/);
  await connectSelected("carol", [{ service: "calendar", access: "read_write" }]);
  // Refresh narrowing actual scopes fences a previously writable token before dispatch.
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
  // A partial grant enables only actual accepted capabilities.
  fixture.grantOnly(serviceScopes("calendar", "read_only"));
  const partial = await connectSelected("dave", GOOGLE_SERVICES.map(service => ({ service, access: "read_write" })));
  fixture.grantOnly();
  assert.equal(partial.calendar_access, true); assert.equal(partial.calendar_write_access, false);
  assert.equal(partial.access.calendar, "read_only");
  assert.equal(partial.gmail_access, false); assert.equal(partial.drive_access, false);

  const app = Fastify();
  let deletedThread = false, routeConfigured = true;
  await registerGoogleRoutes(app, manager, async (request, reply) => {
    const owner = request.headers["x-test-owner"];
    if (typeof owner !== "string") { reply.code(401).send({ error: "unauthorized" }); return null; }
    return { userId: owner, sessionId: `${owner}-session`, email: null, authType: "cookie" };
  }, () => routeConfigured, async (actor, threadId) => !deletedThread && threadId === `${actor.userId}-thread`
    ? { threadId, budId: `${actor.userId}-bud` } : null);
  t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: "/api/google/connection" })).statusCode, 401);
  const inventory = await app.inject({ method: "GET", url: "/api/google/connection", headers: { "x-test-owner": "alice" } });
  assert.equal(inventory.json().connections.length, 1); assert.ok(!inventory.body.includes("encrypted_credentials"));
  assert.equal((await app.inject({ method: "DELETE", url: `/api/google/connection/${alice}`, headers: { "x-test-owner": "alice", origin: "https://attacker.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/google/connection/${alice}`, headers: { "x-test-owner": "bob", origin: config.betterAuthTrustedOrigins[0] } })).statusCode, 404);
  const revokeUrl = `/api/google/connection/${partial.connection_id}/services/calendar`;
  assert.equal((await app.inject({ method: "DELETE", url: revokeUrl })).statusCode, 401);
  assert.equal((await app.inject({ method: "DELETE", url: revokeUrl, headers: { "x-test-owner": "bob", origin: config.betterAuthTrustedOrigins[0] } })).statusCode, 404);
  for (const origin of [undefined, "https://attacker.example"]) {
    assert.equal((await app.inject({ method: "DELETE", url: revokeUrl, headers: { "x-test-owner": "dave", ...(origin ? { origin } : {}) } })).statusCode, 403);
  }
  const revokeHeaders = { "x-test-owner": "dave", origin: config.betterAuthTrustedOrigins[0] };
  assert.equal((await app.inject({ method: "DELETE", url: revokeUrl.replace("calendar", "admin"), headers: revokeHeaders })).statusCode, 400);
  routeConfigured = false;
  const disabledInventory = await app.inject({ method: "GET", url: "/api/google/connection", headers: revokeHeaders });
  assert.equal(disabledInventory.json().configured, false); assert.equal(disabledInventory.json().connections.length, 1);
  assert.equal((await app.inject({ method: "DELETE", url: revokeUrl, headers: revokeHeaders })).statusCode, 204);
  assert.equal((await manager.list("dave"))[0].status, "disconnected");
  routeConfigured = true;
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
  assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { service: "admin" } })).statusCode, 400);
  for (const service of ["gmail", "drive"] as const) {
    assert.equal((await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { selections: [{ service, access: "read_write" }], thread_id: "bob-thread" } })).statusCode, 404);
    const response = await app.inject({ method: "POST", url: "/api/google/connect", headers, payload: { selections: [{ service, access: "read_write" }], thread_id: "alice-thread" } });
    assert.equal(response.statusCode, 200);
    assert.ok(new URL(response.json().authorization_url).searchParams.get("scope")!.includes(service));
  }
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
  // Reconnect failures preserve the usable grant instead of deleting Calendar.
  auth = new URL(await manager.begin("alice", "alice-session")); fixture.authorize(auth.href, "alice"); fixture.partialScopes();
  await assert.rejects(manager.finish("alice", "alice-session", new URLSearchParams({ state: auth.searchParams.get("state")!, code: "alice" })), /google_calendar_permissions_required/);
  assert.equal((await manager.list("alice"))[0].calendar_access, true);
  target = await callback(await start("alice-thread"));
  assert.equal(target.href, "https://bud.example/alice-bud/alice-thread?google=permissions_required");
  const encrypted = (await pool.query("select encrypted_credentials from google_connection where id=$1", [alice])).rows[0].encrypted_credentials;
  const finalCredentials = decryptGoogleCredentials(encrypted, JSON.stringify(["alice", alice, fixture.config.clientId]), key);
  assert.equal(finalCredentials.returnThreadId, undefined);
  assert.equal(finalCredentials.verifier, undefined);
  await manager.disconnect("bob", bob);
  fixture.partialScopes(false); fixture.omitRefresh();
  auth = new URL(await manager.begin("bob", "bob-session", undefined, [{ service: "gmail", access: "read_write" }])); fixture.authorize(auth.href, "bob");
  await assert.rejects(manager.finish("bob", "bob-session", new URLSearchParams({ state: auth.searchParams.get("state")!, code: "bob" })), /google_offline_access_required/);
  assert.equal((await manager.list("bob"))[0].gmail_access, false);
});
