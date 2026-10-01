import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiAgentState, ApiContextBudget } from '../../lib/api-types'
import { apiFetchJson } from '../../lib/transport'

/** Mounted inside the owner/thread-keyed workbench; optional reads never apply agent state. */
export function useContextBudget(threadId: string, initial: ApiContextBudget | null | undefined) {
  const [contextBudget, setContextBudget] = useState(initial ?? null)
  const generation = useRef(0)
  const pending = useRef<AbortController | null>(null)
  const applyContextBudget = useCallback((value: ApiContextBudget | null | undefined) => {
    if (value === undefined) return
    generation.current++
    pending.current?.abort()
    setContextBudget(value)
  }, [])
  const refreshContextBudget = useCallback(async () => {
    const version = ++generation.current
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    try {
      const state = await apiFetchJson<ApiAgentState>(`/api/threads/${threadId}/agent/state`, { signal: controller.signal })
      if (!controller.signal.aborted && version === generation.current && state.context_budget !== undefined) {
        setContextBudget(state.context_budget)
      }
    } catch {
      // Optional read failure retains the last known meter; ordinary state refreshes retry.
    } finally {
      if (pending.current === controller) pending.current = null
    }
  }, [threadId])
  useEffect(() => {
    void refreshContextBudget()
    return () => { pending.current?.abort() }
  }, [refreshContextBudget])
  return { contextBudget, applyContextBudget, refreshContextBudget }
}
