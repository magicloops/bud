import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { eq, desc, and, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  budTerminalTable,
  terminalInputLogTable,
  terminalOutputTable
} from "../db/schema.js";
import { config, TERMINAL_PROTO_VERSION } from "../config.js";
import { sendFrameToBud } from "../ws/gateway.js";
import type { TerminalState } from "../terminal/types.js";
import { TerminalEventBus } from "./event-bus.js";

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

export class TerminalManager {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;
  private readonly readiness = new Map<string, { assessment: unknown; updatedAt: number }>();

  // Trivial touch to trigger service reload during debugging.
  constructor(logger: FastifyBaseLogger, events: TerminalEventBus) {
    this.logger = logger;
    this.events = events;
    logger.debug({ component: "terminal_manager" }, "TerminalManager initialized (reload touch v3)");
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
    this.logger.info(
      { budId, bytes: data.length, source: options.source ?? "unknown", component: "terminal_manager" },
      "terminal input dispatch requested"
    );
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
    this.logger.info(
      { budId, bytes: data.length, message_id: payload.id, component: "terminal_manager" },
      "terminal input forwarded to bud"
    );

    await this.recordInput(budId, data, options);
    await this.bumpInputStats(budId, data.length);
    this.debug("terminal_input forwarded", {
      budId,
      bytes: data.length,
      source: options.source ?? "agent"
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
    this.logger.info(
      {
        budId,
        seq: payload.seq,
        bytes: buffer.length,
        byte_offset: payload.byte_offset,
        component: "terminal_manager"
      },
      "terminal_output received from bud"
    );
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
          target: [terminalOutputTable.budId, terminalOutputTable.seq]
        });
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

    this.logger.info(
      {
        budId,
        seq: payload.seq,
        stored_bytes: toStore.length,
        emitted: true,
        component: "terminal_manager"
      },
      "terminal_output stored and emitting"
    );
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

  async tailOutput(budId: string, maxBytes: number): Promise<{ data: Buffer; totalBytes: number }> {
    const rows = await db
      .select({
        seq: terminalOutputTable.seq,
        data: terminalOutputTable.data
      })
      .from(terminalOutputTable)
      .where(eq(terminalOutputTable.budId, budId))
      .orderBy(desc(terminalOutputTable.seq))
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

    // Clear cached readiness
    this.readiness.delete(budId);

    return { ok: true };
  }
}
