import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  dataPlaneSessions,
  checkDataPlaneRuntimeStreamCapacity,
  countActiveDataPlaneRuntimeStreamsForBud,
  handleDataPlaneStreamFrame,
  registerActiveDataPlaneSessionTracker,
  registerDataPlaneRuntimeStream,
  selectDataPlaneCarrier,
  type DataPlaneSessionTracker,
} from "./data-plane-router.js";

function makeTracker(
  overrides: Partial<DataPlaneSessionTracker> = {},
  sentFrames: Record<string, unknown>[] = [],
): DataPlaneSessionTracker {
  return {
    budId: "b_test",
    deviceSessionId: "s_test",
    controlTransportSessionId: "ts_control",
    transportSessionId: "ts_data",
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
    ...overrides,
  };
}

function makeLogger() {
  return {
    warn() {
      // noop
    },
    error() {
      // noop
    },
    debug() {
      // noop
    },
  };
}

test("selectDataPlaneCarrier reports no active carrier", (t) => {
  t.after(() => dataPlaneSessions.clear());
  dataPlaneSessions.clear();

  const result = selectDataPlaneCarrier({
    budId: "b_test",
    streamType: "localhost_http_proxy",
  });

  assert.equal(result.available, false);
  assert.equal(result.code, "DATA_PLANE_UNAVAILABLE");
  assert.equal(result.transportKind, null);
});

test("selectDataPlaneCarrier selects a WebSocket control+data carrier", (t) => {
  t.after(() => dataPlaneSessions.clear());
  dataPlaneSessions.clear();
  registerActiveDataPlaneSessionTracker(makeTracker());

  const result = selectDataPlaneCarrier({
    budId: "b_test",
    streamType: "localhost_http_proxy",
  });

  assert.equal(result.available, true);
  assert.equal(result.transportKind, "websocket");
  assert.equal(result.role, "control_data");
  assert.equal(result.controlTransportSessionId, "ts_control");
  assert.equal(result.dataTransportSessionId, "ts_data");
});

test("selectDataPlaneCarrier distinguishes unsupported stream families", (t) => {
  t.after(() => dataPlaneSessions.clear());
  dataPlaneSessions.clear();
  registerActiveDataPlaneSessionTracker(makeTracker({ streams: new Set(["file_read"]) }));

  const result = selectDataPlaneCarrier({
    budId: "b_test",
    streamType: "localhost_http_proxy",
  });

  assert.equal(result.available, false);
  assert.equal(result.code, "STREAM_FAMILY_UNSUPPORTED");
  assert.equal(result.transportKind, "websocket");
});

test("selectDataPlaneCarrier prefers WebSocket when both current carriers are active", (t) => {
  t.after(() => dataPlaneSessions.clear());
  dataPlaneSessions.clear();
  registerActiveDataPlaneSessionTracker(
    makeTracker({
      transportKind: "h2_data",
      role: "data",
      transportSessionId: "ts_h2",
    }),
  );
  registerActiveDataPlaneSessionTracker(makeTracker({ transportSessionId: "ts_ws" }));

  const result = selectDataPlaneCarrier({
    budId: "b_test",
    streamType: "localhost_http_proxy",
  });

  assert.equal(result.available, true);
  assert.equal(result.transportKind, "websocket");
  assert.equal(result.dataTransportSessionId, "ts_ws");
});

test("handleDataPlaneStreamFrame dispatches stream data through runtime callbacks", async () => {
  const sentFrames: Record<string, unknown>[] = [];
  const chunks: Buffer[] = [];
  const closes: unknown[] = [];
  const tracker = makeTracker({}, sentFrames);
  registerDataPlaneRuntimeStream(tracker, {
    streamId: "st_test",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 16,
    onData(chunk) {
      chunks.push(chunk);
    },
    onClose(frame) {
      closes.push(frame);
    },
  });

  await handleDataPlaneStreamFrame(
    tracker,
    {
      proto: "0.1",
      type: "stream_data",
      id: "msg_stream_data",
      ts: 1777132800000,
      ext: {},
      stream_id: "st_test",
      stream_type: "localhost_http_proxy",
      offset: 0,
      data: Buffer.from("hello").toString("base64"),
      end_stream: true,
    },
    { logger: makeLogger() as never },
  );

  assert.deepEqual(chunks.map((chunk) => chunk.toString("utf8")), ["hello"]);
  assert.equal(tracker.framesReceived, 1);
  assert.equal(tracker.bytesReceived, 5);
  assert.equal(closes.length, 1);
  assert.deepEqual(
    sentFrames.map((frame) => frame.type),
    ["stream_credit", "stream_close"],
  );
});

test("data-plane stream capacity counts active streams per Bud and stream family", (t) => {
  t.after(() => dataPlaneSessions.clear());
  dataPlaneSessions.clear();
  const tracker = makeTracker({ streams: new Set(["file_read", "localhost_http_proxy"]) });
  registerActiveDataPlaneSessionTracker(tracker);
  registerDataPlaneRuntimeStream(tracker, {
    streamId: "st_file_1",
    streamType: "file_read",
    initialReceiveCreditBytes: 16,
  });
  registerDataPlaneRuntimeStream(tracker, {
    streamId: "st_proxy_1",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 16,
  });

  assert.equal(
    countActiveDataPlaneRuntimeStreamsForBud({
      budId: "b_test",
      streamType: "file_read",
    }),
    1,
  );
  assert.deepEqual(
    checkDataPlaneRuntimeStreamCapacity({
      budId: "b_test",
      streamType: "file_read",
      maxConcurrentStreams: 1,
    }),
    {
      ok: false,
      activeStreams: 1,
      code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
      message: "Bud already has 1 active file_read stream(s)",
    },
  );
  assert.deepEqual(
    checkDataPlaneRuntimeStreamCapacity({
      budId: "b_test",
      streamType: "localhost_http_proxy",
      maxConcurrentStreams: 2,
    }),
    { ok: true, activeStreams: 1 },
  );
});

test("stream_credit is capped to the carrier max in-flight bytes", async () => {
  const tracker = makeTracker({ maxInFlightBytes: 10 });
  const stream = registerDataPlaneRuntimeStream(tracker, {
    streamId: "st_credit",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 16,
  });

  await handleDataPlaneStreamFrame(
    tracker,
    {
      proto: "0.1",
      type: "stream_credit",
      id: "msg_stream_credit",
      ts: 1777132800000,
      ext: {},
      stream_id: "st_credit",
      receive_offset: 0,
      credit_bytes: 100,
    },
    { logger: makeLogger() as never },
  );

  assert.equal(stream.sendCreditBytes, 10);
});
