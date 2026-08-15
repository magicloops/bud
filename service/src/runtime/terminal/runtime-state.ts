import type { FastifyBaseLogger } from "fastify";
import {
  isTerminalIntegration,
  isTerminalMode,
  type TerminalIntegration,
  type TerminalMode,
} from "../../terminal/types.js";

/**
 * Daemon-reported runtime facts for a session (proto 0.3): the current mode
 * and shell-integration level from `mode_changed` events / `terminal_status`
 * info, and the latest cwd from `prompt_ready` events.
 */
export type TerminalRuntimeContext = {
  mode: TerminalMode;
  integration: TerminalIntegration | null;
  cwd: string | null;
};

const DEFAULT_CONTEXT: TerminalRuntimeContext = {
  mode: "unknown",
  integration: null,
  cwd: null,
};

export class TerminalRuntimeState {
  private readonly logger: FastifyBaseLogger;
  private readonly contexts = new Map<string, TerminalRuntimeContext>();

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  clearSessionCache(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  clearSessionCaches(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.clearSessionCache(sessionId);
    }
  }

  getSessionContext(sessionId: string): TerminalRuntimeContext {
    return this.contexts.get(sessionId) ?? { ...DEFAULT_CONTEXT };
  }

  applyModeChange(sessionId: string, mode: unknown, integration: unknown): void {
    const context = this.getOrCreate(sessionId);
    if (isTerminalMode(mode)) {
      context.mode = mode;
    }
    if (isTerminalIntegration(integration)) {
      context.integration = integration;
    }
    this.logger.info(
      {
        sessionId,
        mode: context.mode,
        integration: context.integration,
        component: "terminal_runtime_state",
      },
      "Terminal mode updated"
    );
  }

  applyCwd(sessionId: string, cwd: unknown): void {
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      return;
    }
    this.getOrCreate(sessionId).cwd = cwd;
  }

  applyStatusInfo(
    sessionId: string,
    info: { mode?: unknown; integration?: unknown; cwd?: unknown } | undefined,
  ): void {
    if (!info) {
      return;
    }
    const context = this.getOrCreate(sessionId);
    if (isTerminalMode(info.mode)) {
      context.mode = info.mode;
    }
    if (isTerminalIntegration(info.integration)) {
      context.integration = info.integration;
    }
    if (typeof info.cwd === "string" && info.cwd.trim().length > 0) {
      context.cwd = info.cwd;
    }
  }

  private getOrCreate(sessionId: string): TerminalRuntimeContext {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: TerminalRuntimeContext = { ...DEFAULT_CONTEXT };
    this.contexts.set(sessionId, created);
    return created;
  }
}
