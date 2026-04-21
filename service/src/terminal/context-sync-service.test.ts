import assert from "node:assert/strict";
import test from "node:test";
import { ContextSyncService } from "./context-sync-service.js";

function makeService() {
  return new ContextSyncService({} as never, {
    debug() {
      // noop
    },
    info() {
      // noop
    },
    warn() {
      // noop
    },
  } as never);
}

test("detectModeHeuristic treats a bare greater-than prompt as Node REPL", () => {
  const service = makeService();
  const detectModeHeuristic = Reflect.get(service, "detectModeHeuristic") as (
    capture: string,
    lastLine: string,
  ) => string;

  assert.equal(detectModeHeuristic("Welcome to Node.js\n>", ">"), "repl");
});

test("detectModeHeuristic still recognizes shell prompts ending in greater-than", () => {
  const service = makeService();
  const detectModeHeuristic = Reflect.get(service, "detectModeHeuristic") as (
    capture: string,
    lastLine: string,
  ) => string;

  assert.equal(
    detectModeHeuristic("adam@mbp ~/bud>", "adam@mbp ~/bud>"),
    "shell",
  );
});
