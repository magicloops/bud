import assert from "node:assert/strict";
import test from "node:test";
import { PendingRequestEvents, pendingRequestKinds } from "./pending-events.js";
import type { ThreadChange } from "./change-listener.js";

test("pending publication checks current ownership and invalidates continuity on failure", async () => {
  const emitted: unknown[] = [];
  let losses = 0, owned = true, fail = false;
  const events = new PendingRequestEvents({ emit: (_thread, event) => { emitted.push(event); return "cursor"; },
    invalidateReplay: () => { losses++; } }, async () => { if (fail) throw Error("db unavailable"); return owned; });
  const hint: ThreadChange = { owner: "owner", thread_id: "thread", message_id: null, kind: "pending" };
  events.changed(hint); await events.flush();
  assert.deepEqual(emitted, [{ event: "agent.pending_requests_changed", data: { kinds: pendingRequestKinds } }]);
  owned = false; events.changed(hint); await events.flush(); assert.equal(emitted.length, 1);
  fail = true; events.changed(hint); await events.flush(); assert.equal(losses, 1);
  fail = false; owned = true; events.changed(hint); await events.flush(); assert.equal(emitted.length, 2);
});

test("loss during ownership lookup cannot publish a prior generation", async () => {
  let release!: (owned: boolean) => void;
  let published = 0;
  const events = new PendingRequestEvents({ emit: () => { published++; return "cursor"; }, invalidateReplay: () => {} },
    () => new Promise(resolve => { release = resolve; }));
  events.changed({ owner: "owner", thread_id: "thread", message_id: null, kind: "pending" });
  events.lost(); release(true); await events.flush(); assert.equal(published, 0);
});
