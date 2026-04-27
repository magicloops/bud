import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";
import { grpcDaemonTransportRouter } from "./grpc-daemon-router.js";
import { websocketDaemonTransportRouter } from "./websocket-daemon-router.js";

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
    if (grpcDaemonTransportRouter.isBudOnline(budId)) {
      return grpcDaemonTransportRouter.sendFrameToBud(budId, payload);
    }
    return websocketDaemonTransportRouter.sendFrameToBud(budId, payload);
  },

  getTransportStatus(budId: string): DaemonTransportStatus {
    const grpcStatus = grpcDaemonTransportRouter.getTransportStatus(budId);
    if (grpcStatus.online) {
      return grpcStatus;
    }
    return websocketDaemonTransportRouter.getTransportStatus(budId);
  },
};
