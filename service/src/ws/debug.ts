import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";

let gatewayLogger: FastifyBaseLogger | null = null;

export function setGatewayLogger(logger: FastifyBaseLogger | null): void {
  gatewayLogger = logger;
}

export function logGatewayDebug(meta: Record<string, unknown>, message: string): void {
  if (!config.agentDebug || !gatewayLogger) {
    return;
  }
  gatewayLogger.info({ ...meta, component: "ws_gateway" }, message);
}

