import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { BudConnection } from "./bud-connection.js";
import { setGatewayLogger } from "./debug.js";
import { websocketDaemonTransportRouter } from "../transport/websocket-daemon-router.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";

export {
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  type SessionTracker,
} from "./session-trackers.js";
export {
  clearGatewayDrain,
  getGatewayDrainState,
  startGatewayDrain,
} from "../transport/gateway-drain.js";

export function getActiveBudIds(): string[] {
  return websocketDaemonTransportRouter.getActiveBudIds();
}

export function isBudOnline(budId: string): boolean {
  return websocketDaemonTransportRouter.isBudOnline(budId);
}

export function sendFrameToBud(budId: string, payload: Record<string, unknown>): boolean {
  return websocketDaemonTransportRouter.sendFrameToBud(budId, payload);
}

export async function registerWsGateway(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager
): Promise<void> {
  setGatewayLogger(server.log.child({ component: "ws_gateway" }));
  server.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const connection = new BudConnection(server, socket, terminalSessionManager);
    connection.start().catch((err) => {
      server.log.error({ err }, "WS connection failed");
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
  });
}
