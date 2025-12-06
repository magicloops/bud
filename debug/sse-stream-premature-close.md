# Debug: SSE Stream Premature Close During Long-Running Tasks

_Created: 2025-12-05_

## Problem

During longer-running agent tasks, the SSE stream stops prematurely. The frontend UI doesn't see agent tool calls and text output messages, even though:

1. Terminal output streams properly (visible in terminal pane)
2. Messages are correctly saved to DB (visible after page refresh)

This became more noticeable after implementing activity-based readiness detection, which adds significant wait times (10-15+ seconds minimum) during agent operations.

---

## Architecture Overview

### Two SSE Streams

The frontend maintains two separate SSE connections:

| Stream | Endpoint | Events | Purpose |
|--------|----------|--------|---------|
| Terminal | `/api/terminals/${budId}/stream` | `terminal.output`, `terminal.status`, `terminal.ready`, `heartbeat` | Raw terminal output |
| Agent/Session | `/api/sessions/${sessionId}/stream` | `agent.tool_call`, `agent.tool_result`, `agent.message`, `final`, `heartbeat` | Agent chat messages |

### Backend Event Flow

```
AgentService.runAgentFlow()
    ↓
events.emit(sessionId, "agent.tool_call")
    ↓
SessionEventBus.emit() → Ring buffer (1000 events)
    ↓                  → All attached listeners
    ↓
FastifyReply.sse() → HTTP chunked response
    ↓
Frontend EventSource receives event
```

### Key Code Locations

| Component | File | Lines |
|-----------|------|-------|
| Event Bus | `service/src/runtime/event-bus.ts` | 1-81 |
| SSE Endpoints | `service/src/server.ts` | 90-136 |
| Agent Event Emission | `service/src/agent/agent-service.ts` | 285-422 |
| Frontend Agent Stream | `web/src/App.tsx` | 819-874 |
| Frontend Terminal Stream | `web/src/App.tsx` | 529-690 |

---

## Critical Difference: Reconnection Logic

### Terminal Stream ✅ Has Reconnection

```typescript
// web/src/App.tsx:598-620
const scheduleReconnect = (reason: string) => {
  // Clean up old connection
  source.close()
  setTerminalConnection('reconnecting')

  // Exponential backoff: 500ms, 1s, 1.5s, ... max 5s
  const nextAttempt = terminalReconnectAttemptRef.current + 1
  const delay = Math.min(5000, 500 * nextAttempt)

  // Schedule reconnection
  terminalReconnectTimerRef.current = setTimeout(connect, delay)
}

// Also has heartbeat monitoring (lines 630-641)
heartbeatCheckInterval = setInterval(() => {
  if (Date.now() - lastSseEventTimeRef.current > heartbeatTimeout) {
    scheduleReconnect('heartbeat_timeout')
  }
}, checkInterval)
```

### Agent Stream ❌ NO Reconnection

```typescript
// web/src/App.tsx:868-874
source.addEventListener('error', () => {
  source.close()
  agentEventSourceRef.current = null
  setStatus('idle')
  // Just fetches messages, doesn't reconnect!
  fetchMessages(threadIdForHandlers)
})
```

---

## Hypotheses

### Hypothesis 1: Missing Reconnection Logic for Agent Stream (HIGH CONFIDENCE)

**Problem**: When the agent SSE connection breaks, the frontend doesn't attempt to reconnect. It just closes and fetches messages from DB.

**Why it matters now**: Activity-based detection adds 10-15+ second wait periods. During these waits:
- Agent emits `tool_call` event
- Agent waits for readiness (long silence)
- If connection breaks here, frontend misses `tool_result` and `final` events

**Evidence**:
- Terminal stream (with reconnection) continues working
- Agent stream (without reconnection) loses events
- Messages appear after refresh (they're in DB)

**Timeline of failure**:
```
t=0s   Agent emits "agent.tool_call" → Frontend receives ✅
t=0s   Agent sends input to terminal
t=2s   Activity detection starts (initial delay)
t=7s   First capture-pane hash
t=12s  Second capture-pane hash (stable check 1)
t=15s  ← Connection breaks here (network blip, proxy timeout)
t=17s  Third capture-pane hash (stable check 2) → READY
t=17s  Agent emits "agent.tool_result" → No listener! ❌
t=18s  Agent emits "agent.message" → No listener! ❌
t=18s  Agent emits "final" → No listener! ❌
t=18s  Messages saved to DB ✅
```

**Fix**: Add reconnection logic to agent stream, similar to terminal stream.

---

### Hypothesis 2: Development Server Restart (HIGH CONFIDENCE)

**Problem**: When Vite or Node service restarts during a long-running task:
1. Both SSE connections break (error event fires)
2. Terminal stream reconnects automatically
3. Agent stream closes permanently
4. Agent flow may restart or continue on new server
5. New events have no listener

**Evidence**:
- User mentioned "possible dev server restart"
- This explains why terminal works (reconnects) but agent doesn't (no reconnect)

**Why activity-based makes this worse**:
- Longer tasks = more time for dev server restart to occur
- 10-15 second waits are common during file changes

**Fix**:
1. Add reconnection logic to agent stream
2. Consider using the ring buffer backfill on reconnect

---

### Hypothesis 3: Browser/Proxy Timeout During Long Waits (MEDIUM CONFIDENCE)

**Problem**: Some browsers/proxies close idle connections after a timeout period.

**Server heartbeat config**:
```typescript
// service/src/server.ts:96-115
const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
const heartbeatInterval = setInterval(() => {
  reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
}, heartbeatMs);
```

**Potential issues**:
- Heartbeats are sent (5s prod, 1s dev)
- But frontend agent stream doesn't MONITOR heartbeats
- If connection silently breaks, frontend won't know until next event fails

**Frontend terminal stream monitors heartbeats**:
```typescript
// web/src/App.tsx:635-640
if (timeSinceLastEvent > heartbeatTimeout) {
  scheduleReconnect('heartbeat_timeout')
}
```

**Frontend agent stream does NOT monitor heartbeats**:
- No `lastSseEventTimeRef` tracking
- No heartbeat timeout check
- Relies solely on `error` event (which may not fire immediately)

**Fix**: Add heartbeat monitoring to agent stream.

---

### Hypothesis 4: Race Condition in Event Emission (LOW CONFIDENCE)

**Problem**: If a listener throws during emit, subsequent listeners may not receive the event.

```typescript
// service/src/runtime/event-bus.ts:36-39
for (const listener of listeners) {
  listener(event);  // If this throws, loop stops
}
```

**Scenario**:
1. Client A disconnects
2. Client B is still connected
3. `emit()` iterates: Client A's listener throws (connection closed)
4. Loop breaks, Client B never receives event

**Evidence**: Unlikely to be the primary cause, but could exacerbate other issues.

**Fix**: Wrap listener calls in try-catch:
```typescript
for (const listener of listeners) {
  try {
    listener(event);
  } catch (err) {
    // Log and continue to next listener
  }
}
```

---

### Hypothesis 5: EventSource Buffering/Ordering Issue (LOW CONFIDENCE)

**Problem**: Events emitted in rapid succession may arrive out of order or be buffered.

```typescript
// service/src/agent/agent-service.ts:376-385
this.events.emit(sessionId, { event: "agent.message", ... });
this.events.emit(sessionId, { event: "final", ... });
```

**Scenario**:
1. `agent.message` and `final` emitted back-to-back
2. Browser receives `final` first (network reordering)
3. Frontend closes EventSource on `final`
4. `agent.message` arrives but EventSource is closed

**Evidence**:
- Unlikely - SSE is over HTTP chunked transfer, which preserves order
- TCP guarantees ordering
- EventSource processes events sequentially

**Fix**: If this is an issue, add a small delay before handling `final`:
```typescript
source.addEventListener('final', () => {
  setTimeout(() => {
    source.close()
    // ...
  }, 100)
})
```

---

## Recommended Investigation

### Step 1: Add Console Logging

Add verbose logging to track SSE lifecycle:

```typescript
// Frontend - agent stream
source.addEventListener('open', () => {
  console.log('[agent-sse] connected to', sessionId)
})
source.addEventListener('error', (evt) => {
  console.error('[agent-sse] error', evt)
})
source.addEventListener('heartbeat', () => {
  console.log('[agent-sse] heartbeat')
})
```

### Step 2: Reproduce the Issue

1. Start a long-running agent task (ask Claude to do something complex)
2. Watch console for `[agent-sse]` logs
3. Check if `error` event fires before `final`
4. Try restarting dev server mid-task

### Step 3: Verify Heartbeats

1. Check Network tab in browser DevTools
2. Filter by EventStream
3. Verify heartbeat events are arriving every 1s (dev) / 5s (prod)

---

## Recommended Fixes (Priority Order)

### 1. Add Reconnection Logic to Agent Stream (HIGH PRIORITY)

Mirror the terminal stream's reconnection strategy:

```typescript
const connectAgentStream = (sessionId: string, threadId: string) => {
  const source = new EventSource(buildApiUrl(`/api/sessions/${sessionId}/stream`))
  agentEventSourceRef.current = source

  let heartbeatCheckInterval: NodeJS.Timeout | null = null
  let lastEventTime = Date.now()

  const scheduleReconnect = (reason: string) => {
    source.close()
    if (heartbeatCheckInterval) clearInterval(heartbeatCheckInterval)

    const attempt = agentReconnectAttemptRef.current + 1
    agentReconnectAttemptRef.current = attempt
    const delay = Math.min(5000, 500 * attempt)

    console.warn('[agent-sse] reconnecting', { sessionId, reason, attempt, delay })
    setTimeout(() => connectAgentStream(sessionId, threadId), delay)
  }

  source.addEventListener('open', () => {
    agentReconnectAttemptRef.current = 0
    lastEventTime = Date.now()

    // Start heartbeat monitoring
    const timeout = import.meta.env.DEV ? 3000 : 15000
    heartbeatCheckInterval = setInterval(() => {
      if (Date.now() - lastEventTime > timeout) {
        scheduleReconnect('heartbeat_timeout')
      }
    }, 1000)
  })

  source.addEventListener('heartbeat', () => {
    lastEventTime = Date.now()
  })

  source.addEventListener('error', () => {
    scheduleReconnect('error')
  })

  // ... rest of event handlers
}
```

### 2. Add Try-Catch to Event Emission (MEDIUM PRIORITY)

```typescript
// service/src/runtime/event-bus.ts
emit(channelId: string, event: SseEvent): void {
  // ... buffer logic ...

  const listeners = this.listeners.get(channelId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // Log but don't break the loop
      console.error('SSE listener error', { channelId, event: event.event, err });
    }
  }
}
```

### 3. Add Reconnect Indicator to UI (LOW PRIORITY)

Show user when agent stream is reconnecting:

```typescript
const [agentConnection, setAgentConnection] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
```

---

## Conclusion

**Most likely cause**: Missing reconnection logic in the agent/session SSE stream. The terminal stream has sophisticated reconnection with heartbeat monitoring and exponential backoff, while the agent stream simply closes on error.

**Why it's more noticeable now**: Activity-based readiness detection adds 10-15+ second wait periods during which no agent events are emitted. This increases the window for connection issues to occur, and when they do, the frontend doesn't recover.

**Immediate fix**: Add reconnection logic to the agent stream, matching the terminal stream's implementation.
