import assert from "node:assert/strict";
import test, { mock } from "node:test";
import Fastify from "fastify";
import { auth } from "../../auth/auth.js";
import { db } from "../../db/client.js";
import { registerThreadOpenRoute } from "./open.js";

test("open authorizes before bounded reads and captures one early runtime boundary", async t => {
  t.after(() => mock.restoreAll());
  const server = Fastify();
  t.after(() => server.close());
  const threadId = "11111111-1111-4111-8111-111111111111";
  let signedIn = false, owned = false, reads = 0, snapshots = 0, failRead = false;
  let cursor = "epoch:10";
  mock.method(auth.api, "getSession", async () => signedIn ? {
    user: { id: "owner" }, session: { id: "session", expiresAt: new Date(Date.now() + 60000) },
  } as never : null);
  mock.method(db.query.threadTable, "findFirst", async () => owned ? {
    threadId, budId: "bud", createdByUserId: "owner",
  } as never : undefined);
  mock.method(db, "select", (projection?: unknown) => {
    reads++;
    assert.equal(snapshots, 1, "runtime boundary precedes canonical reads");
    cursor = "epoch:11"; // Publication while canonical reads are in flight.
    const chain = {
      from() { return chain; }, innerJoin() { return chain; }, leftJoin() { return chain; }, where() { return chain; },
      orderBy() {
        if (!projection) return chain;
        return chain;
      },
      limit(limit: number) {
        if (projection && "cursorTimestamp" in (projection as object)) { assert.equal(limit, 8); return Promise.resolve([]); }
        assert.equal(limit, 1);
        return failRead ? Promise.reject(new Error("required read failed")) : Promise.resolve([{
          threadId, budId: "bud", modelId: null, reasoningEffort: null, sessionId: null,
          lastAttentionMessageId: null, lastAttentionMessageCreatedAt: null,
          lastSeenMessageId: null, lastSeenMessageCreatedAt: null,
        }]);
      },
    };
    return chain as never;
  });
  await registerThreadOpenRoute(server, {
    getEnvironmentForBud: async () => ({ mode: "normal", bud_status: "online" }),
    getContextTools: () => assert.fail("open must not reconstruct idle context"),
  } as never, { getSnapshot: () => {
    snapshots++;
    return { active: false, stream_cursor: cursor, draft_assistant: { text: "early" }, context_budget: { stale: true } };
  } } as never);
  const url = `/api/threads/${threadId}/open?limit=7`;
  assert.equal((await server.inject(url)).statusCode, 401);
  signedIn = true;
  assert.equal((await server.inject(url)).statusCode, 404);
  assert.equal(reads, 0);
  assert.equal(snapshots, 0);
  owned = true;
  for (const query of ["limit=201", "limit=0", "limit=1.5", "browser=true"]) {
    assert.equal((await server.inject(`/api/threads/${threadId}/open?${query}`)).statusCode, 400);
  }
  assert.equal(reads, 0);
  const response = await server.inject(url);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json();
  assert.equal(body.stream_cursor, "epoch:10");
  assert.equal(body.agent_state.stream_cursor, "epoch:10");
  assert.equal(body.agent_state.context_budget, undefined);
  assert.deepEqual(body.included, { web_view: false, browser: false, context_budget: false });
  assert.equal(body.transcript.page.limit, 7);
  assert.equal(snapshots, 1);
  failRead = true;
  snapshots = 0;
  assert.equal((await server.inject(url)).statusCode, 500, "required data failure must not look like an empty snapshot");
});
