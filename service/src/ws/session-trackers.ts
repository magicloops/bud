import type WebSocket from "ws";

export type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface SessionTracker {
  budId: string;
  sessionId: string;
  deviceSessionId?: string;
  transportSessionId?: string;
  drainState?: "active" | "draining";
  lastHeartbeat: number;
  socket: WebSocket;
  supportsEnvelopeBinary?: boolean;
  timeout?: TimeoutHandle;
}

export const sessions = new Map<string, SessionTracker>();

export function clearTrackerTimeout(tracker: SessionTracker | null | undefined): void {
  if (!tracker?.timeout) {
    return;
  }
  clearTimeout(tracker.timeout);
  tracker.timeout = undefined;
}

export function registerActiveSessionTracker(
  activeSessions: Map<string, SessionTracker>,
  tracker: SessionTracker
): SessionTracker | null {
  const previous = activeSessions.get(tracker.budId) ?? null;
  clearTrackerTimeout(previous);
  activeSessions.set(tracker.budId, tracker);
  return previous;
}

export function getActiveSessionTracker(
  activeSessions: Map<string, SessionTracker>,
  budId: string,
  tracker: SessionTracker | null | undefined
): SessionTracker | null {
  if (!tracker) {
    return null;
  }
  return activeSessions.get(budId) === tracker ? tracker : null;
}

export function deleteSessionTrackerIfCurrent(
  activeSessions: Map<string, SessionTracker>,
  tracker: SessionTracker | null | undefined
): boolean {
  if (!tracker) {
    return false;
  }
  if (activeSessions.get(tracker.budId) !== tracker) {
    return false;
  }
  activeSessions.delete(tracker.budId);
  clearTrackerTimeout(tracker);
  return true;
}

export function getActiveBudIds(): string[] {
  return Array.from(sessions.keys());
}

export function isBudOnline(budId: string): boolean {
  const session = sessions.get(budId);
  return session !== undefined && session.socket.readyState === session.socket.OPEN;
}
