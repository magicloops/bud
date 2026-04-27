import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProxyAllowedMethods,
  normalizeProxyTargetHost,
  resolveProxyTransportStatus,
} from "./proxy-session.js";
import { grpcSessions } from "../transport/grpc-daemon-router.js";
import {
  grpcDataSessionKey,
  grpcDataSessions,
  type GrpcDataSessionTracker,
} from "../transport/grpc-data-router.js";

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

test("proxy transport status requires active gRPC control and data streams", () => {
  grpcSessions.clear();
  grpcDataSessions.clear();

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: false,
    code: "GRPC_CONTROL_UNAVAILABLE",
    message: "Bud does not have an active authenticated gRPC control stream",
    deviceSessionId: null,
    controlTransportSessionId: null,
    dataTransportSessionId: null,
  });

  grpcSessions.set("bud-1", {
    budId: "bud-1",
    sessionId: "s_1",
    deviceSessionId: "ds_1",
    transportSessionId: "ts_control",
    lastHeartbeat: Date.now(),
    call: { destroyed: false } as never,
  });

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: false,
    code: "GRPC_DATA_UNAVAILABLE",
    message: "Bud does not have an active HTTP/2 data stream attached",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_control",
    dataTransportSessionId: null,
  });

  grpcDataSessions.set(grpcDataSessionKey("bud-1", "ds_1"), {
    budId: "bud-1",
    deviceSessionId: "ds_1",
    transportSessionId: "ts_data",
    lastSeenAt: Date.now(),
    streams: new Set(["terminal_output"]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    call: { destroyed: false } as never,
  } as GrpcDataSessionTracker);

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: false,
    code: "GRPC_DATA_UNAVAILABLE",
    message: "Bud HTTP/2 data stream has not negotiated localhost proxy support",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_control",
    dataTransportSessionId: "ts_data",
  });

  const dataTracker = grpcDataSessions.get(grpcDataSessionKey("bud-1", "ds_1"));
  dataTracker?.streams.add("localhost_http_proxy");

  assert.deepEqual(resolveProxyTransportStatus("bud-1"), {
    available: true,
    code: null,
    message: null,
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_control",
    dataTransportSessionId: "ts_data",
  });

  grpcSessions.clear();
  grpcDataSessions.clear();
});
