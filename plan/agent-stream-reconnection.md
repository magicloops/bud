# Implementation Plan: Agent Stream Reconnection

_Created: 2025-12-05_

## Overview

Add reconnection logic to the agent/session SSE stream, mirroring the terminal stream's implementation. This will prevent loss of agent events (tool calls, messages) during long-running tasks when the connection breaks.

**Debug doc**: `debug/sse-stream-premature-close.md`

## Problem

The agent/session SSE stream currently has no reconnection logic:

```typescript
// Current implementation (web/src/App.tsx:868-874)
source.addEventListener('error', () => {
  source.close()
  agentEventSourceRef.current = null
  setStatus('idle')
  fetchMessages(threadIdForHandlers)  // Just fetches and stops
})
```

Compare to terminal stream which has:
- Heartbeat monitoring
- Exponential backoff reconnection
- Service restart detection
- State recovery on reconnect

## Goals

1. Add reconnection logic to agent stream matching terminal stream's pattern
2. Monitor heartbeats to detect stale connections
3. Recover gracefully from connection breaks during long-running tasks
4. Fetch messages from DB on reconnect to fill any gaps

---

## Part 1: New State Variables

**File**: `web/src/App.tsx`

Add new refs near existing terminal refs (around line 108):

```typescript
// Agent/session stream reconnection state
const agentEventSourceRef = useRef<EventSource | null>(null)  // Already exists
const agentReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const agentReconnectAttemptRef = useRef(0)
const lastAgentEventTimeRef = useRef<number>(Date.now())
const agentSessionIdRef = useRef<string | null>(null)
const agentThreadIdRef = useRef<string | null>(null)
```

Add new state for connection status (optional, for UI indicator):

```typescript
const [agentConnection, setAgentConnection] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
```

---

## Part 2: Extract Agent Stream Connection Logic

**File**: `web/src/App.tsx`

Create a `connectAgentStream` function similar to terminal's `connect()`:

```typescript
const connectAgentStream = useCallback((sessionId: string, threadId: string) => {
  // Store for reconnection
  agentSessionIdRef.current = sessionId
  agentThreadIdRef.current = threadId

  const source = new EventSource(buildApiUrl(`/api/sessions/${sessionId}/stream`))
  agentEventSourceRef.current = source

  let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null

  const scheduleReconnect = (reason: string) => {
    // Clean up current connection
    if (agentEventSourceRef.current === source) {
      agentEventSourceRef.current = null
    }
    if (heartbeatCheckInterval) {
      clearInterval(heartbeatCheckInterval)
      heartbeatCheckInterval = null
    }
    source.close()

    // Update state
    setAgentConnection('reconnecting')

    // Exponential backoff: 500ms, 1s, 1.5s, 2s, 2.5s, ... max 5s
    const nextAttempt = agentReconnectAttemptRef.current + 1
    agentReconnectAttemptRef.current = nextAttempt
    const delay = Math.min(5000, 500 * nextAttempt)

    console.warn('[agent-sse] reconnecting', { sessionId, reason, attempt: nextAttempt, delay })

    // Clear any existing reconnect timer
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
    }

    agentReconnectTimerRef.current = setTimeout(() => {
      connectAgentStream(sessionId, threadId)
    }, delay)
  }

  const cleanup = () => {
    if (heartbeatCheckInterval) {
      clearInterval(heartbeatCheckInterval)
      heartbeatCheckInterval = null
    }
    source.close()
    agentEventSourceRef.current = null
    agentSessionIdRef.current = null
    agentThreadIdRef.current = null
    setAgentConnection('disconnected')
  }

  // Connection opened
  source.addEventListener('open', () => {
    const wasReconnect = agentReconnectAttemptRef.current > 0
    agentReconnectAttemptRef.current = 0
    lastAgentEventTimeRef.current = Date.now()
    setAgentConnection('connected')

    console.log('[agent-sse] connected', { sessionId, wasReconnect })

    // If this is a reconnect, fetch messages to fill any gaps
    if (wasReconnect && threadId) {
      fetchMessages(threadId)
    }

    // Start heartbeat monitoring
    // Dev: 1s heartbeat from server, 3s timeout, check every 1s
    // Prod: 5s heartbeat from server, 15s timeout, check every 5s
    const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
    const checkInterval = import.meta.env.DEV ? 1000 : 5000

    heartbeatCheckInterval = setInterval(() => {
      const timeSinceLastEvent = Date.now() - lastAgentEventTimeRef.current
      if (timeSinceLastEvent > heartbeatTimeout) {
        console.warn(`[agent-sse] no heartbeat for ${heartbeatTimeout / 1000}s, connection stale`)
        scheduleReconnect('heartbeat_timeout')
      }
    }, checkInterval)
  })

  // Heartbeat handler
  source.addEventListener('heartbeat', () => {
    lastAgentEventTimeRef.current = Date.now()
  })

  // Tool call handler (for logging/UI)
  source.addEventListener('agent.tool_call', (evt) => {
    lastAgentEventTimeRef.current = Date.now()
    try {
      const data = JSON.parse(evt.data) as { name: string; args: unknown }
      console.log('[agent-sse] tool_call', data.name, data.args)
    } catch (e) {
      console.warn('Failed to parse agent.tool_call', e)
    }
  })

  // Tool result handler (for logging)
  source.addEventListener('agent.tool_result', () => {
    lastAgentEventTimeRef.current = Date.now()
  })

  // Agent message handler
  source.addEventListener('agent.message', (evt) => {
    lastAgentEventTimeRef.current = Date.now()
    try {
      const data = JSON.parse(evt.data) as { text: string }
      setMessages((prev) => [
        ...prev,
        {
          message_id: `streaming_${Date.now()}`,
          role: 'assistant',
          display_role: 'Assistant',
          content: data.text,
          created_at: new Date().toISOString()
        }
      ])
    } catch (e) {
      console.warn('Failed to parse agent.message', e)
    }
  })

  // Final event - agent completed successfully
  source.addEventListener('final', (evt) => {
    lastAgentEventTimeRef.current = Date.now()
    console.log('[agent-sse] final event received')

    // Clear reconnect state
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
      agentReconnectTimerRef.current = null
    }

    cleanup()
    setStatus('idle')

    // Fetch final messages to get real IDs
    if (threadId) {
      fetchMessages(threadId)
    }
  })

  // Error handler - attempt reconnect
  source.addEventListener('error', (evt) => {
    console.warn('[agent-sse] error', { readyState: source.readyState, evt })

    // Only reconnect if we haven't received a final event
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    if (source.readyState === EventSource.CLOSED) {
      scheduleReconnect('connection_closed')
    }
  })

  return cleanup
}, [fetchMessages, setMessages, setStatus])
```

---

## Part 3: Update handleSubmit

**File**: `web/src/App.tsx`

Replace the inline SSE connection code in `handleSubmit` (around lines 819-874):

```typescript
// Inside handleSubmit, after getting sessionId:
const { sessionId } = (await messageResp.json()) as { messageId: string; sessionId: string }

// Close any existing agent SSE connection
if (agentEventSourceRef.current) {
  agentEventSourceRef.current.close()
  agentEventSourceRef.current = null
}
if (agentReconnectTimerRef.current) {
  clearTimeout(agentReconnectTimerRef.current)
  agentReconnectTimerRef.current = null
}
agentReconnectAttemptRef.current = 0

// Connect to session stream with reconnection support
setStatus('streaming')
connectAgentStream(sessionId, currentThreadId)
```

---

## Part 4: Cleanup on Component Unmount

**File**: `web/src/App.tsx`

Add cleanup for agent stream in the component (or in an existing useEffect):

```typescript
// Add to existing cleanup or create new useEffect
useEffect(() => {
  return () => {
    // Cleanup agent stream on unmount
    if (agentEventSourceRef.current) {
      agentEventSourceRef.current.close()
      agentEventSourceRef.current = null
    }
    if (agentReconnectTimerRef.current) {
      clearTimeout(agentReconnectTimerRef.current)
      agentReconnectTimerRef.current = null
    }
  }
}, [])
```

---

## Part 5: Backend - Add Try-Catch to Event Emission (Optional)

**File**: `service/src/runtime/event-bus.ts`

Wrap listener calls to prevent one failed listener from breaking others:

```typescript
emit(channelId: string, event: SseEvent): void {
  if (!this.buffers.has(channelId)) {
    this.buffers.set(channelId, []);
  }
  const buffer = this.buffers.get(channelId)!;
  buffer.push(event);
  if (buffer.length > this.bufferLimit) {
    buffer.shift();
  }

  const listeners = this.listeners.get(channelId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Log but don't break the loop - other listeners should still receive
      console.error('SSE listener error', { channelId, event: event.event, err });
    }
  }
}
```

---

## Implementation Checklist

### Frontend (web/src/App.tsx)

- [x] Add new refs: `agentReconnectTimerRef`, `agentReconnectAttemptRef`, `lastAgentEventTimeRef`, `agentSessionIdRef`, `agentThreadIdRef`
- [ ] Add optional state: `agentConnection` for UI indicator (skipped - not needed)
- [x] Create `connectAgentStream` function with:
  - [x] Heartbeat monitoring
  - [x] `scheduleReconnect` with exponential backoff
  - [x] Event handlers for all agent events
  - [x] Cleanup function
- [x] Update `handleSubmit` to use `connectAgentStream`
- [x] Update `cancelAgentTurn` to clear reconnection state
- [ ] Add cleanup in useEffect for component unmount (handled by connectAgentStream cleanup)

### Backend (service/src/runtime/event-bus.ts)

- [x] Add try-catch wrapper around listener calls in `emit()`

**Status: ✅ IMPLEMENTED (2025-12-07)**

---

## Testing Plan

### Manual Tests

1. **Basic flow**: Submit message, verify events stream correctly
2. **Dev server restart**:
   - Start long-running task
   - Restart Vite dev server mid-task
   - Verify agent stream reconnects and events resume
3. **Network interruption**:
   - Use browser DevTools to throttle/offline network briefly
   - Verify reconnection occurs
4. **Heartbeat timeout**:
   - Kill backend server (not restart, just stop)
   - Verify frontend detects stale connection within timeout period
5. **Final event after reconnect**:
   - Disconnect/reconnect during task
   - Verify final messages still appear

### Console Verification

Look for these log patterns:
- `[agent-sse] connected` - initial connection
- `[agent-sse] reconnecting` - reconnection attempt
- `[agent-sse] no heartbeat for Xs` - stale detection
- `[agent-sse] final event received` - clean completion

---

## Configuration Constants

| Parameter | Dev | Prod | Description |
|-----------|-----|------|-------------|
| Heartbeat interval (server) | 1s | 5s | How often server sends heartbeat |
| Heartbeat timeout (client) | 3s | 15s | Max time without event before stale |
| Check interval (client) | 1s | 5s | How often to check for staleness |
| Reconnect delay | 500ms × attempt | 500ms × attempt | Exponential backoff, max 5s |

---

## Rollback

To disable reconnection (revert to current behavior):
1. Remove `connectAgentStream` function
2. Restore inline EventSource code in `handleSubmit`
3. Remove new refs and state

---

## Future Enhancements

1. **Connection status UI**: Show indicator when agent stream is reconnecting
2. **Max reconnect attempts**: Stop trying after N failures (e.g., 10)
3. **Backoff jitter**: Add randomness to prevent thundering herd on service restart
4. **Message deduplication**: Track last received message ID to avoid duplicates on reconnect
