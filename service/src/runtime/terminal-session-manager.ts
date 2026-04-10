import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { eq, and, isNull, desc, asc, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  terminalSessionTable,
  terminalSessionOutputTable,
  terminalSessionInputLogTable
} from "../db/schema.js";
import { config, TERMINAL_PROTO_VERSION } from "../config.js";
import { sendFrameToBud, isBudOnline } from "../ws/gateway.js";
import type {
  PendingCommand,
  TerminalContext,
  ReadinessAssessment,
  TerminalDelta,
  TerminalDeltaMessage,
  TerminalWaitFor,
  TerminalObservationView,
} from "../terminal/types.js";
import { TerminalEventBus } from "./event-bus.js";
import { isKnownReplProgram, getProgramInfo } from "../terminal/known-programs.js";

// =============================================================================
// TerminalSessionManager
// =============================================================================
//
// Manages thread-scoped terminal sessions. Each thread gets its own tmux session
// identified by `sessionId`. This replaces the bud-scoped TerminalManager.
//
// Key differences from TerminalManager:
// - Keyed by sessionId (not budId)
// - Sessions are created via createSessionForThread(threadId, budId)
// - Looked up via getSessionForThread(threadId)
// - All operations use sessionId
// =============================================================================

// Session state machine: pending -> creating -> ready <-> active <-> idle -> closed
export type SessionState = "pending" | "creating" | "ready" | "active" | "idle" | "closed";

export interface TerminalSession {
  sessionId: string;
  threadId: string | null;
  budId: string;
  instanceId: string | null;
  tmuxSessionName: string | null;
  state: SessionState;
  cols: number;
  rows: number;
  createdAt: Date;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  outputLogBytes: number;
}

type TerminalStatusPayload = {
  state: string;
  info?: {
    tmux_session?: string;
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

export type ObserveOptions = {
  lines?: number;
  waitFor?: TerminalWaitFor;
  view?: TerminalObservationView;
};

type CapturePaneOptions = {
  startLine?: number;
  endLine?: number;
  escapeSequences?: boolean;
  joinLines?: boolean;
};

export type ObserveResult = {
  view: TerminalObservationView;
  output: string;
  outputBytes: number;
  linesCaptured: number;
  changed?: boolean;
  truncated?: boolean;
  readiness: ReadinessAssessment;
  error?: string;
};

type ObserveResponsePayload = {
  requestId: string;
  view: TerminalObservationView;
  output: string;
  outputBytes: number;
  linesCaptured: number;
  changed?: boolean | null;
  truncated?: boolean | null;
  readiness: ReadinessAssessment;
  error: string | null;
};

type ObserveDebugState = {
  sessionId: string;
  requestId: string;
  view: TerminalObservationView;
  waitFor: TerminalWaitFor;
  lines: number;
  timeoutMs: number;
  localTimeoutMs: number;
  startedAt: number;
  deadlineAt: number;
  context: TerminalContext;
  readinessAtDispatch: ReadinessAssessment | null;
  startOffset: number;
  latestOffset: number;
  outputSeen: boolean;
  outputEventCount: number;
  timedOutAt?: number;
};

export type ExecResult = {
  output: string;
  outputBytes: number;
  truncated: boolean;
  readiness: ReadinessAssessment;
  error?: string;
};

type ExecResultPayload = {
  requestId: string;
  output: string;
  outputBytes: number;
  truncated: boolean;
  readiness: ReadinessAssessment;
  error: string | null;
};

export type SendInteraction = {
  text?: string;
  submit?: boolean;
  keys?: string[];
  observeAfterMs?: number;
  waitFor?: TerminalWaitFor;
};

export type SendResult = {
  submitted: boolean;
  delta?: TerminalDelta | null;
  readiness: ReadinessAssessment;
  error?: string;
};

type SendResultPayload = {
  requestId: string;
  submitted: boolean;
  delta?: TerminalDeltaMessage | null;
  readiness: ReadinessAssessment;
  error: string | null;
};

// Timeout for clearing stale pending commands (30 minutes)
const STALE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export class TerminalSessionManager {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;

  // In-memory state (keyed by sessionId)
  private readonly readiness = new Map<string, { assessment: ReadinessAssessment; updatedAt: number }>();
  private readonly lastOffsets = new Map<string, number>();
  private readonly pendingCommands = new Map<string, PendingCommand | null>();
  private readonly pendingObserves = new Map<
    string,
    {
      resolve: (result: ObserveResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
      state: ObserveDebugState;
    }
  >();
  private readonly pendingExecs = new Map<
    string,
    {
      resolve: (result: ExecResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingSends = new Map<
    string,
    {
      resolve: (result: SendResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly recentObserveStates = new Map<string, ObserveDebugState>();

  constructor(logger: FastifyBaseLogger, events: TerminalEventBus) {
    this.logger = logger;
    this.events = events;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new session for a thread. Returns existing session if one exists.
   */
  async createSessionForThread(
    threadId: string,
    budId: string,
    createdByUserId?: string | null,
  ): Promise<string> {
    // Check if thread already has an active session
    const existing = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, threadId),
        isNull(terminalSessionTable.closedAt)
      )
    });

    if (existing) {
      this.logger.info({ threadId, sessionId: existing.sessionId }, "Session already exists for thread");
      return existing.sessionId;
    }

    // Create new session
    const sessionId = `sess_${ulid()}`;
    const tmuxSessionName = this.tmuxSessionName(sessionId);

    await db.insert(terminalSessionTable).values({
      sessionId,
      threadId,
      budId,
      instanceId: null,
      tmuxSessionName,
      state: "pending",
      createdByUserId: createdByUserId ?? undefined,
    });

    this.logger.info({ threadId, sessionId, budId }, "Created new session for thread");
    return sessionId;
  }

  /**
   * Get the active session for a thread.
   */
  async getSessionForThread(threadId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, threadId),
        isNull(terminalSessionTable.closedAt)
      )
    });

    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Get a session by ID.
   */
  async getSession(sessionId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: eq(terminalSessionTable.sessionId, sessionId)
    });
    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * Ensure a session is running on its Bud instance.
   * Sends terminal_ensure to Bud if not already connected.
   */
  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; created?: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, resumed: false, error: "session_not_found" };
    }

    if (session.state === "closed") {
      return { ok: false, resumed: false, error: "session_closed" };
    }

    // If already ready/active/idle, verify bud is actually online before returning success
    if (session.state === "ready" || session.state === "active" || session.state === "idle") {
      if (!isBudOnline(session.budId)) {
        this.logger.warn({ sessionId, budId: session.budId, state: session.state }, "Session state is ready but bud is offline");
        return { ok: false, resumed: false, error: "bud_offline" };
      }
      return { ok: true, resumed: true };
    }

    // Send terminal_ensure to Bud
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_ensure",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      config: {
        cols: session.cols,
        rows: session.rows
      }
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      this.logger.warn({ sessionId, budId: session.budId }, "Failed to send terminal_ensure (bud offline)");
      return { ok: false, resumed: false, error: "bud_offline" };
    }

    // Update state to creating
    await db
      .update(terminalSessionTable)
      .set({ state: "creating", lastActivityAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    this.logger.info({ sessionId, budId: session.budId }, "terminal_ensure sent");
    return { ok: true, resumed: false, created: true };
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string, reason = "requested"): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    // Send close to Bud
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

    // Update DB
    await db
      .update(terminalSessionTable)
      .set({ state: "closed", closedAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    // Clear in-memory state
    this.clearSessionCache(sessionId);

    // Emit event
    this.events.emit(sessionId, {
      event: "terminal.status",
      data: { state: "closed", reason },
      id: ulid()
    });

    this.logger.info({ sessionId, reason }, "Session closed");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal Operations
  // ─────────────────────────────────────────────────────────────────────────

  async sendInput(
    sessionId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; runId?: string; userId?: string } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const inputStr = data.toString("utf-8");
    const source = options.source ?? "agent";

    // Track command if we're in shell mode and input contains a newline
    if (!this.pendingCommands.get(sessionId) && inputStr.includes("\n")) {
      const command = this.parseCommandFromInput(inputStr);
      if (command && isKnownReplProgram(command)) {
        this.pendingCommands.set(sessionId, {
          input: inputStr,
          command,
          sentAt: Date.now(),
          source
        });
        this.debug("tracking pending command", { sessionId, command, source });
      }
    }

    // Determine detection mode based on terminal context
    const context = this.getSessionContext(sessionId);
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

  async sendInterrupt(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "session_not_found" };
    }

    const context = this.getSessionContext(sessionId);
    const useActivityBased = context.mode === "repl";

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_interrupt",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      await_ready: {
        enabled: true,
        activity_based: useActivityBased,
        ...(useActivityBased
          ? {
              activity_interval_ms: 5000,
              activity_stable_count: 2,
              max_wait_ms: 60000
            }
          : {
              max_wait_ms: 5000
            })
      }
    };

    this.debug("sendInterrupt with readiness config", {
      sessionId,
      mode: context.mode,
      program: context.program,
      useActivityBased
    });

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      this.logger.warn({ sessionId }, "Failed to send terminal_interrupt (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    // Clear pending command - interrupt usually exits REPLs
    const pending = this.pendingCommands.get(sessionId);
    if (pending) {
      this.debug("clearing pending command due to interrupt", { sessionId, command: pending.command });
      this.pendingCommands.set(sessionId, null);
    }

    return { ok: true };
  }

  async sendResize(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers (called by Gateway)
  // ─────────────────────────────────────────────────────────────────────────

  async handleTerminalStatus(sessionId: string, payload: TerminalStatusPayload): Promise<void> {
    const now = new Date();

    await db
      .update(terminalSessionTable)
      .set({
        state: payload.state,
        tmuxSessionName: payload.info?.tmux_session ?? undefined,
        cols: payload.info?.cols ?? undefined,
        rows: payload.info?.rows ?? undefined,
        startedAt: payload.info?.started_at ? new Date(payload.info.started_at) : undefined,
        lastActivityAt: payload.info?.last_activity_at ? new Date(payload.info.last_activity_at) : now,
        outputLogBytes: payload.info?.output_log_bytes ?? undefined
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));

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
    const buffer = Buffer.from(payload.data, "base64");

    // Track byte offset SYNCHRONOUSLY before any async work
    const endOffset = payload.byte_offset + buffer.length;
    this.lastOffsets.set(sessionId, endOffset);

    const observeRequestsSeeingOutput: string[] = [];
    for (const pending of this.pendingObserves.values()) {
      if (pending.state.sessionId !== sessionId) {
        continue;
      }
      pending.state.outputSeen = true;
      pending.state.outputEventCount += 1;
      pending.state.latestOffset = Math.max(pending.state.latestOffset, endOffset);
      observeRequestsSeeingOutput.push(pending.state.requestId);
    }
    if (observeRequestsSeeingOutput.length > 0) {
      this.debug("terminal output arrived while observe was pending", {
        sessionId,
        requestIds: observeRequestsSeeingOutput,
        byteOffset: payload.byte_offset,
        endOffset,
        outputBytes: buffer.length
      });
    }

    const now = new Date();
    const session = await this.getSession(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, "terminal_output for unknown session");
      return;
    }

    const currentLogBytes = session.outputLogBytes ?? 0;
    const remaining = Math.max(config.terminalOutputSoftCapBytes - currentLogBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);

    if (toStore.length > 0) {
      await db
        .insert(terminalSessionOutputTable)
        .values({
          sessionId,
          seq: payload.seq,
          data: toStore,
          byteOffset: payload.byte_offset
        })
        .onConflictDoNothing({
          target: [terminalSessionOutputTable.sessionId, terminalSessionOutputTable.byteOffset]
        });
      this.logger.info(
        {
          sessionId,
          seq: payload.seq,
          byteOffset: payload.byte_offset,
          endOffset,
          storedBytes: toStore.length,
          component: "terminal_session_manager"
        },
        "terminal_output stored in DB"
      );
    }

    await db
      .update(terminalSessionTable)
      .set({
        totalOutputBytes: sql`total_output_bytes + ${buffer.length}`,
        outputLogBytes: sql`LEAST(${config.terminalOutputSoftCapBytes}, output_log_bytes + ${toStore.length})`,
        lastOutputAt: now,
        lastActivityAt: now
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    if (toStore.length < buffer.length) {
      this.logger.warn(
        { sessionId, seq: payload.seq, stored: toStore.length, dropped: buffer.length - toStore.length },
        "terminal output truncated at soft cap"
      );
    }

    this.events.emit(sessionId, {
      event: "terminal.output",
      data: {
        seq: payload.seq,
        data: payload.data,
        byte_offset: payload.byte_offset
      },
      id: ulid()
    });
  }

  async handleTerminalReady(sessionId: string, assessment: ReadinessAssessment): Promise<void> {
    this.storeReadinessAssessment(sessionId, assessment);

    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment },
      id: ulid()
    });
  }

  handleObserveResult(sessionId: string, payload: ObserveResponsePayload): void {
    const pending = this.pendingObserves.get(payload.requestId);
    const observeState = this.recentObserveStates.get(payload.requestId) ?? pending?.state;

    const buffer = Buffer.from(payload.output, "base64");
    const output = buffer.toString("utf-8");
    const outputSummary = this.summarizeObservedOutput(output);
    const latencyMs = observeState ? Date.now() - observeState.startedAt : undefined;

    if (!pending) {
      if (observeState?.timedOutAt) {
        this.logger.warn(
        {
          sessionId,
          requestId: payload.requestId,
          waitFor: observeState.waitFor,
          timeoutMs: observeState.timeoutMs,
          localTimeoutMs: observeState.localTimeoutMs,
          latencyMs,
          lateByMs: Date.now() - observeState.timedOutAt,
            outputBytes: payload.outputBytes,
            linesCaptured: payload.linesCaptured,
            readiness: payload.readiness,
            outputSummary,
            component: "terminal_session_manager"
          },
          "Observe result arrived after local timeout"
        );
        this.recentObserveStates.delete(payload.requestId);
        return;
      }
      this.logger.warn(
        {
          sessionId,
          requestId: payload.requestId,
          outputBytes: payload.outputBytes,
          linesCaptured: payload.linesCaptured,
          readiness: payload.readiness,
          outputSummary,
          component: "terminal_session_manager"
        },
        "Orphaned observe result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingObserves.delete(payload.requestId);
    this.recentObserveStates.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    this.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        view: payload.view,
        waitFor: observeState?.waitFor,
        timeoutMs: observeState?.timeoutMs,
        localTimeoutMs: observeState?.localTimeoutMs,
        latencyMs,
        outputBytes: payload.outputBytes,
        linesCaptured: payload.linesCaptured,
        outputSeenDuringWait: observeState?.outputSeen ?? false,
        outputEventCount: observeState?.outputEventCount ?? 0,
        outputOffsetDelta: observeState
          ? Math.max(observeState.latestOffset - observeState.startOffset, 0)
          : 0,
        readiness: payload.readiness,
        outputSummary,
        component: "terminal_session_manager"
      },
      "Observe result received"
    );

    this.storeReadinessAssessment(sessionId, payload.readiness);
    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment: payload.readiness },
      id: ulid()
    });

    pending.resolve({
      view: payload.view,
      output,
      outputBytes: payload.outputBytes,
      linesCaptured: payload.linesCaptured,
      changed: typeof payload.changed === "boolean" ? payload.changed : undefined,
      truncated: typeof payload.truncated === "boolean" ? payload.truncated : undefined,
      readiness: payload.readiness,
    });
  }

  handleExecResult(sessionId: string, payload: ExecResultPayload): void {
    const pending = this.pendingExecs.get(payload.requestId);
    if (!pending) {
      this.logger.warn(
        { sessionId, requestId: payload.requestId, component: "terminal_session_manager" },
        "Orphaned exec result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingExecs.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    // Decode base64 output
    const buffer = Buffer.from(payload.output, "base64");
    const output = buffer.toString("utf-8");

    this.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        outputBytes: payload.outputBytes,
        truncated: payload.truncated,
        readiness: payload.readiness,
        component: "terminal_session_manager"
      },
      "Exec result received"
    );

    this.storeReadinessAssessment(sessionId, payload.readiness);
    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment: payload.readiness },
      id: ulid()
    });

    pending.resolve({
      output,
      outputBytes: payload.outputBytes,
      truncated: payload.truncated,
      readiness: payload.readiness
    });
  }

  handleSendResult(sessionId: string, payload: SendResultPayload): void {
    const pending = this.pendingSends.get(payload.requestId);
    if (!pending) {
      this.logger.warn(
        { sessionId, requestId: payload.requestId, component: "terminal_session_manager" },
        "Orphaned send result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingSends.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    this.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        submitted: payload.submitted,
        delta: payload.delta
          ? {
              changed: payload.delta.changed,
              textBytes: Buffer.byteLength(payload.delta.text, "utf-8"),
              truncated: payload.delta.truncated,
              summary: this.summarizeObservedOutput(payload.delta.text),
            }
          : null,
        readiness: payload.readiness,
        component: "terminal_session_manager"
      },
      "Send result received"
    );

    this.storeReadinessAssessment(sessionId, payload.readiness);
    this.events.emit(sessionId, {
      event: "terminal.ready",
      data: { assessment: payload.readiness },
      id: ulid()
    });

    pending.resolve({
      submitted: payload.submitted,
      delta: payload.delta
        ? {
            changed: payload.delta.changed,
            text: payload.delta.text,
            truncated: payload.delta.truncated,
          }
        : null,
      readiness: payload.readiness
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context & Readiness
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the current terminal context (shell vs REPL).
   */
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

  /**
   * Get the last known byte offset for a session's output.
   */
  getLastOffset(sessionId: string): number {
    return this.lastOffsets.get(sessionId) ?? 0;
  }

  getLatestReadiness(sessionId: string): ReadinessAssessment | null {
    return this.readiness.get(sessionId)?.assessment ?? null;
  }

  async waitForReadiness(sessionId: string, timeoutMs = 5000): Promise<ReadinessAssessment | null> {
    const start = Date.now();
    const initialUpdated = this.readiness.get(sessionId)?.updatedAt ?? 0;

    while (Date.now() - start < timeoutMs) {
      const latest = this.readiness.get(sessionId);
      if (latest && latest.updatedAt > initialUpdated) {
        return latest.assessment;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this.readiness.get(sessionId)?.assessment ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Output Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get terminal output, optionally filtering to only output after a specific byte offset.
   */
  async tailOutput(
    sessionId: string,
    maxBytes: number,
    options?: { sinceOffset?: number }
  ): Promise<{ data: Buffer; totalBytes: number }> {
    const currentInMemoryOffset = this.lastOffsets.get(sessionId) ?? 0;
    this.logger.info(
      {
        sessionId,
        maxBytes,
        sinceOffset: options?.sinceOffset,
        currentInMemoryOffset,
        component: "terminal_session_manager"
      },
      "tailOutput called"
    );

    // When sinceOffset is provided, query chronologically for output after that offset
    if (options?.sinceOffset !== undefined) {
      const rows = await db
        .select({
          data: terminalSessionOutputTable.data,
          byteOffset: terminalSessionOutputTable.byteOffset
        })
        .from(terminalSessionOutputTable)
        .where(
          and(
            eq(terminalSessionOutputTable.sessionId, sessionId),
            gte(terminalSessionOutputTable.byteOffset, options.sinceOffset)
          )
        )
        .orderBy(asc(terminalSessionOutputTable.byteOffset))
        .limit(200);

      this.logger.info(
        {
          sessionId,
          sinceOffset: options.sinceOffset,
          rowCount: rows.length,
          firstRowOffset: rows[0]?.byteOffset ?? null,
          lastRowOffset: rows[rows.length - 1]?.byteOffset ?? null,
          component: "terminal_session_manager"
        },
        "tailOutput sinceOffset query result"
      );

      if (rows.length === 0) {
        return { data: Buffer.alloc(0), totalBytes: 0 };
      }

      const buffers: Buffer[] = [];
      for (const row of rows) {
        let buf = Buffer.from(row.data);

        // If first chunk starts before sinceOffset, trim the beginning
        if (row.byteOffset < options.sinceOffset) {
          const skip = options.sinceOffset - row.byteOffset;
          buf = buf.subarray(skip);
        }

        buffers.push(buf);
      }

      const combined = Buffer.concat(buffers);
      const result =
        combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;

      return { data: result, totalBytes: combined.length };
    }

    // Default behavior: get last N bytes (for observe/backfill)
    const rows = await db
      .select({
        data: terminalSessionOutputTable.data,
        byteOffset: terminalSessionOutputTable.byteOffset
      })
      .from(terminalSessionOutputTable)
      .where(eq(terminalSessionOutputTable.sessionId, sessionId))
      .orderBy(desc(terminalSessionOutputTable.byteOffset))
      .limit(200);

    if (rows.length === 0) {
      return { data: Buffer.alloc(0), totalBytes: 0 };
    }

    let remaining = Math.max(maxBytes, 0);
    const buffers: Buffer[] = [];
    for (const row of rows) {
      if (remaining <= 0) break;
      const buf = Buffer.from(row.data);
      if (buf.length > remaining) {
        buffers.push(buf.subarray(buf.length - remaining));
        remaining = 0;
      } else {
        buffers.push(buf);
        remaining -= buf.length;
      }
    }
    buffers.reverse();
    const combined = Buffer.concat(buffers);
    const totalBytes = rows.reduce((acc, row) => acc + Buffer.from(row.data).length, 0);
    return { data: combined, totalBytes };
  }

  async observeTerminal(
    sessionId: string,
    options: ObserveOptions = {},
    timeoutMs = 5000
  ): Promise<ObserveResult> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `obs_${ulid()}`;
    const view = options.view ?? "delta";
    const waitFor = options.waitFor ?? "none";
    const lines = options.lines ?? -50;
    const localGraceMs = 1000;
    const localTimeoutMs = timeoutMs + localGraceMs;
    const startedAt = Date.now();
    const deadlineAt = startedAt + localTimeoutMs;
    const context = this.getSessionContext(sessionId);
    const readinessAtDispatch = this.getLatestReadiness(sessionId);
    const startOffset = this.getLastOffset(sessionId);
    const observeState: ObserveDebugState = {
      sessionId,
      requestId,
      view,
      waitFor,
      lines,
      timeoutMs,
      localTimeoutMs,
      startedAt,
      deadlineAt,
      context,
      readinessAtDispatch,
      startOffset,
      latestOffset: startOffset,
      outputSeen: false,
      outputEventCount: 0
    };

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_observe",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      view,
      lines,
      wait_for: waitFor,
      timeout_ms: timeoutMs,
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.pruneRecentObserveStates(startedAt);
    this.recentObserveStates.set(requestId, observeState);

    this.logger.info(
      {
        sessionId,
        requestId,
        view,
        waitFor,
        lines,
        timeoutMs,
        localTimeoutMs,
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(deadlineAt).toISOString(),
        context: this.summarizeContextForLog(context),
        readinessAtDispatch,
        startOffset,
        component: "terminal_session_manager"
      },
      "Sending terminal_observe request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingObserves.get(requestId);
        if (!pending) {
          return;
        }
        const timedOutAt = Date.now();
        pending.state.timedOutAt = timedOutAt;
        pending.state.latestOffset = this.getLastOffset(sessionId);
        this.pendingObserves.delete(requestId);
        this.logger.warn(
          {
            sessionId,
            requestId,
            waitFor: pending.state.waitFor,
            timeoutMs: pending.state.timeoutMs,
            localTimeoutMs: pending.state.localTimeoutMs,
            ageMs: timedOutAt - pending.state.startedAt,
            deadlineAt: new Date(pending.state.deadlineAt).toISOString(),
            contextAtDispatch: this.summarizeContextForLog(pending.state.context),
            contextNow: this.summarizeContextForLog(this.getSessionContext(sessionId)),
            readinessAtDispatch: pending.state.readinessAtDispatch,
            readinessNow: this.getLatestReadiness(sessionId),
            startOffset: pending.state.startOffset,
            latestOffset: pending.state.latestOffset,
            outputSeen: pending.state.outputSeen,
            outputEventCount: pending.state.outputEventCount,
            offsetDelta: Math.max(pending.state.latestOffset - pending.state.startOffset, 0),
            component: "terminal_session_manager"
          },
          "terminal_observe timed out locally"
        );
        reject(new Error("observe_timeout"));
      }, localTimeoutMs);

      this.pendingObserves.set(requestId, { resolve, reject, timeout, state: observeState });
    });
  }

  async capturePane(
    sessionId: string,
    options: CapturePaneOptions = {},
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

  async execCommand(
    sessionId: string,
    command: string,
    options: {
      timeoutMs?: number;
    } = {}
  ): Promise<ExecResult> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `exec_${ulid()}`;
    const timeoutMs = options.timeoutMs ?? 30000;

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_exec",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      command,
      timeout_ms: timeoutMs
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.logger.info(
      { sessionId, requestId, commandLength: command.length, component: "terminal_session_manager" },
      "Sending terminal_exec request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingExecs.delete(requestId);
        reject(new Error("exec_timeout"));
      }, timeoutMs + 10000);

      this.pendingExecs.set(requestId, { resolve, reject, timeout });
    });
  }

  async sendInteraction(
    sessionId: string,
    interaction: SendInteraction,
    options: {
      timeoutMs?: number;
    } = {}
  ): Promise<SendResult> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `send_${ulid()}`;
    const timeoutMs = options.timeoutMs ?? 5000;
    const waitFor = interaction.waitFor ?? "none";
    const observeAfterMs = interaction.observeAfterMs ?? 1000;

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_send",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      text: interaction.text ?? null,
      submit: interaction.submit === true,
      keys: interaction.keys ?? [],
      observe_after_ms: observeAfterMs,
      wait_for: waitFor,
      timeout_ms: timeoutMs,
    };

    const sent = sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.logger.info(
      {
        sessionId,
        requestId,
        hasText: Boolean(interaction.text),
        submit: interaction.submit === true,
        keyCount: interaction.keys?.length ?? 0,
        observeAfterMs,
        waitFor,
        component: "terminal_session_manager"
      },
      "Sending terminal_send request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(requestId);
        reject(new Error("send_timeout"));
      }, timeoutMs + 1000);

      this.pendingSends.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * Set pending command tracking for a session.
   * Called by AgentService when launching known REPL programs.
   */
  setPendingCommand(sessionId: string, command: PendingCommand): void {
    this.pendingCommands.set(sessionId, command);
    this.debug("tracking pending command", {
      sessionId,
      command: command.command,
      source: command.source
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status & Metrics
  // ─────────────────────────────────────────────────────────────────────────

  async fetchStatus(sessionId: string): Promise<{
    state: SessionState | "none";
    info: Record<string, unknown> | null;
  }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { state: "none", info: null };
    }

    const info: Record<string, unknown> = {
      tmux_session: session.tmuxSessionName,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Idle Management
  // ─────────────────────────────────────────────────────────────────────────

  private idleCheckInterval: NodeJS.Timeout | null = null;

  startIdleChecks(): void {
    if (this.idleCheckInterval) {
      return;
    }
    const intervalMs = config.terminalIdleCheckIntervalMinutes * 60 * 1000;
    this.logger.info(
      { intervalMinutes: config.terminalIdleCheckIntervalMinutes, component: "terminal_session_manager" },
      "Starting terminal idle check job"
    );
    this.idleCheckInterval = setInterval(() => {
      this.runIdleCheck().catch((err) => {
        this.logger.error({ err, component: "terminal_session_manager" }, "Idle check failed");
      });
    }, intervalMs);
    // Run immediately on startup
    this.runIdleCheck().catch((err) => {
      this.logger.error({ err, component: "terminal_session_manager" }, "Initial idle check failed");
    });
  }

  stopIdleChecks(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
      this.logger.info({ component: "terminal_session_manager" }, "Stopped terminal idle check job");
    }
  }

  private async runIdleCheck(): Promise<void> {
    const now = new Date();
    const idleThreshold = new Date(now.getTime() - config.terminalIdleTimeoutMinutes * 60 * 1000);

    const markedIdle = await this.markIdleSessions(idleThreshold);
    const closed =
      config.terminalIdleCleanupHours > 0
        ? await this.closeStaleIdleSessions(
            new Date(now.getTime() - config.terminalIdleCleanupHours * 60 * 60 * 1000)
          )
        : 0;

    if (markedIdle > 0 || closed > 0) {
      this.logger.info(
        { markedIdle, closed, component: "terminal_session_manager" },
        "Idle check completed"
      );
    }
  }

  private async markIdleSessions(threshold: Date): Promise<number> {
    const result = await db
      .update(terminalSessionTable)
      .set({ state: "idle" })
      .where(
        and(
          inArray(terminalSessionTable.state, ["ready", "active"]),
          lt(terminalSessionTable.lastActivityAt, threshold)
        )
      );
    return result.rowCount ?? 0;
  }

  private async closeStaleIdleSessions(threshold: Date): Promise<number> {
    const staleSessions = await db.query.terminalSessionTable.findMany({
      where: and(
        eq(terminalSessionTable.state, "idle"),
        lt(terminalSessionTable.lastActivityAt, threshold)
      ),
      columns: { sessionId: true }
    });

    let closed = 0;
    for (const session of staleSessions) {
      await this.closeSession(session.sessionId, "idle_cleanup");
      closed++;
    }
    return closed;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private rowToSession(row: {
    sessionId: string;
    threadId: string | null;
    budId: string;
    instanceId: string | null;
    tmuxSessionName: string | null;
    state: string;
    cols: number;
    rows: number;
    createdAt: Date;
    startedAt: Date | null;
    lastActivityAt: Date | null;
    outputLogBytes: number;
  }): TerminalSession {
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      budId: row.budId,
      instanceId: row.instanceId,
      tmuxSessionName: row.tmuxSessionName,
      state: row.state as SessionState,
      cols: row.cols,
      rows: row.rows,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      outputLogBytes: row.outputLogBytes
    };
  }

  private tmuxSessionName(sessionId: string): string {
    const suffix = sessionId.replace("sess_", "");
    const name = `s_${suffix}`;
    return name.length > 32 ? name.slice(0, 32) : name;
  }

  private clearSessionCache(sessionId: string): void {
    this.readiness.delete(sessionId);
    this.lastOffsets.delete(sessionId);
    this.pendingCommands.delete(sessionId);
  }

  /**
   * Clear all in-memory caches for sessions belonging to a specific bud.
   * Called when a bud disconnects to avoid stale data on reconnect.
   */
  async clearCachesForBud(budId: string): Promise<void> {
    // Find all sessions for this bud
    const sessions = await db.query.terminalSessionTable.findMany({
      where: eq(terminalSessionTable.budId, budId),
      columns: { sessionId: true }
    });

    for (const session of sessions) {
      this.clearSessionCache(session.sessionId);
    }

    this.logger.info(
      { budId, sessionCount: sessions.length, component: "terminal_session_manager" },
      "Cleared terminal caches for bud"
    );
  }

  /**
   * Suspend all active sessions for a bud when it disconnects.
   * This prevents ensureSession from short-circuiting on stale "ready" state.
   */
  async suspendSessionsForBud(budId: string): Promise<void> {
    const result = await db
      .update(terminalSessionTable)
      .set({ state: "pending" })  // Reset to pending so ensureSession will try to reconnect
      .where(
        and(
          eq(terminalSessionTable.budId, budId),
          inArray(terminalSessionTable.state, ["ready", "active", "idle", "creating"]),
          isNull(terminalSessionTable.closedAt)
        )
      );

    this.logger.info(
      { budId, updatedCount: result.rowCount, component: "terminal_session_manager" },
      "Suspended terminal sessions for offline bud"
    );
  }

  /**
   * Clear event buffers for all sessions belonging to a bud.
   * Called when a bud disconnects to prevent stale events from being replayed.
   */
  async clearEventBuffersForBud(budId: string): Promise<void> {
    const sessions = await db.query.terminalSessionTable.findMany({
      where: and(
        eq(terminalSessionTable.budId, budId),
        isNull(terminalSessionTable.closedAt)
      ),
      columns: { sessionId: true }
    });

    for (const session of sessions) {
      this.events.clearBuffer(session.sessionId);
    }

    this.logger.info(
      { budId, sessionCount: sessions.length, component: "terminal_session_manager" },
      "Cleared event buffers for bud sessions"
    );
  }

  /**
   * Emit bud_offline event for all active sessions belonging to a bud.
   * Called when a bud WebSocket disconnects.
   */
  async emitBudOfflineForSessions(budId: string): Promise<void> {
    // Find all non-closed sessions for this bud
    const sessions = await db.query.terminalSessionTable.findMany({
      where: and(
        eq(terminalSessionTable.budId, budId),
        isNull(terminalSessionTable.closedAt)
      ),
      columns: { sessionId: true }
    });

    for (const session of sessions) {
      this.events.emit(session.sessionId, {
        event: "terminal.bud_offline",
        data: { bud_id: budId, reason: "disconnected" },
        id: ulid()
      });
    }

    this.logger.info(
      { budId, sessionCount: sessions.length, component: "terminal_session_manager" },
      "Emitted bud_offline events for sessions"
    );
  }

  /**
   * Emit bud_online event for all active sessions belonging to a bud.
   * Called when a bud WebSocket connects/reconnects.
   */
  async emitBudOnlineForSessions(budId: string): Promise<void> {
    // Find all non-closed sessions for this bud
    const sessions = await db.query.terminalSessionTable.findMany({
      where: and(
        eq(terminalSessionTable.budId, budId),
        isNull(terminalSessionTable.closedAt)
      ),
      columns: { sessionId: true }
    });

    for (const session of sessions) {
      this.events.emit(session.sessionId, {
        event: "terminal.bud_online",
        data: { bud_id: budId },
        id: ulid()
      });
    }

    this.logger.info(
      { budId, sessionCount: sessions.length, component: "terminal_session_manager" },
      "Emitted bud_online events for sessions"
    );
  }

  private cleanupStaleCommand(sessionId: string): void {
    const pending = this.pendingCommands.get(sessionId);
    if (pending && Date.now() - pending.sentAt > STALE_COMMAND_TIMEOUT_MS) {
      this.logger.warn(
        { sessionId, command: pending.command, component: "terminal_session_manager" },
        "Clearing stale pending command"
      );
      this.pendingCommands.set(sessionId, null);
    }
  }

  /**
   * Clear pending command tracking for a session.
   * Called by ContextSyncService when detecting shell mode after REPL exit.
   */
  clearPendingCommand(sessionId: string): void {
    const pending = this.pendingCommands.get(sessionId);
    if (pending) {
      this.debug("clearing pending command via context sync", {
        sessionId,
        command: pending.command
      });
      this.pendingCommands.set(sessionId, null);
    }
  }

  private parseCommandFromInput(input: string): string | null {
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) return null;
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) return null;
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }

  private storeReadinessAssessment(sessionId: string, assessment: ReadinessAssessment): void {
    this.readiness.set(sessionId, { assessment, updatedAt: Date.now() });

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
  }

  private async recordInput(
    sessionId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; runId?: string; userId?: string }
  ) {
    try {
      await db.insert(terminalSessionInputLogTable).values({
        sessionId,
        data,
        source: options.source ?? "agent",
        runId: options.runId,
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
    if (!config.agentDebug) {
      return;
    }
    this.logger.info({ ...meta, component: "terminal_session_manager" }, message);
  }

  private pruneRecentObserveStates(now = Date.now()): void {
    const retentionMs = 5 * 60 * 1000;
    for (const [requestId, state] of this.recentObserveStates.entries()) {
      const referenceTime = state.timedOutAt ?? state.startedAt;
      if (!this.pendingObserves.has(requestId) && now - referenceTime > retentionMs) {
        this.recentObserveStates.delete(requestId);
      }
    }
  }

  private summarizeContextForLog(context: TerminalContext): Record<string, unknown> {
    return {
      mode: context.mode,
      program: context.program ?? null,
      programDisplayName: context.programDisplayName ?? null,
      interactionStyle: context.interactionStyle ?? null,
      pendingCommand: context.pendingCommand?.command ?? null,
      pendingSource: context.pendingCommand?.source ?? null
    };
  }

  private summarizeObservedOutput(output: string): Record<string, unknown> {
    const lines = output.length === 0 ? [] : output.split(/\r?\n/);
    let lastNonEmptyLine = "";
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] && lines[index].trim().length > 0) {
        lastNonEmptyLine = lines[index];
        break;
      }
    }
    if (!lastNonEmptyLine && lines.length > 0) {
      lastNonEmptyLine = lines[lines.length - 1] ?? "";
    }
    const summary: Record<string, unknown> = {
      screenHash: createHash("sha256").update(output).digest("hex").slice(0, 16),
      lineCount: lines.length,
      lastNonEmptyLine: this.truncateForLog(lastNonEmptyLine)
    };

    if (config.agentDebug) {
      summary.firstLines = lines.slice(0, 2).map((line) => this.truncateForLog(line));
      summary.lastLines = lines.slice(-2).map((line) => this.truncateForLog(line));
    }

    return summary;
  }

  private truncateForLog(value: string, maxLength = 160): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 3)}...`;
  }
}
