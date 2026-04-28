import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { z } from "zod";
import { PROTO_VERSION, type DaemonTransportPolicy } from "../config.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import { EnvelopeSchema } from "../ws/protocol.js";
import {
  carrierHealthAllowsNewWork,
  describeCarrierHealth,
  normalizeCarrierHealth,
  type CarrierHealth,
  type CarrierSelectionCandidate,
} from "./carrier-health.js";
import { rankDataPlaneTransport } from "./carrier-policy.js";
import type { DaemonTransportPayload } from "./daemon-router.js";
import { grpcDaemonTransportRouter } from "./grpc-daemon-router.js";
import { websocketDaemonTransportRouter } from "./websocket-daemon-router.js";

export const DATA_PLANE_UNAVAILABLE = "DATA_PLANE_UNAVAILABLE";
export const STREAM_FAMILY_UNSUPPORTED = "STREAM_FAMILY_UNSUPPORTED";
export const TRANSPORT_DEGRADED = "TRANSPORT_DEGRADED";

export type DataPlaneUnavailableCode =
  | typeof DATA_PLANE_UNAVAILABLE
  | typeof STREAM_FAMILY_UNSUPPORTED
  | typeof TRANSPORT_DEGRADED;

export type DataPlaneTransportKind = "websocket" | "h2_data" | "quic";
export type DataPlaneRole = "data" | "control_data";

export interface DataPlaneRuntimeStream {
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

export interface DataPlaneSessionTracker {
  budId: string;
  deviceSessionId: string;
  controlTransportSessionId?: string;
  transportSessionId?: string;
  transportKind: DataPlaneTransportKind;
  role: DataPlaneRole;
  drainState?: "active" | "draining";
  finalizing?: boolean;
  finalized?: boolean;
  health?: Partial<CarrierHealth>;
  lastSeenAt: number;
  lastSeenWrite?: number;
  streams: Set<string>;
  framesReceived: number;
  bytesReceived: number;
  runtimeStreams: Map<string, DataPlaneRuntimeStream>;
  maxChunkBytes: number;
  initialCreditBytes: number;
  maxInFlightBytes: number;
  sendFrame: (frame: Record<string, unknown>) => Promise<void> | void;
  isActive: () => boolean;
  close?: () => Promise<void> | void;
}

export type DataPlaneCarrierSelection =
  | {
      available: true;
      code: null;
      message: null;
      tracker: DataPlaneSessionTracker;
      transportKind: DataPlaneTransportKind;
      role: DataPlaneRole;
      deviceSessionId: string;
      controlTransportSessionId: string | null;
      dataTransportSessionId: string | null;
      streamFamilies: string[];
      maxChunkBytes: number;
      maxInFlightBytes: number;
      initialCreditBytes: number;
      health: CarrierHealth;
      selectionReason: string;
      candidateTransports: CarrierSelectionCandidate[];
    }
  | {
      available: false;
      code: DataPlaneUnavailableCode;
      message: string;
      tracker: DataPlaneSessionTracker | null;
      transportKind: DataPlaneTransportKind | null;
      role: DataPlaneRole | null;
      deviceSessionId: string | null;
      controlTransportSessionId: string | null;
      dataTransportSessionId: string | null;
      streamFamilies: string[];
      maxChunkBytes: number | null;
      maxInFlightBytes: number | null;
      initialCreditBytes: number | null;
      health: CarrierHealth | null;
      selectionReason: string;
      candidateTransports: CarrierSelectionCandidate[];
    };

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "must be a safe integer");

const StreamDataSchema = EnvelopeSchema.extend({
  type: z.literal("stream_data"),
  stream_id: z.string(),
  stream_type: z.string(),
  offset: SafeNonnegativeIntegerSchema,
  data: z.string(),
  end_stream: z.boolean().optional().default(false),
});

const StreamCreditSchema = EnvelopeSchema.extend({
  type: z.literal("stream_credit"),
  stream_id: z.string(),
  receive_offset: SafeNonnegativeIntegerSchema,
  credit_bytes: SafeNonnegativeIntegerSchema,
});

const StreamResetSchema = EnvelopeSchema.extend({
  type: z.literal("stream_reset"),
  stream_id: z.string(),
  reason: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const StreamCloseSchema = EnvelopeSchema.extend({
  type: z.literal("stream_close"),
  stream_id: z.string(),
  final_offset: SafeNonnegativeIntegerSchema,
});

export type StreamDataFrame = z.infer<typeof StreamDataSchema>;
export type StreamCreditFrame = z.infer<typeof StreamCreditSchema>;
export type StreamResetFrame = z.infer<typeof StreamResetSchema>;
export type StreamCloseFrame = z.infer<typeof StreamCloseSchema>;

export const dataPlaneSessions = new Map<string, DataPlaneSessionTracker>();

export function dataPlaneSessionKey(
  budId: string,
  deviceSessionId: string,
  transportKind: DataPlaneTransportKind,
): string {
  return `${budId}:${deviceSessionId}:${transportKind}`;
}

export function registerActiveDataPlaneSessionTracker(
  tracker: DataPlaneSessionTracker,
): DataPlaneSessionTracker | null {
  const key = dataPlaneSessionKey(tracker.budId, tracker.deviceSessionId, tracker.transportKind);
  const previous = dataPlaneSessions.get(key) ?? null;
  dataPlaneSessions.set(key, tracker);
  return previous;
}

export function getActiveDataPlaneSessionTracker(args: {
  budId: string;
  deviceSessionId: string;
  transportKind: DataPlaneTransportKind;
}): DataPlaneSessionTracker | null {
  const tracker = dataPlaneSessions.get(dataPlaneSessionKey(args.budId, args.deviceSessionId, args.transportKind));
  if (!tracker || !isDataPlaneSessionConnected(tracker)) {
    return null;
  }
  return tracker;
}

export function deleteDataPlaneSessionTrackerIfCurrent(
  tracker: DataPlaneSessionTracker | null | undefined,
): boolean {
  if (!tracker) {
    return false;
  }
  const key = dataPlaneSessionKey(tracker.budId, tracker.deviceSessionId, tracker.transportKind);
  if (dataPlaneSessions.get(key) !== tracker) {
    return false;
  }
  dataPlaneSessions.delete(key);
  return true;
}

export function getActiveDataPlaneSessionForBud(args: {
  budId: string;
  deviceSessionId?: string | null;
  streamType?: string;
  transportKind?: DataPlaneTransportKind;
  includeDraining?: boolean;
  policy?: DaemonTransportPolicy;
}): DataPlaneSessionTracker | null {
  const candidates = rankedDataPlaneSessions(args.budId, args.deviceSessionId ?? undefined, args.policy).filter((tracker) => {
    if (args.transportKind && tracker.transportKind !== args.transportKind) {
      return false;
    }
    if (!args.includeDraining && tracker.drainState === "draining") {
      return false;
    }
    if (!args.includeDraining && !carrierHealthAllowsNewWork(normalizeCarrierHealth(tracker.health))) {
      return false;
    }
    if (args.streamType && !tracker.streams.has(args.streamType)) {
      return false;
    }
    return isDataPlaneSessionConnected(tracker);
  });
  return candidates[0] ?? null;
}

export function selectDataPlaneCarrier(args: {
  budId: string;
  deviceSessionId?: string | null;
  streamType: string;
  preferredTransportKind?: DataPlaneTransportKind;
  policy?: DaemonTransportPolicy;
}): DataPlaneCarrierSelection {
  const connected = rankedDataPlaneSessions(args.budId, args.deviceSessionId ?? undefined, args.policy).filter(
    isDataPlaneSessionConnected,
  );
  const filtered = args.preferredTransportKind
    ? connected.filter((tracker) => tracker.transportKind === args.preferredTransportKind)
    : connected;
  const candidates = filtered.map((tracker) => dataPlaneSelectionCandidate(tracker, args.streamType));

  if (filtered.length === 0) {
    return unavailableSelection({
      code: DATA_PLANE_UNAVAILABLE,
      message: "Bud does not have an active data-plane carrier",
      tracker: connected[0] ?? null,
      candidates,
      selectionReason: args.preferredTransportKind
        ? `No active ${args.preferredTransportKind} data-plane carrier is connected`
        : "No active data-plane carrier is connected",
    });
  }

  const familyMatches = filtered.filter((tracker) => tracker.streams.has(args.streamType));
  if (familyMatches.length === 0) {
    return unavailableSelection({
      code: STREAM_FAMILY_UNSUPPORTED,
      message: `Bud data-plane carrier has not negotiated ${args.streamType} support`,
      tracker: filtered[0],
      candidates,
      selectionReason: `No active data-plane carrier negotiated ${args.streamType}`,
    });
  }

  const healthyFamilyMatches = familyMatches.filter((tracker) => dataPlaneTrackerAcceptsNewWork(tracker));
  const familyMatch =
    healthyFamilyMatches[0] ?? familyMatches.find((tracker) => tracker.drainState !== "draining") ?? familyMatches[0];
  if (familyMatch.drainState === "draining") {
    return unavailableSelection({
      code: TRANSPORT_DEGRADED,
      message: "Bud data-plane carrier is draining and cannot accept new streams",
      tracker: familyMatch,
      candidates,
      selectionReason: `${familyMatch.transportKind} is draining and no healthier ${args.streamType} carrier is available`,
    });
  }
  const familyMatchHealth = normalizeCarrierHealth(familyMatch.health);
  if (!carrierHealthAllowsNewWork(familyMatchHealth)) {
    return unavailableSelection({
      code: TRANSPORT_DEGRADED,
      message: `Bud data-plane carrier is unhealthy: ${describeCarrierHealth(familyMatchHealth)}`,
      tracker: familyMatch,
      candidates,
      selectionReason: `${familyMatch.transportKind} is ${describeCarrierHealth(familyMatchHealth)} and no healthier ${args.streamType} carrier is available`,
    });
  }

  return {
    available: true,
    code: null,
    message: null,
    tracker: familyMatch,
    transportKind: familyMatch.transportKind,
    role: familyMatch.role,
    deviceSessionId: familyMatch.deviceSessionId,
    controlTransportSessionId: familyMatch.controlTransportSessionId ?? null,
    dataTransportSessionId: familyMatch.transportSessionId ?? null,
    streamFamilies: Array.from(familyMatch.streams),
    maxChunkBytes: familyMatch.maxChunkBytes,
    maxInFlightBytes: familyMatch.maxInFlightBytes,
    initialCreditBytes: familyMatch.initialCreditBytes,
    health: familyMatchHealth,
    selectionReason: selectionReasonForDataPlaneCarrier({
      selected: familyMatch,
      candidates,
      policy: args.policy,
    }),
    candidateTransports: candidates,
  };
}

export function registerDataPlaneRuntimeStream(
  tracker: DataPlaneSessionTracker,
  args: {
    streamId: string;
    streamType: string;
    initialReceiveCreditBytes: number;
    initialSendCreditBytes?: number;
    onData?: DataPlaneRuntimeStream["onData"];
    onReset?: DataPlaneRuntimeStream["onReset"];
    onClose?: DataPlaneRuntimeStream["onClose"];
  },
): DataPlaneRuntimeStream {
  const existing = tracker.runtimeStreams.get(args.streamId);
  if (existing) {
    return existing;
  }
  const stream: DataPlaneRuntimeStream = {
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

export function countActiveDataPlaneRuntimeStreamsForBud(args: {
  budId: string;
  streamType?: string;
}): number {
  let count = 0;
  for (const tracker of dataPlaneSessions.values()) {
    if (tracker.budId !== args.budId || !isDataPlaneSessionConnected(tracker)) {
      continue;
    }
    for (const stream of tracker.runtimeStreams.values()) {
      if (args.streamType && stream.streamType !== args.streamType) {
        continue;
      }
      if (stream.resetReason || (stream.localClosed && stream.remoteClosed)) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

export function checkDataPlaneRuntimeStreamCapacity(args: {
  budId: string;
  streamType: string;
  maxConcurrentStreams: number;
}): { ok: true; activeStreams: number } | { ok: false; activeStreams: number; code: string; message: string } {
  const activeStreams = countActiveDataPlaneRuntimeStreamsForBud({
    budId: args.budId,
    streamType: args.streamType,
  });
  if (activeStreams < args.maxConcurrentStreams) {
    return { ok: true, activeStreams };
  }
  return {
    ok: false,
    activeStreams,
    code: "DATA_PLANE_STREAM_LIMIT_EXCEEDED",
    message: `Bud already has ${activeStreams} active ${args.streamType} stream(s)`,
  };
}

export function getDataPlaneRuntimeStream(
  tracker: DataPlaneSessionTracker,
  streamId: string,
): DataPlaneRuntimeStream | null {
  return tracker.runtimeStreams.get(streamId) ?? null;
}

export function recordDataPlaneInboundChunk(
  stream: DataPlaneRuntimeStream,
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

export function grantDataPlaneReceiveCredit(
  stream: DataPlaneRuntimeStream,
  creditBytes: number,
): number {
  stream.receiveCreditBytes += creditBytes;
  return stream.receiveCreditBytes;
}

export function recordDataPlaneOutboundCredit(
  stream: DataPlaneRuntimeStream,
  args: { receiveOffset: number; creditBytes: number },
): void {
  stream.remoteReceiveOffset = Math.max(stream.remoteReceiveOffset, args.receiveOffset);
  stream.sendCreditBytes += args.creditBytes;
}

export async function sendDataPlaneFrame(
  tracker: DataPlaneSessionTracker,
  frame: Record<string, unknown>,
): Promise<void> {
  if (!isDataPlaneSessionConnected(tracker)) {
    throw new Error("data-plane carrier is not active");
  }
  await tracker.sendFrame(frame);
}

export async function sendDataPlaneStreamData(
  tracker: DataPlaneSessionTracker,
  args: {
    streamId: string;
    data: Buffer;
    endStream?: boolean;
    maxChunkBytes: number;
  },
): Promise<void> {
  const stream = getDataPlaneRuntimeStream(tracker, args.streamId);
  if (!stream) {
    throw new Error(`unknown data-plane runtime stream: ${args.streamId}`);
  }
  if (stream.localClosed || stream.resetReason) {
    throw new Error(`data-plane runtime stream is not writable: ${args.streamId}`);
  }
  if (args.data.byteLength > args.maxChunkBytes) {
    throw new Error(`data-plane runtime stream chunk exceeds ${args.maxChunkBytes} bytes`);
  }
  if (args.data.byteLength > stream.sendCreditBytes) {
    throw new Error(`data-plane runtime stream has insufficient send credit: ${args.streamId}`);
  }

  const offset = stream.sendOffset;
  stream.sendOffset += args.data.byteLength;
  stream.sendCreditBytes -= args.data.byteLength;
  if (args.endStream) {
    stream.localClosed = true;
  }

  await sendDataPlaneFrame(tracker, {
    proto: PROTO_VERSION,
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

export async function sendDataPlaneFrameToBud(args: {
  budId: string;
  deviceSessionId?: string | null;
  streamType?: string;
  frame: Record<string, unknown>;
}): Promise<boolean> {
  const tracker = getActiveDataPlaneSessionForBud({
    budId: args.budId,
    deviceSessionId: args.deviceSessionId,
    streamType: args.streamType,
  });
  if (!tracker) {
    return false;
  }
  await sendDataPlaneFrame(tracker, args.frame);
  return true;
}

export function sendDataPlaneControlFrame(
  tracker: DataPlaneSessionTracker,
  payload: DaemonTransportPayload,
): boolean {
  switch (tracker.transportKind) {
    case "websocket":
      return websocketDaemonTransportRouter.sendFrameToBud(tracker.budId, payload);
    case "h2_data":
      return grpcDaemonTransportRouter.sendFrameToBud(tracker.budId, payload);
    case "quic":
      return false;
  }
}

export function parseStreamDataFrame(raw: unknown): StreamDataFrame | null {
  const result = StreamDataSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export async function handleDataPlaneStreamFrame(
  tracker: DataPlaneSessionTracker,
  raw: unknown,
  args: {
    logger: FastifyBaseLogger;
    daemonStateStore?: DaemonStateStore;
    component?: string;
  },
): Promise<void> {
  const frameType = isRecord(raw) && typeof raw.type === "string" ? raw.type : undefined;
  switch (frameType) {
    case "stream_data":
      await handleStreamData(tracker, raw, args);
      break;
    case "stream_credit":
      await handleStreamCredit(tracker, raw, args);
      break;
    case "stream_reset":
      await handleStreamReset(tracker, raw, args);
      break;
    case "stream_close":
      await handleStreamClose(tracker, raw, args);
      break;
    default:
      args.logger.warn(
        { type: frameType, component: args.component ?? "data_plane_runtime" },
        "Unhandled data-plane stream frame type",
      );
      break;
  }
}

export async function finalizeDataPlaneSessionTracker(args: {
  tracker: DataPlaneSessionTracker;
  reason: string;
  markDraining?: boolean;
  logger: FastifyBaseLogger;
  daemonStateStore?: DaemonStateStore;
  deleteSession?: boolean;
}): Promise<void> {
  const { tracker, reason } = args;
  if (tracker.finalized || tracker.finalizing) {
    return;
  }
  tracker.finalizing = true;
  try {
    tracker.drainState = args.markDraining ? "draining" : tracker.drainState;
    if (args.deleteSession !== false) {
      deleteDataPlaneSessionTrackerIfCurrent(tracker);
    }
    const daemonStateStore = args.daemonStateStore ?? new DaemonStateStore();
    await resetRuntimeStreamsForDataPlaneTracker({
      tracker,
      reason,
      logger: args.logger,
      daemonStateStore,
    });
    await tracker.close?.();
    if (tracker.role === "data" && tracker.transportSessionId) {
      await daemonStateStore.closeTransportSession({
        transportSessionId: tracker.transportSessionId,
        reason,
        markUnknown: false,
        markDraining: args.markDraining,
      });
    }
    tracker.finalized = true;
  } finally {
    tracker.finalizing = false;
  }
}

export async function finalizeDataPlaneSessionsForControlTracker(args: {
  tracker: {
    budId: string;
    sessionId?: string;
    deviceSessionId?: string;
    transportSessionId?: string;
  };
  reason: string;
  markDraining?: boolean;
  logger: FastifyBaseLogger;
  daemonStateStore?: DaemonStateStore;
}): Promise<number> {
  const deviceSessionIds = new Set(
    [args.tracker.deviceSessionId, args.tracker.sessionId].filter((value): value is string => typeof value === "string"),
  );
  const sessions = Array.from(dataPlaneSessions.values()).filter((session) => {
    if (session.budId !== args.tracker.budId) {
      return false;
    }
    if (deviceSessionIds.size > 0 && !deviceSessionIds.has(session.deviceSessionId)) {
      return false;
    }
    if (!args.tracker.transportSessionId) {
      return true;
    }
    return (
      session.controlTransportSessionId === args.tracker.transportSessionId ||
      session.transportSessionId === args.tracker.transportSessionId
    );
  });
  if (sessions.length === 0) {
    return 0;
  }

  const daemonStateStore = args.daemonStateStore ?? new DaemonStateStore();
  const finalizations = await Promise.allSettled(
    sessions.map((session) =>
      finalizeDataPlaneSessionTracker({
        tracker: session,
        reason: args.reason,
        markDraining: args.markDraining,
        logger: args.logger,
        daemonStateStore,
      }),
    ),
  );

  for (const result of finalizations) {
    if (result.status === "rejected") {
      args.logger.error(
        { err: result.reason, budId: args.tracker.budId, component: "data_plane_runtime" },
        "Failed to finalize subordinate data-plane session",
      );
    }
  }

  return sessions.length;
}

export async function resetRuntimeStreamsForDataPlaneTracker(args: {
  tracker: DataPlaneSessionTracker;
  reason: string;
  logger: FastifyBaseLogger;
  daemonStateStore: DaemonStateStore;
}): Promise<void> {
  const error = {
    code: "DATA_PLANE_STREAM_CLOSED",
    message: `data-plane carrier closed before runtime stream completed: ${args.reason}`,
    retryable: true,
  };
  for (const stream of Array.from(args.tracker.runtimeStreams.values())) {
    if (stream.remoteClosed || stream.resetReason) {
      continue;
    }
    stream.resetReason = "transport_lost";
    try {
      await stream.onReset?.({
        streamId: stream.streamId,
        reason: "transport_lost",
        error,
      });
    } catch (err) {
      args.logger.warn(
        { err, streamId: stream.streamId, component: "data_plane_runtime" },
        "Runtime stream reset callback failed during data-plane finalization",
      );
    }
    await args.daemonStateStore
      .transitionStream({
        streamId: stream.streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "transport_lost",
        error,
      })
      .catch(() => null);
    await args.daemonStateStore
      .appendAuditEvent({
        eventType: "data_plane.stream_reset",
        budId: args.tracker.budId,
        streamId: stream.streamId,
        eventData: {
          reason: "transport_lost",
          error,
          stream_type: stream.streamType,
          device_session_id: args.tracker.deviceSessionId,
          control_transport_session_id: args.tracker.controlTransportSessionId ?? null,
          data_transport_session_id: args.tracker.transportSessionId ?? null,
          transport_kind: args.tracker.transportKind,
        },
      })
      .catch(() => null);
  }
  args.tracker.runtimeStreams.clear();
}

function rankedDataPlaneSessions(
  budId: string,
  deviceSessionId?: string,
  policy?: DaemonTransportPolicy,
): DataPlaneSessionTracker[] {
  return Array.from(dataPlaneSessions.values())
    .filter((tracker) => {
      if (tracker.budId !== budId) {
        return false;
      }
      if (deviceSessionId && tracker.deviceSessionId !== deviceSessionId) {
        return false;
      }
      return true;
    })
    .sort((a, b) => rankDataPlaneTransport(a.transportKind, policy) - rankDataPlaneTransport(b.transportKind, policy));
}

function isDataPlaneSessionConnected(tracker: DataPlaneSessionTracker): boolean {
  if (tracker.finalized) {
    return false;
  }
  return tracker.isActive();
}

function unavailableSelection(args: {
  code: DataPlaneUnavailableCode;
  message: string;
  tracker: DataPlaneSessionTracker | null;
  candidates: CarrierSelectionCandidate[];
  selectionReason: string;
}): DataPlaneCarrierSelection {
  const tracker = args.tracker;
  const health = tracker ? normalizeCarrierHealth(tracker.health) : null;
  return {
    available: false,
    code: args.code,
    message: args.message,
    tracker,
    transportKind: tracker?.transportKind ?? null,
    role: tracker?.role ?? null,
    deviceSessionId: tracker?.deviceSessionId ?? null,
    controlTransportSessionId: tracker?.controlTransportSessionId ?? null,
    dataTransportSessionId: tracker?.transportSessionId ?? null,
    streamFamilies: tracker ? Array.from(tracker.streams) : [],
    maxChunkBytes: tracker?.maxChunkBytes ?? null,
    maxInFlightBytes: tracker?.maxInFlightBytes ?? null,
    initialCreditBytes: tracker?.initialCreditBytes ?? null,
    health,
    selectionReason: args.selectionReason,
    candidateTransports: args.candidates,
  };
}

function dataPlaneSelectionCandidate(
  tracker: DataPlaneSessionTracker,
  streamType: string,
): CarrierSelectionCandidate {
  const health = normalizeCarrierHealth(tracker.health);
  const supportsStream = tracker.streams.has(streamType);
  const connected = isDataPlaneSessionConnected(tracker);
  const draining = tracker.drainState === "draining";
  const healthy = carrierHealthAllowsNewWork(health);
  return {
    transportKind: tracker.transportKind,
    role: tracker.role,
    health,
    available: connected && supportsStream && !draining && healthy,
    reason: candidateUnavailableReason({ connected, supportsStream, draining, health }),
  };
}

function candidateUnavailableReason(args: {
  connected: boolean;
  supportsStream: boolean;
  draining: boolean;
  health: CarrierHealth;
}): string | null {
  if (!args.connected) {
    return "not connected";
  }
  if (!args.supportsStream) {
    return "stream family unsupported";
  }
  if (args.draining) {
    return "draining";
  }
  if (!carrierHealthAllowsNewWork(args.health)) {
    return describeCarrierHealth(args.health);
  }
  return null;
}

function dataPlaneTrackerAcceptsNewWork(tracker: DataPlaneSessionTracker): boolean {
  return tracker.drainState !== "draining" && carrierHealthAllowsNewWork(normalizeCarrierHealth(tracker.health));
}

function selectionReasonForDataPlaneCarrier(args: {
  selected: DataPlaneSessionTracker;
  candidates: CarrierSelectionCandidate[];
  policy?: DaemonTransportPolicy;
}): string {
  const demoted = args.candidates
    .filter((candidate) => candidate.transportKind !== args.selected.transportKind && !candidate.available)
    .map((candidate) => `${candidate.transportKind}: ${candidate.reason ?? describeCarrierHealth(candidate.health)}`);
  const policyText = args.policy ? ` by ${args.policy} policy` : "";
  const selectedHealth = normalizeCarrierHealth(args.selected.health);
  const suffix = demoted.length > 0 ? `; skipped ${demoted.join(", ")}` : "";
  return `selected ${args.selected.transportKind}${policyText} with ${describeCarrierHealth(selectedHealth)}${suffix}`;
}

async function handleStreamData(
  tracker: DataPlaneSessionTracker,
  raw: unknown,
  args: {
    logger: FastifyBaseLogger;
    daemonStateStore?: DaemonStateStore;
    component?: string;
  },
): Promise<void> {
  const component = args.component ?? "data_plane_runtime";
  const result = StreamDataSchema.safeParse(raw);
  if (!result.success) {
    args.logger.warn({ error: result.error.message, component }, "Invalid data-plane stream_data frame");
    return;
  }
  const frame = result.data;
  const stream = getDataPlaneRuntimeStream(tracker, frame.stream_id);
  if (!stream) {
    await sendStreamReset(tracker, frame.stream_id, "protocol_error", {
      code: "UNKNOWN_STREAM",
      message: "stream_data received for an unknown stream",
      retryable: false,
    });
    return;
  }
  if (stream.streamType !== frame.stream_type) {
    await sendStreamReset(tracker, frame.stream_id, "protocol_error", {
      code: "STREAM_TYPE_MISMATCH",
      message: `expected stream_type ${stream.streamType}, got ${frame.stream_type}`,
      retryable: false,
    });
    return;
  }

  const decoded = Buffer.from(frame.data, "base64");
  if (decoded.byteLength > tracker.maxChunkBytes) {
    await sendStreamReset(tracker, frame.stream_id, "protocol_error", {
      code: "CHUNK_TOO_LARGE",
      message: "stream_data chunk exceeds data-plane max chunk size",
      retryable: false,
    });
    return;
  }

  const creditResult = recordDataPlaneInboundChunk(stream, {
    offset: frame.offset,
    byteLength: decoded.byteLength,
  });
  if (!creditResult.ok) {
    await sendStreamReset(tracker, frame.stream_id, streamResetReasonForCreditError(creditResult.code), {
      code: creditResult.code,
      message: creditResult.message,
      retryable: false,
    });
    return;
  }

  tracker.framesReceived += 1;
  tracker.bytesReceived += decoded.byteLength;

  try {
    await stream.onData?.(decoded, {
      streamId: frame.stream_id,
      streamType: frame.stream_type,
      offset: frame.offset,
      endStream: frame.end_stream,
    });
  } catch (err) {
    args.logger.warn(
      { err, streamId: frame.stream_id, component },
      "Data-plane runtime stream consumer failed",
    );
    const error = {
      code: "STREAM_CONSUMER_FAILED",
      message: err instanceof Error ? err.message : "stream consumer failed",
      retryable: false,
    };
    await sendStreamReset(tracker, frame.stream_id, "local_error", error);
    await (args.daemonStateStore ?? new DaemonStateStore())
      .transitionStream({
        streamId: frame.stream_id,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "local_error",
        error,
      })
      .catch(() => null);
    await (args.daemonStateStore ?? new DaemonStateStore())
      .appendAuditEvent({
        eventType: "data_plane.stream_reset",
        budId: tracker.budId,
        streamId: frame.stream_id,
        eventData: {
          reason: "local_error",
          error,
          stream_type: stream.streamType,
          device_session_id: tracker.deviceSessionId,
          control_transport_session_id: tracker.controlTransportSessionId ?? null,
          data_transport_session_id: tracker.transportSessionId ?? null,
          transport_kind: tracker.transportKind,
        },
      })
      .catch(() => null);
    return;
  }

  grantDataPlaneReceiveCredit(stream, decoded.byteLength);
  await sendDataPlaneFrame(tracker, {
    proto: PROTO_VERSION,
    type: "stream_credit",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    stream_id: stream.streamId,
    receive_offset: stream.receiveOffset,
    credit_bytes: decoded.byteLength,
  });
  if (frame.end_stream) {
    stream.remoteClosed = true;
    await stream.onClose?.({
      streamId: stream.streamId,
      finalOffset: stream.receiveOffset,
    });
    await sendDataPlaneFrame(tracker, {
      proto: PROTO_VERSION,
      type: "stream_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      stream_id: stream.streamId,
      final_offset: stream.receiveOffset,
    });
  }
}

async function handleStreamCredit(
  tracker: DataPlaneSessionTracker,
  raw: unknown,
  args: {
    logger: FastifyBaseLogger;
    component?: string;
  },
): Promise<void> {
  const component = args.component ?? "data_plane_runtime";
  const result = StreamCreditSchema.safeParse(raw);
  if (!result.success) {
    args.logger.warn({ error: result.error.message, component }, "Invalid data-plane stream_credit frame");
    return;
  }
  const stream = getDataPlaneRuntimeStream(tracker, result.data.stream_id);
  if (!stream) {
    args.logger.debug?.(
      { streamId: result.data.stream_id, component },
      "Ignoring credit for unknown data-plane runtime stream",
    );
    return;
  }
  recordDataPlaneOutboundCredit(stream, {
    receiveOffset: result.data.receive_offset,
    creditBytes: result.data.credit_bytes,
  });
  stream.sendCreditBytes = Math.min(stream.sendCreditBytes, tracker.maxInFlightBytes);
}

async function handleStreamReset(
  tracker: DataPlaneSessionTracker,
  raw: unknown,
  args: {
    logger: FastifyBaseLogger;
    daemonStateStore?: DaemonStateStore;
    component?: string;
  },
): Promise<void> {
  const component = args.component ?? "data_plane_runtime";
  const result = StreamResetSchema.safeParse(raw);
  if (!result.success) {
    args.logger.warn({ error: result.error.message, component }, "Invalid data-plane stream_reset frame");
    return;
  }
  const stream = getDataPlaneRuntimeStream(tracker, result.data.stream_id);
  if (stream) {
    stream.resetReason = result.data.reason;
    await stream.onReset?.({
      streamId: result.data.stream_id,
      reason: result.data.reason,
      ...(result.data.error ? { error: result.data.error } : {}),
    });
  }
  await (args.daemonStateStore ?? new DaemonStateStore())
    .transitionStream({
      streamId: result.data.stream_id,
      from: ["opening", "open", "half_closed_local", "half_closed_remote"],
      to: "reset",
      resetReason: result.data.reason,
      error: result.data.error ?? null,
    })
    .catch(() => null);
  await (args.daemonStateStore ?? new DaemonStateStore())
    .appendAuditEvent({
      eventType: "data_plane.stream_reset",
      budId: tracker.budId,
      streamId: result.data.stream_id,
      eventData: {
        reason: result.data.reason,
        error: result.data.error ?? null,
        stream_type: stream?.streamType ?? null,
        device_session_id: tracker.deviceSessionId,
        control_transport_session_id: tracker.controlTransportSessionId ?? null,
        data_transport_session_id: tracker.transportSessionId ?? null,
        transport_kind: tracker.transportKind,
      },
    })
    .catch(() => null);
}

async function handleStreamClose(
  tracker: DataPlaneSessionTracker,
  raw: unknown,
  args: {
    logger: FastifyBaseLogger;
    daemonStateStore?: DaemonStateStore;
    component?: string;
  },
): Promise<void> {
  const component = args.component ?? "data_plane_runtime";
  const result = StreamCloseSchema.safeParse(raw);
  if (!result.success) {
    args.logger.warn({ error: result.error.message, component }, "Invalid data-plane stream_close frame");
    return;
  }
  const stream = getDataPlaneRuntimeStream(tracker, result.data.stream_id);
  const daemonStateStore = args.daemonStateStore ?? new DaemonStateStore();
  if (stream && result.data.final_offset !== stream.receiveOffset) {
    const error = {
      code: "FINAL_OFFSET_MISMATCH",
      message: `expected final_offset ${stream.receiveOffset}, got ${result.data.final_offset}`,
      retryable: false,
      details: {
        expected_final_offset: stream.receiveOffset,
        received_final_offset: result.data.final_offset,
      },
    };
    stream.resetReason = "protocol_error";
    await stream.onReset?.({
      streamId: result.data.stream_id,
      reason: "protocol_error",
      error,
    });
    await sendStreamReset(tracker, result.data.stream_id, "protocol_error", error).catch(() => null);
    await daemonStateStore
      .transitionStream({
        streamId: result.data.stream_id,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "protocol_error",
        error,
      })
      .catch(() => null);
    await daemonStateStore
      .appendAuditEvent({
        eventType: "data_plane.stream_reset",
        budId: tracker.budId,
        streamId: result.data.stream_id,
        eventData: {
          reason: "protocol_error",
          error,
          stream_type: stream.streamType,
          device_session_id: tracker.deviceSessionId,
          control_transport_session_id: tracker.controlTransportSessionId ?? null,
          data_transport_session_id: tracker.transportSessionId ?? null,
          transport_kind: tracker.transportKind,
        },
      })
      .catch(() => null);
    return;
  }
  if (stream) {
    stream.remoteClosed = true;
    await stream.onClose?.({
      streamId: result.data.stream_id,
      finalOffset: result.data.final_offset,
    });
  }
  await daemonStateStore
    .transitionStream({
      streamId: result.data.stream_id,
      from: ["opening"],
      to: "open",
    })
    .catch(() => null);
  await daemonStateStore
    .transitionStream({
      streamId: result.data.stream_id,
      from: ["open", "half_closed_local", "half_closed_remote"],
      to: "closed",
      receiveOffset: result.data.final_offset,
    })
    .catch(() => null);
  await daemonStateStore
    .appendAuditEvent({
      eventType: "data_plane.stream_close",
      budId: tracker.budId,
      streamId: result.data.stream_id,
      eventData: {
        final_offset: result.data.final_offset,
        stream_type: stream?.streamType ?? null,
        device_session_id: tracker.deviceSessionId,
        control_transport_session_id: tracker.controlTransportSessionId ?? null,
        data_transport_session_id: tracker.transportSessionId ?? null,
        transport_kind: tracker.transportKind,
      },
    })
    .catch(() => null);
}

async function sendStreamReset(
  tracker: DataPlaneSessionTracker,
  streamId: string,
  reason: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<void> {
  await sendDataPlaneFrame(tracker, {
    proto: PROTO_VERSION,
    type: "stream_reset",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    stream_id: streamId,
    reason,
    error,
  });
}

function streamResetReasonForCreditError(code: string): string {
  return code === "CREDIT_EXHAUSTED" ? "backpressure" : "protocol_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
