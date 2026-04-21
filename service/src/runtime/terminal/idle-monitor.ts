import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config.js";
import { TerminalSessionStore } from "./session-store.js";

type TerminalIdleMonitorDeps = {
  logger: FastifyBaseLogger;
  store: TerminalSessionStore;
  closeSession: (sessionId: string, reason?: string) => Promise<void>;
};

export class TerminalIdleMonitor {
  private readonly deps: TerminalIdleMonitorDeps;
  private idleCheckInterval: NodeJS.Timeout | null = null;

  constructor(deps: TerminalIdleMonitorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.idleCheckInterval) {
      return;
    }
    const intervalMs = config.terminalIdleCheckIntervalMinutes * 60 * 1000;
    this.deps.logger.info(
      { intervalMinutes: config.terminalIdleCheckIntervalMinutes, component: "terminal_idle_monitor" },
      "Starting terminal idle check job"
    );
    this.idleCheckInterval = setInterval(() => {
      this.runIdleCheck().catch((err) => {
        this.deps.logger.error({ err, component: "terminal_idle_monitor" }, "Idle check failed");
      });
    }, intervalMs);
    this.runIdleCheck().catch((err) => {
      this.deps.logger.error({ err, component: "terminal_idle_monitor" }, "Initial idle check failed");
    });
  }

  stop(): void {
    if (!this.idleCheckInterval) {
      return;
    }
    clearInterval(this.idleCheckInterval);
    this.idleCheckInterval = null;
    this.deps.logger.info({ component: "terminal_idle_monitor" }, "Stopped terminal idle check job");
  }

  private async runIdleCheck(): Promise<void> {
    const now = new Date();
    const idleThreshold = new Date(now.getTime() - config.terminalIdleTimeoutMinutes * 60 * 1000);

    const markedIdle = await this.deps.store.markIdleSessions(idleThreshold);
    let closed = 0;

    if (config.terminalIdleCleanupHours > 0) {
      const staleThreshold = new Date(now.getTime() - config.terminalIdleCleanupHours * 60 * 60 * 1000);
      const staleSessionIds = await this.deps.store.listStaleIdleSessionIds(staleThreshold);
      for (const sessionId of staleSessionIds) {
        await this.deps.closeSession(sessionId, "idle_cleanup");
        closed += 1;
      }
    }

    if (markedIdle > 0 || closed > 0) {
      this.deps.logger.info(
        { markedIdle, closed, component: "terminal_idle_monitor" },
        "Idle check completed"
      );
    }
  }
}
