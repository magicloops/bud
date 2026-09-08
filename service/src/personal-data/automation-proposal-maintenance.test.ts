import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomationProposalMaintenance } from "./automation-proposal-maintenance.js";

test("proposal expiry starts explicitly and shutdown drains the current operation", async () => {
  let calls = 0, release!: () => void, entered!: () => void;
  const pending = new Promise<boolean>(resolve => { release = () => resolve(true); });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const worker = new AutomationProposalMaintenance({ expireNext: async () => { calls++; entered(); return pending; } });
  assert.equal(calls, 0);
  worker.start(); worker.start();
  // Keep the test process alive while the production timer remains unref'd.
  const alive = setTimeout(() => {}, 1000);
  try {
    await started;
    let stopped = false;
    const closing = worker.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release(); await closing;
    assert.equal(calls, 1, "stop prevents the next expiry in the batch");
    await worker.stop();
  } finally { clearTimeout(alive); await worker.stop(); }
});

test("proposal expiry failures are reported without losing the shutdown handle", async () => {
  let reported!: () => void;
  const failure = new Promise<void>(resolve => { reported = resolve; });
  const worker = new AutomationProposalMaintenance({ expireNext: async () => { throw new Error("database unavailable"); } }, reported);
  const alive = setTimeout(() => {}, 1000);
  try { worker.start(); await failure; await worker.stop(); }
  finally { clearTimeout(alive); await worker.stop(); }
});
