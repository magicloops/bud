import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { pool as defaultPool } from "../db/client.js";
import * as schema from "../db/schema.js";
import { AppKeys, APP_KEY_REQUEST_TOOL } from "../personal-data/app-keys.js";
import { AppDataQueries } from "../personal-data/app-queries.js";
import { registerAppKeyRoutes } from "../personal-data/app-key-routes.js";
import { BudAppData } from "../personal-data/app-key-backend.mjs";
import { createContactApp } from "../personal-data/example-app/server.mjs";
import { ContactProcessor } from "../personal-data/contact-processor.js";
import { PostgresIngestRepository } from "../personal-data/repository.js";
import { parseBatch } from "../personal-data/parser.js";
import { contactManifestDigest } from "../personal-data/contacts.js";
import { InvocationRepository } from "./invocation-repository.js";
import { AgentConversationLoader } from "./conversation-loader.js";

test("app permission parking and same-turn replay survive approval, expiry and cancellation", { skip: process.env.BUD_DATA_DB_TEST !== "1" }, async t => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.databaseUrl).hostname));
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const database = drizzle(pool, { schema });
  const owner = "permission-replay-" + randomUUID();
  const bud = "bud-" + randomUUID(), site = "site-" + randomUUID();
  const threads: string[] = [];
  t.after(async () => {
    try {
      await database.delete(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.createdByUserId, owner));
      await database.delete(schema.dataAccessRequestTable).where(eq(schema.dataAccessRequestTable.createdByUserId, owner));
      await database.delete(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.createdByUserId, owner));
      await database.delete(schema.messageTable).where(inArray(schema.messageTable.threadId, threads));
      await database.delete(schema.threadTable).where(inArray(schema.threadTable.threadId, threads));
      await database.delete(schema.proxiedSiteTable).where(eq(schema.proxiedSiteTable.proxiedSiteId, site));
      await database.delete(schema.budTable).where(eq(schema.budTable.budId, bud));
      for (const table of [schema.dataDomainEventTable, schema.contactRevisionTable, schema.contactTable,
        schema.contactScanRecordTable, schema.contactScanTable, schema.contactSourceTable, schema.locationObservationTable,
        schema.dataProcessingJobTable, schema.dataEventTable, schema.dataCollectionEpochTable, schema.dataInstallationTable]) {
        await database.delete(table).where(eq(table.createdByUserId, owner));
      }
      await database.delete(schema.dataOwnerStateTable).where(eq(schema.dataOwnerStateTable.createdByUserId, owner));
      await database.delete(schema.authUserTable).where(eq(schema.authUserTable.id, owner));
    } finally { await pool.end(); await defaultPool.end(); }
  });
  await database.insert(schema.authUserTable).values({ id: owner, name: "Fixture", email: `${owner}@example.invalid`, emailVerified: false });
  await database.insert(schema.budTable).values({ budId: bud, name: "Fixture", os: "test", arch: "test", createdByUserId: owner });
  await database.insert(schema.proxiedSiteTable).values({ proxiedSiteId: site, budId: bud, displayName: "Private app", slug: site,
    endpointHost: `${site}.example.invalid`, targetHost: "localhost", targetPort: 3210, auditCorrelationId: randomUUID(),
    expiresAt: new Date(Date.now() + 7 * 86400_000), createdByUserId: owner });
  const repo = new InvocationRepository(database);
  const keys = new AppKeys(database);
  const app = Fastify();
  const root = await mkdtemp(join(tmpdir(), "bud-permission-flow-"));
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  await registerAppKeyRoutes(app, { keys, queries: new AppDataQueries(keys), issuanceEnabled: true,
    authenticate: async request => request.headers.authorization === "Bearer fixture-human" ? { userId: owner } : null });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const helperOptions = { appId: "contacts", apiOrigin: origin, stateRoot: root };
  const helper = new BudAppData(helperOptions);
  const identity = await helper.initialize();
  const input = { app_label: "Private app", purpose: "Find contacts", data_access: { scopes: ["contacts.read", "location.read"],
    contact_fields: ["names"], history_days: 90, location_precision: "rounded_2_decimals" },
    destination: { proxied_site_id: site, public_key: identity.public_key } };
  const setup = async () => {
    const thread = randomUUID(); threads.push(thread);
    await database.insert(schema.threadTable).values({ threadId: thread, budId: bud, createdByUserId: owner });
    await repo.admit({ owner, threadId: thread, origin: "human", idempotencyKey: thread,
      text: "Build my contact app", model: "fixture-model", reasoningEffort: "low" });
    const lease = await repo.claim("request-worker", owner); assert.ok(lease);
    await repo.start(lease);
    const callId = randomUUID(), providerCallId = randomUUID(), clientId = randomUUID();
    await repo.recordAction(lease, callId, APP_KEY_REQUEST_TOOL);
    await database.insert(schema.llmCallTable).values({ llmCallId: providerCallId, threadId: thread, turnId: lease.turnId,
      stepIndex: 0, provider: "openai", model: "fixture-model", requestMode: "openai_responses", createdByUserId: owner });
    await database.insert(schema.llmCallItemTable).values([
      { id: callId, name: APP_KEY_REQUEST_TOOL, input },
      { id: `later-${callId}`, name: "terminal_send", input: { text: "echo reconsider" } },
    ].map((block, sequence) => ({ llmCallItemId: randomUUID(), llmCallId: providerCallId, threadId: thread,
      direction: "output", kind: "tool_use", sequence, toolCallId: block.id,
      canonicalPayload: { type: "tool_use", ...block }, createdByUserId: owner })));
    return { thread, lease, callId, clientId, providerCallId };
  };
  const first = await setup();
  const failing = Object.create(database) as typeof database;
  failing.transaction = ((work: (tx: unknown) => Promise<unknown>) => database.transaction(async tx => work(new Proxy(tx, {
    get(target, name) {
      if (name === "update") return (table: unknown) => {
        if (table === schema.agentInvocationActionTable) throw new Error("injected park failure");
        return target.update(table as typeof schema.agentInvocationTable);
      };
      const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
    },
  })))) as typeof database.transaction;
  await assert.rejects(new InvocationRepository(failing).parkAppDataRequest(first.lease, first.callId, first.clientId, input), /injected park failure/);
  assert.equal((await keys.list(owner)).items.length, 0, "request cannot commit without its parked action");
  const pending = await repo.parkAppDataRequest(first.lease, first.callId, first.clientId, input);
  const recovered = await new InvocationRepository(database).pendingDataRequestsForThread(owner, first.thread);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].client_id, first.clientId);
  assert.equal(recovered[0].turn_id, first.lease.turnId);
  assert.deepEqual(recovered[0].request, pending);
  assert.doesNotMatch(JSON.stringify(recovered), /BEGIN PUBLIC KEY|verification_hash|encrypted_envelope/);
  assert.deepEqual(await repo.pendingDataRequestsForThread("another-owner", first.thread), []);
  assert.deepEqual(await repo.pendingDataRequestsForThread(owner, randomUUID()), []);
  await assert.rejects(repo.heartbeat(first.lease), /lease_lost/);
  assert.equal(await repo.claim("new-worker", owner), null);
  const approvalResponse = await fetch(`${origin}/api/data/access-requests/${pending.request_id}/decision`, {
    method: "POST", headers: { authorization: "Bearer fixture-human", "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", expected_version: 0, idempotency_key: "approve" }),
  });
  assert.equal(approvalResponse.status, 200);
  assert.equal(approvalResponse.headers.get("cache-control"), "no-store");
  const approved = await keys.get(owner, pending.request_id);
  assert.deepEqual(await approvalResponse.json(), JSON.parse(JSON.stringify(approved)));
  assert.ok(approved.key);
  assert.deepEqual(await repo.pendingDataRequestsForThread(owner, first.thread), []);
  await database.update(schema.agentInvocationTable).set({ latestStartAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, first.lease.id));
  const resumed = await new InvocationRepository(database).claim("new-worker", owner); assert.ok(resumed);
  assert.equal(resumed.id, first.lease.id); assert.equal(resumed.turnId, first.lease.turnId);
  await repo.defer(resumed, "waiting_for_model", 1);
  const [waiting] = await database.select().from(schema.agentInvocationTable).where(eq(schema.agentInvocationTable.id, resumed.id));
  assert.equal(waiting.reservesThread, true);
  await database.update(schema.agentInvocationTable).set({ nextAttemptAt: new Date(0) }).where(eq(schema.agentInvocationTable.id, resumed.id));
  const available = await repo.claim("available-worker", owner); assert.ok(available);
  await repo.start(available);
  const restored = await repo.prepareQuestionContinuation(available);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].clientId, first.clientId);
  assert.equal(JSON.parse(restored[0].content).key.key_id, approved.key.key_id);
  assert.equal(JSON.parse(restored[0].content).ok, true);
  assert.match(restored[1].content, /not_executed_due_to_permission/);
  assert.deepEqual(await repo.prepareQuestionContinuation(available), []);
  const [storedKey] = await database.select().from(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.id, approved.key.key_id));
  const content = JSON.stringify(restored);
  assert.equal(content.includes(storedKey.verificationHash), false);
  assert.equal(content.includes(String(storedKey.encryptedEnvelope?.ciphertext)), false);
  const replay = await new AgentConversationLoader().loadWithDiagnostics(first.thread, { provider: "openai" });
  const blocks = replay.messages.flatMap(message => typeof message.content === "string" ? [] : message.content);
  assert.equal(blocks.filter(block => block.type === "tool_use" && block.id === first.callId).length, 1);
  assert.equal(blocks.filter(block => block.type === "tool_result" && block.tool_use_id === first.callId).length, 1);
  const permissionResult = blocks.find(block => block.type === "tool_result" && block.tool_use_id === first.callId);
  assert.ok(permissionResult?.type === "tool_result");
  assert.equal(permissionResult.content, restored[0].content);
  assert.equal(replay.sources.some(source => source.kind === "repair"), false);
  const setupContext = { request_id: pending.request_id, key_id: approved.key.key_id,
    recipient_fingerprint: identity.recipient_fingerprint, expires_at: approved.key.setup_expires_at.toISOString() };
  const installed = await helper.install(setupContext);
  assert.deepEqual(installed, { status: "installed", key_id: approved.key.key_id });
  const restartedHelper = new BudAppData(helperOptions);
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const ingestContext = { userId: owner, installationId: randomUUID(), collectionEpoch: "legacy", batchId: randomUUID() };
  const recordId = randomUUID();
  const common = { payload_version: 1, contact_store_id: randomUUID(), scan_id: randomUUID(), generation: 1,
    previous_generation: 0, scan_mode: "baseline", observed_at: observedAt, previous_observed_at: null,
    time_basis: "observed", authorization: "3" };
  const envelope = (event_type: string, event_id: string, payload: object) => ({ schema_version: 1, event_type, event_id,
    occurred_at: observedAt, recorded_at: observedAt,
    actor: { user_id: owner, installation_id: ingestContext.installationId }, payload });
  const records = [envelope("contacts.record.v1", recordId, { ...common, source_contact_id: "fixture-contact",
    change: "upsert", newly_observed: false, contact: { given_name: "Ada", family_name: "Lovelace",
      organization: "HiddenCompany", phones: [{ label: "phone", value: "5559991234" }], emails: [] } }),
    envelope("contacts.scan.v1", randomUUID(), { ...common, expected_event_count: 1,
      event_ids_sha256: contactManifestDigest([recordId]) }),
    envelope("location.significant_change.v1", randomUUID(), { coordinate: { lat: 37.77491, lon: -122.41942 }, horizontal_accuracy_m: 45 })];
  const batch = await parseBatch(Buffer.from(records.map(record => JSON.stringify(record)).join("\n")), "", ingestContext);
  await new PostgresIngestRepository(database).persist(ingestContext, batch);
  const processor = new ContactProcessor(database);
  while (await processor.processNext(owner)) { /* only this fixture's durable jobs */ }
  assert.equal(await processor.publishNext(false, owner), true);
  assert.deepEqual(await database.select().from(schema.dataDomainEventTable).where(eq(schema.dataDomainEventTable.createdByUserId, owner)), [],
    "initial import is queryable without emitting live contact triggers");
  const queried = await restartedHelper.query(approved.key.key_id, "contacts") as { data: { items: unknown[] } };
  assert.equal(queried.data.items.length, 1);
  const example = createContactApp({ appData: restartedHelper, keyId: approved.key.key_id });
  await new Promise<void>(resolve => example.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => example.close(() => resolve())));
  const exampleAddress = example.address();
  assert.ok(exampleAddress && typeof exampleAddress !== "string");
  const exampleOrigin = `http://127.0.0.1:${exampleAddress.port}`;
  const exampleQuery = await fetch(`${exampleOrigin}/api/contacts`);
  assert.equal(exampleQuery.status, 200);
  const page = await exampleQuery.json() as { data: { items: { id: string; fields: unknown }[] } };
  assert.equal(page.data.items.length, 1);
  const contact = page.data.items[0];
  assert.deepEqual(contact.fields, { given_name: "Ada", family_name: "Lovelace" });
  for (const search of ["HiddenCompany", "5559991234"]) {
    const response = await fetch(`${exampleOrigin}/api/contacts?search=${search}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { data: { items: unknown[] } }).data.items, []);
  }
  const detail = await fetch(`${exampleOrigin}/api/contacts/${contact.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json() as { data: { fields: unknown } }).data.fields, contact.fields);
  const history = await fetch(`${exampleOrigin}/api/contacts/${contact.id}/history`);
  assert.equal(history.status, 200);
  const revisions = (await history.json() as { data: { items: { fields: unknown }[] } }).data.items;
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].fields, contact.fields);
  const window = new URLSearchParams({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() });
  const contextResponse = await fetch(`${exampleOrigin}/api/contacts/${contact.id}/location-context?${window}`);
  assert.equal(contextResponse.status, 200);
  const context = (await contextResponse.json() as { data: { evidence: { coordinate: unknown; source_horizontal_accuracy_m: number;
    coordinate_precision: string }; continuous_coverage: boolean; uncertainty: string } }).data;
  assert.deepEqual(context.evidence.coordinate, { lat: 37.77, lon: -122.42 });
  assert.equal(context.evidence.source_horizontal_accuracy_m, 45);
  assert.equal(context.evidence.coordinate_precision, "rounded_2_decimals");
  assert.equal(context.continuous_coverage, false);
  assert.match(context.uncertainty, /Not a verified meeting/);
  assert.doesNotMatch(JSON.stringify([page, revisions, context]), /HiddenCompany|5559991234|37\.77491|122\.41942/);
  const privateState = JSON.parse(await readFile(join(root, "contacts", `${approved.key.key_id}.json`), "utf8"));
  assert.ok(typeof privateState.credential === "string");
  assert.equal(JSON.stringify([approved, restored, replay.messages, installed, queried]).includes(privateState.credential), false);
  const [installedRow] = await database.select().from(schema.dataAppKeyTable).where(eq(schema.dataAppKeyTable.id, approved.key.key_id));
  assert.equal(installedRow.encryptedEnvelope, null);
  const revoked = await fetch(`${origin}/api/data/app-keys/${approved.key.key_id}/revoke`, {
    method: "POST", headers: { authorization: "Bearer fixture-human", "content-type": "application/json" },
    body: JSON.stringify({ expected_version: installedRow.version, idempotency_key: "revoke-flow" }),
  });
  assert.equal(revoked.status, 200);
  await assert.rejects(restartedHelper.query(approved.key.key_id, "contacts"));
  assert.equal((await fetch(`${exampleOrigin}/api/contacts`)).status, 403);
  await repo.finish(available, "succeeded", "completed");

  for (const decision of ["decline", "expire", "cancel"] as const) {
    const next = await setup();
    const request = await repo.parkAppDataRequest(next.lease, next.callId, next.clientId, input);
    if (decision === "decline") await keys.decide(owner, request.request_id, { decision, expected_version: 0, idempotency_key: decision });
    else if (decision === "expire") await new AppKeys(database, () => new Date(Date.now() + 2 * 86400_000)).expireNext(owner);
    else {
      await repo.requestCancel(owner, next.lease.id);
      assert.equal((await keys.get(owner, request.request_id)).status, "canceled");
      assert.deepEqual(await repo.pendingDataRequestsForThread(owner, next.thread), []);
      assert.equal(await repo.claim("canceled-worker", owner), null);
      continue;
    }
    const continuation = await repo.claim("decision-worker", owner); assert.ok(continuation);
    await repo.start(continuation);
    const messages = await repo.prepareQuestionContinuation(continuation);
    assert.equal(JSON.parse(messages[0].content).ok, false);
    assert.equal(JSON.parse(messages[0].content).key, null);
    await repo.finish(continuation, "succeeded", "completed");
  }
});
