import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { config } from "../../config.js";
import {
  terminalSessionOutputTable,
  terminalSessionTable
} from "../../db/schema.js";
import { TerminalEventBus } from "../event-bus.js";

const READ_BATCH_ROWS = 128;

export type StoredOutputChunk = {
  byteOffset: number;
  data: Buffer;
};

/**
 * Thin persistence boundary so the read/ingest algorithms are unit-testable
 * against an in-memory store. The default implementation uses Drizzle.
 */
export interface TerminalOutputPersistence {
  /** Insert keyed on (session_id, byte_offset); returns true when the row was actually inserted. */
  insertChunk(sessionId: string, byteOffset: number, data: Buffer): Promise<boolean>;
  bumpOutputStats(
    sessionId: string,
    args: { totalDelta: number; storedDelta: number; at: Date },
  ): Promise<void>;
  /** Sum of stored chunk byte lengths for the session. */
  getStoredOutputBytes(sessionId: string): Promise<number>;
  /** Greatest chunk with byteOffset <= offset, or null. */
  findCoveringChunk(sessionId: string, offset: number): Promise<StoredOutputChunk | null>;
  /** Chunks with byteOffset >= fromOffset (and < beforeOffset when given), ascending, up to limit rows. */
  listChunksFrom(
    sessionId: string,
    fromOffset: number,
    limit: number,
    beforeOffset?: number,
  ): Promise<StoredOutputChunk[]>;
  /** Chunks with byteOffset < beforeOffset (all when null), descending, up to limit rows. */
  listTailChunks(
    sessionId: string,
    beforeOffset: number | null,
    limit: number,
  ): Promise<StoredOutputChunk[]>;
  /** max(byte_offset + length(data)) for the session; 0 when no output is stored. */
  getStoredEndOffset(sessionId: string): Promise<number>;
}

class DrizzleTerminalOutputPersistence implements TerminalOutputPersistence {
  async insertChunk(sessionId: string, byteOffset: number, data: Buffer): Promise<boolean> {
    const inserted = await db
      .insert(terminalSessionOutputTable)
      .values({
        sessionId,
        data,
        byteOffset
      })
      .onConflictDoNothing({
        target: [terminalSessionOutputTable.sessionId, terminalSessionOutputTable.byteOffset]
      })
      .returning({ byteOffset: terminalSessionOutputTable.byteOffset });
    return inserted.length > 0;
  }

  async bumpOutputStats(
    sessionId: string,
    args: { totalDelta: number; storedDelta: number; at: Date },
  ): Promise<void> {
    await db
      .update(terminalSessionTable)
      .set({
        totalOutputBytes: sql`total_output_bytes + ${args.totalDelta}`,
        outputLogBytes: sql`output_log_bytes + ${args.storedDelta}`,
        lastOutputAt: args.at,
        lastActivityAt: args.at
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));
  }

  async getStoredOutputBytes(sessionId: string): Promise<number> {
    const [row] = await db
      .select({
        total: sql<string | null>`sum(octet_length(${terminalSessionOutputTable.data}))`
      })
      .from(terminalSessionOutputTable)
      .where(eq(terminalSessionOutputTable.sessionId, sessionId));
    return row?.total ? Number(row.total) : 0;
  }

  async findCoveringChunk(sessionId: string, offset: number): Promise<StoredOutputChunk | null> {
    const [row] = await db
      .select({
        byteOffset: terminalSessionOutputTable.byteOffset,
        data: terminalSessionOutputTable.data
      })
      .from(terminalSessionOutputTable)
      .where(
        and(
          eq(terminalSessionOutputTable.sessionId, sessionId),
          lte(terminalSessionOutputTable.byteOffset, offset)
        )
      )
      .orderBy(desc(terminalSessionOutputTable.byteOffset))
      .limit(1);
    return row ? { byteOffset: row.byteOffset, data: Buffer.from(row.data) } : null;
  }

  async listChunksFrom(
    sessionId: string,
    fromOffset: number,
    limit: number,
    beforeOffset?: number,
  ): Promise<StoredOutputChunk[]> {
    const rows = await db
      .select({
        byteOffset: terminalSessionOutputTable.byteOffset,
        data: terminalSessionOutputTable.data
      })
      .from(terminalSessionOutputTable)
      .where(
        and(
          eq(terminalSessionOutputTable.sessionId, sessionId),
          gte(terminalSessionOutputTable.byteOffset, fromOffset),
          ...(beforeOffset !== undefined
            ? [lt(terminalSessionOutputTable.byteOffset, beforeOffset)]
            : [])
        )
      )
      .orderBy(asc(terminalSessionOutputTable.byteOffset))
      .limit(limit);
    return rows.map((row) => ({ byteOffset: row.byteOffset, data: Buffer.from(row.data) }));
  }

  async listTailChunks(
    sessionId: string,
    beforeOffset: number | null,
    limit: number,
  ): Promise<StoredOutputChunk[]> {
    const rows = await db
      .select({
        byteOffset: terminalSessionOutputTable.byteOffset,
        data: terminalSessionOutputTable.data
      })
      .from(terminalSessionOutputTable)
      .where(
        and(
          eq(terminalSessionOutputTable.sessionId, sessionId),
          ...(beforeOffset !== null ? [lt(terminalSessionOutputTable.byteOffset, beforeOffset)] : [])
        )
      )
      .orderBy(desc(terminalSessionOutputTable.byteOffset))
      .limit(limit);
    return rows.map((row) => ({ byteOffset: row.byteOffset, data: Buffer.from(row.data) }));
  }

  async getStoredEndOffset(sessionId: string): Promise<number> {
    const [row] = await db
      .select({
        end: sql<string | null>`max(${terminalSessionOutputTable.byteOffset} + octet_length(${terminalSessionOutputTable.data}))`
      })
      .from(terminalSessionOutputTable)
      .where(eq(terminalSessionOutputTable.sessionId, sessionId));
    return row?.end ? Number(row.end) : 0;
  }
}

export type OutputRangeReadResult = {
  data: Buffer;
  /** Offset of the first returned byte (>= requested startOffset; may be greater when a gap exists). */
  startOffset: number;
  /** Offset immediately after the last returned byte. Equals startOffset when data is empty. */
  endOffset: number;
  /** True when the read stopped at maxBytes before serving the requested range. */
  truncated: boolean;
  /** Continuation offset for the next read when truncated, otherwise null. */
  nextOffset: number | null;
};

export type OutputTailReadResult = {
  data: Buffer;
  startOffset: number;
  endOffset: number;
  totalBytesStored: number;
};

export class TerminalOutputStore {
  private readonly logger: FastifyBaseLogger;
  private readonly events: TerminalEventBus;
  private readonly persistence: TerminalOutputPersistence;
  private readonly lastOffsets = new Map<string, number>();

  constructor(
    logger: FastifyBaseLogger,
    events: TerminalEventBus,
    persistence: TerminalOutputPersistence = new DrizzleTerminalOutputPersistence(),
  ) {
    this.logger = logger;
    this.events = events;
    this.persistence = persistence;
  }

  /** Highest end offset observed on this process (live cache; 0 when unseen). */
  getLastOffset(sessionId: string): number {
    return this.lastOffsets.get(sessionId) ?? 0;
  }

  /** Highest durably stored end offset (used for terminal_ensure resume_from_offset). */
  async getStoredEndOffset(sessionId: string): Promise<number> {
    return this.persistence.getStoredEndOffset(sessionId);
  }

  async getStoredOutputBytes(sessionId: string): Promise<number> {
    return this.persistence.getStoredOutputBytes(sessionId);
  }

  clearSessionCache(sessionId: string): void {
    this.lastOffsets.delete(sessionId);
  }

  clearSessionCaches(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.clearSessionCache(sessionId);
    }
  }

  /**
   * Read stored output from `startOffset` (inclusive) up to `endOffset`
   * (exclusive, optional) capped at `maxBytes`. The chunk containing
   * `startOffset` is included with its leading bytes trimmed. The read
   * paginates internally; when `maxBytes` stops it early, `truncated` is true
   * and `nextOffset` is the continuation offset.
   */
  async readRange(
    sessionId: string,
    options: { startOffset: number; endOffset?: number; maxBytes: number },
  ): Promise<OutputRangeReadResult> {
    const startOffset = Math.max(0, Math.floor(options.startOffset));
    const rangeEnd = options.endOffset !== undefined ? Math.max(startOffset, Math.floor(options.endOffset)) : undefined;
    const maxBytes = Math.max(0, Math.floor(options.maxBytes));

    const buffers: Buffer[] = [];
    let firstByteOffset: number | null = null;
    let consumedEnd = startOffset;
    let remaining = maxBytes;
    let truncated = false;

    const pushSlice = (chunk: StoredOutputChunk): boolean => {
      let slice = chunk.data;
      let sliceStart = chunk.byteOffset;
      if (sliceStart < startOffset) {
        slice = slice.subarray(startOffset - sliceStart);
        sliceStart = startOffset;
      }
      if (rangeEnd !== undefined && sliceStart + slice.length > rangeEnd) {
        slice = slice.subarray(0, Math.max(rangeEnd - sliceStart, 0));
      }
      if (slice.length === 0) {
        return true;
      }
      if (remaining <= 0) {
        truncated = true;
        return false;
      }
      if (slice.length > remaining) {
        slice = slice.subarray(0, remaining);
        truncated = true;
      }
      if (firstByteOffset === null) {
        firstByteOffset = sliceStart;
      }
      buffers.push(slice);
      consumedEnd = sliceStart + slice.length;
      remaining -= slice.length;
      return !truncated;
    };

    // The chunk that CONTAINS startOffset (trim leading bytes).
    const covering = await this.persistence.findCoveringChunk(sessionId, startOffset);
    let scanFrom = startOffset;
    if (covering && covering.byteOffset + covering.data.length > startOffset) {
      pushSlice(covering);
      scanFrom = covering.byteOffset + covering.data.length;
    }

    while (!truncated && (rangeEnd === undefined || scanFrom < rangeEnd)) {
      const rows = await this.persistence.listChunksFrom(sessionId, scanFrom, READ_BATCH_ROWS, rangeEnd);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        if (!pushSlice(row)) {
          break;
        }
      }
      const last = rows[rows.length - 1];
      scanFrom = last.byteOffset + Math.max(last.data.length, 1);
      if (rows.length < READ_BATCH_ROWS) {
        break;
      }
    }

    const data = Buffer.concat(buffers);
    return {
      data,
      startOffset: firstByteOffset ?? startOffset,
      endOffset: consumedEnd,
      truncated,
      nextOffset: truncated ? consumedEnd : null
    };
  }

  /**
   * Read the most recent `maxBytes` of stored output. Paginates backwards
   * until the byte budget is served (no fixed row-count truncation).
   */
  async tailOutput(sessionId: string, maxBytes: number): Promise<OutputTailReadResult> {
    const budget = Math.max(0, Math.floor(maxBytes));
    const collected: StoredOutputChunk[] = [];
    let collectedBytes = 0;
    let beforeOffset: number | null = null;

    while (collectedBytes < budget) {
      const rows = await this.persistence.listTailChunks(sessionId, beforeOffset, READ_BATCH_ROWS);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        collected.push(row);
        collectedBytes += row.data.length;
        beforeOffset = row.byteOffset;
        if (collectedBytes >= budget) {
          break;
        }
      }
      if (rows.length < READ_BATCH_ROWS) {
        break;
      }
    }

    collected.reverse();
    let combined = Buffer.concat(collected.map((chunk) => chunk.data));
    let startOffset = collected.length > 0 ? collected[0].byteOffset : 0;
    const endOffset =
      collected.length > 0
        ? collected[collected.length - 1].byteOffset + collected[collected.length - 1].data.length
        : 0;
    if (combined.length > budget) {
      const trim = combined.length - budget;
      combined = combined.subarray(trim);
      startOffset += trim;
    }

    const totalBytesStored = await this.persistence.getStoredOutputBytes(sessionId);
    return {
      data: combined,
      startOffset,
      endOffset,
      totalBytesStored
    };
  }

  /**
   * Idempotent at-least-once ingest of a proto 0.3 `terminal_output` frame.
   * `(session_id, byte_offset)` is the idempotency key: stats bumps and SSE
   * emission only happen when the chunk row actually inserts, so redelivered
   * frames never double-count or re-emit.
   */
  async handleTerminalOutput(
    sessionId: string,
    payload: { data: string; byte_offset: number },
    options: {
      getStoredOutputBytes?: (sessionId: string) => Promise<number | null>;
      onOutputObserved?: (details: {
        sessionId: string;
        requestOffset: number;
        endOffset: number;
        outputBytes: number;
      }) => void;
    } = {}
  ): Promise<void> {
    const buffer = Buffer.from(payload.data, "base64");
    const endOffset = payload.byte_offset + buffer.length;
    const previousEnd = this.lastOffsets.get(sessionId) ?? 0;
    if (endOffset > previousEnd) {
      this.lastOffsets.set(sessionId, endOffset);
    }
    options.onOutputObserved?.({
      sessionId,
      requestOffset: payload.byte_offset,
      endOffset,
      outputBytes: buffer.length
    });

    if (buffer.length === 0) {
      return;
    }

    const currentLogBytes =
      (await (options.getStoredOutputBytes?.(sessionId) ?? this.persistence.getStoredOutputBytes(sessionId))) ?? 0;
    const remaining = Math.max(config.terminalOutputSoftCapBytes - currentLogBytes, 0);
    const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);

    if (toStore.length === 0) {
      this.logger.warn(
        {
          sessionId,
          byteOffset: payload.byte_offset,
          droppedBytes: buffer.length,
          component: "terminal_output_store"
        },
        "terminal output dropped at soft cap"
      );
      return;
    }

    const inserted = await this.persistence.insertChunk(sessionId, payload.byte_offset, toStore);
    if (!inserted) {
      this.logger.info(
        {
          sessionId,
          byteOffset: payload.byte_offset,
          endOffset,
          component: "terminal_output_store"
        },
        "terminal_output redelivery ignored (chunk already stored)"
      );
      return;
    }

    const now = new Date();
    await this.persistence.bumpOutputStats(sessionId, {
      totalDelta: buffer.length,
      storedDelta: toStore.length,
      at: now
    });

    if (toStore.length < buffer.length) {
      this.logger.warn(
        {
          sessionId,
          byteOffset: payload.byte_offset,
          stored: toStore.length,
          dropped: buffer.length - toStore.length,
          component: "terminal_output_store"
        },
        "terminal output truncated at soft cap"
      );
    }

    // Offset-only SSE payload (proto 0.3 §6.7.7). The event id is the
    // stringified end offset of the stored bytes so SSE Last-Event-ID doubles
    // as the byte-offset resume cursor.
    this.events.emit(sessionId, {
      event: "terminal.output",
      data: {
        data: toStore.toString("base64"),
        byte_offset: payload.byte_offset
      },
      id: String(payload.byte_offset + toStore.length)
    });
  }
}
