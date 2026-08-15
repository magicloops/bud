import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { terminalCommandTable } from "../../db/schema.js";
import type { TerminalSession } from "./session-types.js";

export type TerminalCommandRecord = {
  commandId: string;
  terminalSessionId: string;
  threadId: string | null;
  budId: string;
  createdByUserId: string | null;
  tenantId: string | null;
  commandStartedAt: Date;
  commandFinishedAt: Date | null;
  exitCode: number | null;
  outputByteStart: number;
  outputByteEnd: number | null;
};

export type CommandStartedEvent = {
  commandId: string;
  outputByteStart: number;
  /** Frame timestamp (ms epoch) — becomes command_started_at. */
  ts: number;
};

export type CommandFinishedEvent = {
  commandId: string;
  exitCode: number | null;
  durationMs: number | null;
  outputByteStart: number | null;
  outputByteEnd: number | null;
  /** Frame timestamp (ms epoch) — becomes command_finished_at. */
  ts: number;
};

/**
 * Thin persistence boundary for `terminal_command` rows so the ingest logic is
 * unit-testable in memory. The default implementation uses Drizzle.
 */
export interface TerminalCommandPersistence {
  /** Insert keyed on command_id; returns true when the row actually inserted. */
  insertCommand(row: TerminalCommandRecord): Promise<boolean>;
  /** Finalize an existing row; returns true when a row was updated. */
  finalizeCommand(
    commandId: string,
    args: {
      commandFinishedAt: Date;
      exitCode: number | null;
      outputByteEnd: number | null;
      outputByteStart: number | null;
    },
  ): Promise<boolean>;
  getCommand(commandId: string): Promise<TerminalCommandRecord | null>;
}

class DrizzleTerminalCommandPersistence implements TerminalCommandPersistence {
  async insertCommand(row: TerminalCommandRecord): Promise<boolean> {
    const inserted = await db
      .insert(terminalCommandTable)
      .values({
        commandId: row.commandId,
        terminalSessionId: row.terminalSessionId,
        threadId: row.threadId,
        budId: row.budId,
        createdByUserId: row.createdByUserId ?? undefined,
        tenantId: row.tenantId ?? undefined,
        commandStartedAt: row.commandStartedAt,
        commandFinishedAt: row.commandFinishedAt,
        exitCode: row.exitCode,
        outputByteStart: row.outputByteStart,
        outputByteEnd: row.outputByteEnd
      })
      .onConflictDoNothing({ target: terminalCommandTable.commandId })
      .returning({ commandId: terminalCommandTable.commandId });
    return inserted.length > 0;
  }

  async finalizeCommand(
    commandId: string,
    args: {
      commandFinishedAt: Date;
      exitCode: number | null;
      outputByteEnd: number | null;
      outputByteStart: number | null;
    },
  ): Promise<boolean> {
    const updated = await db
      .update(terminalCommandTable)
      .set({
        commandFinishedAt: args.commandFinishedAt,
        exitCode: args.exitCode,
        outputByteEnd: args.outputByteEnd,
        ...(args.outputByteStart !== null ? { outputByteStart: args.outputByteStart } : {})
      })
      .where(eq(terminalCommandTable.commandId, commandId))
      .returning({ commandId: terminalCommandTable.commandId });
    return updated.length > 0;
  }

  async getCommand(commandId: string): Promise<TerminalCommandRecord | null> {
    const row = await db.query.terminalCommandTable.findFirst({
      where: eq(terminalCommandTable.commandId, commandId)
    });
    if (!row) {
      return null;
    }
    return {
      commandId: row.commandId,
      terminalSessionId: row.terminalSessionId,
      threadId: row.threadId,
      budId: row.budId,
      createdByUserId: row.createdByUserId,
      tenantId: row.tenantId,
      commandStartedAt: row.commandStartedAt,
      commandFinishedAt: row.commandFinishedAt,
      exitCode: row.exitCode,
      outputByteStart: row.outputByteStart,
      outputByteEnd: row.outputByteEnd
    };
  }
}

/**
 * Persists command lifecycle rows from proto 0.3 `terminal_event` frames
 * (`command_started` / `command_finished`). Owner stamping is inherited from
 * the owning terminal session per AGENTS.md §4.6. Ingest is idempotent on the
 * daemon-minted `command_id`.
 */
export class TerminalCommandStore {
  private readonly logger: FastifyBaseLogger;
  private readonly persistence: TerminalCommandPersistence;

  constructor(
    logger: FastifyBaseLogger,
    persistence: TerminalCommandPersistence = new DrizzleTerminalCommandPersistence(),
  ) {
    this.logger = logger;
    this.persistence = persistence;
  }

  async recordCommandStarted(session: TerminalSession, event: CommandStartedEvent): Promise<void> {
    try {
      const inserted = await this.persistence.insertCommand({
        commandId: event.commandId,
        terminalSessionId: session.sessionId,
        threadId: session.threadId,
        budId: session.budId,
        createdByUserId: session.createdByUserId ?? null,
        tenantId: session.tenantId ?? null,
        commandStartedAt: new Date(event.ts),
        commandFinishedAt: null,
        exitCode: null,
        outputByteStart: event.outputByteStart,
        outputByteEnd: null
      });
      if (!inserted) {
        this.logger.info(
          { sessionId: session.sessionId, commandId: event.commandId, component: "terminal_command_store" },
          "command_started redelivery ignored (command already recorded)"
        );
      }
    } catch (err) {
      this.logger.warn(
        { err, sessionId: session.sessionId, commandId: event.commandId, component: "terminal_command_store" },
        "Failed to record command_started"
      );
    }
  }

  async recordCommandFinished(session: TerminalSession, event: CommandFinishedEvent): Promise<void> {
    const finishedAt = new Date(event.ts);
    try {
      const updated = await this.persistence.finalizeCommand(event.commandId, {
        commandFinishedAt: finishedAt,
        exitCode: event.exitCode,
        outputByteEnd: event.outputByteEnd,
        outputByteStart: event.outputByteStart
      });
      if (updated) {
        return;
      }

      // Tolerate command_finished without a preceding command_started (e.g.
      // the started frame was lost across a reconnect): insert a complete row.
      const startedAt =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
          ? new Date(event.ts - Math.max(event.durationMs, 0))
          : finishedAt;
      await this.persistence.insertCommand({
        commandId: event.commandId,
        terminalSessionId: session.sessionId,
        threadId: session.threadId,
        budId: session.budId,
        createdByUserId: session.createdByUserId ?? null,
        tenantId: session.tenantId ?? null,
        commandStartedAt: startedAt,
        commandFinishedAt: finishedAt,
        exitCode: event.exitCode,
        outputByteStart: event.outputByteStart ?? 0,
        outputByteEnd: event.outputByteEnd
      });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: session.sessionId, commandId: event.commandId, component: "terminal_command_store" },
        "Failed to record command_finished"
      );
    }
  }

  async getCommand(commandId: string): Promise<TerminalCommandRecord | null> {
    return this.persistence.getCommand(commandId);
  }
}
