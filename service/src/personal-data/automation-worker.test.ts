import assert from "node:assert/strict";
import test from "node:test";
import { AutomationWorker } from "./automation-worker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker did not reach checkpoint")), 2000); })]); }
  finally { clearTimeout(timer); }
}

test("automation worker does not poll until started and drains active work before stop", async () => {
  const entered = deferred(), release = deferred();
  const calls: string[] = [];
  const worker = new AutomationWorker({
    matchNext: async () => { calls.push("match"); entered.resolve(); await release.promise; return true; },
    admitLive: async () => { calls.push("live"); return true; },
    admitBootstrap: async () => { calls.push("bootstrap"); return true; },
  });
  assert.deepEqual(calls, []);
  worker.start(); worker.start();
  await reached(entered.promise);
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  await stopping;
  assert.deepEqual(calls, ["match"], "shutdown must not admit more work after an in-flight match");
  await worker.stop();
});

test("automation polling bounds rounds and isolates failures between work queues", async () => {
  const done = deferred();
  const calls: string[] = [], errors: string[] = [];
  let bootstrapCalls = 0;
  const worker = new AutomationWorker({
    matchNext: async () => { calls.push("match"); throw new Error("sensitive database details"); },
    admitLive: async () => { calls.push("live"); return true; },
    admitBootstrap: async () => { calls.push("bootstrap"); if (++bootstrapCalls === 2) done.resolve(); return true; },
  }, code => errors.push(code), 2, 100000);
  worker.start();
  try { await reached(done.promise); }
  finally { await worker.stop(); }
  assert.deepEqual(calls, ["match", "live", "bootstrap", "match", "live", "bootstrap"]);
  assert.deepEqual(errors, ["automation_matchNext_failed", "automation_matchNext_failed"]);
  assert.ok(!errors.join().includes("sensitive"));
});
