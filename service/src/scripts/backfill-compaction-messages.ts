import "dotenv/config";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { agentContextCheckpointTable, messageTable } from "../db/schema.js";
import { buildCompactionMessageValues, COMPACTION_MESSAGE_ROLE } from "../agent/compaction-message.js";
import { normalizeCheckpointRow } from "../agent/context-checkpoint-repository.js";

/**
 * Write a `role: "compaction"` transcript row for every completed context
 * checkpoint that does not have one yet (rows created before the feature,
 * or lost to a crash between recording the checkpoint and the row).
 * Idempotent: keyed on metadata.checkpoint_id. `DRY_RUN=1` only counts.
 */
const DEFAULT_BATCH_SIZE = 200;

function parseBatchSize(raw: string | undefined): number {
  if (!raw) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("COMPACTION_MESSAGE_BACKFILL_BATCH_SIZE must be a positive integer");
  }
  return parsed;
}

const missingRowCondition = sql`NOT EXISTS (
  SELECT 1 FROM ${messageTable}
  WHERE ${messageTable.threadId} = ${agentContextCheckpointTable.threadId}
    AND ${messageTable.role} = ${COMPACTION_MESSAGE_ROLE}
    AND ${messageTable.metadata} ->> 'checkpoint_id' = ${agentContextCheckpointTable.checkpointId}
)`;

async function main() {
  const batchSize = parseBatchSize(process.env.COMPACTION_MESSAGE_BACKFILL_BATCH_SIZE);
  const dryRun = process.env.DRY_RUN === "1";
  let inserted = 0;

  console.log(`${dryRun ? "[dry run] " : ""}Backfilling compaction transcript rows in batches of ${batchSize}...`);

  while (true) {
    const batch = await db
      .select()
      .from(agentContextCheckpointTable)
      .where(and(eq(agentContextCheckpointTable.status, "completed"), missingRowCondition))
      .orderBy(asc(agentContextCheckpointTable.createdAt), asc(agentContextCheckpointTable.checkpointId))
      .limit(batchSize);

    if (batch.length === 0) break;
    if (dryRun) {
      inserted += batch.length;
      console.log(`would insert ${batch.length} rows (through ${batch[batch.length - 1]!.checkpointId})`);
      if (batch.length < batchSize) break;
      // Without inserting, the same rows come back; stop after one page to
      // avoid looping (the count above is a lower bound).
      break;
    }

    await db.insert(messageTable).values(
      batch.map((row) => buildCompactionMessageValues(normalizeCheckpointRow(row))),
    );
    inserted += batch.length;
    console.log(`inserted ${batch.length} rows (through ${batch[batch.length - 1]!.checkpointId})`);
  }

  console.log(`${dryRun ? "Would insert" : "Inserted"} ${inserted} compaction rows.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
