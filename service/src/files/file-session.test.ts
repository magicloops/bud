import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFileRelativePath,
  normalizeFileRootKey,
  normalizeFileSessionPermissions,
  parseViewerFilePath,
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

test("viewer file path parsing extracts relative paths and location metadata", () => {
  assert.deepEqual(parseViewerFilePath("README.md"), {
    kind: "relative",
    rawPath: "README.md",
    relativePath: "README.md",
  });
  assert.deepEqual(parseViewerFilePath("./src//index.ts:12:4"), {
    kind: "relative",
    rawPath: "./src//index.ts:12:4",
    relativePath: "src/index.ts",
    line: 12,
    column: 4,
  });
  assert.deepEqual(parseViewerFilePath("web/src/lib/api.ts#L42-L48"), {
    kind: "relative",
    rawPath: "web/src/lib/api.ts#L42-L48",
    relativePath: "web/src/lib/api.ts",
    line: 42,
  });
  assert.deepEqual(parseViewerFilePath("web/src/lib/api.ts:12", { line: 50 }), {
    kind: "relative",
    rawPath: "web/src/lib/api.ts:12",
    relativePath: "web/src/lib/api.ts",
    line: 50,
  });
  assert.deepEqual(parseViewerFilePath("/Users/adam/bud/docs/proto.md:12"), {
    kind: "absolute_posix",
    rawPath: "/Users/adam/bud/docs/proto.md:12",
    requestedPath: "/Users/adam/bud/docs/proto.md",
    line: 12,
  });
});

test("viewer file path parsing rejects out-of-scope forms", () => {
  assert.throws(() => parseViewerFilePath("~/secrets.txt"), /root-relative/);
  assert.throws(() => parseViewerFilePath("../outside.txt"), /parent-directory/);
  assert.throws(() => parseViewerFilePath("service/../outside.txt"), /parent-directory/);
  assert.throws(() => parseViewerFilePath("C:/Users/adam/file.txt"), /POSIX-style/);
  assert.throws(() => parseViewerFilePath("https://example.com/file.ts"), /URLs/);
  assert.throws(() => parseViewerFilePath("src/"), /Directory paths/);
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

  const missingStatus = resolveFileTransportStatus("bud-1");
  assert.equal(missingStatus.available, false);
  assert.equal(missingStatus.code, "DATA_PLANE_UNAVAILABLE");
  assert.equal(missingStatus.transportKind, null);
  assert.deepEqual(missingStatus.candidateTransports, []);

  const dataTracker = makeDataPlaneTracker(["localhost_http_proxy"]);
  registerActiveDataPlaneSessionTracker(dataTracker);

  const unsupportedStatus = resolveFileTransportStatus("bud-1");
  assert.equal(unsupportedStatus.available, false);
  assert.equal(unsupportedStatus.code, "STREAM_FAMILY_UNSUPPORTED");
  assert.equal(unsupportedStatus.deviceSessionId, "ds_1");
  assert.equal(unsupportedStatus.transportKind, "websocket");
  assert.equal(unsupportedStatus.candidateTransports[0]?.reason, "stream family unsupported");

  dataTracker.streams.add("file_read");

  const readyStatus = resolveFileTransportStatus("bud-1");
  assert.equal(readyStatus.available, true);
  assert.equal(readyStatus.code, null);
  assert.equal(readyStatus.deviceSessionId, "ds_1");
  assert.equal(readyStatus.transportKind, "websocket");
  assert.equal(readyStatus.health?.status, "healthy");
  assert.match(readyStatus.selectionReason, /selected websocket/);

  dataPlaneSessions.clear();
});
