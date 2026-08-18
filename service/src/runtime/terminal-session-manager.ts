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
import type {
  DaemonTransportRouter,
  DaemonTransportStatus,
} from "../transport/daemon-router.js";
import { daemonTransportRouter } from "../transport/composite-daemon-router.js";
import { TerminalEventBus } from "./event-bus.js";
import { TerminalIdleMonitor } from "./terminal/idle-monitor.js";
import { summarizeObservedOutput } from "./terminal/logging.js";
import {
  TerminalRequestDispatcher,
  type ObserveOptions,
  type ObserveResponsePayload,
  type ObserveResult,
  type SendInteraction,
  type SendResult,
  type SendResultPayload,
} from "./terminal/request-dispatcher.js";
import {
  TerminalOutputStore,
  type OutputRangeReadResult,
  type OutputTailReadResult,
} from "./terminal/output-store.js";
import {
  TerminalCommandStore,
  type TerminalCommandRecord,
} from "./terminal/terminal-command-store.js";
import { TerminalRuntimeState, type TerminalRuntimeContext } from "./terminal/runtime-state.js";
import { TerminalSessionStore } from "./terminal/session-store.js";
import type { SessionState, TerminalSession } from "./terminal/session-types.js";

type TerminalStatusPayload = {
  state: string;
  info?: {
    pid?: number;
    cwd?: string;
    cols?: number;
    rows?: number;
    ring_next_offset?: number;
    mode?: string;
    integration?: string;
  };
};

type TerminalOutputPayload = {
  data: string;
  byte_offset: number;
};

type TerminalEventPayload = {
  event: string;
  data: Record<string, unknown>;
  ts: number;
};

/** `terminal_grid` frame minus its envelope/session_id (forwarded verbatim). */
type TerminalGridPayload = Record<string, unknown>;

export type TerminalPathContext = {
  schema: "terminal_cwd_v1";
  source: "terminal_runtime_cache";
  reported_by: "prompt_ready_osc7";
  terminal_session_id: string;
  host_cwd: string;
  captured_at: string;
};

export type TerminalCommandOutput = {
  command: TerminalCommandRecord;
  /** Lossy UTF-8 decode of the command's output byte range. */
  output: string;
  /** Number of bytes represented by `output` (before UTF-8 decoding). */
  outputBytes: number;
  /** True when the caller's maxBytes cap trimmed the range (head-trimmed; tail kept). */
  truncated: boolean;
};

export type { SessionState, TerminalSession } from "./terminal/session-types.js";
export type { TerminalRuntimeContext } from "./terminal/runtime-state.js";
export type { TerminalCommandRecord } from "./terminal/terminal-command-store.js";
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
  private readonly commandStore: TerminalCommandStore;
  private readonly requestDispatcher: TerminalRequestDispatcher;
  private readonly idleMonitor: TerminalIdleMonitor;
  private readonly daemonTransport: DaemonTransportRouter;

  /**
   * Per-session ingest serialization. Gateways dispatch daemon frames
   * concurrently (`void handleIncoming` per socket message), so without this
   * queue, back-to-back terminal_output frames can finish their async DB work
   * out of order and emit SSE out of BYTE order — the browser then renders a
   * byte-perfect stored stream in the wrong order (live-only corruption found
   * in the 2026-08-17 §A validation run: zsh PROMPT_SP `%` artifacts).
   * Storage is offset-keyed and order-insensitive; SSE emission is not.
   * terminal_event frames are chained behind outputs on the same session so
   * event byte references never outrun emitted output (proto §6.4 rule).
   */
  private readonly sessionIngestQueues = new Map<string, Promise<void>>();

  /**
   * Grid-sync viewer refcounts per session (proto §6.8). Grid frames cost
   * WAN bandwidth, so the daemon only emits them while watched: the first
   * viewer sends `terminal_grid_watch enabled:true`, the last one leaving
   * sends `enabled:false`. Watch state dies with the daemon's attachment, so
   * every `ready` status while viewers exist re-arms it (idempotent; the
   * re-arm's fresh full frame is exactly what a client needs after an
   * ensure/resize anyway).
   */
  private readonly gridViewerCounts = new Map<string, number>();

  constructor(
    logger: FastifyBaseLogger,
    events: TerminalEventBus,
    daemonTransport: DaemonTransportRouter = daemonTransportRouter,
  ) {
    this.logger = logger;
    this.events = events;
    this.daemonTransport = daemonTransport;
    this.sessionStore = new TerminalSessionStore(logger, daemonTransport);
    this.runtimeState = new TerminalRuntimeState(logger);
    this.outputStore = new TerminalOutputStore(logger, events);
    this.commandStore = new TerminalCommandStore(logger);
    this.requestDispatcher = new TerminalRequestDispatcher({
      logger,
      getSession: (sessionId) => this.sessionStore.getSession(sessionId),
      getLastOffset: (sessionId) => this.outputStore.getLastOffset(sessionId),
      sendFrameToBud: (budId, payload) => this.daemonTransport.sendFrameToBud(budId, payload),
      summarizeObservedOutput,
    });
    this.idleMonitor = new TerminalIdleMonitor({
      logger,
      store: this.sessionStore,
      closeSession: (sessionId, reason) => this.closeSession(sessionId, reason),
    });
  }

  isBudOnline(budId: string): boolean {
    return this.daemonTransport.isBudOnline(budId);
  }

  getBudTransportStatus(budId: string): DaemonTransportStatus {
    return this.daemonTransport.getTransportStatus(budId);
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

  async getPathContextForSession(sessionId: string): Promise<TerminalPathContext | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session?.cwd) {
      return null;
    }

    return buildTerminalPathContext(session);
  }

  async getPathContextForThread(threadId: string): Promise<TerminalPathContext | null> {
    const session = await this.sessionStore.getSessionForThread(threadId);
    if (!session?.cwd) {
      return null;
    }

    return buildTerminalPathContext(session);
  }

  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; created?: boolean; error?: string }> {
    // resume_from_offset = highest durably stored end offset; the daemon
    // backfills ring-buffered output from exactly this offset (§6.7.2).
    const resumeFromOffset = await this.outputStore.getStoredEndOffset(sessionId);
    return this.sessionStore.ensureSession(sessionId, { resumeFromOffset });
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
    this.daemonTransport.sendFrameToBud(session.budId, payload);

    await this.markSessionClosedLocally(sessionId, reason);
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

    const source = options.source ?? "agent";
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      data: data.toString("base64")
    };

    const sent = this.daemonTransport.sendFrameToBud(session.budId, payload);
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

    const sent = this.daemonTransport.sendFrameToBud(session.budId, payload);
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

  private enqueueSessionIngest<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.sessionIngestQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.sessionIngestQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionIngestQueues.get(sessionId) === tail) {
        this.sessionIngestQueues.delete(sessionId);
      }
    });
    return run;
  }

  async handleTerminalStatus(budId: string, sessionId: string, payload: TerminalStatusPayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleTerminalStatusInner(budId, sessionId, payload));
  }

  private async handleTerminalStatusInner(budId: string, sessionId: string, payload: TerminalStatusPayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_status");
    if (!session) {
      return;
    }

    await this.sessionStore.updateStatus(sessionId, payload);
    this.runtimeState.applyStatusInfo(sessionId, payload.info);
    this.debug("terminal_status processed", { sessionId, state: payload.state });
    this.events.emit(sessionId, {
      event: "terminal.status",
      data: {
        state: payload.state,
        info: payload.info ?? {}
      }
    });

    // A fresh daemon attachment (ensure/reconnect/resize) reports `ready` and
    // has no watch state — re-arm while grid viewers exist.
    if (payload.state === "ready" && this.hasGridViewers(sessionId)) {
      await this.sendGridWatch(sessionId, true);
    }
  }

  async handleTerminalGrid(budId: string, sessionId: string, payload: TerminalGridPayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleTerminalGridInner(budId, sessionId, payload));
  }

  private async handleTerminalGridInner(budId: string, sessionId: string, payload: TerminalGridPayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_grid");
    if (!session) {
      return;
    }
    // Live-only forwarding, no storage: grid state is reconstructible (any
    // reconnecting grid viewer re-arms the watch and receives a full frame),
    // and buffering these would evict output events from the replay buffer.
    this.events.emit(
      sessionId,
      {
        event: "terminal.grid",
        data: { session_id: sessionId, ...payload }
      },
      { buffer: false }
    );
  }

  hasGridViewers(sessionId: string): boolean {
    return (this.gridViewerCounts.get(sessionId) ?? 0) > 0;
  }

  async addGridViewer(sessionId: string): Promise<void> {
    const next = (this.gridViewerCounts.get(sessionId) ?? 0) + 1;
    this.gridViewerCounts.set(sessionId, next);
    // EVERY viewer join re-arms (not just 0→1): a viewer joining an
    // already-watched session has no state, and the daemon cannot target one
    // SSE connection — the re-arm's fresh full frame seeds the newcomer and
    // is an idempotent no-op for existing viewers (found live in the browser
    // E2E: a second concurrent viewer could never seed and reconnect-looped).
    await this.sendGridWatch(sessionId, true);
  }

  async removeGridViewer(sessionId: string): Promise<void> {
    const current = this.gridViewerCounts.get(sessionId) ?? 0;
    if (current <= 1) {
      this.gridViewerCounts.delete(sessionId);
      if (current === 1) {
        await this.sendGridWatch(sessionId, false);
      }
      return;
    }
    this.gridViewerCounts.set(sessionId, current - 1);
  }

  private async sendGridWatch(sessionId: string, enabled: boolean): Promise<boolean> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      return false;
    }
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_grid_watch",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      enabled
    };
    const sent = this.daemonTransport.sendFrameToBud(session.budId, payload);
    if (!sent && enabled) {
      // Bud offline: the eventual reconnect's `ready` status re-arms.
      this.debug("terminal_grid_watch not delivered (bud offline)", { sessionId });
    }
    return sent;
  }

  async handleTerminalOutput(budId: string, sessionId: string, payload: TerminalOutputPayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleTerminalOutputInner(budId, sessionId, payload));
  }

  private async handleTerminalOutputInner(budId: string, sessionId: string, payload: TerminalOutputPayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_output");
    if (!session) {
      return;
    }

    await this.outputStore.handleTerminalOutput(sessionId, payload, {
      onOutputObserved: ({ sessionId: currentSessionId, requestOffset, endOffset, outputBytes }) => {
        this.requestDispatcher.noteOutputObserved(currentSessionId, {
          requestOffset,
          endOffset,
          outputBytes
        });
      }
    });
  }

  async handleTerminalEvent(budId: string, sessionId: string, payload: TerminalEventPayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleTerminalEventInner(budId, sessionId, payload));
  }

  private async handleTerminalEventInner(budId: string, sessionId: string, payload: TerminalEventPayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_event");
    if (!session) {
      return;
    }

    const data = payload.data ?? {};
    switch (payload.event) {
      case "prompt_ready": {
        if (typeof data.cwd === "string" && data.cwd.trim().length > 0) {
          this.runtimeState.applyCwd(sessionId, data.cwd);
          try {
            await this.sessionStore.updateCwd(sessionId, data.cwd);
          } catch (err) {
            this.logger.warn({ err, sessionId }, "Failed to persist prompt_ready cwd");
          }
        }
        break;
      }
      case "mode_changed":
        this.runtimeState.applyModeChange(sessionId, data.mode, data.integration);
        break;
      case "command_started":
        if (typeof data.command_id === "string") {
          await this.commandStore.recordCommandStarted(session, {
            commandId: data.command_id,
            outputByteStart: asNonNegativeInteger(data.output_byte_start) ?? 0,
            ts: payload.ts
          });
        }
        break;
      case "command_finished":
        if (typeof data.command_id === "string") {
          await this.commandStore.recordCommandFinished(session, {
            commandId: data.command_id,
            exitCode: asInteger(data.exit_code),
            durationMs: asNonNegativeInteger(data.duration_ms),
            outputByteStart: asNonNegativeInteger(data.output_byte_start),
            outputByteEnd: asNonNegativeInteger(data.output_byte_end),
            ts: payload.ts
          });
        }
        break;
      case "output_gap":
        this.logger.warn(
          {
            sessionId,
            fromOffset: data.from_offset ?? null,
            resumeOffset: data.resume_offset ?? null,
            component: "terminal_session_manager"
          },
          "Terminal output gap reported (daemon ring truncated)"
        );
        break;
      case "settled":
        break;
      case "child_exited":
        // Session lifecycle: the root process exited, so the session is over.
        await this.markSessionClosedLocally(sessionId, "child_exited");
        break;
      default:
        // Unknown terminal_event values are ignored (additive evolution) but
        // still forwarded to the browser stream below.
        break;
    }

    // Forward every terminal_event to the thread's terminal SSE verbatim
    // (§6.7.7). Non-output events carry no SSE id so Last-Event-ID stays an
    // output byte offset.
    this.events.emit(sessionId, {
      event: "terminal.event",
      data: {
        session_id: sessionId,
        event: payload.event,
        data,
        ts: payload.ts
      }
    });
  }

  async handleObserveResult(budId: string, sessionId: string, payload: ObserveResponsePayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleObserveResultInner(budId, sessionId, payload));
  }

  private async handleObserveResultInner(budId: string, sessionId: string, payload: ObserveResponsePayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_observe_result");
    if (!session) {
      return;
    }
    if (payload.mode || payload.integration) {
      this.runtimeState.applyModeChange(sessionId, payload.mode, payload.integration);
    }
    await this.requestDispatcher.handleObserveResult(sessionId, payload);
  }

  async handleSendResult(budId: string, sessionId: string, payload: SendResultPayload): Promise<void> {
    return this.enqueueSessionIngest(sessionId, () => this.handleSendResultInner(budId, sessionId, payload));
  }

  private async handleSendResultInner(budId: string, sessionId: string, payload: SendResultPayload): Promise<void> {
    const session = await this.resolveOwnedSession(budId, sessionId, "terminal_send_result");
    if (!session) {
      return;
    }
    await this.requestDispatcher.handleSendResult(sessionId, payload);
  }

  getSessionContext(sessionId: string): TerminalRuntimeContext {
    return this.runtimeState.getSessionContext(sessionId);
  }

  getLastOffset(sessionId: string): number {
    return this.outputStore.getLastOffset(sessionId);
  }

  async tailOutput(sessionId: string, maxBytes: number): Promise<OutputTailReadResult> {
    return this.outputStore.tailOutput(sessionId, maxBytes);
  }

  async readOutputRange(
    sessionId: string,
    options: { startOffset: number; endOffset?: number; maxBytes: number },
  ): Promise<OutputRangeReadResult> {
    return this.outputStore.readRange(sessionId, options);
  }

  async getStoredOutputBytes(sessionId: string): Promise<number> {
    return this.outputStore.getStoredOutputBytes(sessionId);
  }

  /**
   * Internal API for the agent tool layer (terminal.run): fetch a persisted
   * command row and slice its output text from the durable output store by
   * byte range. UTF-8 decoding is lossy at slice edges; `maxBytes` caps the
   * returned slice, keeping the TAIL of the range (the most recent output).
   */
  async getCommandOutput(
    commandId: string,
    options: { maxBytes?: number } = {},
  ): Promise<TerminalCommandOutput | null> {
    const command = await this.commandStore.getCommand(commandId);
    if (!command) {
      return null;
    }

    const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 64 * 1024));
    const rangeEnd =
      command.outputByteEnd ?? (await this.outputStore.getStoredEndOffset(command.terminalSessionId));
    const rangeStart = Math.min(command.outputByteStart, rangeEnd);
    const cappedStart = Math.max(rangeStart, rangeEnd - maxBytes);
    const truncatedByCap = cappedStart > rangeStart;

    const read = await this.outputStore.readRange(command.terminalSessionId, {
      startOffset: cappedStart,
      endOffset: rangeEnd,
      maxBytes
    });

    return {
      command,
      output: read.data.toString("utf-8"),
      outputBytes: read.data.length,
      truncated: truncatedByCap || read.truncated
    };
  }

  /**
   * Most recent `terminal_command` row for a session (by started_at, command_id
   * tie-break). Used by the agent tool layer so a still-running `terminal.run`
   * can report the actual command_id it dispatched.
   */
  async getLatestCommandForSession(sessionId: string): Promise<TerminalCommandRecord | null> {
    return this.commandStore.getLatestCommandForSession(sessionId);
  }

  async observeTerminal(
    sessionId: string,
    options: ObserveOptions = {},
    timeoutMs = 30000
  ): Promise<ObserveResult> {
    return this.requestDispatcher.observeTerminal(sessionId, options, timeoutMs);
  }

  async sendInteraction(
    sessionId: string,
    interaction: SendInteraction,
    options: {
      timeoutMs?: number;
      rejectPendingRequestsWith?: string;
      onPendingRequestsRejected?: (count: number) => void;
    } = {}
  ): Promise<SendResult> {
    return this.requestDispatcher.sendInteraction(sessionId, interaction, options);
  }

  async interruptThreadTerminal(threadId: string): Promise<{
    ok: boolean;
    sessionId?: string;
    dispatched?: boolean;
    rejectedPendingRequests?: number;
    error?: string;
  }> {
    const session = await this.sessionStore.getSessionForThread(threadId);
    if (!session) {
      return { ok: false, error: "no_terminal_session" };
    }

    let rejectedPendingRequests = 0;

    try {
      const result = await this.requestDispatcher.sendInteraction(
        session.sessionId,
        { key: "ctrl+c" },
        {
          rejectPendingRequestsWith: "interrupted",
          onPendingRequestsRejected: (count) => {
            rejectedPendingRequests = count;
          },
        },
      );

      this.logger.info(
        {
          threadId,
          sessionId: session.sessionId,
          dispatched: result.dispatched,
          rejectedPendingRequests,
          component: "terminal_session_manager",
        },
        "Terminal interrupt sent",
      );

      return {
        ok: true,
        sessionId: session.sessionId,
        dispatched: result.dispatched,
        rejectedPendingRequests,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "terminal_interrupt_failed";
      this.logger.warn(
        {
          threadId,
          sessionId: session.sessionId,
          error,
          rejectedPendingRequests,
          component: "terminal_session_manager",
        },
        "Terminal interrupt failed",
      );
      return {
        ok: false,
        sessionId: session.sessionId,
        rejectedPendingRequests,
        error,
      };
    }
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
      // Presence transitions are live signals, never history: a replayed
      // stale offline/online pair makes clients treat an old transition as
      // fresh and reconnect — which loops forever on connections that never
      // resume by offset (found live in the grid-renderer browser E2E).
      this.events.emit(
        sessionId,
        {
          event: "terminal.bud_offline",
          data: { bud_id: budId, reason: "disconnected" }
        },
        { buffer: false }
      );
    }

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Emitted bud_offline events for sessions"
    );
  }

  async emitBudOnlineForSessions(budId: string): Promise<void> {
    const sessionIds = await this.sessionStore.listSessionIdsForBud(budId, { activeOnly: true });
    for (const sessionId of sessionIds) {
      // Live-only, like bud_offline above (never replay stale presence).
      this.events.emit(
        sessionId,
        {
          event: "terminal.bud_online",
          data: { bud_id: budId }
        },
        { buffer: false }
      );
    }

    this.logger.info(
      { budId, sessionCount: sessionIds.length, component: "terminal_session_manager" },
      "Emitted bud_online events for sessions"
    );
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

  /**
   * S-C1 ownership guard: every inbound terminal frame handler resolves the
   * session and asserts it belongs to the authenticated daemon connection
   * before any write, emit, or pending-request resolution. Mismatches are
   * logged and the frame is dropped.
   */
  private async resolveOwnedSession(
    budId: string,
    sessionId: string,
    frameType: string,
  ): Promise<TerminalSession | null> {
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      this.logger.warn(
        { sessionId, budId, frameType, component: "terminal_session_manager" },
        "Dropping terminal frame for unknown session"
      );
      return null;
    }
    if (session.budId !== budId) {
      this.logger.warn(
        {
          sessionId,
          frameBudId: budId,
          sessionBudId: session.budId,
          frameType,
          component: "terminal_session_manager"
        },
        "Dropping terminal frame from bud that does not own the session"
      );
      return null;
    }
    return session;
  }

  private async markSessionClosedLocally(sessionId: string, reason: string): Promise<void> {
    await this.sessionStore.markClosed(sessionId);
    this.runtimeState.clearSessionCache(sessionId);
    this.outputStore.clearSessionCache(sessionId);
    this.requestDispatcher.rejectPendingRequestsForSession(sessionId, "session_closed");

    this.events.emit(sessionId, {
      event: "terminal.status",
      data: { state: "closed", reason }
    });

    this.logger.info({ sessionId, reason }, "Session closed");
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

function buildTerminalPathContext(session: TerminalSession): TerminalPathContext {
  return {
    schema: "terminal_cwd_v1",
    source: "terminal_runtime_cache",
    reported_by: "prompt_ready_osc7",
    terminal_session_id: session.sessionId,
    host_cwd: session.cwd ?? "",
    captured_at: (session.lastActivityAt ?? session.startedAt ?? session.createdAt).toISOString(),
  };
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const parsed = asInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
