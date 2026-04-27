import { once } from "node:events";
import type * as grpc from "@grpc/grpc-js";
import { encodeGrpcLegacyJsonEnvelope } from "../grpc/envelope-codec.js";
import { logGatewayDebug } from "../ws/debug.js";
import { getGatewayDrainState, shouldBlockNewDaemonWork } from "./gateway-drain.js";
import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";

export type TimeoutHandle = ReturnType<typeof setTimeout>;

export type GrpcBudEnvelope = Record<string, unknown>;
export type GrpcControlCall = grpc.ServerDuplexStream<GrpcBudEnvelope, GrpcBudEnvelope>;

export interface GrpcSessionTracker {
  budId: string;
  sessionId: string;
  deviceSessionId?: string;
  transportSessionId?: string;
  drainState?: "active" | "draining";
  finalizing?: boolean;
  finalized?: boolean;
  lastHeartbeat: number;
  call: GrpcControlCall;
  backpressured?: boolean;
  timeout?: TimeoutHandle;
}

export const grpcSessions = new Map<string, GrpcSessionTracker>();

export function clearGrpcTrackerTimeout(tracker: GrpcSessionTracker | null | undefined): void {
  if (!tracker?.timeout) {
    return;
  }
  clearTimeout(tracker.timeout);
  tracker.timeout = undefined;
}

export function registerActiveGrpcSessionTracker(
  tracker: GrpcSessionTracker,
): GrpcSessionTracker | null {
  const previous = grpcSessions.get(tracker.budId) ?? null;
  clearGrpcTrackerTimeout(previous);
  grpcSessions.set(tracker.budId, tracker);
  return previous;
}

export function getActiveGrpcSessionTracker(
  budId: string,
  tracker: GrpcSessionTracker | null | undefined,
): GrpcSessionTracker | null {
  if (!tracker) {
    return null;
  }
  return grpcSessions.get(budId) === tracker ? tracker : null;
}

export function deleteGrpcSessionTrackerIfCurrent(
  tracker: GrpcSessionTracker | null | undefined,
): boolean {
  if (!tracker) {
    return false;
  }
  if (grpcSessions.get(tracker.budId) !== tracker) {
    return false;
  }
  grpcSessions.delete(tracker.budId);
  clearGrpcTrackerTimeout(tracker);
  return true;
}

export const grpcDaemonTransportRouter: DaemonTransportRouter = {
  getActiveBudIds(): string[] {
    return Array.from(grpcSessions.keys()).filter((budId) => isGrpcBudOnline(budId));
  },

  isBudOnline(budId: string): boolean {
    return isGrpcBudOnline(budId);
  },

  sendFrameToBud(budId: string, payload: DaemonTransportPayload): boolean {
    const session = grpcSessions.get(budId);
    if (!session) {
      logGatewayDebug({ budId }, "No active gRPC session for bud; dropping frame");
      return false;
    }
    if (session.call.destroyed) {
      logGatewayDebug({ budId }, "gRPC control stream destroyed; dropping frame");
      return false;
    }
    if (shouldBlockNewDaemonWork(payload)) {
      session.drainState = "draining";
      logGatewayDebug(
        {
          budId,
          type: frameType(payload),
          drain: getGatewayDrainState(),
        },
        "Gateway drain active; refusing new daemon work on gRPC transport",
      );
      return false;
    }
    if (session.backpressured) {
      logGatewayDebug({ budId, type: frameType(payload) }, "gRPC stream backpressured; dropping frame");
      return false;
    }

    const envelope = encodeGrpcLegacyJsonEnvelope(payload, { transportKind: "h2_grpc" });
    const accepted = session.call.write(envelope);
    if (!accepted) {
      session.backpressured = true;
      void once(session.call, "drain")
        .then(() => {
          session.backpressured = false;
        })
        .catch(() => {
          session.backpressured = false;
        });
    }
    logGatewayDebug({ budId, type: frameType(payload) }, "Frame sent to Bud over gRPC");
    return true;
  },

  getTransportStatus(budId: string): DaemonTransportStatus {
    return {
      online: isGrpcBudOnline(budId),
      transport_kind: isGrpcBudOnline(budId) ? "h2_grpc" : "none",
    };
  },
};

function isGrpcBudOnline(budId: string): boolean {
  const session = grpcSessions.get(budId);
  return session !== undefined && !session.finalized && !session.call.destroyed;
}

function frameType(payload: DaemonTransportPayload): string | undefined {
  if ("payload" in payload) {
    const nested = payload.payload;
    if (isRecord(nested) && "legacy_json" in nested) {
      const legacyJson = nested.legacy_json;
      return isRecord(legacyJson) && typeof legacyJson.frame_type === "string"
        ? legacyJson.frame_type
        : undefined;
    }
    return isRecord(nested) && typeof nested.type === "string" ? nested.type : undefined;
  }
  return typeof payload.type === "string" ? payload.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
