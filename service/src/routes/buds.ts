import type { FastifyInstance } from "fastify";
import { desc, eq, isNull, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, terminalSessionTable, threadTable } from "../db/schema.js";
import { isBudOnline } from "../ws/gateway.js";
import type { TerminalSessionManager } from "../runtime/terminal-session-manager.js";
import { getAuthorizedBud, requireViewer } from "../auth/session.js";

type BudRow = typeof budTable.$inferSelect;

function normalizeCapabilities(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (Array.isArray(raw)) {
    return { legacy: raw };
  }
  return {};
}

function serializeBud(bud: BudRow) {
  return {
    bud_id: bud.budId,
    name: bud.name,
    display_name: bud.displayName ?? bud.name,
    os: bud.os,
    arch: bud.arch,
    version: bud.version,
    accent_color: bud.accentColor,
    tags: bud.tags ?? [],
    capabilities: normalizeCapabilities(bud.capabilities),
    status: bud.status,
    last_seen_at: bud.lastSeenAt,
    created_at: bud.createdAt
  };
}

export async function registerBudRoutes(
  server: FastifyInstance,
  terminalSessionManager: TerminalSessionManager
): Promise<void> {
  server.get("/api/buds", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const buds = await db
      .select()
      .from(budTable)
      .where(eq(budTable.createdByUserId, viewer.userId))
      .orderBy(desc(budTable.lastSeenAt));

    return buds.map(serializeBud);
  });

  // GET /api/buds/:budId/sessions - List active terminal sessions on Bud with thread info
  server.get("/api/buds/:budId/sessions", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const { budId } = request.params as { budId: string };

    if (!(await getAuthorizedBud(viewer, budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    // Get sessions with thread info via LEFT JOIN
    const sessions = await db
      .select({
        session_id: terminalSessionTable.sessionId,
        state: terminalSessionTable.state,
        thread_id: terminalSessionTable.threadId,
        thread_title: threadTable.title,
        thread_deleted_at: threadTable.deletedAt,
        created_at: terminalSessionTable.createdAt,
        started_at: terminalSessionTable.startedAt,
        last_activity_at: terminalSessionTable.lastActivityAt,
        output_bytes: terminalSessionTable.outputLogBytes,
        total_output_bytes: terminalSessionTable.totalOutputBytes
      })
      .from(terminalSessionTable)
      .leftJoin(threadTable, eq(terminalSessionTable.threadId, threadTable.threadId))
      .where(
        and(
          eq(terminalSessionTable.budId, budId),
          eq(terminalSessionTable.createdByUserId, viewer.userId),
          isNull(terminalSessionTable.closedAt)
        )
      )
      .orderBy(desc(terminalSessionTable.lastActivityAt));

    const budOnline = isBudOnline(budId);

    return {
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        state: s.state,
        thread_id: s.thread_id,
        thread_title: s.thread_title,
        thread_deleted: s.thread_deleted_at !== null,
        created_at: s.created_at?.toISOString() ?? null,
        started_at: s.started_at?.toISOString() ?? null,
        last_activity_at: s.last_activity_at?.toISOString() ?? null,
        output_bytes: s.output_bytes ?? 0,
        total_output_bytes: s.total_output_bytes ?? 0
      })),
      bud_online: budOnline
    };
  });

  // DELETE /api/buds/:budId/sessions/:sessionId - Close a session
  server.delete("/api/buds/:budId/sessions/:sessionId", async (request, reply) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) {
      return;
    }

    const { budId, sessionId } = request.params as { budId: string; sessionId: string };
    if (!(await getAuthorizedBud(viewer, budId))) {
      return reply.status(404).send({ error: "bud_not_found" });
    }

    // Verify session exists and belongs to this bud
    const session = await terminalSessionManager.getSession(sessionId);
    if (!session || session.budId !== budId) {
      return reply.status(404).send({ error: "session_not_found" });
    }
    if (session.state === "closed") {
      return reply.status(409).send({ error: "session_already_closed" });
    }

    // Check if bud is online
    const budOnline = isBudOnline(budId);

    // Close the session
    await terminalSessionManager.closeSession(sessionId, "user_requested");

    return {
      ok: true,
      session_id: sessionId,
      closed_on_bud: budOnline
    };
  });
}
