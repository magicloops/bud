import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFileRelativePath,
  normalizeFileRootKey,
  normalizeFileSessionPermissions,
  resolveFileTransportStatus,
} from "./file-session.js";
import { grpcSessions } from "../transport/grpc-daemon-router.js";
import {
  grpcDataSessionKey,
  grpcDataSessions,
  type GrpcDataSessionTracker,
} from "../transport/grpc-data-router.js";

test("file root validation only permits workspace root in Phase 4.3", () => {
  assert.equal(normalizeFileRootKey("workspace"), "workspace");
  assert.throws(
    () => normalizeFileRootKey("home"),
    /Only the workspace file root is allowed/,
  );
  assert.throws(
    () => normalizeFileRootKey("/"),
    /Only the workspace file root is allowed/,
  );
});

test("file path validation normalizes safe root-relative POSIX paths", () => {
  assert.equal(normalizeFileRelativePath("src/index.ts"), "src/index.ts");
  assert.equal(normalizeFileRelativePath("./src//index.ts"), "src/index.ts");
  assert.throws(() => normalizeFileRelativePath("/etc/passwd"), /root-relative/);
  assert.throws(() => normalizeFileRelativePath("../secrets"), /parent-directory/);
  assert.throws(() => normalizeFileRelativePath("src/../secrets"), /parent-directory/);
  assert.throws(() => normalizeFileRelativePath("C:\\Users\\adam"), /POSIX-style/);
});

test("file permission validation normalizes implied read/stat permissions", () => {
  assert.deepEqual(normalizeFileSessionPermissions(), ["stat", "read", "range"]);
  assert.deepEqual(normalizeFileSessionPermissions(["read"]), ["read", "stat"]);
  assert.deepEqual(normalizeFileSessionPermissions(["range"]), ["range", "read", "stat"]);
  assert.deepEqual(normalizeFileSessionPermissions(["STAT", "read", "read"]), ["stat", "read"]);
  assert.throws(() => normalizeFileSessionPermissions(["write"]), /File permission write is not allowed/);
});

test("file transport status requires active gRPC control and file-read data support", () => {
  grpcSessions.clear();
  grpcDataSessions.clear();

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
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

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
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
    streams: new Set(["localhost_http_proxy"]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    call: { destroyed: false } as never,
  } as GrpcDataSessionTracker);

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
    available: false,
    code: "GRPC_DATA_UNAVAILABLE",
    message: "Bud HTTP/2 data stream has not negotiated file-read support",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_control",
    dataTransportSessionId: "ts_data",
  });

  const dataTracker = grpcDataSessions.get(grpcDataSessionKey("bud-1", "ds_1"));
  dataTracker?.streams.add("file_read");

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
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
