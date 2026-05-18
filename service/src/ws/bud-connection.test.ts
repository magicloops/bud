import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { mock } from "node:test";
import { db } from "../db/client.js";
import { decodeLegacyJsonFrame } from "../proto/wire.js";
import {
  dataPlaneSessions,
  registerActiveDataPlaneSessionTracker,
  registerDataPlaneRuntimeStream,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import { BudConnection } from "./bud-connection.js";
import { sessions, type SessionTracker } from "./session-trackers.js";

function createServer() {
  return {
    log: {
      info() {
        // noop
      },
      warn() {
        // noop
      },
      error() {
        // noop
      },
      debug() {
        // noop
      },
    },
  };
}

function createSocket() {
  let readyState = 1;
  const sentFrames: Array<string | Buffer> = [];
  return {
    OPEN: 1,
    get readyState() {
      return readyState;
    },
    on() {
      // noop
    },
    send(payload: string | Buffer) {
      sentFrames.push(payload);
    },
    close() {
      readyState = 3;
    },
    sentFrames,
  };
}

test("handleOfflineTransition rejects pending waits before suspending Bud-owned sessions", async (t) => {
  t.after(() => {
    mock.restoreAll();
  });

  mock.method(db, "update", () => ({
    set() {
      return {
        async where() {
          return undefined;
        },
      };
    },
  }) as never);

  const calls: string[] = [];
  const connection = new BudConnection(
    createServer() as never,
    createSocket() as never,
    {
      async rejectPendingRequestsForBud() {
        calls.push("rejectPendingRequestsForBud");
      },
      async clearCachesForBud() {
        calls.push("clearCachesForBud");
      },
      async clearEventBuffersForBud() {
        calls.push("clearEventBuffersForBud");
      },
      async suspendSessionsForBud() {
        calls.push("suspendSessionsForBud");
      },
      async emitBudOfflineForSessions() {
        calls.push("emitBudOfflineForSessions");
      },
    } as never,
  );
  const handleOfflineTransition = Reflect.get(connection, "handleOfflineTransition") as (
    budId: string,
  ) => Promise<void>;

  await handleOfflineTransition.call(connection, "bud-1");

  assert.deepEqual(calls, [
    "rejectPendingRequestsForBud",
    "clearCachesForBud",
    "clearEventBuffersForBud",
    "suspendSessionsForBud",
    "emitBudOfflineForSessions",
  ]);
});

test("hello frames without binary BudEnvelope support are rejected before auth", async () => {
  const socket = createSocket();
  const connection = new BudConnection(
    createServer() as never,
    socket as never,
    {
      async rejectPendingRequestsForBud() {
        // noop
      },
    } as never,
  );

  const handleRaw = Reflect.get(connection, "handleRaw") as (raw: string) => Promise<void>;
  await handleRaw.call(
    connection,
    JSON.stringify({
      proto: "0.1",
      type: "hello",
      id: "msg_hello",
      ts: 1777132800000,
      ext: {},
      name: "bud-test",
      os: "darwin",
      arch: "arm64",
      token: "enroll_test",
      capabilities: {
        max_concurrency: 1,
        sessions: true,
        terminal: true,
      },
    }),
  );

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sentFrames.length, 1);
  const errorFrame = JSON.parse(socket.sentFrames[0] as string) as Record<string, unknown>;
  assert.equal(errorFrame.type, "error");
  assert.equal(errorFrame.code, "PROTO_VERSION_MISMATCH");
  assert.match(errorFrame.message as string, /websocket_binary/);
});

test("binary BudEnvelope sessions reject legacy JSON text frames", async () => {
  const socket = createSocket();
  const connection = new BudConnection(
    createServer() as never,
    socket as never,
    {
      async rejectPendingRequestsForBud() {
        // noop
      },
    } as never,
  );
  Reflect.set(connection, "state", {
    kind: "connected",
    budId: "b_test",
    sessionId: "s_test",
    hello: binaryEnvelopeHello(),
  });

  const handleIncoming = Reflect.get(connection, "handleIncoming") as (raw: string | Buffer) => Promise<void>;
  await handleIncoming.call(
    connection,
    JSON.stringify({
      proto: "0.1",
      type: "heartbeat",
      id: "msg_heartbeat",
      ts: 1777132800000,
      ext: {},
      session_id: "s_test",
    }),
  );

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sentFrames.length, 1);
  const [encoded] = socket.sentFrames;
  assert.ok(Buffer.isBuffer(encoded));
  const errorFrame = decodeLegacyJsonFrame(encoded);
  assert.equal(errorFrame.type, "error");
  assert.equal(errorFrame.code, "PROTO_VERSION_MISMATCH");
  assert.match(errorFrame.message as string, /Binary BudEnvelope/);
});

test("unknown protobuf payload fields fail with typed unsupported-payload errors", async () => {
  const socket = createSocket();
  const connection = new BudConnection(
    createServer() as never,
    socket as never,
    {
      async rejectPendingRequestsForBud() {
        // noop
      },
    } as never,
  );
  Reflect.set(connection, "state", {
    kind: "connected",
    budId: "b_test",
    sessionId: "s_test",
    hello: binaryEnvelopeHello(),
  });

  const handleIncoming = Reflect.get(connection, "handleIncoming") as (raw: string | Buffer) => Promise<void>;
  await handleIncoming.call(connection, encodeEnvelopeWithUnknownPayloadField(190));

  assert.equal(socket.readyState, 3);
  assert.equal(socket.sentFrames.length, 1);
  const [encoded] = socket.sentFrames;
  assert.ok(Buffer.isBuffer(encoded));
  const errorFrame = decodeLegacyJsonFrame(encoded);
  assert.equal(errorFrame.type, "error");
  assert.equal(errorFrame.code, "UNSUPPORTED_PAYLOAD");
  assert.match(errorFrame.message as string, /190/);
});

test("WebSocket stream frames dispatch into the shared data-plane runtime", async (t) => {
  t.after(() => {
    sessions.clear();
    dataPlaneSessions.clear();
  });
  sessions.clear();
  dataPlaneSessions.clear();

  const socket = createSocket();
  const connection = new BudConnection(createServer() as never, socket as never, {
    async rejectPendingRequestsForBud() {
      // noop
    },
  } as never);
  Reflect.set(connection, "daemonStateStore", {
    async recordHeartbeat() {
      // noop
    },
  });

  const sessionTracker: SessionTracker = {
    budId: "b_test",
    sessionId: "s_test",
    deviceSessionId: "ds_test",
    transportSessionId: "ts_ws",
    drainState: "active",
    lastHeartbeat: Date.now(),
    socket: socket as never,
    supportsEnvelopeBinary: true,
    supportsStreamFrames: true,
    streamFamilies: new Set(["localhost_http_proxy"]),
  };
  sessions.set("b_test", sessionTracker);
  Reflect.set(connection, "tracker", sessionTracker);
  Reflect.set(connection, "state", {
    kind: "connected",
    budId: "b_test",
    sessionId: "s_test",
    hello: {
      capabilities: {
        max_concurrency: 1,
        sessions: true,
        terminal: true,
        bud_envelope: {
          version: 1,
          websocket_binary: true,
          stream_frames: true,
        },
      },
    },
  });

  const chunks: Buffer[] = [];
  const sentFrames: Record<string, unknown>[] = [];
  const dataTracker: DataPlaneSessionTracker = {
    budId: "b_test",
    deviceSessionId: "ds_test",
    controlTransportSessionId: "ts_ws",
    transportSessionId: "ts_ws",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(["localhost_http_proxy"]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame(frame) {
      sentFrames.push(frame);
    },
    isActive() {
      return true;
    },
  };
  registerActiveDataPlaneSessionTracker(dataTracker);
  registerDataPlaneRuntimeStream(dataTracker, {
    streamId: "st_test",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 16,
    onData(chunk) {
      chunks.push(chunk);
    },
  });

  const handleRaw = Reflect.get(connection, "handleRaw") as (raw: string) => Promise<void>;
  await handleRaw.call(
    connection,
    JSON.stringify({
      proto: "0.1",
      type: "stream_data",
      id: "msg_stream_data",
      ts: 1777132800000,
      ext: {},
      stream_id: "st_test",
      stream_type: "localhost_http_proxy",
      offset: 0,
      data: Buffer.from("hello").toString("base64"),
      end_stream: false,
    }),
  );

  assert.deepEqual(chunks.map((chunk) => chunk.toString("utf8")), ["hello"]);
  assert.deepEqual(sentFrames.map((frame) => frame.type), ["stream_credit"]);
});

test("WebSocket stream frame dispatch is not blocked by activity heartbeat writes", async (t) => {
  t.after(() => {
    sessions.clear();
    dataPlaneSessions.clear();
  });
  sessions.clear();
  dataPlaneSessions.clear();

  const socket = createSocket();
  const connection = new BudConnection(createServer() as never, socket as never, {
    async rejectPendingRequestsForBud() {
      // noop
    },
  } as never);
  let releaseHeartbeat!: () => void;
  const heartbeatCanFinish = new Promise<void>((resolve) => {
    releaseHeartbeat = resolve;
  });
  Reflect.set(connection, "daemonStateStore", {
    async recordHeartbeat() {
      await heartbeatCanFinish;
    },
    async transitionStream() {
      // noop
    },
    async appendAuditEvent() {
      // noop
    },
  });

  const sessionTracker: SessionTracker = {
    budId: "b_test",
    sessionId: "s_test",
    deviceSessionId: "ds_test",
    transportSessionId: "ts_ws",
    drainState: "active",
    lastHeartbeat: Date.now(),
    socket: socket as never,
    supportsEnvelopeBinary: true,
    supportsStreamFrames: true,
    streamFamilies: new Set(["localhost_http_proxy"]),
  };
  sessions.set("b_test", sessionTracker);
  Reflect.set(connection, "tracker", sessionTracker);
  Reflect.set(connection, "state", {
    kind: "connected",
    budId: "b_test",
    sessionId: "s_test",
    hello: {
      capabilities: {
        max_concurrency: 1,
        sessions: true,
        terminal: true,
        bud_envelope: {
          version: 1,
          websocket_binary: true,
          stream_frames: true,
        },
      },
    },
  });

  const resetFrames: unknown[] = [];
  const closeFrames: unknown[] = [];
  const sentFrames: Record<string, unknown>[] = [];
  const dataTracker: DataPlaneSessionTracker = {
    budId: "b_test",
    deviceSessionId: "ds_test",
    controlTransportSessionId: "ts_ws",
    transportSessionId: "ts_ws",
    transportKind: "websocket",
    role: "control_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(["localhost_http_proxy"]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame(frame) {
      sentFrames.push(frame);
    },
    isActive() {
      return true;
    },
  };
  registerActiveDataPlaneSessionTracker(dataTracker);
  registerDataPlaneRuntimeStream(dataTracker, {
    streamId: "st_test",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 16,
    onReset(frame) {
      resetFrames.push(frame);
    },
    onClose(frame) {
      closeFrames.push(frame);
    },
  });

  const handleRaw = Reflect.get(connection, "handleRaw") as (raw: string) => Promise<void>;
  const dataPromise = handleRaw.call(
    connection,
    JSON.stringify({
      proto: "0.1",
      type: "stream_data",
      id: "msg_stream_data",
      ts: 1777132800000,
      ext: {},
      stream_id: "st_test",
      stream_type: "localhost_http_proxy",
      offset: 0,
      data: Buffer.from("hello").toString("base64"),
      end_stream: false,
    }),
  );
  const closePromise = handleRaw.call(
    connection,
    JSON.stringify({
      proto: "0.1",
      type: "stream_close",
      id: "msg_stream_close",
      ts: 1777132800001,
      ext: {},
      stream_id: "st_test",
      final_offset: 5,
    }),
  );

  await closePromise;

  assert.deepEqual(resetFrames, []);
  assert.equal(closeFrames.length, 1);
  assert.deepEqual(sentFrames.map((frame) => frame.type), ["stream_credit"]);

  releaseHeartbeat();
  await dataPromise;
});

function binaryEnvelopeHello() {
  return {
    proto: "0.1",
    type: "hello",
    id: "msg_hello",
    ts: 1777132800000,
    ext: {},
    name: "bud-test",
    os: "darwin",
    arch: "arm64",
    capabilities: {
      max_concurrency: 1,
      sessions: true,
      terminal: true,
      bud_envelope: {
        version: 1,
        websocket_binary: true,
        stream_frames: true,
      },
    },
  };
}

function encodeEnvelopeWithUnknownPayloadField(fieldNumber: number): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeStringField(2, "msg_unknown_payload"),
    encodeStringField(10, "2026-04-25T16:00:00.000Z"),
    encodeVarintField(11, 1),
    encodeLengthDelimitedField(fieldNumber, Buffer.alloc(0)),
  ]);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  return encodeLengthDelimitedField(fieldNumber, Buffer.from(value, "utf8"));
}

function encodeLengthDelimitedField(fieldNumber: number, bytes: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function encodeVarint(value: number): Buffer {
  const chunks: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    chunks.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  chunks.push(remaining);
  return Buffer.from(chunks);
}
