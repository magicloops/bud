export const MAX_THREAD_STREAM_RECONNECT_DELAY_MS = 5000
export const THREAD_STREAM_RECONNECT_STEP_MS = 500
export const THREAD_STREAM_STATUS_STALE_THRESHOLD_MS = 5000

export const getThreadStreamReconnectDelay = (attempt: number) => {
  const normalizedAttempt = Math.max(1, attempt)
  return Math.min(
    MAX_THREAD_STREAM_RECONNECT_DELAY_MS,
    THREAD_STREAM_RECONNECT_STEP_MS * normalizedAttempt,
  )
}

export const getThreadStreamHeartbeatConfig = (isDev: boolean) => ({
  heartbeatTimeoutMs: isDev ? 3000 : 15000,
  checkIntervalMs: isDev ? 1000 : 5000,
})

export const hasMissedThreadStreamHeartbeat = (
  lastEventAt: number,
  now: number,
  heartbeatTimeoutMs: number,
) => now - lastEventAt > heartbeatTimeoutMs

export const shouldTreatTerminalStatusAsStale = (lastEventAt: number, now: number) =>
  now - lastEventAt > THREAD_STREAM_STATUS_STALE_THRESHOLD_MS
