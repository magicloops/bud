# Phase 7: Frontend Changes

_Status: Complete_

## Overview

Update the React frontend to connect to terminal via thread-based endpoints instead of bud-based endpoints.

**File:** `web/src/App.tsx`

---

## Current State

```typescript
// Current: connects via budId
const connect = () => {
  const source = new EventSource(buildApiUrl(`/api/terminals/${budId}/stream`))
  // ...
}

// Input sent via budId
await fetch(buildApiUrl(`/api/terminals/${budId}/input`), {
  method: 'POST',
  body: JSON.stringify({ input: data }),
})
```

---

## Target State

```typescript
// New: connects via threadId
const connect = async () => {
  // Ensure terminal exists for thread
  const resp = await fetch(buildApiUrl(`/api/threads/${threadId}/terminal`), {
    method: 'POST'
  })
  if (!resp.ok) return

  const { session_id, resumed, created } = await resp.json()
  currentSessionIdRef.current = session_id

  // Connect to thread's terminal stream
  const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/terminal/stream`))
  // ...
}

// Input sent via threadId
await fetch(buildApiUrl(`/api/threads/${threadId}/terminal/input`), {
  method: 'POST',
  body: JSON.stringify({ input: data }),
})
```

---

## Implementation

### 1. Add Session Tracking Ref

```typescript
// Add ref to track current session ID
const currentSessionIdRef = useRef<string | null>(null)
```

### 2. Update Terminal Connection Effect

```typescript
// Connect terminal when thread changes (not when bud changes)
useEffect(() => {
  if (!currentThreadId) {
    setTerminalConnection('disconnected')
    terminalConnectionRef.current = 'disconnected'
    currentSessionIdRef.current = null
    return
  }

  let cancelled = false
  let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

  const connect = async () => {
    if (cancelled) return

    try {
      // Ensure terminal session exists for this thread
      const ensureResp = await fetch(buildApiUrl(`/api/threads/${currentThreadId}/terminal`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!ensureResp.ok || cancelled) {
        if (!cancelled) {
          console.warn('[terminal] Failed to ensure terminal session')
          setTerminalConnection('disconnected')
          terminalConnectionRef.current = 'disconnected'
        }
        return
      }

      const { session_id, resumed, created } = await ensureResp.json()
      currentSessionIdRef.current = session_id

      if (resumed) {
        console.log('[terminal] Resumed existing session', session_id)
      } else if (created) {
        console.log('[terminal] Created new session', session_id)
      }

      // Connect to thread's terminal stream
      const source = new EventSource(
        buildApiUrl(`/api/threads/${currentThreadId}/terminal/stream`)
      )
      terminalEventSourceRef.current = source

      const handleOutput = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const raw = event.data ?? ''
          const payload = JSON.parse(raw) as { data?: string }
          if (payload.data) {
            const decoded = decodeTerminalData(payload.data)
            if (decoded && terminalRef.current) {
              terminalRef.current.write(decoded)
              setTerminalHasOutput(true)
              fitTerminal()
            }
          }
        } catch (err) {
          console.error('Failed to parse terminal.output SSE', err)
        }
      }

      const handleStatus = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data ?? '{}') as { state?: string }
          if (payload.state) {
            lastSseEventTimeRef.current = Date.now()
            setTerminalState(payload.state)
          }
        } catch (err) {
          console.error('Failed to parse terminal.status SSE', err)
        }
      }

      const handleHeartbeat = () => {
        lastSseEventTimeRef.current = Date.now()
      }

      const handleReady = (event: MessageEvent) => {
        try {
          lastSseEventTimeRef.current = Date.now()
          const payload = JSON.parse(event.data ?? '{}') as {
            assessment?: {
              ready: boolean
              confidence: number
              trigger: string
              hints: Record<string, boolean>
            }
          }
          if (payload.assessment) {
            setTerminalReadiness(payload.assessment)
          }
        } catch (err) {
          console.error('Failed to parse terminal.ready SSE', err)
        }
      }

      const scheduleReconnect = (reason: string) => {
        if (terminated || cancelled) return

        if (terminalEventSourceRef.current === source) {
          terminalEventSourceRef.current = null
        }
        if (heartbeatCheckInterval) {
          clearInterval(heartbeatCheckInterval)
          heartbeatCheckInterval = null
        }
        source.removeEventListener('heartbeat', handleHeartbeat)
        source.removeEventListener('terminal.output', handleOutput)
        source.removeEventListener('terminal.status', handleStatus)
        source.removeEventListener('terminal.ready', handleReady)
        source.close()

        setTerminalConnection('reconnecting')
        terminalConnectionRef.current = 'reconnecting'

        const nextAttempt = terminalReconnectAttemptRef.current + 1
        terminalReconnectAttemptRef.current = nextAttempt
        const delay = Math.min(5000, 500 * nextAttempt)

        console.warn('[terminal] Reconnecting', { threadId: currentThreadId, reason, attempt: nextAttempt, delay })
        terminalReconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) connect()
        }, delay)
      }

      source.addEventListener('terminal.output', handleOutput)
      source.addEventListener('terminal.status', handleStatus)
      source.addEventListener('heartbeat', handleHeartbeat)
      source.addEventListener('terminal.ready', handleReady)

      source.addEventListener('open', () => {
        const wasReconnect = terminalReconnectAttemptRef.current > 0
        terminalReconnectAttemptRef.current = 0
        lastSseEventTimeRef.current = Date.now()
        setTerminalConnection('connected')
        terminalConnectionRef.current = 'connected'
        setTerminalDisconnectTime(null)

        console.log('[terminal] SSE connected', { threadId: currentThreadId, wasReconnect })

        // Start heartbeat monitoring
        const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
        const checkInterval = import.meta.env.DEV ? 1000 : 5000

        heartbeatCheckInterval = setInterval(() => {
          const elapsed = Date.now() - lastSseEventTimeRef.current
          if (elapsed > heartbeatTimeout) {
            console.warn('[terminal] Heartbeat timeout', { elapsed, threshold: heartbeatTimeout })
            scheduleReconnect('heartbeat_timeout')
          }
        }, checkInterval)

        // Fetch history on reconnect
        if (wasReconnect) {
          fetchTerminalHistory()
        }
      })

      source.addEventListener('error', () => {
        console.warn('[terminal] SSE error', { readyState: source.readyState })
        if (source.readyState === EventSource.CLOSED) {
          scheduleReconnect('connection_closed')
        }
      })

    } catch (err) {
      console.error('[terminal] Connection error', err)
      if (!cancelled) {
        setTerminalConnection('disconnected')
        terminalConnectionRef.current = 'disconnected'
      }
    }
  }

  connect()

  return () => {
    cancelled = true
    if (heartbeatCheckInterval) {
      clearInterval(heartbeatCheckInterval)
    }
    if (terminalEventSourceRef.current) {
      terminalEventSourceRef.current.close()
      terminalEventSourceRef.current = null
    }
    if (terminalReconnectTimerRef.current) {
      clearTimeout(terminalReconnectTimerRef.current)
      terminalReconnectTimerRef.current = null
    }
  }
}, [currentThreadId])  // Changed from activeBud?.bud_id
```

### 3. Update Input Handler

```typescript
// Send input via thread endpoint
const sendTerminalInput = async (data: string) => {
  if (!currentThreadId) return

  try {
    const resp = await fetch(buildApiUrl(`/api/threads/${currentThreadId}/terminal/input`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: data }),
    })

    if (!resp.ok) {
      console.error('[terminal] Input send failed', await resp.text())
    }
  } catch (err) {
    console.error('[terminal] Input send error', err)
  }
}
```

### 4. Update Resize Handler

```typescript
// Send resize via thread endpoint
const handleTerminalResize = async (cols: number, rows: number) => {
  if (!currentThreadId) return

  try {
    await fetch(buildApiUrl(`/api/threads/${currentThreadId}/terminal/resize`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    })
  } catch (err) {
    console.error('[terminal] Resize error', err)
  }
}
```

### 5. Update History Fetch

```typescript
// Fetch history via thread endpoint
const fetchTerminalHistory = async () => {
  if (!currentThreadId) return

  try {
    const resp = await fetch(
      buildApiUrl(`/api/threads/${currentThreadId}/terminal/history?bytes=100000`)
    )
    if (!resp.ok) return

    const { data_base64 } = await resp.json()
    if (data_base64 && terminalRef.current) {
      const decoded = decodeTerminalData(data_base64)
      if (decoded) {
        terminalRef.current.write(decoded)
        setTerminalHasOutput(true)
      }
    }
  } catch (err) {
    console.error('[terminal] History fetch error', err)
  }
}
```

### 6. Remove Bud-Based Terminal Code

Remove/update:
- Connection trigger from `activeBud?.bud_id` to `currentThreadId`
- All `/api/terminals/:budId/*` endpoint calls
- Any `lastConnectedBudIdRef` tracking (replace with thread-based)

---

## Implementation Checklist

- [ ] Add `currentSessionIdRef` to track active session
- [ ] Update terminal connection effect
  - [ ] Change dependency from `budId` to `currentThreadId`
  - [ ] Add `POST /api/threads/:threadId/terminal` call on connect
  - [ ] Update SSE URL to `/api/threads/:threadId/terminal/stream`
  - [ ] Handle `resumed`/`created` status
- [ ] Update `sendTerminalInput()` to use thread endpoint
- [ ] Update `handleTerminalResize()` to use thread endpoint
- [ ] Update `fetchTerminalHistory()` to use thread endpoint
- [ ] Remove bud-based terminal connection code
- [ ] Update logging to show `threadId` and `sessionId`
- [ ] Test terminal connection on thread switch
- [ ] Test terminal reconnection after service restart

---

## Optional: Session Indicator

Add visual indicator showing active terminal session in thread list:

```typescript
// In thread list item
{thread.has_terminal_session && (
  <span
    className="w-2 h-2 rounded-full bg-green-500"
    title="Active terminal session"
  />
)}
```

This requires adding `has_terminal_session` to thread list query (join on `terminal_session` table).

---

## Optional: BudPage Component

New page showing all sessions on a Bud:

```typescript
// web/src/components/workbench/bud-page.tsx

export function BudPage({ budId }: { budId: string }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([])

  useEffect(() => {
    fetch(buildApiUrl(`/api/buds/${budId}/sessions`))
      .then(r => r.json())
      .then(data => setSessions(data.sessions))
  }, [budId])

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-4">Active Sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground">No active sessions</p>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => (
            <div key={session.session_id} className="border rounded p-3">
              <div className="font-mono text-sm">{session.session_id}</div>
              <div className="text-sm text-muted-foreground">
                Thread: {session.thread_id ?? 'orphaned'}
              </div>
              <div className="text-sm text-muted-foreground">
                State: {session.state}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

---

## Notes

- Terminal now connects per-thread, not per-bud
- Session is created lazily when terminal view opens
- `resumed` flag helps show reconnection status to user
- BudPage is a stretch goal - useful for debugging but not required
