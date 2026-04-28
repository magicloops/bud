import type {
  DaemonTransportPayload,
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "./daemon-router.js";
import { orderedControlTransportKinds, type ControlTransportKind } from "./carrier-policy.js";
import { grpcDaemonTransportRouter } from "./grpc-daemon-router.js";
import { websocketDaemonTransportRouter } from "./websocket-daemon-router.js";

const defaultRouters: Record<ControlTransportKind, DaemonTransportRouter> = {
  websocket: websocketDaemonTransportRouter,
  h2_grpc: grpcDaemonTransportRouter,
};

export function createCompositeDaemonRouter(args: {
  routers?: Record<ControlTransportKind, DaemonTransportRouter>;
  orderedKinds?: () => readonly ControlTransportKind[];
} = {}): DaemonTransportRouter {
  const routers = args.routers ?? defaultRouters;
  const getOrderedKinds = args.orderedKinds ?? orderedControlTransportKinds;
  return {
    getActiveBudIds(): string[] {
      return Array.from(
        new Set(Object.values(routers).flatMap((router) => router.getActiveBudIds())),
      );
    },

    isBudOnline(budId: string): boolean {
      return Object.values(routers).some((router) => router.isBudOnline(budId));
    },

    sendFrameToBud(budId: string, payload: DaemonTransportPayload): boolean {
      for (const kind of getOrderedKinds()) {
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
      for (const kind of getOrderedKinds()) {
        const status = routers[kind].getTransportStatus(budId);
        if (status.online) {
          return status;
        }
      }
      return routers.websocket.getTransportStatus(budId);
    },
  };
}

export const daemonTransportRouter: DaemonTransportRouter = createCompositeDaemonRouter();
