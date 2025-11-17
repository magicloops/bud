import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { runSummaryTable, runTable, threadTable } from "./schema.js";

type RunStatus = typeof runTable.$inferSelect.status;

type RunSummaryInput = {
  runId: string;
  status?: RunStatus;
  exitCode?: number | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  finishedAt?: Date;
};

export async function upsertRunSummary({
  runId,
  status,
  exitCode,
  stdoutBytes,
  stderrBytes,
  finishedAt
}: RunSummaryInput): Promise<void> {
  const run = await db.query.runTable.findFirst({
    where: eq(runTable.runId, runId)
  });
  if (!run) {
    return;
  }

  const thread = await db.query.threadTable.findFirst({
    where: eq(threadTable.threadId, run.threadId)
  });
  if (!thread) {
    return;
  }

  const payload: typeof runSummaryTable.$inferInsert = {
    runId,
    threadId: run.threadId,
    budId: thread.budId,
    status: status ?? run.status,
    exitCode: exitCode ?? null,
    stdoutBytes: stdoutBytes ?? 0,
    stderrBytes: stderrBytes ?? 0,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: finishedAt ?? run.finishedAt ?? new Date()
  };

  await db
    .insert(runSummaryTable)
    .values(payload)
    .onConflictDoUpdate({
      target: runSummaryTable.runId,
      set: payload
    });
}
