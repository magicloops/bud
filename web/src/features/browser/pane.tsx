import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createRecoveryDiagnostics, inventoryRecoveryDelay } from '../threads/recovery-diagnostics'
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
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let baseline = true
    let failures = 0
    let stopped = false
    const diagnostics = createRecoveryDiagnostics('browser-inventory', threadId)
    const poll = async () => {
      if (abort.signal.aborted || stopped || isAuthRedirectPending()) return
      let delay = 5000
      try {
        const revision = activity.current
        const result = await apiFetchJson<{ sessions: Inventory[] }>(`/api/threads/${encodeURIComponent(threadId)}/browser-sessions`, { signal: abort.signal })
        if (abort.signal.aborted) return
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
        failures = 0
        diagnostics.finish()
      } catch (error) {
        if (abort.signal.aborted) return
        diagnostics.start('inventory_request')
        diagnostics.attempt('inventory_request')
        const failure = diagnostics.failure(error)
        if (!failure.retryable || isAuthRedirectPending()) {
          stopped = true
          if ([401, 403, 404, 410].includes(failure.status ?? 0)) setSessionId(null)
          diagnostics.finish('stopped')
          return
        }
        // Keep current presentation through transient disconnects.
        delay = inventoryRecoveryDelay(++failures)
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), delay)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer); diagnostics.finish('stopped') }
  }, [threadId, open])
  return { sessionId, open, notice }
}
