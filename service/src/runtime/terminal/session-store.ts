import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../../db/client.js";
import { terminalSessionTable } from "../../db/schema.js";
import { TERMINAL_PROTO_VERSION } from "../../config.js";
import { isBudOnline, sendFrameToBud } from "../../ws/gateway.js";
import type { TerminalSession } from "./session-types.js";

type TerminalSessionRow = typeof terminalSessionTable.$inferSelect;

export class TerminalSessionStore {
  private readonly logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger;
  }

  async ensureSessionRecordForThread(
    threadId: string,
    budId: string,
    createdByUserId?: string | null,
  ): Promise<{ session: TerminalSession; created: boolean }> {
    const existing = await this.getSessionForThread(threadId);
    if (existing) {
      return { session: existing, created: false };
    }

    const sessionId = `sess_${ulid()}`;

    try {
      const [row] = await db.insert(terminalSessionTable).values({
        sessionId,
        threadId,
        budId,
        instanceId: null,
        state: "pending",
        createdByUserId: createdByUserId ?? undefined,
      }).returning();

      const session = this.rowToSession(row);
      this.logger.info({ threadId, sessionId, budId }, "Created new session for thread");
      return { session, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.getSessionForThread(threadId);
      if (winner) {
        this.logger.info(
          { threadId, sessionId: winner.sessionId, budId: winner.budId },
          "Session already existed after concurrent create"
        );
        return { session: winner, created: false };
      }

      throw error;
    }
  }

  async getSessionForThread(threadId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, threadId),
        isNull(terminalSessionTable.closedAt)
      )
    });

    return row ? this.rowToSession(row) : null;
  }

  async getSession(sessionId: string): Promise<TerminalSession | null> {
    const row = await db.query.terminalSessionTable.findFirst({
      where: eq(terminalSessionTable.sessionId, sessionId)
    });
    return row ? this.rowToSession(row) : null;
  }

  async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; created?: boolean; error?: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return { ok: false, resumed: false, error: "session_not_found" };
    }

    if (session.state === "closed") {
      return { ok: false, resumed: false, error: "session_closed" };
    }

    if (session.state === "ready" || session.state === "active" || session.state === "idle") {
      if (!isBudOnline(session.budId)) {
        this.logger.warn(
          { sessionId, budId: session.budId, state: session.state },
          "Session state is ready but bud is offline"
        );
        return { ok: false, resumed: false, error: "bud_offline" };
      }
      return { ok: true, resumed: true };
    }

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

    await db
      .update(terminalSessionTable)
      .set({ state: "creating", lastActivityAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));

    this.logger.info({ sessionId, budId: session.budId }, "terminal_ensure sent");
    return { ok: true, resumed: false, created: true };
  }

  async markClosed(sessionId: string): Promise<void> {
    await db
      .update(terminalSessionTable)
      .set({ state: "closed", closedAt: new Date() })
      .where(eq(terminalSessionTable.sessionId, sessionId));
  }

  async updateStatus(
    sessionId: string,
    payload: {
      state: string;
      info?: {
        cols?: number;
        rows?: number;
        output_log_bytes?: number;
        started_at?: string;
        last_activity_at?: string;
      };
    }
  ): Promise<void> {
    const now = new Date();

    await db
      .update(terminalSessionTable)
      .set({
        state: payload.state,
        cols: payload.info?.cols ?? undefined,
        rows: payload.info?.rows ?? undefined,
        startedAt: payload.info?.started_at ? new Date(payload.info.started_at) : undefined,
        lastActivityAt: payload.info?.last_activity_at ? new Date(payload.info.last_activity_at) : now,
        outputLogBytes: payload.info?.output_log_bytes ?? undefined
      })
      .where(eq(terminalSessionTable.sessionId, sessionId));
  }

  async listSessionIdsForBud(
    budId: string,
    options?: { activeOnly?: boolean }
  ): Promise<string[]> {
    const where = options?.activeOnly
      ? and(
          eq(terminalSessionTable.budId, budId),
          isNull(terminalSessionTable.closedAt)
        )
      : eq(terminalSessionTable.budId, budId);

    const rows = await db.query.terminalSessionTable.findMany({
      where,
      columns: { sessionId: true }
    });

    return rows.map((row) => row.sessionId);
  }

  async suspendSessionsForBud(budId: string): Promise<void> {
    const result = await db
      .update(terminalSessionTable)
      .set({ state: "pending" })
      .where(
        and(
          eq(terminalSessionTable.budId, budId),
          inArray(terminalSessionTable.state, ["ready", "active", "idle", "creating"]),
          isNull(terminalSessionTable.closedAt)
        )
      );

    this.logger.info(
      { budId, updatedCount: result.rowCount, component: "terminal_session_store" },
      "Suspended terminal sessions for offline bud"
    );
  }

  async markIdleSessions(threshold: Date): Promise<number> {
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

  async listStaleIdleSessionIds(threshold: Date): Promise<string[]> {
    const rows = await db.query.terminalSessionTable.findMany({
      where: and(
        eq(terminalSessionTable.state, "idle"),
        lt(terminalSessionTable.lastActivityAt, threshold)
      ),
      columns: { sessionId: true }
    });

    return rows.map((row) => row.sessionId);
  }

  private rowToSession(row: TerminalSessionRow): TerminalSession {
    return {
      sessionId: row.sessionId,
      threadId: row.threadId,
      budId: row.budId,
      instanceId: row.instanceId,
      state: row.state as TerminalSession["state"],
      cols: row.cols,
      rows: row.rows,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      outputLogBytes: row.outputLogBytes
    };
  }
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
