import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../db/client.js";
import {
  terminalSessionInputLogTable,
  terminalSessionTable
} from "../db/schema.js";
import { TERMINAL_PROTO_VERSION } from "../config.js";
import { sendFrameToBud } from "../ws/gateway.js";
import type { PendingCommand, ReadinessAssessment } from "../terminal/types.js";
import { isKnownReplProgram } from "../terminal/known-programs.js";
import { TerminalEventBus } from "./event-bus.js";
import { TerminalIdleMonitor } from "./terminal/idle-monitor.js";
import {
  summarizeContextForLog,
  summarizeObservedOutput,
} from "./terminal/logging.js";
import {
  TerminalRequestDispatcher,
  type ObserveOptions,
  type ObserveResponsePayload,
  type ObserveResult,
  type SendInteraction,
  type SendResult,
  type SendResultPayload,
} from "./terminal/request-dispatcher.js";
import { TerminalOutputStore } from "./terminal/output-store.js";
import { TerminalRuntimeState } from "./terminal/runtime-state.js";
import { TerminalSessionStore } from "./terminal/session-store.js";
import type { SessionState, TerminalSession } from "./terminal/session-types.js";

type TerminalStatusPayload = {
  state: string;
  info?: {
    pid?: number;
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    output_log_bytes?: number;
    started_at?: string;
    last_activity_at?: string;
  };
};

type TerminalOutputPayload = {
  seq: number;
  data: string;
  byte_offset: number;
};

type TerminalReadyPayload = {
  assessment: ReadinessAssessment;
};

export type { SessionState, TerminalSession } from "./terminal/session-types.js";
export type {
  ObserveOptions,
  ObserveResult,
  SendInteraction,
  SendResult,
} from "./terminal/request-dispatcher.js";

export class TerminalSessionManager {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;
  private readonly sessionStore: TerminalSessionStore;
  private readonly runtimeState: TerminalRuntimeState;
  private readonly outputStore: TerminalOutputStore;
  private readonly requestDispatcher: TerminalRequestDispatcher;
  private readonly idleMonitor: TerminalIdleMonitor;

  constructor(logger: FastifyBaseLogger, events: TerminalEventBus) {
    this.logger = logger;
    this.events = events;
    this.sessionStore = new TerminalSessionStore(logger);
    this.runtimeState = new TerminalRuntimeState(logger);
    this.outputStore = new TerminalOutputStore(logger, events);
    this.requestDispatcher = new TerminalRequestDispatcher({
      logger,
      getSession: (sessionId) => this.sessionStore.getSession(sessionId),
      getSessionContext: (sessionId) => this.runtimeState.getSessionContext(sessionId),
      getLatestReadiness: (sessionId) => this.runtimeState.getLatestReadiness(sessionId),
      getLastOffset: (sessionId) => this.outputStore.getLastOffset(sessionId),
      storeReadinessAssessment: (sessionId, assessment) => {
        this.runtimeState.storeReadinessAssessment(sessionId, assessment);
      },
      emitReadyEvent: (sessionId, assessment) => {
        this.events.emit(sessionId, {
          event: "terminal.ready",
          data: { assessment },
          id: ulid()
        });
      },
      sendFrameToBud,
      summarizeContextForLog,
      summarizeObservedOutput,
    });
    this.idleMonitor = new TerminalIdleMonitor({
      logger,
      store: this.sessionStore,
      closeSession: (sessionId, reason) => this.closeSession(sessionId, reason),
    });
  }

  async ensureSessionRecordForThread(
    threadId: string,
    budId: string,
    createdByUserId?: string | null,
  ): Promise<{ session: TerminalSession; created: boolean }> {
    return this.sessionStore.ensureSessionRecordForThread(threadId, budId, createdByUserId);
  }

  async createSessionForThread(
    threadId: string,
    budId: string,
    createdByUserId?: string | null,
  ): Promise<string> {
    const { session } = await this.ensureSessionRecordForThread(threadId, budId, createdByUserId);
    return session.sessionId;
  }

  async getSessionForThread(threadId: string): Promise<TerminalSession | null> {
    return this.sessionStore.getSessionForThread(threadId);
  }

  async getSession(sessionId: string): Promise<TerminalSession | null> {
    return this.sessionStore.getSession(sessionId);
  }

  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; created?: boolean; error?: string }> {
    return this.sessionStore.ensureSession(sessionId);
  }

  async closeSession(sessionId: string, reason = "requested"): Promise<void> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return;
    }

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      reason
    };
    sendFrameToBud(session.budId, payload);

    await this.sessionStore.markClosed(sessionId);
    this.runtimeState.clearSessionCache(sessionId);
    this.outputStore.clearSessionCache(sessionId);
    this.requestDispatcher.rejectPendingRequestsForSession(sessionId, "session_closed");

    this.events.emit(sessionId, {
      event: "terminal.status",
      data: { state: "closed", reason },
      id: ulid()
    });

    this.logger.info({ sessionId, reason }, "Session closed");
  }

  async sendInput(
    sessionId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; userId?: string } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const inputStr = data.toString("utf-8");
    const source = options.source ?? "agent";

    if (this.runtimeState.getSessionContext(sessionId).mode === "shell" && inputStr.includes("\n")) {
      const command = this.parseCommandFromInput(inputStr);
      if (command && isKnownReplProgram(command)) {
        this.runtimeState.setPendingCommand(sessionId, {
          input: inputStr,
          command,
          sentAt: Date.now(),
          source
        });
      }
    }

    const context = this.runtimeState.getSessionContext(sessionId);
    const useActivityBased = context.mode === "repl";

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      data: data.toString("base64"),
      await_ready: {
        enabled: true,
        activity_based: useActivityBased,
        ...(useActivityBased
          ? {
              activity_interval_ms: 5000,
              activity_stable_count: 2,
              activity_initial_delay_ms: 2000,
              max_wait_ms: 60000
            }
          : {
              max_wait_ms: 30000
            })
      }
    };

    this.debug("sendInput with readiness config", {
      sessionId,
      mode: context.mode,
      program: context.program,
      useActivityBased
    });

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      this.logger.warn({ sessionId }, "Failed to send terminal_input (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    await this.recordInput(sessionId, data, options);
    await this.bumpInputStats(sessionId, data.length);
    this.debug("terminal_input forwarded", {
      sessionId,
      bytes: data.length,
      source
    });
    return { ok: true };
  }

  async sendResize(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_resize",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      cols,
      rows
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      this.logger.warn({ sessionId }, "Failed to send terminal_resize (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    await db
      .update(terminalSessionTable)
      .set({ cols, rows, lastActivityAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    this.debug("terminal_resize forwarded", { sessionId, cols, rows });
    return { ok: true };
  }

  async handleTerminalStatus(sessionId: string, payload: TerminalStatusPayload): Promise<void> {
    await this.sessionStore.updateStatus(sessionId, payload);
    this.debug("terminal_status processed", { sessionId, state: payload.state });
    this.events.emit(sessionId, {
      event: "terminal.status",
      data: {
        state: payload.state,
        info: payload.info ?? {}
      },
      id: ulid()
    });
  }

  async handleTerminalOutput(sessionId: string, payload: TerminalOutputPayload): Promise<void> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, "terminal_output for unknown session");
      return;
    }

    await this.outputStore.handleTerminalOutput(sessionId, payload, {
      getStoredOutputBytes: async () => session.outputLogBytes ?? 0,
      onOutputObserved: ({ sessionId: currentSessionId, requestOffset, endOffset, outputBytes }) => {
        this.requestDispatcher.noteOutputObserved(currentSessionId, {
          requestOffset,
          endOffset,
          outputBytes
        });
      }
    });
  }

  async handleTerminalReady(sessionId: string, payload: TerminalReadyPayload): Promise<void> {
    this.runtimeState.storeReadinessAssessment(sessionId, payload.assessment);
    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment: payload.assessment },
      id: ulid()
    });
  }

  handleObserveResult(sessionId: string, payload: ObserveResponsePayload): void {
    this.requestDispatcher.handleObserveResult(sessionId, payload);
  }

  handleSendResult(sessionId: string, payload: SendResultPayload): void {
    this.requestDispatcher.handleSendResult(sessionId, payload);
  }

  getSessionContext(sessionId: string): ReturnType<TerminalRuntimeState["getSessionContext"]> {
    return this.runtimeState.getSessionContext(sessionId);
  }

  getLastOffset(sessionId: string): number {
    return this.outputStore.getLastOffset(sessionId);
  }

  getLatestReadiness(sessionId: string): ReadinessAssessment | null {
    return this.runtimeState.getLatestReadiness(sessionId);
  }

  async tailOutput(
    sessionId: string,
    maxBytes: number,
    options?: { sinceOffset?: number }
  ): Promise<{ data: Buffer; totalBytes: number }> {
    return this.outputStore.tailOutput(sessionId, maxBytes, options);
  }

  async observeTerminal(
    sessionId: string,
    options: ObserveOptions = {},
    timeoutMs = 30000
  ): Promise<ObserveResult> {
    return this.requestDispatcher.observeTerminal(sessionId, options, timeoutMs);
  }

  async capturePane(
    sessionId: string,
    options: { startLine?: number; endLine?: number; escapeSequences?: boolean; joinLines?: boolean } = {},
    timeoutMs = 5000
  ): Promise<ObserveResult> {
    return this.observeTerminal(
      sessionId,
      {
        lines: options.startLine ?? -50,
        waitFor: "none",
        view: "history"
      },
      timeoutMs
    );
  }

  async sendInteraction(
    sessionId: string,
    interaction: SendInteraction,
    options: {
      timeoutMs?: number;
    } = {}
  ): Promise<SendResult> {
    return this.requestDispatcher.sendInteraction(sessionId, interaction, options);
  }

  setPendingCommand(sessionId: string, command: PendingCommand): void {
    this.runtimeState.setPendingCommand(sessionId, command);
  }

  async fetchStatus(sessionId: string): Promise<{
    state: SessionState | "none";
    info: Record<string, unknown> | null;
  }> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return { state: "none", info: null };
    }

    const info: Record<string, unknown> = {
      cols: session.cols,
      rows: session.rows,
      started_at: session.startedAt?.toISOString(),
      last_activity_at: session.lastActivityAt?.toISOString(),
      output_log_bytes: session.outputLogBytes
    };

    return { state: session.state, info };
  }

  async fetchMetrics(sessionId: string): Promise<{
    sessionId: string;
    state: string;
    totalInputBytes: number;
    totalOutputBytes: number;
    storedOutputBytes: number;
    uptime: number | null;
    idleSeconds: number | null;
  }> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: eq(terminalSessionTable.sessionId, sessionId)
    });

    if (!row) {
      return {
        sessionId,
        state: "none",
        totalInputBytes: 0,
        totalOutputBytes: 0,
        storedOutputBytes: 0,
        uptime: null,
        idleSeconds: null
      };
    }

    const now = Date.now();
    const uptime = row.startedAt ? Math.floor((now - row.startedAt.getTime()) / 1000) : null;
    const idleSeconds = row.lastActivityAt
      ? Math.floor((now - row.lastActivityAt.getTime()) / 1000)
      : null;

    return {
      sessionId,
      state: row.state,
      totalInputBytes: row.totalInputBytes ?? 0,
      totalOutputBytes: row.totalOutputBytes ?? 0,
      storedOutputBytes: row.outputLogBytes ?? 0,
      uptime,
      idleSeconds
    };
  }

  async fetchAggregateMetrics(): Promise<{
    totalSessions: number;
    byState: Record<string, number>;
    totalInputBytes: number;
    totalOutputBytes: number;
  }> {
    const all = await db.query.terminalSessionTable.findMany({
      columns: {
        state: true,
        totalInputBytes: true,
        totalOutputBytes: true
      }
    });

    const byState: Record<string, number> = {};
    let totalInputBytes = 0;
    let totalOutputBytes = 0;

    for (const row of all) {
      byState[row.state] = (byState[row.state] ?? 0) + 1;
      totalInputBytes += row.totalInputBytes ?? 0;
      totalOutputBytes += row.totalOutputBytes ?? 0;
    }

    return {
      totalSessions: all.length,
      byState,
      totalInputBytes,
      totalOutputBytes
    };
  }

  startIdleChecks(): void {
    this.idleMonitor.start();
  }

  stopIdleChecks(): void {
    this.idleMonitor.stop();
  }

  async clearCachesForBud(budId: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId);
    this.runtimeState.clearSessionCaches(sessionIds);
    this.outputStore.clearSessionCaches(sessionIds);

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Cleared terminal caches for bud"
    );
  }

  async suspendSessionsForBud(budId: string): Promise<void> {
    await this.sessionStore.suspendSessionsForBud(budId);
  }

  async clearEventBuffersForBud(budId: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId, { activeOnly: true });
    for (const sessionId of sessionIds) {
      this.events.clearBuffer(sessionId);
    }

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Cleared event buffers for bud sessions"
    );
  }

  async emitBudOfflineForSessions(budId: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId, { activeOnly: true });
    for (const sessionId of sessionIds) {
      this.events.emit(sessionId, {
        event: "terminal.bud_offline",
        data: { bud_id: budId, reason: "disconnected" },
        id: ulid()
      });
    }

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Emitted bud_offline events for sessions"
    );
  }

  async emitBudOnlineForSessions(budId: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId, { activeOnly: true });
    for (const sessionId of sessionIds) {
      this.events.emit(sessionId, {
        event: "terminal.bud_online",
        data: { bud_id: budId },
        id: ulid()
      });
    }

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Emitted bud_online events for sessions"
    );
  }

  clearPendingCommand(sessionId: string): void {
    this.runtimeState.clearPendingCommand(sessionId);
  }

  async rejectPendingRequestsForThread(threadId: string, errorMessage: string): Promise<number> {
    const session = await this.sessionStore.getSessionForThread(threadId);
    if (!session) {
      return 0;
    }
    return this.requestDispatcher.rejectPendingRequestsForSession(session.sessionId, errorMessage);
  }

  async rejectPendingRequestsForBud(budId: string, errorMessage: string): Promise<number> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId, { activeOnly: true });
    return this.requestDispatcher.rejectPendingRequestsForSessions(sessionIds, errorMessage);
  }

  private parseCommandFromInput(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) {
      return null;
    }
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) {
      return null;
    }
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }

  private async recordInput(
    sessionId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; userId?: string }
  ) {
    try {
      await db.insert(terminalSessionInputLogTable).values({
        sessionId,
        data,
        source: options.source ?? "agent",
        userId: options.userId
      });
    } catch (err) {
      this.logger.warn({ sessionId, err }, "Failed to record terminal input");
    }
  }

  private async bumpInputStats(sessionId: string, deltaBytes: number) {
    try {
      await db
        .update(terminalSessionTable)
        .set({
          totalInputBytes: sql`total_input_bytes + ${deltaBytes}`,
          lastInputAt: new Date(),
          lastActivityAt: new Date()
        })
        .where(eq(terminalSessionTable.sessionId, sessionId));
    } catch (err) {
      this.logger.warn({ sessionId, err }, "Failed to update terminal input stats");
    }
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    this.logger.info({ ...meta, component: "terminal_session_manager" }, message);
  }
}
