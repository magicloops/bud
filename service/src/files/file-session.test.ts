import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFileRelativePath,
  normalizeFileRootKey,
  normalizeFileSessionPermissions,
  resolveFileTransportStatus,
} from "./file-session.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";

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

test("file transport status requires an active carrier with file-read support", () => {
  dataPlaneSessions.clear();

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
    available: false,
    code: "DATA_PLANE_UNAVAILABLE",
    message: "Bud does not have an active data-plane carrier",
    deviceSessionId: null,
    controlTransportSessionId: null,
    dataTransportSessionId: null,
    transportKind: null,
  });

  const dataTracker = makeDataPlaneTracker(["localhost_http_proxy"]);
  registerActiveDataPlaneSessionTracker(dataTracker);

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
    available: false,
    code: "STREAM_FAMILY_UNSUPPORTED",
    message: "Bud data-plane carrier has not negotiated file_read support",
    deviceSessionId: "ds_1",
    controlTransportSessionId: "ts_ws",
    dataTransportSessionId: "ts_ws",
    transportKind: "websocket",
  });

  dataTracker.streams.add("file_read");

  assert.deepEqual(resolveFileTransportStatus("bud-1"), {
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
