# Debug: Agent SSE Disconnect Investigation

**Date:** 2025-12-17
**Status:** ✅ Fixed
**Symptom:** User reports `[agent-sse] final event received` in console, new messages not showing up

## Root Cause (Confirmed)

The **event buffer was not cleared between agent runs**. When a new agent run started:

1. Buffer contained events from previous run: `[old_tool_call, old_result, old_final]`
2. New agent started, added events: `[old_events..., old_final, new_tool_call, new_result...]`
3. Frontend SSE connected, backend replayed **all** buffered events
4. `old_final` event was processed → stream closed prematurely
5. New events after `old_final` were never delivered

## Fix Applied

Added `this.events.clearBuffer(threadId)` at the start of `startUserMessage()` in `agent-service.ts:233-235`:

```typescript
// Clear old agent events (especially `final`) so new SSE connections
// don't receive stale events from previous runs
this.events.clearBuffer(threadId);
```

This ensures each agent run starts with a clean buffer.

---

## 1. Executive Summary

The agent SSE stream **does have reconnection logic**, but the `final` event is **intentionally terminal** - once received, reconnection is disabled by design. The issue is likely that:

1. The `final` event arrives correctly (agent completed)
2. But `fetchMessages()` after `final` either fails silently or messages aren't updating the UI
3. OR the stream connects and immediately receives a buffered `final` event from a previous agent run

---

## 2. Architecture Overview

### 2.1 Agent SSE Flow

```
┌────────────────┐         ┌────────────────┐         ┌────────────────┐
│   Frontend     │  SSE    │   Service      │ Events  │  AgentService  │
│  (browser)     │◄────────│ /agent/stream  │◄────────│  runAgentFlow  │
└────────────────┘         └────────────────┘         └────────────────┘
        │                          │                          │
        │ EventSource()            │ attach()                 │
        ├─────────────────────────►│                          │
        │                          │ Replay buffered events   │
        │ ◄─────────────────────────────────────────────────┤
        │                          │                          │
        │ heartbeat (1s dev)       │                          │
        │ ◄─────────────────────────                          │
        │                          │                          │
        │                          │ agent.tool_call          │
        │ ◄─────────────────────────────────────────────────┤
        │                          │                          │
        │                          │ agent.tool_result        │
        │ ◄─────────────────────────────────────────────────┤
        │                          │                          │
        │                          │ agent.message            │
        │ ◄─────────────────────────────────────────────────┤
        │                          │                          │
        │                          │ final                    │
        │ ◄─────────────────────────────────────────────────┤
        │                          │                          │
        │ fetchMessages()          │                          │
        ├─────────────────────────►│                          │
        │                          │                          │
        │ Close EventSource        │                          │
        X──────────────────────────X                          │
```

### 2.2 Key Files

| File | Location | Purpose |
|------|----------|---------|
| Thread View | `web/src/routes/$budId/$threadId.tsx` | Agent SSE client (lines 376-544) |
| New Thread View | `web/src/routes/$budId/new.tsx` | Creates thread, posts message, navigates |
| Agent Stream Endpoint | `service/src/routes/threads.ts:399-421` | SSE endpoint with heartbeat |
| Agent Service | `service/src/agent/agent-service.ts` | Emits events during agent run |
| Event Bus | `service/src/runtime/event-bus.ts` | Buffers events, replays on attach |

---

## 3. Current Reconnection Implementation

### 3.1 Frontend Reconnection Logic

**File:** `web/src/routes/$budId/$threadId.tsx`

```typescript
// Lines 395-409 - Reconnection with exponential backoff
const scheduleReconnect = (reason: string) => {
  cleanupAgent()
  const nextAttempt = agentReconnectAttemptRef.current + 1
  agentReconnectAttemptRef.current = nextAttempt
  const delay = Math.min(5000, 500 * nextAttempt)  // 500ms, 1s, 1.5s, ... max 5s
  console.warn('[agent-sse] reconnecting', { threadId, reason, attempt, delay })
  agentReconnectTimerRef.current = setTimeout(() => {
    if (agentThreadIdRef.current) {  // Only if thread still active
      connectAgentStream(agentThreadIdRef.current)
    }
  }, delay)
}
```

**Heartbeat monitoring (lines 423-431):**
```typescript
const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
const checkInterval = import.meta.env.DEV ? 1000 : 5000
heartbeatCheckInterval = setInterval(() => {
  const timeSinceLastEvent = Date.now() - lastAgentEventTimeRef.current
  if (timeSinceLastEvent > heartbeatTimeout) {
    scheduleReconnect('heartbeat_timeout')
  }
}, checkInterval)
```

### 3.2 The `final` Event Handler - THE KEY

**File:** `web/src/routes/$budId/$threadId.tsx:486-501`

```typescript
source.addEventListener('final', () => {
  lastAgentEventTimeRef.current = Date.now()
  console.log('[agent-sse] final event received')  // ← USER SEES THIS

  // Cancel any pending reconnection
  if (agentReconnectTimerRef.current) {
    clearTimeout(agentReconnectTimerRef.current)
    agentReconnectTimerRef.current = null
  }

  // ⚠️ CRITICAL: This disables reconnection permanently for this run
  agentThreadIdRef.current = null

  cleanupAgent()
  setStatus('idle')

  // Fetch final messages from DB
  if (threadId) {
    fetchMessages(threadId).catch((err) => {
      console.error('[agent-sse] failed to fetch final messages', err)
    })
  }
})
```

**Key insight:** `agentThreadIdRef.current = null` stops all future reconnection attempts. This is **intentional** - once the agent completes, there's nothing more to stream.

### 3.3 Backend Event Emission

**File:** `service/src/agent/agent-service.ts`

Events are emitted to `AgentEventBus` at these points:

| Event | When | Lines |
|-------|------|-------|
| `agent.tool_call` | Before executing tool | 273-281 |
| `agent.tool_result` | After tool execution | 318-330 |
| `agent.message` | Agent's final text | 347-351 |
| `final` (success) | Agent completes | 352-356 |
| `final` (canceled) | User cancels | 375-382 |
| `final` (error) | Agent fails | 386-393 |

### 3.4 Event Buffer Replay

**File:** `service/src/runtime/event-bus.ts:67-74`

```typescript
// On attach, replay all buffered events
const buffer = this.buffers.get(channelId) ?? [];
reply.log.info({ channelId, buffered: buffer.length }, "SSE listener attached");
for (const event of buffer) {
  listener(event);
}
```

**Buffer limit:** 1000 events per channel (line 20)

---

## 4. Potential Root Causes

### 4.1 Scenario A: `final` Arrives Immediately on Connect (Buffer Replay)

**Most Likely Cause**

**Flow:**
1. User posts message on `/new` route
2. Navigate to `/$threadId` immediately
3. Agent completes **very quickly** (before or during navigation)
4. Events buffered: `[tool_call, tool_result, agent.message, final]`
5. Frontend connects to SSE
6. Event bus replays all buffered events
7. `final` is received, stream closes
8. **`fetchMessages()` runs, but...**

**Possible issues:**
- `fetchMessages()` may complete but state update races with navigation
- The `final` event may replay before `agent.message`, causing messages to be missing
- React state updates are async - UI may not reflect new messages immediately

### 4.2 Scenario B: `fetchMessages()` Failing Silently

**Check console for:**
```
[agent-sse] failed to fetch final messages: ...
```

If not present, `fetchMessages()` succeeded but:
- State update (`setMessages`) might not trigger re-render
- Message data might be stale (still has temporary optimistic IDs)

### 4.3 Scenario C: Agent Run Already Complete Before Navigation

When navigating from `/new`:
1. Thread created, message posted, agent starts
2. Navigate to `/$threadId`
3. **Agent may have already finished** before SSE connects
4. SSE connects → gets buffered `final` → immediately closes
5. This is **expected behavior** - just need to ensure `fetchMessages()` works

### 4.4 Scenario D: Race Between Agent SSE and Initial Loader

**File:** `web/src/routes/$budId/$threadId.tsx:26-32`

```typescript
loader: async ({ params }) => {
  const messagesResp = await fetch(`/api/threads/${params.threadId}/messages?limit=200`)
  const messages = messagesResp.ok ? ((await messagesResp.json()) as ApiMessage[]) : []
  return { messages }
}
```

The loader runs **before** the component mounts. If:
1. Loader fetches messages (agent still running or just finished)
2. Component mounts with loader data
3. Agent SSE connects → gets `final` → closes
4. `fetchMessages()` runs but its result may be **ignored** because `initialMessages` is used

**Check:** Line 137 - `useEffect(() => { setMessages(initialMessages) }, [initialMessages])`

This syncs state with loader data, but if `fetchMessages()` completes **after** this, it should update.

---

## 5. Diagnostic Steps

### 5.1 Add Detailed Console Logging

Temporarily add this logging to `$threadId.tsx`:

```typescript
// Around line 361
const fetchMessages = useCallback(async (thread: string | null) => {
  console.log('[agent-sse] fetchMessages called', { thread, currentMessagesCount: messages.length })
  if (!thread) {
    setMessages([])
    return
  }
  const resp = await apiFetch(`/api/threads/${thread}/messages?limit=200`)
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    console.error('[agent-sse] fetchMessages failed', { status: resp.status, body })
    throw new Error(body.error ?? `HTTP ${resp.status}`)
  }
  const data = (await resp.json()) as ApiMessage[]
  console.log('[agent-sse] fetchMessages success', { count: data.length, ids: data.map(m => m.message_id) })
  setMessages(data)
}, [])
```

Also add to event handlers:

```typescript
source.addEventListener('open', () => {
  console.log('[agent-sse] 🟢 OPEN', { threadId: agentThreadId, wasReconnect, timestamp: Date.now() })
  // ...
})

source.addEventListener('agent.tool_call', (evt) => {
  console.log('[agent-sse] 🔧 TOOL_CALL', { timestamp: Date.now(), data: evt.data })
  // ...
})

source.addEventListener('agent.message', (evt) => {
  console.log('[agent-sse] 💬 MESSAGE', { timestamp: Date.now(), data: evt.data })
  // ...
})

source.addEventListener('final', () => {
  console.log('[agent-sse] 🏁 FINAL', { timestamp: Date.now() })
  // ...
})
```

### 5.2 Check Network Tab

1. Open DevTools → Network
2. Filter by "EventStream" or look for `/agent/stream`
3. Click the request
4. View "EventStream" tab to see all received events
5. Verify the order: should be `open` → (heartbeat) → `tool_call` → `tool_result` → `message` → `final`

### 5.3 Check Backend Logs

Look for SSE event emissions:
```
SSE event emit { channelId: '<threadId>', event: 'agent.tool_call', component: 'sse' }
SSE event emit { channelId: '<threadId>', event: 'agent.message', component: 'sse' }
SSE event emit { channelId: '<threadId>', event: 'final', component: 'sse' }
```

Also check buffer replay:
```
SSE listener attached { channelId: '<threadId>', buffered: 5, component: 'sse' }
```

If `buffered: N` is non-zero, all N events are replayed immediately on connect.

### 5.4 Verify Message Fetch After Final

Check for:
- `[agent-sse] failed to fetch final messages` error
- Network request to `/api/threads/:threadId/messages` after stream closes
- Response status and body

---

## 6. Potential Fixes

### 6.1 Immediate Fix: Force Re-fetch on Mount

If the issue is stale loader data, add a post-mount fetch:

```typescript
// In $threadId.tsx, add after agent SSE effect
useEffect(() => {
  if (threadId) {
    // Small delay to let any SSE events settle
    const timer = setTimeout(() => {
      fetchMessages(threadId).catch(err => {
        console.error('[mount] failed to fetch messages', err)
      })
    }, 500)
    return () => clearTimeout(timer)
  }
}, [threadId])
```

### 6.2 Don't Auto-Connect SSE on Mount for New Navigations

Currently (lines 521-544), SSE auto-connects on mount. This causes immediate `final` replay.

**Option:** Only connect SSE when user sends a new message, not on initial mount:

```typescript
useEffect(() => {
  if (!threadId) return

  // Don't auto-connect on initial navigation - let loader data suffice
  // SSE will be connected when user sends a new message
  return () => {
    agentEventSourceRef.current?.close()
    agentThreadIdRef.current = null
  }
}, [threadId])
```

Then connect in `handleSubmit`:
```typescript
// After successful message POST
connectAgentStream(threadId)
```

### 6.3 Clear Agent Event Buffer on `final`

If the buffer retains `final` events, new connects get stale `final`:

**In `service/src/agent/agent-service.ts`, after emitting `final`:**
```typescript
this.events.emit(threadId, {
  event: "final",
  data: { status: directive.status, text: directive.message },
  id: ulid()
});

// Clear buffer so new listeners don't get stale final
this.events.clearBuffer(threadId);  // ← Add this
```

**Note:** `clearBuffer()` already exists in `event-bus.ts:50-52`.

### 6.4 Delay `fetchMessages()` After Final

The current code runs `fetchMessages()` immediately after `final`. If the DB hasn't been updated yet (race condition), it may return stale data:

```typescript
source.addEventListener('final', () => {
  // ... cleanup ...
  if (threadId) {
    // Give backend a moment to persist final message
    setTimeout(() => {
      fetchMessages(threadId).catch((err) => {
        console.error('[agent-sse] failed to fetch final messages', err)
      })
    }, 100)  // 100ms delay
  }
})
```

---

## 7. Test Scenarios

### 7.1 Normal Flow (Agent Takes >2 seconds)

1. Post message
2. Navigate to thread
3. SSE connects, sees heartbeats
4. Agent events stream in: tool_call → tool_result → message → final
5. fetchMessages() runs
6. Messages appear in UI

**Expected:** Works correctly

### 7.2 Fast Agent (<500ms)

1. Post message on /new
2. Agent finishes before navigation completes
3. Navigate to thread
4. SSE connects
5. Buffer replays: [all events including final]
6. Stream closes immediately
7. fetchMessages() runs

**Check:** Do messages appear? If not, this is the bug.

### 7.3 Multiple Rapid Messages

1. User sends message
2. Agent completes
3. User sends another message quickly
4. Does SSE properly reconnect for second run?

**Check:** `agentThreadIdRef.current` should be set again when `handleSubmit` calls `connectAgentStream`.

---

## 8. Summary

| Aspect | Status | Notes |
|--------|--------|-------|
| Reconnection logic | ✅ Implemented | Exponential backoff, heartbeat monitoring |
| Heartbeat | ✅ Working | 1s dev / 5s prod |
| Buffer replay | ✅ Working | Up to 1000 events |
| Final event handling | ✅ Correct | Closes stream, fetches messages |
| Auto-connect on mount | ⚠️ May cause issues | Gets buffered `final` if agent already done |
| fetchMessages after final | ⚠️ Investigate | May fail silently or race with state updates |

### Most Likely Issue

The stream connects on navigation, receives buffered `final` immediately, closes, and either:
1. `fetchMessages()` fails silently (check console for errors)
2. `fetchMessages()` succeeds but UI doesn't update (React state race)
3. Messages are fetched but component uses stale loader data

### Recommended Next Steps

1. Add detailed logging (Section 5.1)
2. Check Network tab for event order (Section 5.2)
3. Implement buffer clear on final (Section 6.3)
4. Consider not auto-connecting SSE on mount (Section 6.2)

---

*Created: 2025-12-17*
