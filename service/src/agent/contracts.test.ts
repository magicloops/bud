import assert from "node:assert/strict";
import test from "node:test";
import { parseWaitForArg } from "./contracts.js";

test("parseWaitForArg accepts public modes and legacy compatibility modes", () => {
  assert.equal(parseWaitForArg("none"), "none");
  assert.equal(parseWaitForArg("changed"), "changed");
  assert.equal(parseWaitForArg("settled"), "settled");
  assert.equal(parseWaitForArg("shell_ready"), "shell_ready");
  assert.equal(parseWaitForArg("screen_stable"), "settled");
  assert.equal(parseWaitForArg("unknown"), undefined);
  assert.equal(parseWaitForArg(null), undefined);
});
