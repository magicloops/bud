import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { gzipSync } from "node:zlib";
import { registerPersonalDataRoutes } from "./routes.js";
import type { IngestContext, ParsedBatch } from "./contracts.js";

const envelope = {
  schema_version: 1, event_id: "event-a", event_type: "location.visit",
  occurred_at: "2026-09-04T10:00:00Z", recorded_at: "2026-09-04T10:00:00Z",
  actor: { user_id: "owner-a", installation_id: "phone-a" }, payload: {},
};

test("shutdown drains contact processing before later database finalizers", async () => {
  const app = Fastify();
  const order: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await registerPersonalDataRoutes(app, {
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
    processor: {
      requeueSupportedLocations: async () => { order.push("processing"); await pending; return false; },
      processNext: async () => { order.push("staging"); return false; },
      publishNext: async () => { order.push("publication"); return false; },
    },
  });
  app.addHook("onClose", async () => { order.push("pool_closed"); });
  await app.ready();
  const closing = app.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["processing"], "pool remains available during active processing");
  release();
  await closing;
  assert.deepEqual(order, ["processing", "staging", "publication", "pool_closed"]);
});

test("encapsulated upload parser, auth, explicit ACK, owner status and commit failure", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const persisted: { context: IngestContext; batch: ParsedBatch }[] = [];
  let fail = false;
  app.post("/unrelated-json", async (request) => request.body);
  await registerPersonalDataRoutes(app, {
    authenticate: async (request) => request.headers.authorization === "Bearer test-a" ? { userId: "owner-a" } : null,
    repository: {
      persist: async (context, batch) => {
        if (fail) throw new Error("database failure with sensitive query parameters");
        persisted.push({ context, batch });
        return { accepted_count: batch.events.length, duplicate_count: 0, acked_event_ids: batch.events.map((e) => e.eventId), rejected: batch.rejected };
      },
      status: async (userId) => ({ sources: [{ owner: userId }] }),
    },
  });
  const headers = { authorization: "Bearer test-a", "content-type": "application/x-ndjson", "content-encoding": "gzip", "x-installation-id": "phone-a", "x-batch-id": "batch-a" };
  const payload = gzipSync(Buffer.from(JSON.stringify(envelope) + "\n"));
  const denied = await app.inject({ method: "POST", url: "/v1/events/batches", headers: { ...headers, authorization: "Bearer invalid" }, payload });
  assert.equal(denied.statusCode, 401);
  assert.equal(persisted.length, 0);
  const accepted = await app.inject({ method: "POST", url: "/v1/events/batches", headers, payload });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().batch_id, "batch-a");
  assert.deepEqual(accepted.json().acked_event_ids, ["event-a"]);
  assert.equal(persisted[0].context.userId, "owner-a");
  const normal = await app.inject({ method: "POST", url: "/unrelated-json", payload: { value: 42 } });
  assert.deepEqual(normal.json(), { value: 42 });
  const status = await app.inject({ url: "/api/data/status", headers: { authorization: "Bearer test-a" } });
  assert.equal(status.json().sources[0].owner, "owner-a");
  assert.equal(status.json().features.automations, false);
  assert.equal(status.json().features.app_keys, false);
  assert.equal(status.json().features.contacts_payload_v2, false);
  fail = true;
  const failed = await app.inject({ method: "POST", url: "/v1/events/batches", headers, payload });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().acked_event_ids, undefined);
  assert.ok(!failed.body.includes("sensitive"));
});

test("uploads with follow-up readings process inline and answer which follow-ups are settled", async t => {
  const app = Fastify();
  t.after(() => app.close());
  const processed: Array<string | undefined> = [];
  let pending = 2;
  await registerPersonalDataRoutes(app, {
    authenticate: async () => ({ userId: "owner-a" }),
    repository: {
      persist: async (_context, batch) => ({ accepted_count: batch.events.length, duplicate_count: 0,
        acked_event_ids: batch.events.map(e => e.eventId), rejected: batch.rejected }),
      status: async () => ({}),
    },
    processor: {
      requeueSupportedLocations: async () => false,
      // The background worker polls without an owner; only the inline drain is counted.
      processNext: async (owner?: string) => { if (!owner) return false; processed.push(owner); return pending-- > 0; },
      publishNext: async () => false,
    },
    settleFollowUps: async (_owner, requests) => Object.fromEntries([...requests].map(([id, request]) =>
      [id, request.transition === "entered" ? "open" : "settled"])),
  });
  const place = "01M5KD6NQN33ZS31CJ8NRXDXCZ", office = "01M5DV10ZNSFWHYS34RCZ6F1PR";
  const line = (eventId: string, type: string, payload: unknown) => JSON.stringify({ ...envelope, event_id: eventId, event_type: type, payload });
  const headers = { "content-type": "application/x-ndjson", "x-installation-id": "phone-a", "x-batch-id": "batch-f" };
  const body = [
    line("f1", "location.fix.v1", { fix_key: "fix:a", reason: "follow_up", coordinate: { lat: 1, lon: 1 }, horizontal_accuracy_m: 5,
      follow_up: { place_id: place, transition: "entered" } }),
    line("f2", "location.region_transition.v1", { place_id: office, transition: "exited", initial: false, occurred_at: envelope.occurred_at,
      geometry_revision: "1" }),
  ].join("\n") + "\n";
  const response = await app.inject({ method: "POST", url: "/v1/events/batches", headers, payload: body });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().follow_ups, { [place]: "open", [office]: "settled" });
  assert.deepEqual(processed, ["owner-a", "owner-a", "owner-a"], "the owner's pending jobs were drained inline, until none were left");
  // A batch without follow-ups answers as before.
  const plain = await app.inject({ method: "POST", url: "/v1/events/batches", headers: { ...headers, "x-batch-id": "batch-g" },
    payload: JSON.stringify(envelope) + "\n" });
  assert.equal(plain.json().follow_ups, undefined);
});

test("app permission capability follows explicit composition setting", async t => {
  const app = Fastify();
  t.after(() => app.close());
  await registerPersonalDataRoutes(app, {
    appKeysEnabled: true,
    authenticate: async () => ({ userId: "owner-a" }),
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
  });
  const response = await app.inject({ url: "/api/data/status" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().features.app_keys, true);
});

test("automation reads authenticate before dispatch and bind the viewer independently of query parameters", async t => {
  const app = Fastify();
  t.after(() => app.close());
  const seen: unknown[][] = [];
  await registerPersonalDataRoutes(app, {
    authenticate: async request => request.headers.authorization === "Bearer a" ? { userId: "owner-a" } : null,
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
    automations: {
      create: async () => { throw new Error("unused"); },
      update: async () => { throw new Error("unused"); },
      pause: async () => { throw new Error("unused"); },
      delete: async () => { throw new Error("unused"); },
      activate: async () => { throw new Error("unused"); },
      list: async (owner, filter) => { seen.push(["list", owner, filter]); return { context_filter: true, items: [] }; },
      get: async (owner, id) => { seen.push(["get", owner, id]); throw new Error("fixture failure"); },
      history: async (owner, id, query) => { seen.push(["history", owner, id, query]); return { items: [], next_cursor: null }; },
    },
  });
  for (const url of ["/api/automations", "/api/automations/rule", "/api/automations/rule/deliveries"]) {
    assert.equal((await app.inject({ url })).statusCode, 401);
  }
  assert.equal(seen.length, 0);
  const headers = { authorization: "Bearer a" };
  assert.equal((await app.inject({ url: "/api/automations?owner=foreign", headers })).statusCode, 400);
  assert.equal(seen.length, 0);
  assert.equal((await app.inject({ url: "/api/automations?bud_id=bud-a&thread_id=thread-a&state=enabled", headers })).statusCode, 200);
  assert.deepEqual(seen[0], ["list", "owner-a", { bud_id: "bud-a", thread_id: "thread-a", state: "enabled" }]);
  assert.equal((await app.inject({ url: "/api/automations/rule/deliveries?limit=2&cursor=abc", headers })).statusCode, 200);
  assert.deepEqual(seen[1], ["history", "owner-a", "rule", { limit: 2, cursor: "abc" }]);
  const failed = await app.inject({ url: "/api/automations/rule", headers });
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes("fixture failure"));
});

test("mounted proposal inventory is distinct from rule detail and approval shares the capability", async t => {
  for (const enabled of [false, true]) {
    const app = Fastify(); t.after(() => app.close());
    const seen: string[] = [];
    await registerPersonalDataRoutes(app, {
      automationActivationEnabled: true, automationProposalsEnabled: enabled,
      authenticate: async () => ({ userId: "owner-a" }),
      repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
      automationProposals: {
        get: async owner => { assert.equal(owner, "owner-a"); return {} as never; },
        list: async owner => { seen.push(owner); return { items: [], next_cursor: null }; },
        decide: async () => { seen.push("decide"); return {} as never; },
        cancel: async () => ({} as never), expireNext: async () => false,
      },
    });
    const inventory = await app.inject({ url: "/api/automations/proposals" });
    assert.equal(inventory.statusCode, 200);
    assert.deepEqual(seen, ["owner-a"]);
    assert.equal(inventory.headers["cache-control"], "no-store");
    const status = await app.inject({ url: "/api/data/status" });
    assert.equal(status.json().features.automation_proposals, enabled);
    const decision = await app.inject({ method: "POST", url: "/api/automations/proposals/proposal/decision",
      payload: { decision: "approve", expected_version: 0, idempotency_key: "retry" } });
    assert.equal(decision.statusCode, enabled ? 200 : 503);
    assert.equal(seen.includes("decide"), enabled);
  }
});


test("expanded capture capability requires successful schema readiness and authenticated uncached status", async t => {
  const app = Fastify(); t.after(() => app.close());
  const order: string[] = [];
  await registerPersonalDataRoutes(app, {
    authenticate: async request => request.headers.authorization === "Bearer owner" ? { userId: "owner-a" } : null,
    verifyExpandedContactsSchema: async () => { order.push("schema"); },
    repository: { persist: async () => { throw new Error("unused"); }, status: async owner => {
      order.push(owner); return { sources: [] };
    } },
  });
  const denied = await app.inject({ url: "/api/data/status" });
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(order, ["schema"]);
  const status = await app.inject({ url: "/api/data/status?owner=foreign", headers: { authorization: "Bearer owner" } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(status.json().features.contacts_payload_v2, true);
  assert.deepEqual(order, ["schema", "owner-a"]);
});

test("missing field schema fails readiness before contact processing starts", async t => {
  const app = Fastify(); t.after(() => app.close());
  const work: string[] = [];
  await registerPersonalDataRoutes(app, {
    verifyExpandedContactsSchema: async () => { throw new Error("missing_contact_fields"); },
    repository: { persist: async () => { throw new Error("unused"); }, status: async () => ({}) },
    processor: {
      requeueSupportedLocations: async () => { work.push("recovery"); return false; },
      processNext: async () => { work.push("stage"); return false; },
      publishNext: async () => { work.push("publish"); return false; },
    },
  });
  await assert.rejects(async () => { await app.ready(); }, /missing_contact_fields/);
  assert.deepEqual(work, []);
});
