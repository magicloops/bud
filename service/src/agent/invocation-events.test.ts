import assert from "node:assert/strict";
import test from "node:test";
import { InvocationEvents } from "./invocation-events.js";
import type { Invocation } from "./invocation-repository.js";
import { AgentRuntimeStateManager } from "../runtime/agent-runtime-state.js";

test("delayed commit hints reload current state and serialize publication", async () => {
  let current = { id: "one", status: "running" } as Invocation;
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const publisher = new InvocationEvents(row => seen.push(row.status), () => assert.fail('publication failed'), async () => {
    const row = current;
    if (++reads === 1) await gate;
    return row;
  });
  publisher.changed(['one']);
  current = { ...current, status: 'succeeded' };
  publisher.changed(['one', 'one']);
  release();
  await publisher.flush();
  assert.deepEqual(seen, ['running', 'succeeded']);
  publisher.changed(['one']); // A delayed callback from the running commit.
  await publisher.flush();
  assert.deepEqual(seen, ['running', 'succeeded', 'succeeded']);
});

test("failed publication invalidates replay and later hints remain usable", async () => {
  const runtime = new AgentRuntimeStateManager();
  const cursor = runtime.getSnapshot('thread').stream_cursor;
  const events: string[] = [];
  const attachment = runtime.attachCallback('thread', event => events.push(event.event));
  let fail = true;
  const publisher = new InvocationEvents(() => events.push('published'), () => runtime.invalidateReplay(), async () => {
    if (fail) throw new Error('database unavailable');
    return { id: 'one' } as Invocation;
  });
  publisher.changed(['one']);
  await publisher.flush();
  assert.deepEqual(events, ['agent.resync_required']);
  assert.equal(runtime.attachCallback('thread', () => {}, {afterCursor: cursor}).status, 'resync_required');
  fail = false;
  publisher.changed(['one']);
  await publisher.flush();
  assert.deepEqual(events, ['agent.resync_required', 'published']);
  attachment.detach();
});
