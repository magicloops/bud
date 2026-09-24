import { BrowserStateFeed, observeBrowserState } from './state-feed'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRecoveryDiagnostics } from '../threads/recovery-diagnostics'
import { isAuthRedirectPending } from '@/lib/auth-redirect'
import { apiFetchJson } from '@/lib/transport'
import type { ApiMessage, ApiAgentState } from '@/lib/api-types'
import { browserReveal, browserSessionId, BrowserRevealTracker } from './pane-state'

export const BrowserPaneContext = createContext<((sessionId: string) => void) | null>(null)
export const useOpenBrowserPane = () => useContext(BrowserPaneContext)
export const BrowserWaitActionsContext = createContext<{
  visibleSessionId?: string | null
  returnAction: { sessionId: string; disabled: boolean; returning: boolean; run: () => void } | null
  error: { sessionId: string; message: string } | null
  stop: (invocationId: string) => Promise<void>
} | null>(null)
export const useBrowserWaitActions = () => useContext(BrowserWaitActionsContext)
type Inventory = { session_id: string; state: string; handoff: { id: string } | null }

export function useBrowserPane(threadId: string, initialMessages: ApiMessage[], initialState: ApiAgentState, reveal: () => void) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const stateFeed = useMemo(() => new BrowserStateFeed(`/api/threads/${encodeURIComponent(threadId)}/browser-state`), [threadId])
  const activity = useRef(0)
  const tracker = useRef<BrowserRevealTracker | null>(null)
  if (!tracker.current) {
    tracker.current = new BrowserRevealTracker()
    for (const message of initialMessages) {
      try {
        const found = browserReveal(JSON.parse(message.content))
        if (found) tracker.current.seed(found.key)
      } catch { /* Ordinary text is not browser state. */ }
    }
    const args = initialState.pending_tool?.args
    if (args) {
      const found = browserReveal(args)
      if (found) tracker.current.seed(found.key)
    }
  }
  const open = useCallback((id: string) => {
    if (!browserSessionId(id)) return
    activity.current++
    setSessionId(id)
    reveal()
  }, [reveal])
  const notice = useCallback((payload: Record<string, unknown>) => {
    const found = browserReveal(payload)
    if (found && tracker.current!.accept(found.key)) {
      tracker.current!.seed(`open:${found.id}`)
      open(found.id)
    }
  }, [open])
  useEffect(() => {
    let baseline = true
    let stopped = false
    const diagnostics = createRecoveryDiagnostics('browser-inventory', threadId)
    const poll = async (signal: AbortSignal) => {
      if (signal.aborted || stopped || isAuthRedirectPending()) return
      try {
        const revision = activity.current
        const result = await apiFetchJson<{ sessions: Inventory[] }>(`/api/threads/${encodeURIComponent(threadId)}/browser-sessions`, { signal: signal })
        if (signal.aborted) return
        const sessions = result.sessions.filter(s => s.state !== 'closing' && browserSessionId(s.session_id))
        for (const session of sessions) {
          const keys = [`open:${session.session_id}`, ...(session.handoff ? [`handoff:${session.handoff.id}`] : [])]
          let shouldOpen = false
          for (const key of keys) {
            if (baseline) tracker.current!.seed(key)
            else if (tracker.current!.accept(key)) shouldOpen = true
          }
          if (shouldOpen) open(session.session_id)
        }
        if (revision === activity.current) setSessionId(current => sessions.some(s => s.session_id === current) ? current : sessions[0]?.session_id ?? null)
        baseline = false
        diagnostics.finish()
      } catch (error) {
        if (signal.aborted) return
        diagnostics.start('inventory_request')
        diagnostics.attempt('inventory_request')
        const failure = diagnostics.failure(error)
        if (!failure.retryable || isAuthRedirectPending()) {
          stopped = true
          if ([401, 403, 404, 410].includes(failure.status ?? 0)) setSessionId(null)
          diagnostics.finish('stopped')
          return false
        }
        // Keep current presentation through transient disconnects.
        throw error
      }
    }
    const observer = observeBrowserState(stateFeed, poll, { revoked: () => setSessionId(null) })
    return () => { observer.stop(); diagnostics.finish('stopped') }
  }, [threadId, open, stateFeed])
  return { sessionId, open, notice, stateFeed }
}
