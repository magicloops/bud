import { logGatewayDebug } from "../ws/debug.js";
import {
  getActiveBudIds as getTrackedBudIds,
  isBudOnline as getBudOnlineState,
  sessions,
} from "../ws/session-trackers.js";
import { encodeLegacyJsonFrame } from "../proto/wire.js";
import { getGatewayDrainState, shouldBlockNewDaemonWork } from "./gateway-drain.js";
import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";

export const websocketDaemonTransportRouter: DaemonTransportRouter = {
  getActiveBudIds(): string[] {
    return getTrackedBudIds();
  },

  isBudOnline(budId: string): boolean {
    return getBudOnlineState(budId);
  },

  sendFrameToBud(budId: string, payload: DaemonTransportPayload): boolean {
    const session = sessions.get(budId);
    if (!session) {
      logGatewayDebug(
        { budId, activeBuds: getTrackedBudIds() },
        "No active session for bud; dropping frame ",
      );
      return false;
    }
    if (session.socket.readyState !== session.socket.OPEN) {
      logGatewayDebug(
        {
          budId,
          readyState: session.socket.readyState,
        },
        "WS socket not open; dropping frame",
      );
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
        "Gateway drain active; refusing new daemon work",
      );
      return false;
    }
    if (session.supportsEnvelopeBinary) {
      session.socket.send(encodeLegacyJsonFrame(payload));
    } else {
      session.socket.send(JSON.stringify(payload));
    }
    logGatewayDebug({ budId, type: frameType(payload) }, "Frame sent to Bud");
    return true;
  },

  getTransportStatus(budId: string): DaemonTransportStatus {
    return {
      online: getBudOnlineState(budId),
      transport_kind: getBudOnlineState(budId) ? "websocket" : "none",
    };
  },
};

function frameType(payload: DaemonTransportPayload): string | undefined {
  if ("payload" in payload) {
    const nested = payload.payload;
    return isRecord(nested) && typeof nested.type === "string" ? nested.type : undefined;
  }
  return typeof payload.type === "string" ? payload.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
