export const MAX_THREAD_STREAM_RECONNECT_DELAY_MS = 5000
export const THREAD_STREAM_RECONNECT_STEP_MS = 500

/**
 * Service SSE heartbeat cadence (see `service/src/routes/threads/agent.ts`
 * and `.../terminal.ts`): 5s in production, 1s in development. If the service
 * cadence changes, these must change with it.
 */
export const THREAD_STREAM_HEARTBEAT_INTERVAL_MS = 5000
export const THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS = 1000

/**
 * The missed-heartbeat watchdog must sit comfortably above the heartbeat
 * cadence (>= 2.5x) so a single late heartbeat never triggers a false
 * reconnect. The former 5s status-staleness heuristic
 * (`shouldTreatTerminalStatusAsStale`) equaled the production heartbeat
 * interval exactly and caused spurious terminal reconnects; it was deleted.
 * Reconnects are now driven only by EventSource errors and this watchdog.
 */
export const THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER = 3

export const getThreadStreamReconnectDelay = (attempt: number) => {
  const normalizedAttempt = Math.max(1, attempt)
  return Math.min(
    MAX_THREAD_STREAM_RECONNECT_DELAY_MS,
    THREAD_STREAM_RECONNECT_STEP_MS * normalizedAttempt,
  )
}

export const getThreadStreamHeartbeatConfig = (isDev: boolean) => {
  const heartbeatIntervalMs = isDev
    ? THREAD_STREAM_DEV_HEARTBEAT_INTERVAL_MS
    : THREAD_STREAM_HEARTBEAT_INTERVAL_MS

  return {
    heartbeatTimeoutMs: heartbeatIntervalMs * THREAD_STREAM_HEARTBEAT_TIMEOUT_MULTIPLIER,
    checkIntervalMs: heartbeatIntervalMs,
  }
}

export const hasMissedThreadStreamHeartbeat = (
  lastEventAt: number,
  now: number,
  heartbeatTimeoutMs: number,
) => now - lastEventAt > heartbeatTimeoutMs
