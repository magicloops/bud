import "dotenv/config";
import { asc, count, eq, isNull } from "drizzle-orm";
import { pool, db } from "../db/client.js";
import { generateMessageClientId } from "../db/message-client-id.js";
import { messageTable } from "../db/schema.js";

const DEFAULT_BATCH_SIZE = 500;

function parseBatchSize(rawValue: string | undefined): number {
  if (!rawValue) {
    return DEFAULT_BATCH_SIZE;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("MESSAGE_CLIENT_ID_BACKFILL_BATCH_SIZE must be a positive integer");
  }

  return parsed;
}

async function countMissingClientIds(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(messageTable)
    .where(isNull(messageTable.clientId));

  return result?.count ?? 0;
}

async function main() {
  const batchSize = parseBatchSize(process.env.MESSAGE_CLIENT_ID_BACKFILL_BATCH_SIZE);
  let totalUpdated = 0;

  console.log(`Backfilling message.client_id in batches of ${batchSize}...`);

  while (true) {
    const batch = await db
      .select({
        messageId: messageTable.messageId,
      })
      .from(messageTable)
      .where(isNull(messageTable.clientId))
      .orderBy(asc(messageTable.createdAt), asc(messageTable.messageId))
      .limit(batchSize);

    if (batch.length === 0) {
      break;
    }

    await db.transaction(async (tx) => {
      for (const row of batch) {
        await tx
          .update(messageTable)
          .set({ clientId: generateMessageClientId() })
          .where(eq(messageTable.messageId, row.messageId));
      }
    });

    totalUpdated += batch.length;
    console.log(`Updated ${totalUpdated} messages so far...`);
  }

  const remaining = await countMissingClientIds();
  console.log(`Remaining rows without client_id: ${remaining}`);

  if (remaining > 0) {
    throw new Error("message.client_id backfill incomplete");
  }

  console.log(`Backfill complete. Updated ${totalUpdated} message rows.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
