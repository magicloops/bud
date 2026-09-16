import type { ApiTurnTiming } from '../../lib/api-types.ts'

export function isTurnTiming(value: unknown): value is ApiTurnTiming {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ApiTurnTiming>
  return typeof row.turn_id === 'string' && row.turn_id.length > 0 &&
    (row.work_duration_ms === null || (typeof row.work_duration_ms === 'number' &&
      Number.isSafeInteger(row.work_duration_ms) && row.work_duration_ms >= 0))
}

/** Settled totals only. Missing fields do not erase loaded history. */
export function mergeTurnTimings(previous: ReadonlyMap<string, number | null>, rows: readonly unknown[] = []): ReadonlyMap<string, number | null> {
  let next: Map<string, number | null> | undefined
  for (const row of rows) {
    if (!isTurnTiming(row)) continue
    const current = next ?? previous
    if (current.has(row.turn_id) && current.get(row.turn_id) === row.work_duration_ms) continue
    next ??= new Map(previous)
    next.set(row.turn_id, row.work_duration_ms)
  }
  return next ?? previous
}
