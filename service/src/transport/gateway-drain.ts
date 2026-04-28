export type GatewayDrainState = {
  draining: boolean;
  reason: string;
  started_at: string;
  deadline_at?: string;
};

const LONG_LIVED_FRAME_TYPES = new Set([
  "terminal_ensure",
  "proxy_open",
  "proxy_connect",
  "file_open",
  "file_read",
  "file_view",
]);

let activeDrain: GatewayDrainState | null = null;

export function startGatewayDrain(args: { reason: string; deadlineAt?: Date | string | null }): GatewayDrainState {
  activeDrain = {
    draining: true,
    reason: args.reason,
    started_at: new Date().toISOString(),
    ...(args.deadlineAt ? { deadline_at: normalizeTimestamp(args.deadlineAt) } : {}),
  };
  return activeDrain;
}

export function clearGatewayDrain(): void {
  activeDrain = null;
}

export function getGatewayDrainState(): GatewayDrainState | null {
  return activeDrain;
}

export function isGatewayDraining(): boolean {
  return activeDrain !== null;
}

export function shouldBlockNewDaemonWork(payload: Record<string, unknown>): boolean {
  if (!activeDrain) {
    return false;
  }
  const type = frameType(payload);
  return typeof type === "string" && LONG_LIVED_FRAME_TYPES.has(type);
}

function frameType(payload: Record<string, unknown>): string | undefined {
  if ("payload" in payload) {
    const nested = payload.payload;
    return isRecord(nested) && typeof nested.type === "string" ? nested.type : undefined;
  }
  return typeof payload.type === "string" ? payload.type : undefined;
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
