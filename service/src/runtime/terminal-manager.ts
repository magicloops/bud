import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { eq, desc, asc, gte, and, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  budTerminalTable,
  terminalInputLogTable,
  terminalOutputTable
} from "../db/schema.js";
import { config, TERMINAL_PROTO_VERSION } from "../config.js";
import { sendFrameToBud } from "../ws/gateway.js";
import type { TerminalState, PendingCommand, TerminalContext, ReadinessAssessment } from "../terminal/types.js";
import { TerminalEventBus } from "./event-bus.js";
import { isKnownReplProgram, getProgramInfo } from "../terminal/known-programs.js";

// =============================================================================
// TODO: Terminal Output Storage Architecture
// =============================================================================
//
// CURRENT STATE (TEMPORARY):
// Terminal output is stored in PostgreSQL (terminal_output table) as a series
// of chunks with sequence numbers and byte offsets. This works but has issues:
//
// 1. RACE CONDITION: Output chunks are inserted async, but readiness signals
//    are processed sync. The agent may read from DB before output is written.
//    We work around this by tracking byte offsets in memory (lastOffsets map)
//    and querying "sinceOffset" to get only new output.
//
// 2. DUPLICATE STORAGE: Bud already writes output to a local file via tmux
//    pipe-pane. We're duplicating that data into the DB just to read it back.
//
// 3. SCALE: PostgreSQL isn't ideal for high-volume binary log data.
//
// FUTURE STATE (S3 STREAMING):
// - Bud streams output directly to S3 (or local file in dev)
// - Service stores only metadata (S3 key, byte offsets) in DB
// - Agent reads output from S3/file, not from DB
// - Eliminates race condition (file is always current)
// - Eliminates duplicate storage
// - Scales naturally with S3
//
// See: plan/fix-agent-terminal-output-race.md for full design discussion.
// =============================================================================

type TerminalEnsureConfig = {
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
};

type TerminalStatusPayload = {
  state: TerminalState | "none" | string;
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

// Timeout for clearing stale pending commands (30 minutes)
const STALE_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

export class TerminalManager {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;
  private readonly readiness = new Map<string, { assessment: unknown; updatedAt: number }>();
  // Track last known byte offset per terminal (see TODO comment at top of file)
  private readonly lastOffsets = new Map<string, number>();
  // Track pending commands per terminal for context awareness
  private readonly pendingCommands = new Map<string, PendingCommand | null>();

  constructor(logger: FastifyBaseLogger, events: TerminalEventBus) {
    this.logger = logger;
    this.events = events;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Stack Tracking (for REPL context awareness)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse the command name from raw terminal input.
   * Extracts the first word (command) from input like "claude\n" or "python3 script.py\n".
   */
  private parseCommandFromInput(input: string): string | null {
    // Remove trailing newlines and whitespace
    const trimmed = input.replace(/[\r\n]+$/, "").trim();
    if (!trimmed) return null;

    // Extract first word (the command)
    const firstWord = trimmed.split(/\s+/)[0];
    if (!firstWord) return null;

    // Handle common patterns:
    // - "claude" -> "claude"
    // - "./script.sh" -> "script.sh"
    // - "/usr/bin/python" -> "python"
    // - "python3 script.py" -> "python3"
    const basename = firstWord.split("/").pop() || firstWord;
    return basename.replace(/^\.\//, "");
  }

  /**
   * Get the current terminal context (shell vs REPL).
   * Used by the agent to understand how to interact with the terminal.
   */
  getTerminalContext(budId: string): TerminalContext {
    // Clean up stale commands first
    this.cleanupStaleCommand(budId);

    const pending = this.pendingCommands.get(budId);

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
   * Clean up commands that have been pending for too long.
   */
  private cleanupStaleCommand(budId: string): void {
    const pending = this.pendingCommands.get(budId);
    if (pending && Date.now() - pending.sentAt > STALE_COMMAND_TIMEOUT_MS) {
      this.logger.warn(
        { budId, command: pending.command, component: "terminal_manager" },
        "Clearing stale pending command"
      );
      this.pendingCommands.set(budId, null);
    }
  }

  /**
   * Get the last known byte offset for a terminal's output.
   * Used by the agent to capture position before sending input,
   * then request only output since that position after readiness.
   */
  getLastOffset(budId: string): number {
    return this.lastOffsets.get(budId) ?? 0;
  }

  /**
   * Clear cached state for a terminal (call on disconnect/close).
   */
  clearTerminalCache(budId: string): void {
    this.readiness.delete(budId);
    this.lastOffsets.delete(budId);
    this.pendingCommands.delete(budId);
  }

  async ensureTerminal(budId: string, configOverride?: TerminalEnsureConfig): Promise<{ ok: boolean; error?: string }> {
    const cols = configOverride?.cols ?? 200;
    const rows = configOverride?.rows ?? 50;
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_ensure",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      config: configOverride ?? {}
    };
    const sent = sendFrameToBud(budId, payload);
    if (!sent) {
      this.logger.warn({ budId }, "Failed to dispatch terminal_ensure (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    const now = new Date();
    await db
      .insert(budTerminalTable)
      .values({
        budId,
        state: "creating",
        cols,
        rows,
        startedAt: now,
        lastActivityAt: now
      })
      .onConflictDoUpdate({
        target: budTerminalTable.budId,
        set: {
          state: "creating",
          cols,
          rows,
          lastActivityAt: now
        }
      });

    this.debug("terminal_ensure dispatched", { budId, config: configOverride });
    return { ok: true };
  }

  async sendInput(
    budId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; runId?: string; userId?: string } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const inputStr = data.toString("utf-8");
    const source = options.source ?? "agent";

    // Track command if:
    // 1. We're currently in shell mode (no pending command)
    // 2. Input contains a newline (actually executing something)
    // 3. The command is a known REPL program
    if (!this.pendingCommands.get(budId) && inputStr.includes("\n")) {
      const command = this.parseCommandFromInput(inputStr);
      if (command && isKnownReplProgram(command)) {
        this.pendingCommands.set(budId, {
          input: inputStr,
          command,
          sentAt: Date.now(),
          source
        });
        this.debug("tracking pending command", { budId, command, source });
      }
    }

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_input",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      data: data.toString("base64"),
      await_ready: { enabled: true }
    };
    const sent = sendFrameToBud(budId, payload);
    if (!sent) {
      this.logger.warn({ budId }, "Failed to send terminal_input (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    await this.recordInput(budId, data, options);
    await this.bumpInputStats(budId, data.length);
    this.debug("terminal_input forwarded", {
      budId,
      bytes: data.length,
      source
    });
    return { ok: true };
  }

  async sendInterrupt(budId: string): Promise<{ ok: boolean; error?: string }> {
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_interrupt",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      await_ready: { enabled: true }
    };
    const sent = sendFrameToBud(budId, payload);
    if (!sent) {
      this.logger.warn({ budId }, "Failed to send terminal_interrupt (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    // Clear pending command - interrupt usually exits REPLs
    const pending = this.pendingCommands.get(budId);
    if (pending) {
      this.debug("clearing pending command due to interrupt", { budId, command: pending.command });
      this.pendingCommands.set(budId, null);
    }

    return { ok: true };
  }

  async sendResize(budId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> {
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_resize",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      cols,
      rows
    };
    const sent = sendFrameToBud(budId, payload);
    if (!sent) {
      this.logger.warn({ budId }, "Failed to send terminal_resize (bud offline)");
      return { ok: false, error: "bud_offline" };
    }

    await db
      .update(budTerminalTable)
      .set({ cols, rows, lastActivityAt: new Date() })
      .where(eq(budTerminalTable.budId, budId));

    this.debug("terminal_resize forwarded", { budId, cols, rows });
    return { ok: true };
  }

  async handleTerminalStatus(budId: string, payload: TerminalStatusPayload): Promise<void> {
    const now = new Date();
    await db
      .insert(budTerminalTable)
      .values({
        budId,
        state: payload.state,
        tmuxSessionName: payload.info?.tmux_session,
        pid: payload.info?.pid ?? null,
        shell: payload.info?.shell ?? null,
        cols: payload.info?.cols ?? undefined,
        rows: payload.info?.rows ?? undefined,
        startedAt: payload.info?.started_at ? new Date(payload.info.started_at) : undefined,
        lastActivityAt: payload.info?.last_activity_at ? new Date(payload.info.last_activity_at) : now,
        outputLogBytes: payload.info?.output_log_bytes ?? undefined
      })
      .onConflictDoUpdate({
        target: budTerminalTable.budId,
        set: {
          state: payload.state,
          tmuxSessionName: payload.info?.tmux_session ?? null,
          pid: payload.info?.pid ?? null,
          shell: payload.info?.shell ?? null,
          cols: payload.info?.cols ?? undefined,
          rows: payload.info?.rows ?? undefined,
          startedAt: payload.info?.started_at ? new Date(payload.info.started_at) : undefined,
          lastActivityAt: payload.info?.last_activity_at ? new Date(payload.info.last_activity_at) : now,
          outputLogBytes: payload.info?.output_log_bytes ?? undefined
        }
    });
    this.debug("terminal_status processed", { budId, state: payload.state });
    this.events.emit(budId, {
      event: "terminal.status",
      data: {
        state: payload.state,
        info: payload.info ?? {}
      },
      id: ulid()
    });
  }

  async handleTerminalOutput(budId: string, payload: TerminalOutputPayload): Promise<void> {
    const buffer = Buffer.from(payload.data, "base64");

    // Track byte offset SYNCHRONOUSLY before any async work.
    // This ensures the agent can read the correct offset even if DB inserts are slow.
    // See TODO comment at top of file for why this workaround exists.
    const endOffset = payload.byte_offset + buffer.length;
    this.lastOffsets.set(budId, endOffset);

    const now = new Date();
    const row = await db.query.budTerminalTable.findFirst({
      where: eq(budTerminalTable.budId, budId),
      columns: {
        outputLogBytes: budTerminalTable.outputLogBytes,
        totalOutputBytes: budTerminalTable.totalOutputBytes
      }
    });
    const currentLogBytes = row?.outputLogBytes ?? 0;
    const currentTotalBytes = row?.totalOutputBytes ?? 0;
    const remaining = Math.max(config.terminalOutputSoftCapBytes - currentLogBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
    if (toStore.length > 0) {
      await db
        .insert(terminalOutputTable)
        .values({
          budId,
          seq: payload.seq,
          data: toStore,
          byteOffset: payload.byte_offset
        })
        .onConflictDoNothing({
          // Use byte_offset for conflict detection, NOT seq.
          // seq resets to 0 when Bud reconnects, but byte_offset is monotonically increasing.
          target: [terminalOutputTable.budId, terminalOutputTable.byteOffset]
        });
      this.logger.info({
        budId,
        seq: payload.seq,
        byteOffset: payload.byte_offset,
        endOffset,
        storedBytes: toStore.length,
        component: "terminal_manager"
      }, "terminal_output stored in DB");
    }
    const newOutputBytes = currentTotalBytes + buffer.length;
    const newLogBytes = currentLogBytes + toStore.length;
    await db
      .update(budTerminalTable)
      .set({
        totalOutputBytes: newOutputBytes,
        outputLogBytes: Math.min(config.terminalOutputSoftCapBytes, newLogBytes),
        lastOutputAt: now,
        lastActivityAt: now
      })
      .where(eq(budTerminalTable.budId, budId));

    if (toStore.length < buffer.length) {
      this.logger.warn(
        { budId, seq: payload.seq, stored: toStore.length, dropped: buffer.length - toStore.length },
        "terminal output truncated at soft cap"
      );
    }

    this.events.emit(budId, {
      event: "terminal.output",
      data: {
        seq: payload.seq,
        data: payload.data,
        byte_offset: payload.byte_offset
      },
      id: ulid()
    });
  }

  async handleTerminalReady(budId: string, assessment: unknown): Promise<void> {
    this.readiness.set(budId, { assessment, updatedAt: Date.now() });

    // Clear pending command if we're back at a shell prompt
    const typed = assessment as ReadinessAssessment | undefined;
    if (
      typed?.prompt_type === "shell" &&
      typed.confidence >= 0.8 &&
      typed.hints?.looks_like_prompt
    ) {
      const pending = this.pendingCommands.get(budId);
      if (pending) {
        const durationMs = Date.now() - pending.sentAt;
        this.debug("clearing pending command - returned to shell", {
          budId,
          command: pending.command,
          durationMs
        });
        this.pendingCommands.set(budId, null);
      }
    }

    this.events.emit(budId, {
      event: "terminal.ready",
      data: { assessment },
      id: ulid()
    });
  }

  getLatestReadiness(budId: string): unknown | null {
    return this.readiness.get(budId)?.assessment ?? null;
  }

  async waitForReadiness(budId: string, timeoutMs = 5000): Promise<unknown | null> {
    const start = Date.now();
    const initialUpdated = this.readiness.get(budId)?.updatedAt ?? 0;
    while (Date.now() - start < timeoutMs) {
      const latest = this.readiness.get(budId);
      if (latest && latest.updatedAt > initialUpdated) {
        return latest.assessment;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.readiness.get(budId)?.assessment ?? null;
  }

  async fetchStatus(budId: string): Promise<{
    state: TerminalState | "none";
    info: Record<string, unknown> | null;
  }> {
    const row = await db.query.budTerminalTable.findFirst({
      where: eq(budTerminalTable.budId, budId)
    });
    if (!row) {
      return { state: "none", info: null };
    }
    const info: Record<string, unknown> = {
      tmux_session: row.tmuxSessionName,
      pid: row.pid,
      shell: row.shell,
      cols: row.cols,
      rows: row.rows,
      started_at: row.startedAt?.toISOString(),
      last_input_at: row.lastInputAt?.toISOString(),
      last_output_at: row.lastOutputAt?.toISOString(),
      last_activity_at: row.lastActivityAt?.toISOString(),
      output_log_bytes: row.outputLogBytes,
      total_input_bytes: row.totalInputBytes,
      total_output_bytes: row.totalOutputBytes,
      closed_at: row.closedAt?.toISOString()
    };
    return { state: (row.state as TerminalState) ?? "none", info };
  }

  /**
   * Get terminal output, optionally filtering to only output after a specific byte offset.
   *
   * @param budId - The bud/terminal ID
   * @param maxBytes - Maximum bytes to return
   * @param options.sinceOffset - If provided, only return output after this byte offset.
   *                              Used by the agent to get only output from its command.
   *                              See TODO comment at top of file for context.
   */
  async tailOutput(
    budId: string,
    maxBytes: number,
    options?: { sinceOffset?: number }
  ): Promise<{ data: Buffer; totalBytes: number }> {
    const currentInMemoryOffset = this.lastOffsets.get(budId) ?? 0;
    this.logger.info({
      budId,
      maxBytes,
      sinceOffset: options?.sinceOffset,
      currentInMemoryOffset,
      component: "terminal_manager"
    }, "tailOutput called");

    // When sinceOffset is provided, query chronologically for output after that offset
    if (options?.sinceOffset !== undefined) {
      const rows = await db
        .select({
          data: terminalOutputTable.data,
          byteOffset: terminalOutputTable.byteOffset
        })
        .from(terminalOutputTable)
        .where(
          and(
            eq(terminalOutputTable.budId, budId),
            gte(terminalOutputTable.byteOffset, options.sinceOffset)
          )
        )
        .orderBy(asc(terminalOutputTable.byteOffset))
        .limit(200);

      this.logger.info({
        budId,
        sinceOffset: options.sinceOffset,
        rowCount: rows.length,
        firstRowOffset: rows[0]?.byteOffset ?? null,
        lastRowOffset: rows[rows.length - 1]?.byteOffset ?? null,
        component: "terminal_manager"
      }, "tailOutput sinceOffset query result");

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
      // Apply maxBytes limit from the end if needed
      const result = combined.length > maxBytes
        ? combined.subarray(combined.length - maxBytes)
        : combined;

      return { data: result, totalBytes: combined.length };
    }

    // Default behavior: get last N bytes (for observe/backfill)
    // Order by byte_offset (NOT seq) because seq resets on Bud reconnection.
    // byte_offset is the file position and is monotonically increasing.
    const rows = await db
      .select({
        data: terminalOutputTable.data,
        byteOffset: terminalOutputTable.byteOffset
      })
      .from(terminalOutputTable)
      .where(eq(terminalOutputTable.budId, budId))
      .orderBy(desc(terminalOutputTable.byteOffset))
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

  private async recordInput(
    budId: string,
    data: Buffer,
    options: { source?: "agent" | "user" | "system"; runId?: string; userId?: string }
  ) {
    try {
      await db.insert(terminalInputLogTable).values({
        budId,
        data,
        source: options.source ?? "agent",
        runId: options.runId,
        userId: options.userId
      });
    } catch (err) {
      this.logger.warn({ budId, err }, "Failed to record terminal input");
    }
  }

  private async bumpInputStats(budId: string, deltaBytes: number) {
    try {
      const existing = await db.query.budTerminalTable.findFirst({
        where: eq(budTerminalTable.budId, budId),
        columns: { totalInputBytes: budTerminalTable.totalInputBytes }
      });
      const currentTotal = existing?.totalInputBytes ?? 0;
      await db
        .update(budTerminalTable)
        .set({
          totalInputBytes: currentTotal + deltaBytes,
          lastInputAt: new Date(),
          lastActivityAt: new Date()
        })
        .where(eq(budTerminalTable.budId, budId));
    } catch (err) {
      this.logger.warn({ budId, err }, "Failed to update terminal input stats");
    }
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    if (!config.agentDebug) {
      return;
    }
    this.logger.info({ ...meta, component: "terminal_manager" }, message);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch metrics for a specific terminal.
   */
  async fetchMetrics(budId: string): Promise<{
    budId: string;
    state: string;
    totalInputBytes: number;
    totalOutputBytes: number;
    storedOutputBytes: number;
    uptime: number | null;
    idleSeconds: number | null;
  }> {
    const row = await db.query.budTerminalTable.findFirst({
      where: eq(budTerminalTable.budId, budId)
    });
    if (!row) {
      return {
        budId,
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
      budId,
      state: row.state,
      totalInputBytes: row.totalInputBytes ?? 0,
      totalOutputBytes: row.totalOutputBytes ?? 0,
      storedOutputBytes: row.outputLogBytes ?? 0,
      uptime,
      idleSeconds
    };
  }

  /**
   * Fetch aggregate metrics across all terminals.
   */
  async fetchAggregateMetrics(): Promise<{
    totalTerminals: number;
    byState: Record<string, number>;
    totalInputBytes: number;
    totalOutputBytes: number;
  }> {
    const all = await db.query.budTerminalTable.findMany({
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
      totalTerminals: all.length,
      byState,
      totalInputBytes,
      totalOutputBytes
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Idle Management
  // ─────────────────────────────────────────────────────────────────────────

  private idleCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Start the periodic idle check job.
   * Call this once at service startup.
   */
  startIdleChecks(): void {
    if (this.idleCheckInterval) {
      return; // Already running
    }
    const intervalMs = config.terminalIdleCheckIntervalMinutes * 60 * 1000;
    this.logger.info(
      { intervalMinutes: config.terminalIdleCheckIntervalMinutes, component: "terminal_manager" },
      "Starting terminal idle check job"
    );
    this.idleCheckInterval = setInterval(() => {
      this.runIdleCheck().catch((err) => {
        this.logger.error({ err, component: "terminal_manager" }, "Idle check failed");
      });
    }, intervalMs);
    // Run immediately on startup
    this.runIdleCheck().catch((err) => {
      this.logger.error({ err, component: "terminal_manager" }, "Initial idle check failed");
    });
  }

  /**
   * Stop the idle check job.
   * Call this on graceful shutdown.
   */
  stopIdleChecks(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
      this.logger.info({ component: "terminal_manager" }, "Stopped terminal idle check job");
    }
  }

  /**
   * Run idle checks:
   * 1. Mark active terminals as idle if no activity for IDLE_TIMEOUT_MINUTES
   * 2. Close terminals that have been idle for IDLE_CLEANUP_HOURS
   */
  private async runIdleCheck(): Promise<void> {
    const now = new Date();
    const idleThreshold = new Date(now.getTime() - config.terminalIdleTimeoutMinutes * 60 * 1000);
    const cleanupThreshold = new Date(now.getTime() - config.terminalIdleCleanupHours * 60 * 60 * 1000);

    // Step 1: Mark active/ready terminals as idle if no recent activity
    const markedIdle = await this.markIdleTerminals(idleThreshold);

    // Step 2: Close terminals that have been idle too long
    const closed = await this.closeStaleIdleTerminals(cleanupThreshold);

    if (markedIdle > 0 || closed > 0) {
      this.logger.info(
        { markedIdle, closed, component: "terminal_manager" },
        "Idle check completed"
      );
    }
  }

  /**
   * Mark terminals as idle if their last activity is before the threshold.
   * Only affects terminals in 'ready' or 'active' state.
   */
  private async markIdleTerminals(threshold: Date): Promise<number> {
    const result = await db
      .update(budTerminalTable)
      .set({ state: "idle" })
      .where(
        and(
          inArray(budTerminalTable.state, ["ready", "active"]),
          lt(budTerminalTable.lastActivityAt, threshold)
        )
      );
    return result.rowCount ?? 0;
  }

  /**
   * Close terminals that have been idle for too long.
   * Sends terminal_close to Bud and updates DB state.
   */
  private async closeStaleIdleTerminals(threshold: Date): Promise<number> {
    const staleTerminals = await db.query.budTerminalTable.findMany({
      where: and(
        eq(budTerminalTable.state, "idle"),
        lt(budTerminalTable.lastActivityAt, threshold)
      ),
      columns: { budId: true }
    });

    let closed = 0;
    for (const terminal of staleTerminals) {
      await this.closeTerminal(terminal.budId, "idle_cleanup");
      closed++;
    }
    return closed;
  }

  /**
   * Close a terminal: send close frame to Bud and update DB state.
   */
  async closeTerminal(budId: string, reason: string = "requested"): Promise<{ ok: boolean; error?: string }> {
    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_close",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      reason
    };
    // Best-effort send to Bud (may be offline)
    sendFrameToBud(budId, payload);

    // Update DB state
    await db
      .update(budTerminalTable)
      .set({
        state: "closed",
        closedAt: new Date()
      })
      .where(eq(budTerminalTable.budId, budId));

    this.logger.info({ budId, reason, component: "terminal_manager" }, "Terminal closed");
    this.events.emit(budId, {
      event: "terminal.status",
      data: { state: "closed", reason },
      id: ulid()
    });

    // Clear all cached state for this terminal
    this.clearTerminalCache(budId);

    return { ok: true };
  }
}
