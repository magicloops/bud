import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  grantGrpcDataReceiveCredit,
  recordGrpcDataInboundChunk,
  recordGrpcDataOutboundCredit,
  registerGrpcDataRuntimeStream,
  sendGrpcDataFrame,
  sendGrpcDataStreamData,
  type GrpcDataSessionTracker,
} from "./grpc-data-router.js";

function makeTracker(write: (frame: unknown) => boolean = () => true): GrpcDataSessionTracker {
  return {
    budId: "b_test",
    deviceSessionId: "s_test",
    controlTransportSessionId: "ts_control",
    transportSessionId: "ts_data",
    transportKind: "h2_data",
    role: "data",
    drainState: "active",
    lastSeenAt: Date.now(),
    streams: new Set(["localhost_http_proxy"]),
    framesReceived: 0,
    bytesReceived: 0,
    runtimeStreams: new Map(),
    maxChunkBytes: 16 * 1024,
    initialCreditBytes: 1024 * 1024,
    maxInFlightBytes: 1024 * 1024,
    sendFrame() {
      // sendGrpcDataFrame exercises the gRPC call directly.
    },
    isActive() {
      return true;
    },
    call: {
      destroyed: false,
      write,
    } as GrpcDataSessionTracker["call"],
  };
}

test("runtime stream credits enforce offsets and available receive window", () => {
  const tracker = makeTracker();
  const stream = registerGrpcDataRuntimeStream(tracker, {
    streamId: "st_test",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 8,
  });

  assert.deepEqual(recordGrpcDataInboundChunk(stream, { offset: 0, byteLength: 5 }), {
    ok: true,
    receiveOffset: 5,
    creditRemaining: 3,
  });
  assert.equal(stream.receiveOffset, 5);
  assert.equal(stream.receiveCreditBytes, 3);
  assert.equal(recordGrpcDataInboundChunk(stream, { offset: 4, byteLength: 1 }).ok, false);
  assert.equal(recordGrpcDataInboundChunk(stream, { offset: 5, byteLength: 4 }).ok, false);

  grantGrpcDataReceiveCredit(stream, 5);
  assert.equal(stream.receiveCreditBytes, 8);
  assert.equal(recordGrpcDataInboundChunk(stream, { offset: 5, byteLength: 4 }).ok, true);
});

test("runtime stream outbound credits accumulate from peer credit frames", () => {
  const tracker = makeTracker();
  const stream = registerGrpcDataRuntimeStream(tracker, {
    streamId: "st_test",
    streamType: "file_read",
    initialReceiveCreditBytes: 1024,
  });

  recordGrpcDataOutboundCredit(stream, { receiveOffset: 512, creditBytes: 4096 });
  recordGrpcDataOutboundCredit(stream, { receiveOffset: 256, creditBytes: 1024 });

  assert.equal(stream.remoteReceiveOffset, 512);
  assert.equal(stream.sendCreditBytes, 5120);
});

test("sendGrpcDataFrame writes typed envelopes to the active data call", async () => {
  const writes: unknown[] = [];
  const tracker = makeTracker((frame) => {
    writes.push(frame);
    return true;
  });

  await sendGrpcDataFrame(tracker, {
    proto: "0.1",
    type: "stream_credit",
    id: "msg_credit",
    ts: 1777132800000,
    ext: {},
    stream_id: "st_test",
    receive_offset: 10,
    credit_bytes: 10,
  });

  assert.equal(writes.length, 1);
  assert.equal((writes[0] as Record<string, unknown>).streamCredit !== undefined, true);
  assert.equal((writes[0] as Record<string, unknown>).transportKind, "TRANSPORT_KIND_H2_DATA");
});

test("sendGrpcDataStreamData enforces send credits before writing", async () => {
  const writes: unknown[] = [];
  const tracker = makeTracker((frame) => {
    writes.push(frame);
    return true;
  });
  registerGrpcDataRuntimeStream(tracker, {
    streamId: "st_test",
    streamType: "localhost_http_proxy",
    initialReceiveCreditBytes: 1024,
    initialSendCreditBytes: 5,
  });

  await sendGrpcDataStreamData(tracker, {
    streamId: "st_test",
    data: Buffer.from("hello"),
    maxChunkBytes: 1024,
  });
  await assert.rejects(
    sendGrpcDataStreamData(tracker, {
      streamId: "st_test",
      data: Buffer.from("!"),
      maxChunkBytes: 1024,
    }),
    /insufficient send credit/,
  );

  const stream = tracker.runtimeStreams.get("st_test");
  assert.equal(stream?.sendOffset, 5);
  assert.equal(stream?.sendCreditBytes, 0);
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as Record<string, unknown>).streamData !== undefined, true);
});
