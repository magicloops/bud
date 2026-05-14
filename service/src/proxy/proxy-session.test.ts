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

test("proxy target validation permits loopback hosts", () => {
  assert.equal(normalizeProxyTargetHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeProxyTargetHost("localhost"), "localhost");
  assert.equal(normalizeProxyTargetHost("::1"), "::1");
  assert.throws(
    () => normalizeProxyTargetHost("10.0.0.1"),
    /Only localhost loopback proxy targets are allowed/,
  );
});

test("proxy method validation normalizes safe method sets", () => {
  assert.deepEqual(normalizeProxyAllowedMethods(), [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ]);
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

  const missingStatus = resolveProxyTransportStatus("bud-1");
  assert.equal(missingStatus.available, false);
  assert.equal(missingStatus.code, "DATA_PLANE_UNAVAILABLE");
  assert.equal(missingStatus.transportKind, null);
  assert.deepEqual(missingStatus.candidateTransports, []);

  const dataTracker = makeDataPlaneTracker(["file_read"]);
  registerActiveDataPlaneSessionTracker(dataTracker);

  const unsupportedStatus = resolveProxyTransportStatus("bud-1");
  assert.equal(unsupportedStatus.available, false);
  assert.equal(unsupportedStatus.code, "STREAM_FAMILY_UNSUPPORTED");
  assert.equal(unsupportedStatus.deviceSessionId, "ds_1");
  assert.equal(unsupportedStatus.transportKind, "websocket");
  assert.equal(unsupportedStatus.candidateTransports[0]?.reason, "stream family unsupported");

  dataTracker.streams.add("localhost_http_proxy");

  const readyStatus = resolveProxyTransportStatus("bud-1");
  assert.equal(readyStatus.available, true);
  assert.equal(readyStatus.code, null);
  assert.equal(readyStatus.deviceSessionId, "ds_1");
  assert.equal(readyStatus.transportKind, "websocket");
  assert.equal(readyStatus.health?.status, "healthy");
  assert.match(readyStatus.selectionReason, /selected websocket/);

  dataPlaneSessions.clear();
});
