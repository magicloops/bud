import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import { config } from "../config.js";
import * as schema from "../db/schema.js";
import { GoogleConnections } from "./connections.js";
import { googleFetch, googleJson } from "./http.js";
import { GoogleOAuth } from "./oauth.js";
import { registerGoogleRoutes } from "./routes.js";
import { googleFixture } from "./test-fixture.js";
import { decryptGoogleCredentials, encryptGoogleCredentials } from "./credentials.js";
import { GOOGLE_SERVICES, GoogleError, serviceScopes, type GoogleService, type GoogleSelection } from "./config.js";
import { DRIVE_TOOLS } from "./drive.js";

test("a rejected HTTP request keeps its known status if discarding the body fails", async () => {
  for (const advertisedSize of [5, 2 * 1024 * 1024]) {
    const fetcher = googleFetch(async () => new Response(new ReadableStream({
      cancel() { throw new Error("private broken error body"); },
    }), { status: 412, headers: { "content-length": String(advertisedSize) } }));
    await assert.rejects(googleJson(fetcher, "https://www.googleapis.com/calendar/v3/calendars/primary/events/abc", "test",
      { method: "PATCH", headers: { "If-Match": '"etag"' } }), /google_event_changed/);
  }
});

test("owned Google grants: callback binding, expiry, replay, partial consent, refresh and disconnect", {
  skip: process.env.BUD_DATA_DB_TEST !== "1",
}, async t => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(config.databaseUrl).hostname));
  const namespace = `google_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 1, connectionTimeoutMillis: 1500 });
  await pool.query(`create schema ${namespace}`);
  t.after(async () => { await pool.query(`drop schema ${namespace} cascade`); await pool.end(); });
  await pool.query("create table fixture_user(id text primary key); insert into fixture_user values ('alice'),('bob'),('carol'),('dave'),('erin'),('frank'),('grace'),('heidi'),('ivan'),('transient'),('limited'),('other')");
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
  await assert.rejects(grantService("drive"), /google_drive_permissions_required/);
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
  for (const mimeType of ["application/json", "text/csv", "application/vnd.custom+json"]) {
    fileType = mimeType; requests.length = 0;
    await driveManager.call("alice", alice, patch, signal, async () => {}, "drive");
    const body = Buffer.from(await requests[1].arrayBuffer()).toString();
    assert.ok(body.includes(`Content-Type: ${mimeType}\r\n\r\ntest`));
  }
  const override = DRIVE_TOOLS.find(tool => tool.name === "drive_update_file")!.prepare({
    file_id: "file", expected_version: "123", content: "test", mime_type: "text/html" }, "operation");
  requests.length = 0;
  await driveManager.call("alice", alice, override, signal, async () => {}, "drive");
  assert.match(Buffer.from(await requests[1].arrayBuffer()).toString(), /Content-Type: text\/html\r\n\r\ntest/);
  requests.length = 0; fileType = "text/csv\r\nInjected: yes";
  await assert.rejects(driveManager.call("alice", alice, patch, signal, async () => {}, "drive"), /google_invalid_file_mime_type/);
  assert.deepEqual(requests.map(req => req.method), ["GET"]);
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
  // A valid newly selected service replaces scopes that Google has revoked upstream.
  const established = await connectSelected("erin", [{ service: "calendar", access: "read_write" }]);
  fixture.grantOnly(serviceScopes("gmail", "read_write"));
  await connectSelected("erin", [{ service: "gmail", access: "read_write" }]);
  assert.equal((await manager.list("erin"))[0].access.calendar, "none");
  assert.equal((await manager.list("erin"))[0].access.gmail, "read_write");
  fixture.grantOnly(serviceScopes("calendar", "read_only"));
  await connectSelected("erin", [{ service: "calendar", access: "read_write" }, { service: "drive", access: "read_write" }]);
  assert.deepEqual((await manager.list("erin"))[0].access, { calendar: "read_only", gmail: "none", drive: "none" });
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
  // Disconnect does not wait for the call; the call then sends nothing.
  const sent = fixture.calls.length;
  await manager.disconnect("alice", alice);
  release(); await assert.rejects(active, /google_reconnect_required/);
  assert.equal(fixture.calls.length, sent);
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
  fixture.omitRefresh(false);

  const grantWith = async (target: GoogleConnections, owner: string, selections: GoogleSelection[] = [{ service: "calendar", access: "read_write" }]) => {
    const url = new URL(await target.begin(owner, `${owner}-session`, undefined, selections));
    fixture.authorize(url.href, owner);
    await target.finish(owner, `${owner}-session`, new URLSearchParams({ state: url.searchParams.get("state")!, code: owner }));
    return (await target.list(owner))[0];
  };
  const expire = async (owner: string, id: string) => {
    const stored = (await pool.query("select encrypted_credentials from google_connection where id=$1", [id])).rows[0];
    const binding = JSON.stringify([owner, id, fixture.config.clientId]);
    const value = decryptGoogleCredentials(stored.encrypted_credentials, binding, key);
    value.tokens!.expiry_date = Date.now() - 1000;
    await pool.query("update google_connection set encrypted_credentials=$1 where id=$2", [encryptGoogleCredentials(value, binding, key), id]);
    return value;
  };

  await t.test("unreadable credentials remain owner-scoped and support direct reconnect or local removal", async () => {
    const all = GOOGLE_SERVICES.map(service => ({ service, access: "read_write" as const }));
    const saved = await grantWith(manager, "frank", all), replacementKey = randomBytes(32);
    const rotated = new GoogleConnections(fixture.config, database, () => replacementKey, new GoogleOAuth(fixture.config, fixture.fetcher), fixture.fetcher);
    const recoveryApp = Fastify();
    await registerGoogleRoutes(recoveryApp, rotated, async (request, reply) => {
      const owner = request.headers["x-test-owner"];
      if (typeof owner !== "string") { reply.code(401).send({ error: "unauthorized" }); return null; }
      return { userId: owner, sessionId: `${owner}-session`, email: null, authType: "cookie" };
    }, () => true, async (actor, threadId) => threadId === `${actor.userId}-thread`
      ? { threadId, budId: `${actor.userId}-bud` } : null);
    t.after(() => recoveryApp.close());
    const ownerHeaders = { "x-test-owner": "frank", origin: config.betterAuthTrustedOrigins[0] };
    const foreignHeaders = { ...ownerHeaders, "x-test-owner": "bob" };
    const savedUrl = `/api/google/connection/${saved.connection_id}`;
    const beforeAttacks = (await pool.query("select encrypted_credentials from google_connection where id=$1", [saved.connection_id])).rows[0].encrypted_credentials;
    assert.equal((await recoveryApp.inject({ method: "GET", url: "/api/google/connection" })).statusCode, 401);
    for (const url of [savedUrl, `${savedUrl}/services/calendar`]) {
      assert.equal((await recoveryApp.inject({ method: "DELETE", url })).statusCode, 401);
      assert.equal((await recoveryApp.inject({ method: "DELETE", url, headers: foreignHeaders })).statusCode, 404);
      assert.equal((await recoveryApp.inject({ method: "DELETE", url, headers: { ...ownerHeaders, origin: "https://attacker.example" } })).statusCode, 403);
    }
    assert.equal((await recoveryApp.inject({ method: "POST", url: "/api/google/connect", payload: {} })).statusCode, 401);
    assert.equal((await recoveryApp.inject({ method: "POST", url: "/api/google/connect", headers: foreignHeaders, payload: { connection_id: saved.connection_id } })).statusCode, 400);
    assert.equal((await recoveryApp.inject({ method: "POST", url: "/api/google/connect", headers: foreignHeaders, payload: { thread_id: "frank-thread" } })).statusCode, 404);
    const foreignInventory = await recoveryApp.inject({ method: "GET", url: "/api/google/connection", headers: foreignHeaders });
    assert.equal(foreignInventory.statusCode, 200); assert.ok(!foreignInventory.body.includes(saved.connection_id));
    assert.ok(!foreignInventory.body.includes("frank@example.com"));
    assert.equal((await pool.query("select encrypted_credentials from google_connection where id=$1", [saved.connection_id])).rows[0].encrypted_credentials, beforeAttacks);
    const broken = (await rotated.list("frank"))[0];
    assert.equal(broken.status, "reconnect_required"); assert.equal(broken.recovery_required, true);
    assert.equal(broken.email, "frank@example.com");
    assert.deepEqual(broken.access, { calendar: "none", gmail: "none", drive: "none" });
    assert.equal(broken.calendar_access, false); assert.equal(broken.calendar_write_access, false);
    assert.doesNotMatch(JSON.stringify(broken), /refresh-frank|encrypted_credentials|access_token|device_secret/);
    const ownerInventory = await recoveryApp.inject({ method: "GET", url: "/api/google/connection", headers: ownerHeaders });
    assert.equal(ownerInventory.statusCode, 200); assert.deepEqual(ownerInventory.json().connections, [broken]);
    assert.doesNotMatch(ownerInventory.body, /refresh-frank|encrypted_credentials|access_token|device_secret/);
    await assert.rejects(rotated.call("frank", saved.connection_id, request, signal, async () => { assert.fail("Unreadable credentials dispatched"); }), /google_reconnect_required/);
    await assert.rejects(rotated.revokeService("bob", saved.connection_id, "calendar"), /google_not_found/);
    await assert.rejects(rotated.disconnect("bob", saved.connection_id), /google_not_found/);
    const freshConsent = await recoveryApp.inject({ method: "POST", url: "/api/google/connect", headers: ownerHeaders,
      payload: { selections: [{ service: "drive", access: "read_only" }] } });
    assert.equal(freshConsent.statusCode, 200);
    const consent = new URL(freshConsent.json().authorization_url); fixture.authorize(consent.href, "frank");
    const completed = await recoveryApp.inject({ method: "GET", url: `/api/google/callback?${new URLSearchParams({ state: consent.searchParams.get("state")!, code: "frank" })}`, headers: ownerHeaders });
    assert.equal(completed.statusCode, 303);
    const restored = (await rotated.list("frank"))[0];
    assert.equal(restored.recovery_required, undefined); assert.equal(restored.status, "connected");
    assert.deepEqual(restored.access, { calendar: "none", gmail: "none", drive: "read_only" });
    await rotated.call("frank", saved.connection_id, { method: "GET", path: "/files" }, signal, async () => {}, "drive");

    const revoked = await grantWith(manager, "grace", all);
    assert.equal((await recoveryApp.inject({ method: "DELETE", url: `/api/google/connection/${revoked.connection_id}/services/gmail`,
      headers: { ...ownerHeaders, "x-test-owner": "grace" } })).statusCode, 204);
    const row = (await pool.query("select * from google_connection where id=$1", [revoked.connection_id])).rows[0];
    assert.equal(row.status, "disconnected"); assert.equal(row.encrypted_credentials, null);
    assert.equal(row.account_subject, null); assert.equal(row.oauth_state_hash, null); assert.deepEqual(row.granted_scopes, []);
    const withoutKey = new GoogleConnections(fixture.config, database, () => { throw new GoogleError("google_encryption_key_required"); });
    const missingKey = await grantWith(manager, "heidi");
    assert.equal((await withoutKey.list("heidi"))[0].recovery_required, true);
    await withoutKey.revokeService("heidi", missingKey.connection_id, "calendar");
    assert.equal((await withoutKey.list("heidi"))[0].status, "disconnected");
    const disconnected = await grantWith(manager, "ivan");
    assert.equal((await recoveryApp.inject({ method: "DELETE", url: `/api/google/connection/${disconnected.connection_id}`,
      headers: { ...ownerHeaders, "x-test-owner": "ivan" } })).statusCode, 204);
    assert.equal((await rotated.list("ivan"))[0].status, "disconnected");
  });

  await t.test("transient refresh failures retain tokens and access, while invalid_grant requires reconnect", async () => {
    const connected = await grantWith(manager, "transient"), expired = await expire("transient", connected.connection_id);
    let refreshAttempts = 0, rejectPermanently = false, dispatched = 0;
    const transport: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/token" && new URLSearchParams(await req.clone().text()).get("grant_type") === "refresh_token") {
        refreshAttempts++;
        if (rejectPermanently) return Response.json({ error: "invalid_grant", error_description: "private provider failure" }, { status: 400 });
        if (refreshAttempts <= 3) return Response.json({ error: "temporarily_unavailable", error_description: "private provider failure" }, { status: [500, 503, 429][refreshAttempts - 1] });
        if (refreshAttempts === 4) throw new Error("private transport failure");
      }
      return fixture.fetcher(req);
    };
    const refreshing = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, transport), fixture.fetcher);
    const callsBefore = fixture.calls.length;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await assert.rejects(refreshing.call("transient", connected.connection_id, write, signal, async () => { dispatched++; }), error => {
        assert.ok(error instanceof GoogleError); assert.equal(error.code, "google_refresh_unavailable"); assert.equal(error.retryable, true);
        assert.doesNotMatch(JSON.stringify(error), /private|refresh-transient/); return true;
      });
      assert.equal(refreshAttempts, attempt, "one explicit request must make only one refresh attempt");
      const current = (await refreshing.list("transient"))[0];
      assert.equal(current.status, "connected"); assert.equal(current.access.calendar, "read_write");
      const encrypted = (await pool.query("select encrypted_credentials from google_connection where id=$1", [connected.connection_id])).rows[0].encrypted_credentials;
      assert.deepEqual(decryptGoogleCredentials(encrypted, JSON.stringify(["transient", connected.connection_id, fixture.config.clientId]), key).tokens, expired.tokens);
    }
    assert.equal(dispatched, 0); assert.equal(fixture.calls.length, callsBefore);
    await refreshing.call("transient", connected.connection_id, write, signal, async () => { dispatched++; });
    assert.equal(refreshAttempts, 5); assert.equal(dispatched, 1); assert.equal(fixture.calls.length, callsBefore + 1);
    await expire("transient", connected.connection_id); rejectPermanently = true;
    await assert.rejects(refreshing.call("transient", connected.connection_id, write, signal, async () => { assert.fail("Revoked refresh token dispatched"); }), error => {
      assert.ok(error instanceof GoogleError); assert.equal(error.code, "google_reconnect_required"); assert.equal(error.retryable, false); return true;
    });
    assert.equal((await refreshing.list("transient"))[0].status, "reconnect_required");
  });

  await t.test("one 401 refreshes once and rechecks authority before retry; ambiguous writes never retry", async () => {
    const { connection_id: id } = await grantWith(manager, "bob");
    let responses: (number | Error)[] = [], apiAttempts = 0, refreshAttempts = 0, refreshStatus = 200;
    const oauthFetch: typeof fetch = async (input, init) => {
      refreshAttempts++;
      if (refreshStatus !== 200) return Response.json({ error: refreshStatus === 400 ? "invalid_grant" : "temporarily_unavailable" }, { status: refreshStatus });
      return fixture.fetcher(input, init);
    };
    const recovering = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, oauthFetch), async () => {
      apiAttempts++;
      const result = responses.shift();
      assert.ok(result, "unexpected retry");
      if (result instanceof Error) throw result;
      return Response.json({}, { status: result });
    });
    const changes: boolean[] = [];
    const perform = (onCheck = async () => {}) => recovering.call("bob", id, write, signal, onCheck, "calendar",
      { access: "write", onDispatchChange: value => changes.push(value) });
    responses = [401, 200];
    let fences = 0;
    await perform(async () => { fences++; });
    assert.deepEqual(changes.splice(0), [true, false, true]);
    assert.equal(fences, 2); assert.equal(refreshAttempts, 1); assert.equal(apiAttempts, 2);
    responses = [401]; refreshStatus = 503;
    await assert.rejects(perform(), /google_refresh_unavailable/);
    assert.deepEqual(changes.splice(0), [true, false]);
    assert.equal((await recovering.list("bob"))[0].status, "connected");
    responses = [401]; refreshStatus = 200; fences = 0;
    await assert.rejects(perform(async () => { if (++fences === 2) throw new Error("authority changed"); }), /authority changed/);
    assert.deepEqual(changes.splice(0), [true, false]);
    for (const failure of [503, new Error("lost reply")]) {
      responses = [failure]; const previousRefresh: number = refreshAttempts;
      await assert.rejects(perform()); assert.deepEqual(changes.splice(0), [true]); assert.equal(refreshAttempts, previousRefresh);
    }
    responses = [401, 401];
    await assert.rejects(perform(), /google_reconnect_required/);
    assert.deepEqual(changes.splice(0), [true, false, true, false]);
    assert.equal((await recovering.list("bob"))[0].status, "reconnect_required");

    // No dispatch marker is published after synchronous cancellation in the final authorization fence.
    await grantWith(manager, "bob");
    const controller = new AbortController(), previous = apiAttempts;
    await assert.rejects(recovering.call("bob", id, write, controller.signal, async () => controller.abort(),
      "calendar", { access: "write", onDispatchChange: value => changes.push(value) }));
    assert.deepEqual(changes, []); assert.equal(apiAttempts, previous);
  });

  await t.test("the real SDK persists a rotated refresh token before an ambiguous provider write", async () => {
    const { connection_id: id } = await grantWith(manager, "bob");
    await expire("bob", id);
    const refresh = new GoogleOAuth(fixture.config, async input => {
      const form = new URLSearchParams(await new Request(input).text());
      assert.equal(form.get("refresh_token"), "refresh-bob");
      return Response.json({ access_token: "new-bob", refresh_token: "rotated-bob", token_type: "Bearer", expires_in: 3600 });
    });
    const target = new GoogleConnections(fixture.config, database, () => key, refresh, async () => {
      const row = (await pool.query("select encrypted_credentials from google_connection where id=$1", [id])).rows[0];
      const persisted = decryptGoogleCredentials(row.encrypted_credentials, JSON.stringify(["bob", id, fixture.config.clientId]), key);
      assert.equal(persisted.tokens?.refresh_token, "rotated-bob");
      throw new Error("lost reply");
    });
    await assert.rejects(target.call("bob", id, write, signal, async () => {}), /lost reply/);
    const row = (await pool.query("select encrypted_credentials from google_connection where id=$1", [id])).rows[0];
    const retained = decryptGoogleCredentials(row.encrypted_credentials, JSON.stringify(["bob", id, fixture.config.clientId]), key);
    assert.equal(retained.tokens?.refresh_token, "rotated-bob");
  });

  await t.test("Drive preflight rejection refreshes without marking a write; rejected mutation repeats preflight", async () => {
    const { connection_id: id } = await grantWith(manager, "alice", [{ service: "drive", access: "read_write" }]);
    const responses = [401, 200, 401];
    const markers: boolean[] = [], phases: string[] = [], methods: string[] = [];
    const transport = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, fixture.fetcher), async (input, init) => {
      const method = new Request(input, init).method;
      methods.push(method);
      return Response.json({ version: "123", mimeType: "application/json" }, { status: responses.shift()! });
    });
    const send = () => transport.call("alice", id, patch, signal, async phase => { phases.push(phase); }, "drive",
      { access: "write", onDispatchChange: value => markers.push(value) });
    await assert.rejects(send(), /google_reconnect_required/);
    assert.deepEqual(methods, ["GET", "GET", "PATCH"]);
    assert.deepEqual(markers, [true, false]);
    await grantWith(manager, "alice", [{ service: "drive", access: "read_write" }]);
    responses.push(200, 401, 200, 200); markers.length = 0; phases.length = 0; methods.length = 0;
    await send();
    assert.deepEqual(methods, ["GET", "PATCH", "GET", "PATCH"]);
    assert.deepEqual(phases, ["preflight", "dispatch", "preflight", "dispatch"]);
    assert.deepEqual(markers, [true, false, true]);
  });

  // A point a test holds work at: `entered` resolves when the work arrives, `open` lets it go on.
  const gate = () => {
    let open!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { open = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    return { held, entered, open, enter };
  };
  const isRefresh = async (req: Request) => new URL(req.url).pathname === "/token" &&
    new URLSearchParams(await req.clone().text()).get("grant_type") === "refresh_token";
  const storedRow = async (owner: string, id: string) => {
    const row = (await pool.query("select encrypted_credentials, grant_epoch from google_connection where id=$1", [id])).rows[0];
    return { epoch: row.grant_epoch as number, encrypted: row.encrypted_credentials as string | null,
      data: row.encrypted_credentials ? decryptGoogleCredentials(row.encrypted_credentials, JSON.stringify([owner, id, fixture.config.clientId]), key) : null };
  };

  const leaseOf = async (id: string) =>
    (await pool.query("select refresh_lease_until from google_connection where id=$1", [id])).rows[0].refresh_lease_until as Date | null;
  // Rewrites the stored tokens as another service instance would.
  const rewriteTokens = async (owner: string, id: string, change: (tokens: NonNullable<Awaited<ReturnType<typeof expire>>["tokens"]>) => void) => {
    const binding = JSON.stringify([owner, id, fixture.config.clientId]);
    const row = (await pool.query("select encrypted_credentials from google_connection where id=$1", [id])).rows[0];
    const value = decryptGoogleCredentials(row.encrypted_credentials, binding, key);
    change(value.tokens!);
    await pool.query("update google_connection set encrypted_credentials=$1 where id=$2", [encryptGoogleCredentials(value, binding, key), id]);
  };
  // A second service instance: its own process state, the same database.
  const instance = (oauthFetch: typeof fetch, api: typeof fetch = fixture.fetcher) =>
    new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, oauthFetch), api);

  await t.test("pending OAuth exchange releases its SQL client and cannot resurrect a cleared account", async () => {
    const exchange = gate();
    const slowOauth = new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/token") { exchange.enter(); await exchange.held; }
      return fixture.fetcher(req);
    });
    const slow = new GoogleConnections(fixture.config, database, () => key, slowOauth, fixture.fetcher);
    const authorization = new URL(await slow.begin("bob", "session"));
    fixture.authorize(authorization.href, "bob");
    const params = new URLSearchParams({ code: "bob", state: authorization.searchParams.get("state")! });
    const callback = slow.finish("bob", "session", params);
    await exchange.entered;
    try {
      await assert.rejects(manager.finish("bob", "session", params), /google_invalid_oauth_state/);
      await manager.list("alice");
      // A replacement key cannot decrypt the stored credentials. Clearing the unusable
      // envelope must still fence the old process's successful OAuth response.
      const replacement = new GoogleConnections(fixture.config, database, () => randomBytes(32));
      const started = Date.now();
      await replacement.disconnect("bob", bob);
      assert.ok(Date.now() - started < 1000, "disconnect must not wait for the exchange");
    } finally { exchange.open(); }
    await assert.rejects(callback, /google_connection_changed/);
    assert.equal((await manager.list("bob"))[0].status, "disconnected");
  });

  await t.test("an exchange cut off by the deadline consumes its state and preserves the prior grant", async () => {
    await grantWith(manager, "heidi", [{ service: "calendar", access: "read_only" }]);
    const stalled = new GoogleOAuth(fixture.config, (input, init) => new Promise((_, reject) => {
      const req = new Request(input, init);
      req.signal.addEventListener("abort", () => reject(req.signal.reason));
    }));
    const target = new GoogleConnections(fixture.config, database, () => key, stalled, fixture.fetcher, 50);
    const authorization = new URL(await target.begin("heidi", "session", undefined, [{ service: "drive", access: "read_write" }]));
    fixture.authorize(authorization.href, "heidi");
    const params = new URLSearchParams({ code: "heidi", state: authorization.searchParams.get("state")! });
    await assert.rejects(target.finish("heidi", "session", params), /google_operation_timed_out/);
    const retained = (await manager.list("heidi"))[0];
    assert.equal(retained.status, "connected");
    assert.deepEqual(retained.access, { calendar: "read_only", gmail: "none", drive: "none" });
    await assert.rejects(target.finish("heidi", "session", params), /google_invalid_oauth_state/);
  });

  await t.test("a stalled PostgreSQL row lock blocks neither calls nor the single application pool client", async () => {
    await grantWith(manager, "alice");
    const holder = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${namespace}`, max: 1 });
    const client = await holder.connect();
    try {
      await client.query("begin");
      await client.query("select id from google_connection where id=$1 for update", [alice]);
      // A call reads without a lock.
      await manager.call("alice", alice, request, AbortSignal.timeout(1500), async () => {});
      // An edit retries without holding the client, then gives up as busy.
      const blocked = assert.rejects(manager.revokeService("alice", alice, "gmail"), error => {
        assert.ok(error instanceof GoogleError); assert.equal(error.code, "google_busy"); assert.equal(error.retryable, true); return true;
      });
      await delay(150);
      await pool.query("select 1");
      await blocked;
      await client.query("rollback");
      await manager.revokeService("alice", alice, "gmail");
    } finally { client.release(true); await holder.end(); }
  });

  await t.test("calls for one account run together on a one-client SQL pool", async () => {
    await grantWith(manager, "alice");
    const provider = gate();
    const slow = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, fixture.fetcher), async () => {
      provider.enter(); await provider.held; return Response.json({});
    });
    const active = slow.call("alice", alice, request, signal, async () => { await pool.query("select 1"); });
    await provider.entered;
    try {
      const before = fixture.calls.length;
      await manager.call("alice", alice, request, AbortSignal.timeout(1500), async () => { await pool.query("select 1"); });
      assert.equal(fixture.calls.length, before + 1);
      await pool.query("select 1");
    } finally { provider.open(); await active; }
  });

  await t.test("disconnect and revoke return during an in-flight call, and its next request is not sent", async () => {
    for (const [change, expected] of [
      [(id: string) => manager.disconnect("ivan", id), /google_reconnect_required/],
      [(id: string) => manager.revokeService("ivan", id, "calendar"), /google_calendar_permissions_required/],
    ] as const) {
      await grantWith(manager, "ivan", [{ service: "calendar", access: "read_write" }, { service: "gmail", access: "read_only" }]);
      const { connection_id: id } = (await manager.list("ivan"))[0];
      const fence = gate(), markers: boolean[] = [], before = fixture.calls.length;
      const stalled = factory().call("ivan", id, write, signal, async () => { fence.enter(); await fence.held; }, "calendar",
        { access: "write", onDispatchChange: value => markers.push(value) });
      await fence.entered;
      const started = Date.now();
      await change(id);
      assert.ok(Date.now() - started < 1000, "the change must not wait for the call");
      fence.open();
      await assert.rejects(stalled, expected);
      assert.deepEqual(markers, []); assert.equal(fixture.calls.length, before);
    }
    // The call's own failure must not undo the revoke: Gmail is still there, Calendar is not.
    assert.deepEqual((await manager.list("ivan"))[0].access, { calendar: "none", gmail: "read_only", drive: "none" });
    assert.equal((await manager.list("ivan"))[0].status, "connected");
  });

  await t.test("a call started under an earlier grant sends nothing under a later one", async () => {
    const { connection_id: id } = await grantWith(manager, "ivan");
    // Access still stands after each change, but the grant is not the one the request was prepared for.
    for (const change of [
      async () => { await manager.disconnect("ivan", id); await grantWith(manager, "ivan"); },
      async () => { await manager.revokeService("ivan", id, "gmail"); },
    ]) {
      const fence = gate(), markers: boolean[] = [], before = fixture.calls.length;
      const stalled = factory().call("ivan", id, write, signal, async () => { fence.enter(); await fence.held; }, "calendar",
        { access: "write", onDispatchChange: value => markers.push(value) });
      await fence.entered;
      await change();
      const granted = await storedRow("ivan", id);
      fence.open();
      await assert.rejects(stalled, error => {
        assert.ok(error instanceof GoogleError); assert.equal(error.code, "google_connection_changed"); assert.equal(error.retryable, true); return true;
      });
      assert.deepEqual(markers, []); assert.equal(fixture.calls.length, before);
      assert.equal((await storedRow("ivan", id)).encrypted, granted.encrypted, "the stale call wrote nothing");
      // The same request, started again, goes through.
      await manager.call("ivan", id, write, signal, async () => {});
    }
  });

  await t.test("calls that find the token expired share one refresh", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    let refreshes = 0;
    const counting = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refreshes++; await delay(30); }
      return fixture.fetcher(req);
    }), fixture.fetcher);
    const before = fixture.calls.length;
    await Promise.all(Array.from({ length: 4 }, () => counting.call("frank", id, request, signal, async () => {})));
    assert.equal(refreshes, 1); assert.equal(fixture.calls.length, before + 4);
    await counting.call("frank", id, request, signal, async () => {});
    assert.equal(refreshes, 1);
  });

  await t.test("a refresh that completes after a disconnect saves nothing", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    const refresh = gate(), before = fixture.calls.length;
    const slow = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refresh.enter(); await refresh.held; }
      return fixture.fetcher(req);
    }), fixture.fetcher);
    const pending = slow.call("frank", id, request, signal, async () => assert.fail("dispatched after disconnect"));
    await refresh.entered;
    await manager.disconnect("frank", id);
    refresh.open();
    await assert.rejects(pending, /google_connection_changed/);
    assert.equal((await storedRow("frank", id)).encrypted, null);
    assert.equal(await leaseOf(id), null);
    assert.equal((await manager.list("frank"))[0].status, "disconnected"); assert.equal(fixture.calls.length, before);
  });

  await t.test("a refresh that completes after a new connect flow began keeps that flow", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    const refresh = gate();
    const slow = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refresh.enter(); await refresh.held; }
      return fixture.fetcher(req);
    }), fixture.fetcher);
    const pending = slow.call("frank", id, request, signal, async () => {});
    await refresh.entered;
    const flow = new URL(await manager.begin("frank", "frank-session", undefined, [{ service: "gmail", access: "read_only" }]));
    refresh.open();
    await pending;
    const saved = await storedRow("frank", id);
    assert.ok(saved.data!.verifier, "the refresh must not drop the pending flow");
    assert.ok(saved.data!.tokens!.expiry_date! > Date.now());
    fixture.authorize(flow.href, "frank");
    await manager.finish("frank", "frank-session", new URLSearchParams({ state: flow.searchParams.get("state")!, code: "frank" }));
    assert.deepEqual((await manager.list("frank"))[0].access, { calendar: "read_write", gmail: "read_only", drive: "none" });
  });

  await t.test("a callback that completes after a newer connect flow began stores its grant and keeps that flow", async () => {
    const { connection_id: id } = await grantWith(manager, "erin");
    const exchange = gate();
    let hold = true;
    const slow = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init), token = new URL(req.url).pathname === "/token";
      // Hold Google's answer, not the request: the fixture has then used up the code.
      const response = await fixture.fetcher(req);
      if (token && hold) { hold = false; exchange.enter(); await exchange.held; }
      return response;
    }), fixture.fetcher);
    const first = new URL(await slow.begin("erin", "erin-session", undefined, [{ service: "drive", access: "read_write" }]));
    fixture.authorize(first.href, "erin");
    const callback = slow.finish("erin", "erin-session", new URLSearchParams({ state: first.searchParams.get("state")!, code: "erin" }));
    await exchange.entered;
    const second = new URL(await manager.begin("erin", "erin-session", undefined, [{ service: "gmail", access: "read_only" }]));
    exchange.open();
    await callback;
    const between = (await manager.list("erin"))[0];
    assert.equal(between.status, "connected");
    assert.deepEqual(between.access, { calendar: "read_write", gmail: "none", drive: "read_write" });
    assert.equal((await pool.query("select status from google_connection where id=$1", [id])).rows[0].status, "connecting");
    await manager.call("erin", id, request, signal, async () => {});
    fixture.authorize(second.href, "erin");
    await manager.finish("erin", "erin-session", new URLSearchParams({ state: second.searchParams.get("state")!, code: "erin" }));
    assert.deepEqual((await manager.list("erin"))[0].access, { calendar: "read_write", gmail: "read_only", drive: "read_write" });
  });

  await t.test("two instances that find the token expired make one refresh request", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    const refresh = gate();
    let refreshes = 0;
    const counted = (hold: boolean): typeof fetch => async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refreshes++; if (hold) { refresh.enter(); await refresh.held; } }
      return fixture.fetcher(req);
    };
    const first = instance(counted(true)), second = instance(counted(false)), before = fixture.calls.length;
    const one = first.call("frank", id, request, signal, async () => {});
    await refresh.entered;
    const two = second.call("frank", id, request, signal, async () => {});
    await delay(400);
    // The second instance waits for the first one's tokens. It holds no pool client meanwhile.
    assert.equal(refreshes, 1); assert.equal(fixture.calls.length, before);
    assert.ok((await leaseOf(id))! > new Date());
    await pool.query("select 1");
    refresh.open();
    await Promise.all([one, two]);
    assert.equal(refreshes, 1); assert.equal(fixture.calls.length, before + 2);
    assert.equal(await leaseOf(id), null);
  });

  await t.test("a refresh lease left by an instance that died only delays the next refresh until it ends", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    await pool.query("update google_connection set refresh_lease_until = now() + interval '600 milliseconds' where id=$1", [id]);
    const before = fixture.refreshCount, started = Date.now();
    await factory().call("frank", id, request, signal, async () => {});
    const waited = Date.now() - started;
    assert.ok(waited >= 400 && waited < 3000, `waited ${waited} ms`);
    assert.equal(fixture.refreshCount, before + 1); assert.equal(await leaseOf(id), null);
  });

  await t.test("a refresh that fails gives the lease back, so the next call tries at once", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    let fail = true;
    const flaky = instance(async (input, init) => {
      const req = new Request(input, init);
      if (fail && await isRefresh(req)) { fail = false; return Response.json({ error: "temporarily_unavailable" }, { status: 503 }); }
      return fixture.fetcher(req);
    });
    await assert.rejects(flaky.call("frank", id, request, signal, async () => {}), /google_refresh_unavailable/);
    assert.equal(await leaseOf(id), null);
    await flaky.call("frank", id, request, AbortSignal.timeout(1500), async () => {});
  });

  await t.test("a token with life left is used while another instance refreshes", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    // Inside the refresh window, but still good for half a minute.
    await rewriteTokens("frank", id, tokens => { tokens.expiry_date = Date.now() + 30_000; });
    await pool.query("update google_connection set refresh_lease_until = now() + interval '30 seconds' where id=$1", [id]);
    const lease = await leaseOf(id), before = fixture.refreshCount, sent = fixture.calls.length;
    await factory().call("frank", id, request, AbortSignal.timeout(1500), async () => {});
    assert.equal(fixture.refreshCount, before); assert.equal(fixture.calls.length, sent + 1);
    assert.deepEqual(await leaseOf(id), lease, "the other instance's lease is left alone");
    await pool.query("update google_connection set refresh_lease_until = null where id=$1", [id]);
  });

  await t.test("a call rejected with 401 while another instance refreshes waits for that instance's token", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await pool.query("update google_connection set refresh_lease_until = now() + interval '30 seconds' where id=$1", [id]);
    let refreshes = 0, apiAttempts = 0;
    const waiting = instance(async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) refreshes++;
      return fixture.fetcher(req);
    }, async () => Response.json({}, { status: ++apiAttempts === 1 ? 401 : 200 }));
    const pending = waiting.call("frank", id, request, signal, async () => {});
    await delay(400);
    assert.equal(apiAttempts, 1); assert.equal(refreshes, 0);
    // The other instance finishes: new tokens, lease given back.
    await rewriteTokens("frank", id, tokens => { tokens.access_token = "frank-renewed"; tokens.expiry_date = Date.now() + 3_600_000; });
    await pool.query("update google_connection set refresh_lease_until = null where id=$1", [id]);
    await pending;
    assert.equal(apiAttempts, 2); assert.equal(refreshes, 0);
  });

  await t.test("an instance that stalled past its refresh lease cannot overwrite the tokens of the one that took over", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    const stall = gate();
    const answering = (refreshToken: string, hold: boolean): typeof fetch => async (input, init) => {
      const req = new Request(input, init);
      if (!await isRefresh(req)) return fixture.fetcher(req);
      if (hold) { stall.enter(); await stall.held; }
      return Response.json({ access_token: "frank", refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600 });
    };
    const stalled = instance(answering("issued-to-stalled", true)), successor = instance(answering("issued-to-successor", false));
    const first = stalled.call("frank", id, request, signal, async () => {});
    await stall.entered;
    // The stalled instance's lease runs out, and another instance refreshes.
    await pool.query("update google_connection set refresh_lease_until = now() - interval '1 second' where id=$1", [id]);
    await successor.call("frank", id, request, signal, async () => {});
    assert.equal((await storedRow("frank", id)).data!.tokens!.refresh_token, "issued-to-successor");
    const epoch = (await storedRow("frank", id)).epoch;
    stall.open();
    // It carries on with the successor's tokens.
    await first;
    const after = await storedRow("frank", id);
    assert.equal(after.data!.tokens!.refresh_token, "issued-to-successor"); assert.equal(after.epoch, epoch);
    assert.equal(await leaseOf(id), null);
  });

  await t.test("a refresh that fails after its lease passed to another instance does not speak for the connection", async () => {
    for (const failure of [{ status: 400, error: "invalid_grant" }, { status: 503, error: "temporarily_unavailable" }]) {
      const { connection_id: id } = await grantWith(manager, "frank");
      await expire("frank", id);
      const stall = gate();
      const stalled = instance(async (input, init) => {
        const req = new Request(input, init);
        if (!await isRefresh(req)) return fixture.fetcher(req);
        stall.enter(); await stall.held;
        return Response.json({ error: failure.error }, { status: failure.status });
      });
      const first = stalled.call("frank", id, request, signal, async () => {});
      await stall.entered;
      await pool.query("update google_connection set refresh_lease_until = now() - interval '1 second' where id=$1", [id]);
      await factory().call("frank", id, request, signal, async () => {});
      const refreshed = await storedRow("frank", id);
      stall.open();
      // The stalled instance's failure is about a token that has since been replaced.
      await first;
      const after = await storedRow("frank", id);
      assert.equal((await manager.list("frank"))[0].status, "connected");
      assert.deepEqual(after.data!.tokens, refreshed.data!.tokens); assert.equal(after.epoch, refreshed.epoch);
      assert.equal(await leaseOf(id), null);
    }
  });

  await t.test("a cancelled call stops waiting for a shared refresh, which carries on for the others", async () => {
    const { connection_id: id } = await grantWith(manager, "frank");
    await expire("frank", id);
    const refresh = gate();
    let refreshes = 0;
    const slow = instance(async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refreshes++; refresh.enter(); await refresh.held; }
      return fixture.fetcher(req);
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const waiting = controllers.map(controller => slow.call("frank", id, request, controller.signal, async () => assert.fail("a cancelled call dispatched")));
    await refresh.entered;
    const started = Date.now();
    for (const controller of controllers) controller.abort();
    for (const call of waiting) await assert.rejects(call, { name: "AbortError" });
    assert.ok(Date.now() - started < 500, "cancellation must not wait for the refresh");
    // All four admission slots are free again while the refresh is still in the air.
    const next = slow.call("frank", id, request, signal, async () => {});
    refresh.open();
    await next;
    assert.equal(refreshes, 1);
  });

  await t.test("two calls rejected with 401 share one forced refresh and each retry once", async () => {
    const { connection_id: id } = await grantWith(manager, "grace");
    let apiAttempts = 0, refreshes = 0;
    const bothRejected = gate();
    const recovering = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, async (input, init) => {
      const req = new Request(input, init);
      if (await isRefresh(req)) { refreshes++; await bothRejected.held; }
      return fixture.fetcher(req);
    }), async () => {
      const attempt = ++apiAttempts;
      if (attempt === 2) bothRejected.open();
      return Response.json({}, { status: attempt <= 2 ? 401 : 200 });
    });
    await Promise.all([1, 2].map(() => recovering.call("grace", id, request, signal, async () => {})));
    assert.equal(refreshes, 1); assert.equal(apiAttempts, 4);
    assert.equal((await manager.list("grace"))[0].status, "connected");
  });

  await t.test("a write Google confirmed is returned even when the caller gives up as the answer arrives", async () => {
    const { connection_id: id } = await grantWith(manager, "grace");
    const controller = new AbortController(), markers: boolean[] = [];
    const target = new GoogleConnections(fixture.config, database, () => key, new GoogleOAuth(fixture.config, fixture.fetcher), async () => {
      controller.abort();
      return Response.json({ id: "confirmed" });
    });
    const result = await target.call("grace", id, write, controller.signal, async () => {}, "calendar",
      { access: "write", onDispatchChange: value => markers.push(value) });
    assert.equal(result.id, "confirmed"); assert.deepEqual(markers, [true]);
  });

  await t.test("one owner's four running calls do not exhaust another owner's admission", async () => {
    const limited = await grantWith(manager, "limited"), other = await grantWith(manager, "other");
    const fence = gate();
    let waiting = 0;
    const running = Array.from({ length: 4 }, () => manager.call("limited", limited.connection_id, request, signal, async () => {
      if (++waiting === 4) fence.enter();
      await fence.held;
    }));
    await fence.entered;
    try {
      await assert.rejects(manager.call("limited", limited.connection_id, request, signal, async () => {}), /google_busy/);
      await manager.call("other", other.connection_id, request, AbortSignal.timeout(2000), async () => {});
    } finally { fence.open(); await Promise.all(running); }
    await manager.call("limited", limited.connection_id, request, signal, async () => {});
  });
});
