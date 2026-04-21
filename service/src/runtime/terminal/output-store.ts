import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../../db/client.js";
import { config } from "../../config.js";
import {
  terminalSessionOutputTable,
  terminalSessionTable
} from "../../db/schema.js";
import { TerminalEventBus } from "../event-bus.js";

export class TerminalOutputStore {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;
  private readonly lastOffsets = new Map<string, number>();

  constructor(logger: FastifyBaseLogger, events: TerminalEventBus) {
    this.logger = logger;
    this.events = events;
  }

  getLastOffset(sessionId: string): number {
    return this.lastOffsets.get(sessionId) ?? 0;
  }

  clearSessionCache(sessionId: string): void {
    this.lastOffsets.delete(sessionId);
  }

  clearSessionCaches(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.clearSessionCache(sessionId);
    }
  }

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
        component: "terminal_output_store"
      },
      "tailOutput called"
    );

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
          component: "terminal_output_store"
        },
        "tailOutput sinceOffset query result"
      );

      if (rows.length === 0) {
        return { data: Buffer.alloc(0), totalBytes: 0 };
      }

      const buffers: Buffer[] = [];
      for (const row of rows) {
        let buf = Buffer.from(row.data);
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
      if (remaining <= 0) {
        break;
      }
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

  async handleTerminalOutput(
    sessionId: string,
    payload: { seq: number; data: string; byte_offset: number },
    options: {
      getStoredOutputBytes: (sessionId: string) => Promise<number | null>;
      onOutputObserved?: (details: {
        sessionId: string;
        requestOffset: number;
        endOffset: number;
        outputBytes: number;
      }) => void;
    }
  ): Promise<void> {
    const buffer = Buffer.from(payload.data, "base64");
    const endOffset = payload.byte_offset + buffer.length;
    this.lastOffsets.set(sessionId, endOffset);
    options.onOutputObserved?.({
      sessionId,
      requestOffset: payload.byte_offset,
      endOffset,
      outputBytes: buffer.length
    });

    const currentLogBytes = (await options.getStoredOutputBytes(sessionId)) ?? 0;
    const remaining = Math.max(config.terminalOutputSoftCapBytes - currentLogBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
    const now = new Date();

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
          component: "terminal_output_store"
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
}

