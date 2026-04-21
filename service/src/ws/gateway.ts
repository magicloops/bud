import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { BudConnection } from "./bud-connection.js";
import { logGatewayDebug, setGatewayLogger } from "./debug.js";
import {
  getActiveBudIds as getTrackedBudIds,
  isBudOnline as getBudOnlineState,
  sessions,
} from "./session-trackers.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";

export {
  deleteSessionTrackerIfCurrent,
  getActiveSessionTracker,
  registerActiveSessionTracker,
  type SessionTracker,
} from "./session-trackers.js";

export function getActiveBudIds(): string[] {
  return getTrackedBudIds();
}

export function isBudOnline(budId: string): boolean {
  return getBudOnlineState(budId);
}

export function sendFrameToBud(budId: string, payload: Record<string, unknown>): boolean {
  const session = sessions.get(budId);
  if (!session) {
    logGatewayDebug({ budId, activeBuds: getActiveBudIds() }, "No active session for bud; dropping frame ");
    return false;
  }
  if (session.socket.readyState !== session.socket.OPEN) {
    logGatewayDebug(
      {
        budId,
        readyState: session.socket.readyState
      },
      "WS socket not open; dropping frame"
    );
    return false;
  }
  session.socket.send(JSON.stringify(payload));
  logGatewayDebug({ budId, type: payload.type }, "Frame sent to Bud");
  return true;
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
