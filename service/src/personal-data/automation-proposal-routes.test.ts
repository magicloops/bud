import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerAutomationProposalRoutes } from "./automation-proposal-routes.js";
import { DataRequestError } from "./contracts.js";

test("automation review routes require a human owner and gate only approval after owned lookup", async () => {
  const calls: unknown[] = [];
  const proposals = {
    get: async (owner: string, id: string) => {
      calls.push(["get", owner, id]);
      if (owner !== "owner" || id !== "proposal") throw new DataRequestError(404, "automation_proposal_not_found", "Not found");
      return { proposal_id: id } as never;
    },
    list: async (owner: string, query: unknown) => { calls.push(["list", owner, query]); return { items: [], next_cursor: null }; },
    decide: async (owner: string, id: string, input: unknown) => { calls.push(["decide", owner, id, input]); return { proposal_id: id } as never; },
    cancel: async (owner: string, id: string, input: unknown) => { calls.push(["cancel", owner, id, input]); return { proposal_id: id } as never; },
  };
  const app = Fastify();
  await registerAutomationProposalRoutes(app, { proposals, authenticate: async request => {
    const value = request.headers.authorization;
    return value === "Bearer human" ? { userId: "owner" } : value === "Bearer other" ? { userId: "other" } : null;
  } });
  try {
    const root = "/api/automations/proposals";
    for (const url of [root, `${root}/proposal`]) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      assert.equal((await app.inject({ url, headers: { authorization: "Bearer dak_fake" } })).statusCode, 401);
    }
    const headers = { authorization: "Bearer human" };
    const decision = { decision: "approve", expected_version: 0, idempotency_key: "retry" };
    const post = { method: "POST" as const, url: `${root}/proposal/decision`, headers, payload: decision };
    assert.equal((await app.inject({ ...post, headers: { authorization: "Bearer other" } })).statusCode, 404);
    const gated = await app.inject(post);
    assert.equal(gated.statusCode, 503);
    assert.equal(gated.headers["cache-control"], "no-store");
    assert.equal(calls.some(call => (call as string[])[0] === "decide"), false);
    assert.equal((await app.inject({ ...post, payload: { ...decision, owner: "other" } })).statusCode, 400);
    assert.equal((await app.inject({ ...post, payload: { ...decision, decision: "decline" } })).statusCode, 200);
    assert.equal((await app.inject({ url: `${root}?owner=other`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: `${root}?pending_only=maybe`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: `${root}?limit=10&pending_only=true`, headers })).statusCode, 200);
    assert.deepEqual(calls.at(-1), ["list", "owner", { limit: 10, cursor: undefined, pending_only: true }]);
    assert.equal((await app.inject({ ...post, payload: { ...decision, padding: "x".repeat(5000) } })).statusCode, 413);
  } finally { await app.close(); }
});
