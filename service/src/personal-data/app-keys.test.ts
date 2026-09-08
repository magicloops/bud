import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt, randomUUID, sign } from "node:crypto";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppKeys, APP_KEY_REQUEST_TOOL } from "./app-keys.js";
import { appKeyProofMessage, type AppKeyContext } from "./app-key-crypto.js";
import { DataRequestError } from "./contracts.js";
import Fastify from "fastify";
import { registerAppKeyRoutes } from "./app-key-routes.js";
import { AppDataQueries } from "./app-queries.js";
import { ContactQueries } from "./contact-queries.js";
import { LocationQueries } from "./location.js";
import { BudAppData } from "./app-key-backend.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("app data approval, encrypted recovery, scoped proof and revocation are durable and owner-bound", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const database = drizzle(pool, { schema });
  const owners = ["app-key-test-" + randomUUID(), "app-key-test-" + randomUUID()];
  const buds = owners.map(() => "bud-" + randomUUID());
  const threads = owners.map(() => randomUUID());
  const invocations = owners.map(() => "inv-" + randomUUID());
  const sites = owners.map(() => "site-" + randomUUID());
  t.after(async () => {
    try {
      await database.delete(schema.dataAppKeyTable).where(inArray(schema.dataAppKeyTable.createdByUserId, owners));
      await database.delete(schema.dataAccessRequestTable).where(inArray(schema.dataAccessRequestTable.createdByUserId, owners));
      await database.delete(schema.agentInvocationTable).where(inArray(schema.agentInvocationTable.createdByUserId, owners));
      await database.delete(schema.messageTable).where(inArray(schema.messageTable.threadId, threads));
      await database.delete(schema.threadTable).where(inArray(schema.threadTable.threadId, threads));
      await database.delete(schema.proxiedSiteTable).where(inArray(schema.proxiedSiteTable.proxiedSiteId, sites));
      await database.delete(schema.budTable).where(inArray(schema.budTable.budId, buds));
      await database.delete(schema.dataOwnerStateTable).where(inArray(schema.dataOwnerStateTable.createdByUserId, owners));
      await database.delete(schema.authUserTable).where(inArray(schema.authUserTable.id, owners));
    } finally { await pool.end(); await defaultPool.end(); }
  });
  await database.insert(schema.authUserTable).values(owners.map(id => ({ id, name: "App data fixture", email: `${id}@example.invalid`, emailVerified: false })));
  await database.insert(schema.budTable).values(owners.map((owner, i) => ({ budId: buds[i], name: "Fixture", os: "test", arch: "test", createdByUserId: owner })));
  await database.insert(schema.threadTable).values(owners.map((owner, i) => ({ threadId: threads[i], budId: buds[i], createdByUserId: owner })));
  for (let i = 0; i < owners.length; i++) {
    const [message] = await database.insert(schema.messageTable).values({ threadId: threads[i], clientId: randomUUID(), role: "user", content: "Build a contact app", createdByUserId: owners[i] }).returning();
    await database.insert(schema.agentInvocationTable).values({ id: invocations[i], turnId: randomUUID(), threadId: threads[i], budId: buds[i],
      inputMessageId: message.messageId, origin: "human", idempotencyKey: "test", model: "fixture", reasoningEffort: "low", status: "running",
      reservesThread: true, workerId: "app-key-worker", fence: 1, leaseExpiresAt: new Date(Date.now() + 3600_000), createdByUserId: owners[i] });
    await database.insert(schema.proxiedSiteTable).values({ proxiedSiteId: sites[i], budId: buds[i], displayName: "Contact app",
      slug: sites[i], endpointHost: `${sites[i]}.example.invalid`, targetHost: "localhost", targetPort: 3210,
      auditCorrelationId: randomUUID(), expiresAt: new Date(Date.now() + 7 * 86400_000), createdByUserId: owners[i] });
  }
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const request = { app_label: "Contact app", purpose: "Search contacts", data_access: {
    scopes: ["contacts.read"], contact_fields: ["names"], location_precision: "none", history_days: 90,
  }, destination: { proxied_site_id: sites[0], public_key: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } };
  const repo = new AppKeys(database);
  const app = Fastify();
  t.after(() => app.close());
  await registerAppKeyRoutes(app, { keys: repo, issuanceEnabled: true,
    queries: new AppDataQueries(repo, new ContactQueries(database), new LocationQueries(database)),
    authenticate: async request => request.headers.authorization === "Bearer user-a" ? { userId: owners[0] }
      : request.headers.authorization === "Bearer user-b" ? { userId: owners[1] } : null,
  });
  const context = { owner: owners[0], invocationId: invocations[0], workerId: "app-key-worker", fence: 1, callId: "create" };
  const expectCode = (code: string) => (error: unknown) => { assert.ok(error instanceof DataRequestError); assert.equal(error.code, code); return true; };
  const intent = async (callId: string) => {
    await database.insert(schema.agentInvocationActionTable).values({ id: randomUUID(), invocationId: invocations[0], callId,
      fence: 1, kind: APP_KEY_REQUEST_TOOL, status: "intent", createdByUserId: owners[0] });
    return { ...context, callId };
  };
  const make = async (callId: string) => repo.request(await intent(callId), request);
  const approve = (id: string, retry: string = randomUUID()) => repo.decide(owners[0], id, { decision: "approve", expected_version: 0, idempotency_key: retry });
  const proof = (action: "retrieve" | "installed", info: AppKeyContext, digest?: string) => ({ signature: sign("sha256", appKeyProofMessage(action, info, digest), {
    key: pair.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
  }).toString("base64url") });

  await assert.rejects(repo.request(context, request), expectCode("app_data_intent_required"));
  await intent("create");
  await assert.rejects(repo.request({ ...context, fence: 0 }, request), expectCode("invocation_unavailable"));
  await assert.rejects(repo.request({ ...context, owner: owners[1] }, request), expectCode("app_data_not_found"));
  await assert.rejects(repo.request(context, { ...request, destination: { ...request.destination, proxied_site_id: sites[1] } }), expectCode("app_data_not_found"));
  const pending = await Promise.all([repo.request(context, request), repo.request(context, request)]);
  assert.equal(pending[0].request_id, pending[1].request_id);
  await assert.rejects(repo.request(context, { ...request, purpose: "Changed" }), expectCode("app_data_conflict"));
  assert.equal((await database.select().from(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.createdByUserId, owners[0]))).length, 0);
  await assert.rejects(repo.get(owners[1], pending[0].request_id), expectCode("app_data_not_found"));
  await assert.rejects(repo.decide(owners[1], pending[0].request_id, { decision: "approve", expected_version: 0, idempotency_key: "foreign" }), expectCode("app_data_not_found"));
  assert.deepEqual((await repo.list(owners[1])).items, []);

  const decision = "approval-retry";
  const approved = await Promise.all([approve(pending[0].request_id, decision), approve(pending[0].request_id, decision)]);
  const key = approved[0].key!;
  assert.equal(approved[0].status, "approved");
  assert.equal(key.key_id, approved[1].key?.key_id);
  await assert.rejects(repo.decide(owners[0], pending[0].request_id, { decision: "decline", expected_version: 0, idempotency_key: decision }), expectCode("app_data_conflict"));
  const info: AppKeyContext = { request_id: pending[0].request_id, key_id: key.key_id,
    recipient_fingerprint: pending[0].destination.recipient_fingerprint, expires_at: key.setup_expires_at.toISOString() };
  await assert.rejects(repo.handoff(key.key_id, "retrieve", { signature: "A".repeat(512) }), expectCode("app_data_not_found"));
  const retrieval = proof("retrieve", info);
  const firstDelivery = await repo.handoff(key.key_id, "retrieve", retrieval);
  const restarted = new AppKeys(database);
  assert.deepEqual(await restarted.handoff(key.key_id, "retrieve", retrieval), firstDelivery, "restart retrieves the original ciphertext without minting");
  assert.ok(firstDelivery.envelope);
  const envelope = firstDelivery.envelope;
  const credential = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
    oaepLabel: Buffer.from(JSON.stringify(["bud-app-key-v1", info.request_id, info.key_id, info.recipient_fingerprint, info.expires_at])),
  }, Buffer.from(envelope.ciphertext, "base64url")).toString();
  await assert.rejects(repo.authenticate(credential), expectCode("app_data_key_invalid"));
  await assert.rejects(repo.handoff(key.key_id, "installed", retrieval), expectCode("app_data_not_found"));
  const receipt = proof("installed", info, envelope.ciphertext_sha256);
  assert.equal((await repo.handoff(key.key_id, "installed", receipt)).status, "installed");
  assert.equal((await restarted.handoff(key.key_id, "installed", receipt)).status, "installed");
  const installed = await repo.get(owners[0], pending[0].request_id);
  const authority = await repo.authenticate(credential);
  assert.equal(authority.owner, owners[0]);
  assert.deepEqual(authority.policy.contact_fields, ["names"]);
  await repo.confirmCurrent(authority);
  const [stored] = await database.select().from(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.id, key.key_id));
  assert.equal(stored.encryptedEnvelope, null);
  assert.ok(stored.lastUsedAt);
  const ordinary = JSON.stringify([approved, installed, await repo.list(owners[0]), authority]);
  for (const secret of [credential, stored.verificationHash, envelope.ciphertext, retrieval.signature, receipt.signature])
    assert.equal(ordinary.includes(secret), false, "ordinary metadata must omit credential and delivery material");
  await database.update(schema.proxiedSiteTable).set({ enabled: false }).where(eq(schema.proxiedSiteTable.proxiedSiteId, sites[0]));
  await assert.rejects(repo.authenticate(credential), expectCode("app_data_key_invalid"));
  await database.update(schema.proxiedSiteTable).set({ enabled: true }).where(eq(schema.proxiedSiteTable.proxiedSiteId, sites[0]));
  const revoke = { expected_version: installed.key!.version, idempotency_key: "revoke-retry" };
  await assert.rejects(repo.revoke(owners[1], key.key_id, revoke), expectCode("app_data_not_found"));
  const revoked = await Promise.all([repo.revoke(owners[0], key.key_id, revoke), repo.revoke(owners[0], key.key_id, revoke)]);
  assert.ok(revoked.every(row => row.status === "revoked"));
  await assert.rejects(repo.authenticate(credential), expectCode("app_data_key_invalid"));
  await assert.rejects(repo.confirmCurrent(authority), expectCode("app_data_key_invalid"));
  assert.equal((await repo.handoff(key.key_id, "installed", receipt)).status, "revoked");

  const race = await make("decision-race");
  const decisions = await Promise.allSettled([approve(race.request_id), repo.decide(owners[0], race.request_id,
    { decision: "decline", expected_version: 0, idempotency_key: "decline-race" })]);
  assert.equal(decisions.filter(result => result.status === "fulfilled").length, 1);
  const settled = await repo.get(owners[0], race.request_id);
  assert.equal(!!settled.key, settled.status === "approved");
  const declined = await make("decline");
  assert.equal((await repo.decide(owners[0], declined.request_id, { decision: "decline", expected_version: 0, idempotency_key: "decline" })).key, null);

  const atomic = await make("rollback");
  const failing = Object.create(database) as typeof database;
  failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(async tx => work(new Proxy(tx, {
    get(target, name) {
      if (name === "update") return (table: unknown) => {
        if (table === schema.dataAccessRequestTable) throw new Error("injected decision failure");
        return target.update(table as typeof schema.dataAppKeyTable);
      };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  })))) as typeof database.transaction;
  await assert.rejects(new AppKeys(failing).decide(owners[0], atomic.request_id,
    { decision: "approve", expected_version: 0, idempotency_key: "rollback" }), /injected decision failure/);
  assert.equal((await repo.get(owners[0], atomic.request_id)).status, "pending");
  assert.equal((await repo.get(owners[0], atomic.request_id)).key, null, "key insertion rolls back with approval");

  const httpRequest = await make("http-approval");
  const userHeaders = { authorization: "Bearer user-a" };
  assert.equal((await app.inject({ url: `/api/data/access-requests/${httpRequest.request_id}`, headers: { authorization: "Bearer user-b" } })).statusCode, 404);
  const httpApproved = await app.inject({ method: "POST", url: `/api/data/access-requests/${httpRequest.request_id}/decision`, headers: userHeaders,
    payload: { decision: "approve", expected_version: 0, idempotency_key: "http-approve" } });
  assert.equal(httpApproved.statusCode, 200);
  const httpKey = httpApproved.json().key;
  const httpInfo: AppKeyContext = { key_id: httpKey.key_id, request_id: httpRequest.request_id,
    recipient_fingerprint: httpRequest.destination.recipient_fingerprint, expires_at: httpKey.setup_expires_at };
  const httpDelivery = await app.inject({ method: "POST", url: `/api/app-data/setup/${httpKey.key_id}/retrieve`, payload: proof("retrieve", httpInfo) });
  assert.equal(httpDelivery.statusCode, 200);
  const httpEnvelope = httpDelivery.json().envelope;
  const httpCredential = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
    oaepLabel: Buffer.from(JSON.stringify(["bud-app-key-v1", httpInfo.request_id, httpInfo.key_id, httpInfo.recipient_fingerprint, httpInfo.expires_at])),
  }, Buffer.from(httpEnvelope.ciphertext, "base64url")).toString();
  const appHeaders = { authorization: `Bearer ${httpCredential}` };
  assert.equal((await app.inject({ url: "/api/app-data/contacts", headers: appHeaders })).statusCode, 403);
  const httpInstalled = await app.inject({ method: "POST", url: `/api/app-data/setup/${httpKey.key_id}/installed`,
    payload: proof("installed", httpInfo, httpEnvelope.ciphertext_sha256) });
  assert.equal(httpInstalled.json().status, "installed");
  const httpQuery = await app.inject({ url: "/api/app-data/contacts", headers: appHeaders });
  assert.equal(httpQuery.statusCode, 200);
  assert.deepEqual(httpQuery.json().data.items, []);
  assert.deepEqual(httpQuery.json().permission.contact_fields, ["names"]);
  assert.equal((await app.inject({ url: "/api/app-data/contacts?owner=foreign", headers: appHeaders })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/app-data/location?from=2026-09-03T00:00:00Z&to=2026-09-04T00:00:00Z", headers: appHeaders })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/api/data/app-keys/${httpKey.key_id}/revoke`, headers: userHeaders,
    payload: { expected_version: 1, idempotency_key: "http-revoke" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/app-data/contacts", headers: appHeaders })).statusCode, 403);

  const helperRoot = await mkdtemp(join(tmpdir(), "bud-app-key-http-"));
  t.after(() => rm(helperRoot, { recursive: true, force: true }));
  const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  const helperDownload = await fetch(`${apiOrigin}/api/app-data/backend-helper.mjs`);
  assert.equal(helperDownload.status, 200);
  assert.match(await helperDownload.text(), /export class BudAppData/);
  const helper = new BudAppData({ appId: "http-example", apiOrigin, stateRoot: helperRoot });
  const recipientMetadata = await helper.initialize();
  const backendRequest = await repo.request(await intent("backend-helper"), { ...request,
    destination: { ...request.destination, public_key: recipientMetadata.public_key } });
  const backendApproved = await approve(backendRequest.request_id);
  const installedByHelper = await helper.install({ request_id: backendRequest.request_id,
    key_id: backendApproved.key!.key_id, recipient_fingerprint: recipientMetadata.recipient_fingerprint,
    expires_at: backendApproved.key!.setup_expires_at.toISOString() });
  assert.equal(installedByHelper.status, "installed");
  const helperQuery = await helper.query(installedByHelper.key_id, "contacts", { search: "Ada" }) as { data: { items: unknown[] } };
  assert.deepEqual(helperQuery.data.items, []);
  const backendInstalled = await repo.get(owners[0], backendRequest.request_id);
  await repo.revoke(owners[0], installedByHelper.key_id, { expected_version: backendInstalled.key!.version, idempotency_key: "helper-revoke" });
  await assert.rejects(helper.query(installedByHelper.key_id, "contacts"), /app_data_permission_denied/);

  const expiring = await make("expires");
  const setup = await approve((await make("setup-expires")).request_id);
  const future = new AppKeys(database, () => new Date(Date.now() + 2 * 86400_000));
  assert.equal(await future.expireNext(owners[1]), false);
  assert.equal(await future.expireNext(owners[0]), true);
  assert.equal((await repo.get(owners[0], expiring.request_id)).status, "expired");
  assert.equal((await repo.get(owners[0], setup.request_id)).key?.status, "setup_failed");
  assert.equal((await database.select().from(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.id, setup.key!.key_id)))[0].encryptedEnvelope, null);

  const canceled = await make("cancel");
  await database.update(schema.agentInvocationTable).set({ cancelRequestedAt: new Date() }).where(eq(schema.agentInvocationTable.id, invocations[0]));
  const canceledResult = await approve(canceled.request_id);
  assert.equal(canceledResult.status, "canceled");
  assert.equal(canceledResult.key, null);
  const page = await repo.list(owners[0], { limit: 1 });
  assert.ok(page.next_cursor);
  await assert.rejects(repo.list(owners[1], { limit: 1, cursor: page.next_cursor }), expectCode("invalid_app_data_cursor"));
  await assert.rejects(repo.list(owners[0], { limit: 1, cursor: page.next_cursor, pending_only: true }), expectCode("invalid_app_data_cursor"));
  assert.notEqual((await repo.list(owners[0], { limit: 1, cursor: page.next_cursor })).items[0].request_id, page.items[0].request_id);
});
