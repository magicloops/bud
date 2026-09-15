import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { apiFetchJson } from '@/lib/transport'
import type { ApiMessage, ApiAgentState } from '@/lib/api-types'
import { browserReveal, browserSessionId, BrowserRevealTracker } from './pane-state'

export const BrowserPaneContext = createContext<((sessionId: string) => void) | null>(null)
export const useOpenBrowserPane = () => useContext(BrowserPaneContext)
type Inventory = { session_id: string; state: string; control_state?: string; runtime_status?: string; handoff: { id: string } | null }

export function useBrowserPane(threadId: string, initialMessages: ApiMessage[], initialState: ApiAgentState, reveal: () => void) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [pausedSessionId, setPausedSessionId] = useState<string | null>(null)
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
    const poll = async () => {
      try {
        const revision = activity.current
        const result = await apiFetchJson<{ sessions: Inventory[] }>(`/api/threads/${encodeURIComponent(threadId)}/browser-sessions`, { signal: abort.signal })
        if (abort.signal.aborted) return
        const sessions = result.sessions.filter(s => s.state !== 'closing' && browserSessionId(s.session_id))
        setPausedSessionId(sessions.find(s => s.control_state && s.control_state !== 'agent' && !['daemon_restarted', 'ended'].includes(s.runtime_status ?? ''))?.session_id ?? null)
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
      } catch { /* Keep current presentation through transient disconnects. */ }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [threadId, open])
  return { sessionId, pausedSessionId, open, notice }
}
