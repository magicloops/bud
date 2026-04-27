import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  dataAttachMatchesControlSession,
  finalizeGrpcDataSessionsForControlTracker,
  parseDataAttachFrame,
  parseStreamDataFrame,
  type DataAttachFrame,
} from "./data-gateway.js";
import type { GrpcSessionTracker } from "../transport/grpc-daemon-router.js";
import {
  grpcDataSessionKey,
  grpcDataSessions,
  type GrpcDataRuntimeStream,
  type GrpcDataSessionTracker,
} from "../transport/grpc-data-router.js";

function makeTracker(overrides: Partial<GrpcSessionTracker> = {}): GrpcSessionTracker {
  return {
    budId: "b_test",
    sessionId: "s_test",
    deviceSessionId: "s_test",
    transportSessionId: "ts_control",
    drainState: "active",
    lastHeartbeat: Date.now(),
    call: {
      destroyed: false,
    } as GrpcSessionTracker["call"],
    ...overrides,
  };
}

function makeDataTracker(
  overrides: Partial<GrpcDataSessionTracker> = {},
  onEnd: () => void = () => undefined,
): GrpcDataSessionTracker {
  return {
    budId: "b_test",
    deviceSessionId: "s_test",
    controlTransportSessionId: "ts_control",
    transportSessionId: "ts_data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(["terminal_output"]),
    framesReceived: 1,
    bytesReceived: 128,
    runtimeStreams: new Map(),
    call: {
      destroyed: false,
      end: onEnd,
    } as GrpcDataSessionTracker["call"],
    ...overrides,
  };
}

function makeLogger() {
  return {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  };
}

test("parseDataAttachFrame accepts the negotiated terminal-output attach shape", () => {
  const frame = parseDataAttachFrame({
    proto: "0.1",
    type: "data_attach",
    id: "msg_data_attach",
    ts: 1777132800000,
    ext: {},
    bud_id: "b_test",
    device_session_id: "s_test",
    control_transport_session_id: "ts_control",
    streams: ["terminal_output"],
    max_chunk_bytes: 16384,
    initial_credit_bytes: 1048576,
  });

  assert.equal(frame?.bud_id, "b_test");
  assert.deepEqual(frame?.streams, ["terminal_output"]);
});

test("parseDataAttachFrame rejects non-attach frames", () => {
  assert.equal(
    parseDataAttachFrame({
      proto: "0.1",
      type: "heartbeat",
      id: "msg_heartbeat",
      ts: 1777132800000,
      ext: {},
    }),
    null,
  );
});

test("parseStreamDataFrame accepts generic stream data frames", () => {
  const frame = parseStreamDataFrame({
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
  });

  assert.equal(frame?.stream_id, "st_test");
  assert.equal(frame?.stream_type, "localhost_http_proxy");
  assert.equal(frame?.end_stream, true);
});

test("dataAttachMatchesControlSession binds data streams to active control session ids", () => {
  const attach: DataAttachFrame = {
    proto: "0.1",
    type: "data_attach",
    id: "msg_data_attach",
    ts: 1777132800000,
    ext: {},
    bud_id: "b_test",
    device_session_id: "s_test",
    control_transport_session_id: "ts_control",
    streams: ["terminal_output"],
  };

  assert.equal(dataAttachMatchesControlSession(attach, makeTracker()), true);
  assert.equal(
    dataAttachMatchesControlSession(
      { ...attach, control_transport_session_id: "ts_other" },
      makeTracker(),
    ),
    false,
  );
  assert.equal(dataAttachMatchesControlSession(attach, makeTracker({ finalized: true })), false);
});

test("finalizeGrpcDataSessionsForControlTracker closes matching subordinate data sessions", async (t) => {
  t.after(() => {
    grpcDataSessions.clear();
  });
  grpcDataSessions.clear();

  const ended: string[] = [];
  const closedTransports: unknown[] = [];
  const matching = makeDataTracker({}, () => ended.push("matching"));
  const other = makeDataTracker(
    {
      budId: "b_test",
      deviceSessionId: "s_other",
      transportSessionId: "ts_other_data",
    },
    () => ended.push("other"),
  );
  grpcDataSessions.set(grpcDataSessionKey(matching.budId, matching.deviceSessionId), matching);
  grpcDataSessions.set(grpcDataSessionKey(other.budId, other.deviceSessionId), other);

  const finalized = await finalizeGrpcDataSessionsForControlTracker({
    tracker: makeTracker({ deviceSessionId: "s_test" }),
    reason: "heartbeat_timeout",
    markDraining: true,
    logger: makeLogger() as never,
    daemonStateStore: {
      async closeTransportSession(args: unknown) {
        closedTransports.push(args);
      },
    } as never,
  });

  assert.equal(finalized, 1);
  assert.deepEqual(ended, ["matching"]);
  assert.equal(grpcDataSessions.has(grpcDataSessionKey("b_test", "s_test")), false);
  assert.equal(grpcDataSessions.has(grpcDataSessionKey("b_test", "s_other")), true);
  assert.equal(matching.finalized, true);
  assert.equal(matching.drainState, "draining");
  assert.deepEqual(closedTransports, [
    {
      transportSessionId: "ts_data",
      reason: "heartbeat_timeout",
      markUnknown: false,
      markDraining: true,
    },
  ]);
});

test("finalizing a data session resets active runtime streams", async (t) => {
  t.after(() => {
    grpcDataSessions.clear();
  });
  grpcDataSessions.clear();

  const resetCallbacks: unknown[] = [];
  const streamTransitions: unknown[] = [];
  const runtimeStreams = new Map<string, GrpcDataRuntimeStream>();
  runtimeStreams.set("st_proxy", {
    streamId: "st_proxy",
    streamType: "localhost_http_proxy",
    receiveOffset: 0,
    receiveCreditBytes: 1024,
    sendOffset: 0,
    sendCreditBytes: 0,
    remoteReceiveOffset: 0,
    onReset(frame) {
      resetCallbacks.push(frame);
    },
  });
  const tracker = makeDataTracker({ runtimeStreams });
  grpcDataSessions.set(grpcDataSessionKey(tracker.budId, tracker.deviceSessionId), tracker);

  await finalizeGrpcDataSessionsForControlTracker({
    tracker: makeTracker(),
    reason: "control_closed",
    logger: makeLogger() as never,
    daemonStateStore: {
      async closeTransportSession() {
        // noop
      },
      async transitionStream(args: unknown) {
        streamTransitions.push(args);
      },
    } as never,
  });

  assert.equal(resetCallbacks.length, 1);
  assert.deepEqual(resetCallbacks[0], {
    streamId: "st_proxy",
    reason: "transport_lost",
    error: {
      code: "GRPC_DATA_STREAM_CLOSED",
      message: "gRPC data stream closed before runtime stream completed: control_closed",
      retryable: true,
    },
  });
  assert.equal(streamTransitions.length, 1);
  assert.equal(tracker.runtimeStreams.size, 0);
});
