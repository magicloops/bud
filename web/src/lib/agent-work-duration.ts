import type { ApiMessage } from './api-types'
import { AGENT_MESSAGE_DURATION_SOURCE, getMessageTiming } from './agent-message-metadata.ts'

/**
 * `Worked for …` duration for one agent-work group (mobile-parity semantics,
 * reference/mobile-agent-work-collapse-web-handoff.md §Duration Semantics):
 *
 * 1. Union of authoritative `service_wall_clock` intervals from the group's
 *    messages — overlapping tool/reasoning intervals are counted once.
 * 2. Legacy fallback, pure-tool groups only: sum of numeric tool-payload
 *    `duration_ms` values on rows with no authoritative timing (pre-timing
 *    history where the command runtime is the only signal).
 * 3. Otherwise null — render `Worked` with no number, never an estimate.
 *
 * The caller passes the group's WORK messages only (reasoning, tools,
 * intermediate assistant); the final answer is excluded by construction.
 */
export const computeAgentWorkDurationMs = (messages: ApiMessage[]): number | null => {
  const intervals: Array<{ start: number; end: number }> = []
  for (const message of messages) {
    const timing = getMessageTiming(message)
    if (timing) {
      intervals.push({ start: timing.startedAtMs, end: timing.finishedAtMs })
    }
  }

  if (intervals.length > 0) {
    intervals.sort((a, b) => a.start - b.start)
    let total = 0
    let currentStart = intervals[0].start
    let currentEnd = intervals[0].end
    for (const interval of intervals.slice(1)) {
      if (interval.start <= currentEnd) {
        currentEnd = Math.max(currentEnd, interval.end)
      } else {
        total += currentEnd - currentStart
        currentStart = interval.start
        currentEnd = interval.end
      }
    }
    total += currentEnd - currentStart
    return total
  }

  // Legacy fallback: only when the group is tools all the way down.
  if (messages.length === 0 || !messages.every((message) => message.role === 'tool')) {
    return null
  }
  let sum = 0
  let found = false
  for (const message of messages) {
    const metadata = message.metadata ?? {}
    if (metadata.duration_source === AGENT_MESSAGE_DURATION_SOURCE) {
      continue // authoritative but unparseable timing: handled above, skip
    }
    if (typeof metadata.duration_ms === 'number' && Number.isFinite(metadata.duration_ms)) {
      sum += Math.max(0, Math.trunc(metadata.duration_ms))
      found = true
    }
  }
  return found ? sum : null
}

/** `Worked for 1m 28s` formatting: seconds under a minute, minutes+seconds after. */
export const formatWorkDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}
