import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProxyAllowedMethods,
  normalizeProxyTargetHost,
  resolveProxyTransportStatus,
} from "./proxy-session.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";

test("proxy target validation only permits explicit loopback host", () => {
  assert.equal(normalizeProxyTargetHost("127.0.0.1"), "127.0.0.1");
  assert.throws(
    () => normalizeProxyTargetHost("localhost"),
    /Only http:\/\/127\.0\.0\.1:<port> proxy targets are allowed/,
  );
  assert.throws(
    () => normalizeProxyTargetHost("10.0.0.1"),
    /Only http:\/\/127\.0\.0\.1:<port> proxy targets are allowed/,
  );
});

test("proxy method validation normalizes safe method sets", () => {
  assert.deepEqual(normalizeProxyAllowedMethods(), ["GET", "HEAD"]);
  assert.deepEqual(normalizeProxyAllowedMethods(["get"]), ["GET", "HEAD"]);
  assert.deepEqual(normalizeProxyAllowedMethods(["post", "POST", "options"]), ["POST", "OPTIONS"]);
  assert.throws(() => normalizeProxyAllowedMethods(["connect"]), /Proxy method connect is not allowed/);
});

function makeDataPlaneTracker(streams: string[]): DataPlaneSessionTracker {
  return {
    budId: "bud-1",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_ws",
    transportSessionId: "ts_ws",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(streams),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame() {
      // noop
    },
    isActive() {
      return true;
    },
  };
}

test("proxy transport status requires an active carrier with localhost proxy support", () => {
  dataPlaneSessions.clear();

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: false,
    code: "DATA_PLANE_UNAVAILABLE",
    message: "Bud does not have an active data-plane carrier",
    deviceSessionId: null,
    controlTransportSessionId: null,
    dataTransportSessionId: null,
    transportKind: null,
  });

  const dataTracker = makeDataPlaneTracker(["file_read"]);
  registerActiveDataPlaneSessionTracker(dataTracker);

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: false,
    code: "STREAM_FAMILY_UNSUPPORTED",
    message: "Bud data-plane carrier has not negotiated localhost_http_proxy support",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_ws",
    dataTransportSessionId: "ts_ws",
    transportKind: "websocket",
  });

  dataTracker.streams.add("localhost_http_proxy");

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: true,
    code: null,
    message: null,
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_ws",
    dataTransportSessionId: "ts_ws",
    transportKind: "websocket",
  });

  dataPlaneSessions.clear();
});
