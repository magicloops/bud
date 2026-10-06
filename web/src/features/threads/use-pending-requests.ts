import { useCallback, useEffect, useRef } from 'react'
import type { ApiAgentState } from '../../lib/api-types'
import { apiFetchJson, isApiError } from '../../lib/transport'

export function pendingInventory(state: ApiAgentState) {
  return {
    pending_questions: state.pending_questions,
    pending_data_requests: state.pending_data_requests,
    pending_automation_requests: state.pending_automation_requests,
    pending_bootstrap_requests: state.pending_bootstrap_requests,
    pending_browser_waits: state.pending_browser_waits,
  }
}

/** Bounds staleness after a missed hint; hints remain the primary path. */
export const PENDING_BACKSTOP_MS = 60_000

/** One request per dirty inventory, plus one slow visible-only backstop read. */
export function usePendingRequests(threadId: string, apply: (state: ApiAgentState) => void) {
  const callback = useRef(apply)
  useEffect(() => { callback.current = apply }, [apply])
  const notify = useRef<() => void>(() => {})
  useEffect(() => {
    let stopped = false, dirty = false, generation = 0, failures = 0
    let request: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let backstop: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState !== 'hidden'
    const run = async () => {
      if (stopped || !dirty || request || !visible()) return
      dirty = false
      const version = generation
      const controller = new AbortController()
      request = controller
      try {
        const state = await apiFetchJson<ApiAgentState>(`/api/threads/${threadId}/agent/state`, { signal: controller.signal })
        if (stopped) return
        failures = 0
        if (version === generation) callback.current(state)
        else dirty = true
      } catch (error) {
        if (stopped) return
        if (isApiError(error, 401) || isApiError(error, 403) || isApiError(error, 404)) {
          stopped = true
          return
        }
        dirty = true
        failures++
      } finally {
        request = null
        arm()
        if (!stopped && dirty && visible()) schedule(failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)) : 0)
      }
    }
    const schedule = (delay: number) => {
      if (timer !== undefined || stopped) return
      timer = setTimeout(() => { timer = undefined; void run() }, delay)
    }
    const invalidate = () => {
      if (stopped) return
      generation++
      dirty = true
      if (!request && visible()) schedule(0)
    }
    // Restarted by every completed read. Left unarmed while hidden: returning
    // to the foreground invalidates, and that read arms it again.
    const arm = () => {
      clearTimeout(backstop)
      if (!stopped) backstop = setTimeout(() => { if (visible()) invalidate() }, PENDING_BACKSTOP_MS)
    }
    const foreground = () => { if (visible()) invalidate() }
    notify.current = invalidate
    document.addEventListener('visibilitychange', foreground)
    arm()
    return () => {
      stopped = true
      notify.current = () => {}
      clearTimeout(timer)
      clearTimeout(backstop)
      request?.abort()
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [threadId])
  return useCallback(() => notify.current(), [])
}
