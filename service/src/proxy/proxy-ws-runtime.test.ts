import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import WebSocket from "ws";
import { PROTO_VERSION, config } from "../config.js";
import {
  ProxyWebSocketRuntimeSession,
  clearProxyWebSocketRuntimeSessionsForTests,
  closeProxyWebSocketRuntimeSessionsForSite,
  countActiveProxyWebSocketRuntimeSessionsForSite,
  handleProxyWebSocketClose,
  handleProxyWebSocketOpenResult,
  registerProxyWebSocketRuntimeSession,
} from "./proxy-ws-runtime.js";

test("proxy WebSocket runtime forwards browser and daemon text/binary frames", () => {
  const browser = createBrowserSocket();
  const daemonFrames: Record<string, unknown>[] = [];
  const runtime = new ProxyWebSocketRuntimeSession(
    "st_ws",
    "op_ws",
    "bud-1",
    "site-1",
    browser as never,
    (frame) => {
      daemonFrames.push(frame);
      return true;
    },
    () => undefined,
  );

  assert.equal(runtime.sendBrowserMessage(Buffer.from("hello"), false), true);
  assert.equal(runtime.sendBrowserMessage(Buffer.from([0, 1, 2]), true), true);
  assert.equal(daemonFrames[0]?.type, "proxy_ws_message");
  assert.equal(daemonFrames[0]?.message_type, "text");
  assert.equal(daemonFrames[0]?.data, "hello");
  assert.equal(daemonFrames[1]?.message_type, "binary");
  assert.equal(daemonFrames[1]?.data, Buffer.from([0, 1, 2]).toString("base64"));

  runtime.handleDaemonMessage({
    proto: PROTO_VERSION,
    type: "proxy_ws_message",
    id: "msg_daemon_text",
    ts: Date.now(),
    ext: {},
    ws_session_id: "st_ws",
    message_type: "text",
    data: "world",
  });
  runtime.handleDaemonMessage({
    proto: PROTO_VERSION,
    type: "proxy_ws_message",
    id: "msg_daemon_binary",
    ts: Date.now(),
    ext: {},
    ws_session_id: "st_ws",
    message_type: "binary",
    data: Buffer.from([3, 4, 5]).toString("base64"),
  });

  assert.equal(browser.sent[0]?.payload, "world");
  assert.deepEqual(browser.sent[0]?.options, { binary: false });
  assert.deepEqual(browser.sent[1]?.payload, Buffer.from([3, 4, 5]));
  assert.deepEqual(browser.sent[1]?.options, { binary: true });
});

test("proxy WebSocket runtime resolves daemon open results by session id", async (t) => {
  t.after(() => {
    clearProxyWebSocketRuntimeSessionsForTests();
  });

  const browser = createBrowserSocket();
  const runtime = new ProxyWebSocketRuntimeSession(
    "st_open",
    "op_open",
    "bud-1",
    "site-1",
    browser as never,
    () => true,
    () => undefined,
  );
  registerProxyWebSocketRuntimeSession(runtime);

  const wait = runtime.waitForOpen(1000);
  const parsed = handleProxyWebSocketOpenResult({
    proto: PROTO_VERSION,
    type: "proxy_ws_open_result",
    id: "msg_open_result",
    ts: Date.now(),
    ext: {},
    operation_id: "op_open",
    ws_session_id: "st_open",
    accepted: true,
    selected_protocol: "vite-hmr",
  });

  assert.equal(parsed?.accepted, true);
  assert.equal((await wait).selected_protocol, "vite-hmr");
});

test("proxy WebSocket runtime propagates daemon close and cleans active state", (t) => {
  t.after(() => {
    clearProxyWebSocketRuntimeSessionsForTests();
  });

  const browser = createBrowserSocket();
  let cleaned = false;
  const runtime = new ProxyWebSocketRuntimeSession(
    "st_close",
    "op_close",
    "bud-1",
    "site-1",
    browser as never,
    () => true,
    () => {
      cleaned = true;
    },
  );
  registerProxyWebSocketRuntimeSession(runtime);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite("site-1"), 1);

  const parsed = handleProxyWebSocketClose({
    proto: PROTO_VERSION,
    type: "proxy_ws_close",
    id: "msg_close",
    ts: Date.now(),
    ext: {},
    ws_session_id: "st_close",
    code: 1001,
    reason: "going away",
  });

  assert.equal(parsed?.code, 1001);
  assert.equal(browser.closed[0]?.code, 1001);
  assert.equal(browser.closed[0]?.reason, "going away");
  assert.equal(cleaned, true);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite("site-1"), 0);
});

test("proxy WebSocket runtime rejects oversized browser frames with typed service close", () => {
  const browser = createBrowserSocket();
  const daemonFrames: Record<string, unknown>[] = [];
  let cleaned = false;
  const runtime = new ProxyWebSocketRuntimeSession(
    "st_over_limit",
    "op_over_limit",
    "bud-1",
    "site-1",
    browser as never,
    (frame) => {
      daemonFrames.push(frame);
      return true;
    },
    () => {
      cleaned = true;
    },
  );

  assert.equal(runtime.sendBrowserMessage(Buffer.alloc(config.proxyWebSocketMaxMessageBytes + 1), true), false);
  assert.equal(daemonFrames[0]?.type, "proxy_ws_error");
  assert.deepEqual((daemonFrames[0]?.error as { code?: string })?.code, "PROXY_WS_MESSAGE_TOO_LARGE");
  assert.equal(daemonFrames[1]?.type, "proxy_ws_close");
  assert.equal(browser.closed[0]?.code, 1011);
  assert.equal(cleaned, true);
  assert.equal(runtime.isComplete(), true);
});

test("proxy WebSocket runtime can close all active sessions for a disabled site", (t) => {
  t.after(() => {
    clearProxyWebSocketRuntimeSessionsForTests();
  });
  clearProxyWebSocketRuntimeSessionsForTests();

  const first = createRuntimeForSite("st_disable_1", "site-disable");
  const second = createRuntimeForSite("st_disable_2", "site-disable");
  const other = createRuntimeForSite("st_disable_other", "site-other");
  registerProxyWebSocketRuntimeSession(first.runtime);
  registerProxyWebSocketRuntimeSession(second.runtime);
  registerProxyWebSocketRuntimeSession(other.runtime);

  const closed = closeProxyWebSocketRuntimeSessionsForSite("site-disable", {
    reason: "site_disabled",
    closeCode: 1008,
    error: {
      code: "PROXIED_SITE_DISABLED",
      message: "proxied site was disabled",
      retryable: false,
    },
  });

  assert.equal(closed, 2);
  assert.equal(first.browser.closed[0]?.code, 1008);
  assert.equal(second.browser.closed[0]?.code, 1008);
  assert.equal(other.browser.closed.length, 0);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite("site-disable"), 0);
  assert.equal(countActiveProxyWebSocketRuntimeSessionsForSite("site-other"), 1);
});

function createRuntimeForSite(wsSessionId: string, proxiedSiteId: string) {
  const browser = createBrowserSocket();
  const runtime = new ProxyWebSocketRuntimeSession(
    wsSessionId,
    `op_${wsSessionId}`,
    "bud-1",
    proxiedSiteId,
    browser as never,
    () => true,
    () => undefined,
  );
  return { browser, runtime };
}

function createBrowserSocket() {
  return {
    readyState: WebSocket.OPEN as number,
    sent: [] as Array<{ payload: string | Buffer; options: { binary?: boolean } }>,
    closed: [] as Array<{ code: number; reason: string }>,
    send(payload: string | Buffer, options: { binary?: boolean }) {
      this.sent.push({ payload, options });
    },
    close(code: number, reason: string) {
      this.closed.push({ code, reason });
      this.readyState = WebSocket.CLOSED;
    },
  };
}
