/** Shared diagnostics/policy only; each mounted consumer owns its retry lifecycle. */
export function recoveryFailure(error: unknown) {
  const value = error as { status?: unknown; body?: { error?: unknown } } | null
  const status = typeof value?.status === 'number' ? value.status : null
  const rawCode = value?.body?.error
  const code = typeof rawCode === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(rawCode)
    ? rawCode : status === null ? 'request_failed' : 'http_error'
  return { status, code, retryable: status === null || status === 408 || status === 429 || status >= 500 }
}

export const offlineRecoveryDelay = (attempt: number) =>
  Math.min(30_000, 2000 * 2 ** Math.min(4, Math.max(0, attempt - 1)))

export const inventoryRecoveryDelay = (attempt: number) =>
  Math.min(30_000, 10_000 * 2 ** Math.min(2, Math.max(0, attempt - 1)))

export function createRecoveryDiagnostics(component: string, threadId: string) {
  let episode: { id: number; started: number; attempts: number; failure: string | null } | null = null
  let sequence = 0
  let attempts = 0
  const emit = (level: 'info' | 'warn' | 'debug', event: string, fields: Record<string, unknown> = {}) => {
    console[level]('client-recovery', {
      at: new Date().toISOString(), component, thread_id: threadId,
      recovery_id: episode?.id, event, attempt: episode?.attempts,
      elapsed_ms: episode ? Date.now() - episode.started : 0, ...fields,
    })
  }
  return {
    start(trigger: string) {
      if (episode) return
      episode = { id: ++sequence, started: Date.now(), attempts, failure: null }
      emit('info', 'started', { trigger })
    },
    attempt(trigger: string) {
      attempts++
      if (episode) {
        episode.attempts = attempts
        emit('debug', 'attempt', { trigger })
      }
    },
    scheduled(trigger: string, delayMs: number, transportState?: number) {
      if (episode) emit('debug', 'scheduled', { trigger, delay_ms: delayMs, transport_state: transportState })
    },
    failure(error: unknown) {
      const failure = recoveryFailure(error)
      const key = `${failure.status}:${failure.code}`
      if (episode?.failure !== key) {
        // Offline is an availability state, not an exception needing a stack.
        emit(failure.code === 'bud_offline' ? 'debug' : 'warn', 'failed', failure)
        if (episode) episode.failure = key
      }
      return failure
    },
    finish(event: 'succeeded' | 'stopped' = 'succeeded') {
      if (episode) emit('info', event)
      episode = null
      attempts = 0
    },
  }
}
