export type SessionState = "pending" | "creating" | "ready" | "active" | "idle" | "closed";

export interface TerminalSession {
  sessionId: string;
  threadId: string | null;
  budId: string;
  instanceId: string | null;
  state: SessionState;
  cols: number;
  rows: number;
  cwd: string | null;
  createdAt: Date;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  outputLogBytes: number;
}
