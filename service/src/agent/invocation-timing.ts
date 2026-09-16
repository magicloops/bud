import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { Invocation } from "./invocation-repository.js";

export type TurnTiming = { turn_id: string; work_duration_ms: number | null };
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type TimedInvocation = Pick<Invocation, "turnId" | "threadId" | "status" | "workDurationMs" | "workStartedAt">;

// Also used by the raw-pg browser park. Evaluate the DB clock only at the
// durable boundary, never at token/tool events or while waiting for a person.
export const settledWorkDurationSql = `case
  when work_duration_ms is null then null
  when status = 'running' and work_started_at is not null then
    work_duration_ms + greatest(0, floor(extract(epoch from (clock_timestamp() - work_started_at)) * 1000))::bigint
  when status = 'running' or work_started_at is not null then null
  else work_duration_ms end`;
export const settleWorkTiming = () => ({ workDurationMs: sql.raw(settledWorkDurationSql), workStartedAt: null });
export const invalidateWorkTiming = () => ({ workDurationMs: null, workStartedAt: null });
export const beginWorkTiming = () => ({
  workDurationMs: sql`case when work_started_at is not null then null else work_duration_ms end`,
  workStartedAt: sql`clock_timestamp()`,
});

export function settledTurnTiming(row: TimedInvocation): TurnTiming | null {
  if (!["succeeded", "failed", "canceled", "expired", "needs_review"].includes(row.status)) return null;
  const value = row.workDurationMs;
  return { turn_id: row.turnId, work_duration_ms: row.status !== "needs_review" && row.workStartedAt === null &&
    value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null };
}

// One subscription per service database/runtime, including repositories created
// by automation cancellation. No polling or asynchronous timing persistence.
const publishers = new WeakMap<Database, (threadId: string, timing: TurnTiming) => void>();
export function subscribeTurnTimings(database: Database, publish: (threadId: string, timing: TurnTiming) => void) {
  publishers.set(database, publish);
  return () => { if (publishers.get(database) === publish) publishers.delete(database); };
}
const committedRows = new WeakMap<Transaction, TimedInvocation[]>();
export function recordSettledTiming(tx: Transaction, row: TimedInvocation) {
  committedRows.get(tx)?.push(row);
}
/** Transaction owner publishes only after commit, including nested cancel helpers. */
export async function invocationTimingTransaction<T>(database: Database, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  const rows: TimedInvocation[] = [];
  const result = await database.transaction(async tx => {
    committedRows.set(tx, rows);
    try { return await operation(tx); } finally { committedRows.delete(tx); }
  });
  for (const row of rows) {
    const timing = settledTurnTiming(row);
    if (timing) publishers.get(database)?.(row.threadId, timing);
  }
  return result;
}
