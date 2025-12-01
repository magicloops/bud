import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { eq, desc } from "drizzle-orm";
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
}
