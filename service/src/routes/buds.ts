import type { FastifyInstance } from "fastify";
import { desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable, runSummaryTable } from "../db/schema.js";

type BudRow = typeof budTable.$inferSelect;

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
    capabilities: bud.capabilities ?? [],
    status: bud.status,
    last_seen_at: bud.lastSeenAt,
    created_at: bud.createdAt
  };
}

export async function registerBudRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/buds", async () => {
    const buds = await db
      .select()
      .from(budTable)
      .orderBy(desc(budTable.lastSeenAt));
    const budIds = buds.map((bud) => bud.budId);
    const lastRuns = new Map<
      string,
      {
        run_id: string;
        status: string;
        exit_code: number | null;
        started_at: Date | null;
        finished_at: Date | null;
      }
    >();
    if (budIds.length > 0) {
      const summaries = await db
        .select({
          budId: runSummaryTable.budId,
          runId: runSummaryTable.runId,
          status: runSummaryTable.status,
          exitCode: runSummaryTable.exitCode,
          startedAt: runSummaryTable.startedAt,
          finishedAt: runSummaryTable.finishedAt
        })
        .from(runSummaryTable)
        .where(inArray(runSummaryTable.budId, budIds))
        .orderBy(runSummaryTable.budId, desc(runSummaryTable.startedAt));
      for (const summary of summaries) {
        if (lastRuns.has(summary.budId)) {
          continue;
        }
        lastRuns.set(summary.budId, {
          run_id: summary.runId,
          status: summary.status,
          exit_code: summary.exitCode ?? null,
          started_at: summary.startedAt ?? null,
          finished_at: summary.finishedAt ?? null
        });
      }
    }

    return buds.map((bud) => ({
      ...serializeBud(bud),
      last_run: lastRuns.get(bud.budId) ?? null
    }));
  });
}
