import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerAppKeyRoutes } from "./app-key-routes.js";
import { AppKeyMaintenance } from "./app-key-maintenance.js";
import { DataRequestError } from "./contracts.js";

test("human approval and app query/setup routes use separate authentication boundaries", async t => {
  const logs: string[] = [];
  const app = Fastify({ logger: { stream: { write: (text: string) => logs.push(text) } } });
  t.after(() => app.close());
  const calls: unknown[][] = [];
  const credential = "dak_01K00000000000000000000000." + "s".repeat(43);
  type Dependencies = NonNullable<Parameters<typeof registerAppKeyRoutes>[1]>;
  const keys = {
    get: async (owner: string, id: string) => {
      calls.push(["get", owner, id]);
      if (id !== "owned" || owner !== "owner-a") throw new DataRequestError(404, "app_data_not_found", "Not found");
      return { request_id: id };
    },
    list: async (...args: unknown[]) => { calls.push(["list", ...args]); return { items: [], next_cursor: null }; },
    decide: async (...args: unknown[]) => { calls.push(["decision", ...args]); return { status: "declined" }; },
    revoke: async (...args: unknown[]) => { calls.push(["revoke", ...args]); return { status: "revoked" }; },
    handoff: async (...args: unknown[]) => { calls.push(["handoff", ...args]); throw new Error("private backend failure " + credential); },
    expireNext: async () => false,
  } as unknown as Dependencies["keys"];
  await registerAppKeyRoutes(app, { keys,
    authenticate: async request => {
      // Explicit Authorization always wins over an otherwise valid cookie.
      if (request.headers.authorization) return request.headers.authorization === "Bearer oauth-a" ? { userId: "owner-a" } : null;
      return request.headers.cookie === "session=a" ? { userId: "owner-a" } : null;
    },
    queries: { execute: async (...args) => { calls.push(["query", ...args]); return { data: {}, permission: {} } as never; } },
  });
  const decision = { decision: "approve", expected_version: 0, idempotency_key: "retry" };
  for (const headers of [{}, { authorization: `Bearer ${credential}`, cookie: "session=a" }]) {
    assert.equal((await app.inject({ url: "/api/data/access-requests", headers })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/data/access-requests/owned/decision", headers, payload: decision })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/data/app-keys/key/revoke", headers, payload: decision })).statusCode, 401);
  }
  assert.equal(calls.length, 0);
  const human = { cookie: "session=a" };
  assert.equal((await app.inject({ url: "/api/data/access-requests?pending_only=true&limit=2", headers: human })).statusCode, 200);
  assert.deepEqual(calls[0], ["list", "owner-a", { limit: 2, cursor: undefined, pending_only: true }]);
  assert.equal((await app.inject({ url: "/api/data/access-requests?owner=other", headers: human })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/data/access-requests?pending_only=yes", headers: human })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/data/access-requests/foreign/decision", headers: human, payload: decision })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/data/access-requests/owned/decision", headers: human, payload: decision })).statusCode, 503);
  assert.equal(calls.some(call => call[0] === "decision"), false, "disabled issuance cannot mint a key");
  const declined = await app.inject({ method: "POST", url: "/api/data/access-requests/owned/decision", headers: human,
    payload: { ...decision, decision: "decline" } });
  assert.equal(declined.statusCode, 200);
  assert.equal(declined.headers["cache-control"], "no-store");
  for (const headers of [human, { authorization: "Bearer oauth-a" }, {}])
    assert.equal((await app.inject({ url: "/api/app-data/contacts", headers })).statusCode, 403);
  assert.equal(calls.some(call => call[0] === "query"), false);
  const queried = await app.inject({ url: "/api/app-data/contacts/contact/history?limit=2", headers: { authorization: `Bearer ${credential}` } });
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.headers["cache-control"], "no-store");
  assert.deepEqual(calls.at(-1), ["query", credential, "contacts_history", { limit: 2, contact_id: "contact" }]);
  const signature = "p".repeat(512);
  const failed = await app.inject({ method: "POST", url: "/api/app-data/setup/key/retrieve", payload: { signature } });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(calls.at(-1), ["handoff", "key", "retrieve", { signature }]);
  assert.equal(failed.body.includes(credential), false);
  assert.equal((await app.inject({ method: "POST", url: "/api/app-data/setup/key/retrieve", payload: { signature: "x".repeat(3000) } })).statusCode, 413);
  assert.equal(logs.join("").includes(credential), false);
  assert.equal(logs.join("").includes(signature), false);
});

test("expiry maintenance is lazy, bounded and drains before closing the database", async () => {
  let release!: () => void;
  let began!: () => void;
  let count = 0;
  const started = new Promise<void>(resolve => { began = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = new AppKeyMaintenance({ expireNext: async () => { count++; began(); await held; return true; } });
  assert.equal(count, 0);
  worker.start(); worker.start();
  // A live timeout keeps this isolated test alive while the worker timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 2000);
  await started;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release(); await stopping; clearTimeout(keepAlive);
  assert.equal(count, 1);
  await worker.stop();
});

test("expiry maintenance caps each polling pass", async () => {
  let count = 0;
  let reached!: () => void;
  const complete = new Promise<void>(resolve => { reached = resolve; });
  const worker = new AppKeyMaintenance({ expireNext: async () => { if (++count === 25) reached(); return true; } }, undefined, 60_000);
  const keepAlive = setTimeout(() => {}, 2000);
  worker.start();
  await complete;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(count, 25);
  await worker.stop(); clearTimeout(keepAlive);
});
