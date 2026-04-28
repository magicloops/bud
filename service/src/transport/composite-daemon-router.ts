import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";
import { orderedControlTransportKinds, type ControlTransportKind } from "./carrier-policy.js";
import { grpcDaemonTransportRouter } from "./grpc-daemon-router.js";
import { websocketDaemonTransportRouter } from "./websocket-daemon-router.js";

const routers: Record<ControlTransportKind, DaemonTransportRouter> = {
  websocket: websocketDaemonTransportRouter,
  h2_grpc: grpcDaemonTransportRouter,
};

export const daemonTransportRouter: DaemonTransportRouter = {
  getActiveBudIds(): string[] {
    return Array.from(
      new Set([
        ...grpcDaemonTransportRouter.getActiveBudIds(),
        ...websocketDaemonTransportRouter.getActiveBudIds(),
      ]),
    );
  },

  isBudOnline(budId: string): boolean {
    return grpcDaemonTransportRouter.isBudOnline(budId) || websocketDaemonTransportRouter.isBudOnline(budId);
  },

  sendFrameToBud(budId: string, payload: DaemonTransportPayload): boolean {
    for (const kind of orderedControlTransportKinds()) {
      const router = routers[kind];
      if (!router.isBudOnline(budId)) {
        continue;
      }
      try {
        if (router.sendFrameToBud(budId, payload)) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  },

  getTransportStatus(budId: string): DaemonTransportStatus {
    for (const kind of orderedControlTransportKinds()) {
      const status = routers[kind].getTransportStatus(budId);
      if (status.online) {
        return status;
      }
    }
    return websocketDaemonTransportRouter.getTransportStatus(budId);
  },
};
