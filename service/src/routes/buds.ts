import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { budTable } from "../db/schema.js";

type BudRow = typeof budTable.$inferSelect;

function serializeBud(bud: BudRow) {
  return {
    bud_id: bud.budId,
    name: bud.name,
    os: bud.os,
    arch: bud.arch,
    version: bud.version,
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
    return buds.map(serializeBud);
  });
}
