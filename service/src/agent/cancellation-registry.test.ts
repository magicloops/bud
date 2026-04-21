import assert from "node:assert/strict";
import test from "node:test";
import { AgentCancellationRegistry } from "./cancellation-registry.js";

test("cancel aborts and removes the controller for a thread", () => {
  const registry = new AgentCancellationRegistry();
  const controller = new AbortController();

  registry.set("thread-1", controller);
  const canceled = registry.cancel("thread-1");

  assert.equal(canceled, controller);
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.has("thread-1"), false);
});

test("clear removes a controller without aborting it", () => {
  const registry = new AgentCancellationRegistry();
  const controller = new AbortController();

  registry.set("thread-1", controller);
  registry.clear("thread-1");

  assert.equal(controller.signal.aborted, false);
  assert.equal(registry.has("thread-1"), false);
});
