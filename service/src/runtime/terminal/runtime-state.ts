import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config.js";
import type { PendingCommand, ReadinessAssessment, TerminalContext } from "../../terminal/types.js";
import { getProgramInfo } from "../../terminal/known-programs.js";

const STALE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export class TerminalRuntimeState {
  private readonly logger: FastifyBaseLogger;
  private readonly readiness = new Map<string, ReadinessAssessment>();
  private readonly pendingCommands = new Map<string, PendingCommand | null>();

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  clearSessionCache(sessionId: string): void {
    this.readiness.delete(sessionId);
    this.pendingCommands.delete(sessionId);
  }

  clearSessionCaches(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.clearSessionCache(sessionId);
    }
  }

  setPendingCommand(sessionId: string, command: PendingCommand): void {
    this.pendingCommands.set(sessionId, command);
    this.debug("tracking pending command", {
      sessionId,
      command: command.command,
      source: command.source
    });
  }

  clearPendingCommand(sessionId: string): void {
    const pending = this.pendingCommands.get(sessionId);
    if (!pending) {
      return;
    }
    this.debug("clearing pending command via context sync", {
      sessionId,
      command: pending.command
    });
    this.pendingCommands.set(sessionId, null);
  }

  getLatestReadiness(sessionId: string): ReadinessAssessment | null {
    return this.readiness.get(sessionId) ?? null;
  }

  getSessionContext(sessionId: string): TerminalContext {
    this.cleanupStaleCommand(sessionId);
    const pending = this.pendingCommands.get(sessionId);

    if (!pending) {
      return { mode: "shell" };
    }

    const programInfo = getProgramInfo(pending.command);
    if (!programInfo) {
      return {
        mode: "unknown",
        pendingCommand: pending
      };
    }

    return {
      mode: "repl",
      pendingCommand: pending,
      program: programInfo.name,
      programDisplayName: programInfo.displayName,
      interactionStyle: programInfo.interactionStyle,
      hints: programInfo.hints
    };
  }

  storeReadinessAssessment(
    sessionId: string,
    assessment: ReadinessAssessment,
  ): ReadinessAssessment {
    this.readiness.set(sessionId, assessment);

    if (
      assessment.prompt_type === "shell" &&
      assessment.confidence >= 0.8 &&
      assessment.hints?.looks_like_prompt
    ) {
      const pending = this.pendingCommands.get(sessionId);
      if (pending) {
        const durationMs = Date.now() - pending.sentAt;
        this.debug("clearing pending command - returned to shell", {
          sessionId,
          command: pending.command,
          durationMs
        });
        this.pendingCommands.set(sessionId, null);
      }
    }

    return assessment;
  }

  private cleanupStaleCommand(sessionId: string): void {
    const pending = this.pendingCommands.get(sessionId);
    if (pending && Date.now() - pending.sentAt > STALE_COMMAND_TIMEOUT_MS) {
      this.logger.warn(
        { sessionId, command: pending.command, component: "terminal_runtime_state" },
        "Clearing stale pending command"
      );
      this.pendingCommands.set(sessionId, null);
    }
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    if (!config.agentDebug) {
      return;
    }
    this.logger.info({ ...meta, component: "terminal_runtime_state" }, message);
  }
}

