import { Buffer } from "node:buffer";
import { once } from "node:events";
import type * as grpc from "@grpc/grpc-js";
import { ulid } from "ulid";
import { encodeGrpcLegacyJsonEnvelope } from "../grpc/envelope-codec.js";
import type { GrpcBudEnvelope } from "./grpc-daemon-router.js";

export type GrpcDataCall = grpc.ServerDuplexStream<GrpcBudEnvelope, GrpcBudEnvelope>;

export interface GrpcDataRuntimeStream {
  streamId: string;
  streamType: string;
  receiveOffset: number;
  receiveCreditBytes: number;
  sendOffset: number;
  sendCreditBytes: number;
  remoteReceiveOffset: number;
  localClosed?: boolean;
  remoteClosed?: boolean;
  resetReason?: string;
  onData?: (
    chunk: Buffer,
    frame: {
      streamId: string;
      streamType: string;
      offset: number;
      endStream: boolean;
    },
  ) => Promise<void> | void;
  onReset?: (frame: {
    streamId: string;
    reason: string;
    error?: {
      code: string;
      message: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
    };
  }) => Promise<void> | void;
  onClose?: (frame: { streamId: string; finalOffset: number }) => Promise<void> | void;
}

export interface GrpcDataSessionTracker {
  budId: string;
  deviceSessionId: string;
  controlTransportSessionId?: string;
  transportSessionId?: string;
  drainState?: "active" | "draining";
  finalizing?: boolean;
  finalized?: boolean;
  lastSeenAt: number;
  lastSeenWrite?: number;
  streams: Set<string>;
  framesReceived: number;
  bytesReceived: number;
  runtimeStreams: Map<string, GrpcDataRuntimeStream>;
  call: GrpcDataCall;
}

export const grpcDataSessions = new Map<string, GrpcDataSessionTracker>();

export function grpcDataSessionKey(budId: string, deviceSessionId: string): string {
  return `${budId}:${deviceSessionId}`;
}

export function registerActiveGrpcDataSessionTracker(
  tracker: GrpcDataSessionTracker,
): GrpcDataSessionTracker | null {
  const key = grpcDataSessionKey(tracker.budId, tracker.deviceSessionId);
  const previous = grpcDataSessions.get(key) ?? null;
  grpcDataSessions.set(key, tracker);
  return previous;
}

export function getActiveGrpcDataSessionTracker(
  budId: string,
  deviceSessionId: string,
): GrpcDataSessionTracker | null {
  const tracker = grpcDataSessions.get(grpcDataSessionKey(budId, deviceSessionId));
  if (!tracker || tracker.finalized || tracker.call.destroyed) {
    return null;
  }
  return tracker;
}

export function deleteGrpcDataSessionTrackerIfCurrent(
  tracker: GrpcDataSessionTracker | null | undefined,
): boolean {
  if (!tracker) {
    return false;
  }
  const key = grpcDataSessionKey(tracker.budId, tracker.deviceSessionId);
  if (grpcDataSessions.get(key) !== tracker) {
    return false;
  }
  grpcDataSessions.delete(key);
  return true;
}

export function isGrpcDataAttached(budId: string, deviceSessionId: string): boolean {
  return getActiveGrpcDataSessionTracker(budId, deviceSessionId) !== null;
}

export function registerGrpcDataRuntimeStream(
  tracker: GrpcDataSessionTracker,
  args: {
    streamId: string;
    streamType: string;
    initialReceiveCreditBytes: number;
    initialSendCreditBytes?: number;
    onData?: GrpcDataRuntimeStream["onData"];
    onReset?: GrpcDataRuntimeStream["onReset"];
    onClose?: GrpcDataRuntimeStream["onClose"];
  },
): GrpcDataRuntimeStream {
  const existing = tracker.runtimeStreams.get(args.streamId);
  if (existing) {
    return existing;
  }
  const stream: GrpcDataRuntimeStream = {
    streamId: args.streamId,
    streamType: args.streamType,
    receiveOffset: 0,
    receiveCreditBytes: args.initialReceiveCreditBytes,
    sendOffset: 0,
    sendCreditBytes: args.initialSendCreditBytes ?? 0,
    remoteReceiveOffset: 0,
    onData: args.onData,
    onReset: args.onReset,
    onClose: args.onClose,
  };
  tracker.runtimeStreams.set(args.streamId, stream);
  return stream;
}

export function getGrpcDataRuntimeStream(
  tracker: GrpcDataSessionTracker,
  streamId: string,
): GrpcDataRuntimeStream | null {
  return tracker.runtimeStreams.get(streamId) ?? null;
}

export function recordGrpcDataInboundChunk(
  stream: GrpcDataRuntimeStream,
  args: { offset: number; byteLength: number },
): { ok: true; receiveOffset: number; creditRemaining: number } | { ok: false; code: string; message: string } {
  if (stream.resetReason) {
    return { ok: false, code: "STREAM_RESET", message: "stream has already been reset" };
  }
  if (stream.remoteClosed) {
    return { ok: false, code: "STREAM_CLOSED", message: "stream is already closed by the remote peer" };
  }
  if (args.offset !== stream.receiveOffset) {
    return {
      ok: false,
      code: "OFFSET_MISMATCH",
      message: `expected stream offset ${stream.receiveOffset}, got ${args.offset}`,
    };
  }
  if (args.byteLength > stream.receiveCreditBytes) {
    return {
      ok: false,
      code: "CREDIT_EXHAUSTED",
      message: `stream frame exceeds available credit by ${args.byteLength - stream.receiveCreditBytes} bytes`,
    };
  }
  stream.receiveOffset += args.byteLength;
  stream.receiveCreditBytes -= args.byteLength;
  return { ok: true, receiveOffset: stream.receiveOffset, creditRemaining: stream.receiveCreditBytes };
}

export function grantGrpcDataReceiveCredit(
  stream: GrpcDataRuntimeStream,
  creditBytes: number,
): number {
  stream.receiveCreditBytes += creditBytes;
  return stream.receiveCreditBytes;
}

export function recordGrpcDataOutboundCredit(
  stream: GrpcDataRuntimeStream,
  args: { receiveOffset: number; creditBytes: number },
): void {
  stream.remoteReceiveOffset = Math.max(stream.remoteReceiveOffset, args.receiveOffset);
  stream.sendCreditBytes += args.creditBytes;
}

export async function sendGrpcDataFrame(
  tracker: GrpcDataSessionTracker,
  frame: Record<string, unknown>,
): Promise<void> {
  if (tracker.finalized || tracker.call.destroyed) {
    throw new Error("gRPC data stream is not active");
  }
  const envelope = encodeGrpcLegacyJsonEnvelope(frame, { transportKind: "h2_data" });
  if (tracker.call.write(envelope)) {
    return;
  }
  await once(tracker.call, "drain");
}

export async function sendGrpcDataStreamData(
  tracker: GrpcDataSessionTracker,
  args: {
    streamId: string;
    data: Buffer;
    endStream?: boolean;
    maxChunkBytes: number;
  },
): Promise<void> {
  const stream = getGrpcDataRuntimeStream(tracker, args.streamId);
  if (!stream) {
    throw new Error(`unknown gRPC data runtime stream: ${args.streamId}`);
  }
  if (stream.localClosed || stream.resetReason) {
    throw new Error(`gRPC data runtime stream is not writable: ${args.streamId}`);
  }
  if (args.data.byteLength > args.maxChunkBytes) {
    throw new Error(`gRPC data runtime stream chunk exceeds ${args.maxChunkBytes} bytes`);
  }
  if (args.data.byteLength > stream.sendCreditBytes) {
    throw new Error(`gRPC data runtime stream has insufficient send credit: ${args.streamId}`);
  }

  const offset = stream.sendOffset;
  stream.sendOffset += args.data.byteLength;
  stream.sendCreditBytes -= args.data.byteLength;
  if (args.endStream) {
    stream.localClosed = true;
  }

  await sendGrpcDataFrame(tracker, {
    proto: "0.1",
    type: "stream_data",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    stream_id: stream.streamId,
    stream_type: stream.streamType,
    offset,
    data: args.data.toString("base64"),
    end_stream: args.endStream ?? false,
  });
}

export async function sendGrpcDataFrameToBud(
  budId: string,
  deviceSessionId: string,
  frame: Record<string, unknown>,
): Promise<boolean> {
  const tracker = getActiveGrpcDataSessionTracker(budId, deviceSessionId);
  if (!tracker) {
    return false;
  }
  await sendGrpcDataFrame(tracker, frame);
  return true;
}
