import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveToolArgs,
  getEffectiveToolWaitFor,
  parseWaitForArg,
} from "./contracts.js";

test("parseWaitForArg accepts public modes and legacy compatibility modes", () => {
  assert.equal(parseWaitForArg("none"), "none");
  assert.equal(parseWaitForArg("changed"), "changed");
  assert.equal(parseWaitForArg("settled"), "settled");
  assert.equal(parseWaitForArg("shell_ready"), "shell_ready");
  assert.equal(parseWaitForArg("screen_stable"), "settled");
  assert.equal(parseWaitForArg("unknown"), undefined);
  assert.equal(parseWaitForArg(null), undefined);
});

test("effective tool args expose default terminal wait modes", () => {
  assert.equal(
    getEffectiveToolWaitFor({
      type: "tool_call",
      tool: "terminal.send",
      command: "pwd",
      callId: "call-send-default",
    }),
    "settled",
  );
  assert.deepEqual(
    buildEffectiveToolArgs({
      type: "tool_call",
      tool: "terminal.send",
      command: "pwd",
      callId: "call-send-default",
    }),
    {
      command: "pwd",
      wait_for: "settled",
    },
  );
  assert.deepEqual(
    buildEffectiveToolArgs({
      type: "tool_call",
      tool: "terminal.send",
      key: "ctrl+c",
      waitFor: "none",
      callId: "call-send-none",
    }),
    {
      key: "ctrl+c",
      wait_for: "none",
    },
  );
  assert.deepEqual(
    buildEffectiveToolArgs({
      type: "tool_call",
      tool: "terminal.observe",
      lines: -50,
      callId: "call-observe-default",
    }),
    {
      lines: -50,
      wait_for: "none",
    },
  );
  assert.deepEqual(
    buildEffectiveToolArgs({
      type: "tool_call",
      tool: "terminal.observe",
      view: "screen",
      waitFor: "settled",
      callId: "call-observe-settled",
    }),
    {
      view: "screen",
      wait_for: "settled",
    },
  );
  assert.deepEqual(
    buildEffectiveToolArgs({
      type: "tool_call",
      tool: "web_view.open",
      targetHost: "localhost",
      targetPort: 5173,
      path: "/",
      callId: "call-web-view-open",
    }),
    {
      target_host: "localhost",
      target_port: 5173,
      path: "/",
    },
  );
});
