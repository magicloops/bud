import { Buffer } from "node:buffer";
import { once } from "node:events";
import type * as grpc from "@grpc/grpc-js";
import { ulid } from "ulid";
import { encodeGrpcLegacyJsonEnvelope } from "../grpc/envelope-codec.js";
import type { GrpcBudEnvelope } from "./grpc-daemon-router.js";
import {
  deleteDataPlaneSessionTrackerIfCurrent,
  getDataPlaneRuntimeStream,
  grantDataPlaneReceiveCredit,
  recordDataPlaneInboundChunk,
  recordDataPlaneOutboundCredit,
  registerActiveDataPlaneSessionTracker,
  registerDataPlaneRuntimeStream,
  type DataPlaneRuntimeStream,
  type DataPlaneSessionTracker,
} from "./data-plane-router.js";

export type GrpcDataCall = grpc.ServerDuplexStream<GrpcBudEnvelope, GrpcBudEnvelope>;

export type GrpcDataRuntimeStream = DataPlaneRuntimeStream;

export interface GrpcDataSessionTracker extends DataPlaneSessionTracker {
  transportKind: "h2_data";
  role: "data";
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
  registerActiveDataPlaneSessionTracker(tracker);
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
  deleteDataPlaneSessionTrackerIfCurrent(tracker);
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
  return registerDataPlaneRuntimeStream(tracker, args);
}

export function getGrpcDataRuntimeStream(
  tracker: GrpcDataSessionTracker,
  streamId: string,
): GrpcDataRuntimeStream | null {
  return getDataPlaneRuntimeStream(tracker, streamId);
}

export function recordGrpcDataInboundChunk(
  stream: GrpcDataRuntimeStream,
  args: { offset: number; byteLength: number },
): { ok: true; receiveOffset: number; creditRemaining: number } | { ok: false; code: string; message: string } {
  return recordDataPlaneInboundChunk(stream, args);
}

export function grantGrpcDataReceiveCredit(
  stream: GrpcDataRuntimeStream,
  creditBytes: number,
): number {
  return grantDataPlaneReceiveCredit(stream, creditBytes);
}

export function recordGrpcDataOutboundCredit(
  stream: GrpcDataRuntimeStream,
  args: { receiveOffset: number; creditBytes: number },
): void {
  recordDataPlaneOutboundCredit(stream, args);
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
