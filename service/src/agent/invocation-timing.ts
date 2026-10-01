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
const changedInvocations = new WeakMap<Transaction, { ids: Set<string>; wake: boolean }>();
const changeSubscribers = new WeakMap<object, (ids: string[]) => void>();
export function subscribeInvocationChanges(database: object, publish: (ids: string[]) => void) {
  changeSubscribers.set(database, publish);
  return () => { if (changeSubscribers.get(database) === publish) changeSubscribers.delete(database); };
}
/** Raw-pg transaction owners call this only after COMMIT succeeds. */
export function publishInvocationChanges(database: object, ids: string[] = []) {
  changeSubscribers.get(database)?.(ids);
}
/** Register inside the outer transaction; rolled-back hints are discarded. */
export function recordInvocationChange(tx: Transaction, id?: string) {
  const changes = changedInvocations.get(tx);
  if (changes) {
    changes.wake = true;
    if (id) changes.ids.add(id);
  }
}
export function recordSettledTiming(tx: Transaction, row: TimedInvocation) {
  committedRows.get(tx)?.push(row);
  if ('id' in row && typeof row.id === 'string') recordInvocationChange(tx, row.id);
}
/** Transaction owner publishes only after commit, including nested cancel helpers. */
export async function invocationTimingTransaction<T>(database: Database, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  const rows: TimedInvocation[] = [];
  const changes = { ids: new Set<string>(), wake: false };
  const result = await database.transaction(async tx => {
    committedRows.set(tx, rows);
    changedInvocations.set(tx, changes);
    try { return await operation(tx); } finally { committedRows.delete(tx); changedInvocations.delete(tx); }
  });
  if (changes.wake) publishInvocationChanges(database, [...changes.ids]);
  for (const row of rows) {
    const timing = settledTurnTiming(row);
    if (timing) publishers.get(database)?.(row.threadId, timing);
  }
  return result;
}
