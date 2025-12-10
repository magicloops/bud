# Bud Disconnect Detection - Debug Investigation

## Problem Statement

When a Bud process disconnects (e.g., we stop the bud process), the frontend UI does not show "reconnecting" or "offline" status. However, when the frontend dev server is killed, the reconnection indicator does appear correctly.

## Architecture Overview

```
┌─────────────┐    SSE     ┌─────────────┐    WebSocket    ┌─────────────┐
│   Frontend  │◄──────────►│   Service   │◄───────────────►│    Bud      │
│   (React)   │ /terminal/ │  (Fastify)  │     /ws         │  (Agent)    │
│             │   stream   │             │                 │             │
└─────────────┘            └─────────────┘                 └─────────────┘
       │                         │                               │
       │ heartbeat check         │ sends heartbeats              │ sends heartbeats
       │ (3s dev, 15s prod)      │ every 1s/5s                   │
       │                         │                               │
```

## Relevant Code Paths

### Frontend (web/src/routes/$budId/$threadId.tsx)

1. **SSE Connection**: `useEffect` at line ~472 establishes EventSource to `/api/threads/:threadId/terminal/stream`

2. **Heartbeat Check** (lines 654-662):
   ```typescript
   const heartbeatTimeout = import.meta.env.DEV ? 3000 : 15000
   const checkInterval = import.meta.env.DEV ? 1000 : 5000
   heartbeatCheckInterval = setInterval(() => {
     const timeSinceLastEvent = Date.now() - lastSseEventTimeRef.current
     if (timeSinceLastEvent > heartbeatTimeout) {
       scheduleReconnect('heartbeat_timeout')
     }
   }, checkInterval)
   ```

3. **Heartbeat Handler** (lines 594-596):
   ```typescript
   const handleHeartbeat = () => {
     lastSseEventTimeRef.current = Date.now()
   }
   ```

### Service (service/src/routes/threads.ts)

**Terminal SSE Endpoint** (lines 462-494):
```typescript
server.get("/api/threads/:threadId/terminal/stream", (request, reply) => {
  // ...
  const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
  const heartbeatInterval = setInterval(() => {
    try {
      reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, heartbeatMs);
});
```

### Gateway (service/src/ws/gateway.ts)

**Bud Disconnect Handling** (lines 764-772):
```typescript
private async handleClose() {
  if (this.state.kind === "connected") {
    sessions.delete(this.state.budId);
    await this.terminalSessionManager.clearCachesForBud(this.state.budId);
    await markBudOffline(this.state.budId, this.server);
  }
  this.state = { kind: "closed" };
}
```

Note: `clearCachesForBud()` only clears in-memory caches (readiness, byte offsets, pending commands). It does **NOT** emit any events to the TerminalEventBus.

---

## Hypotheses

### Hypothesis 1: Service Heartbeats Mask Bud Disconnection (HIGH CONFIDENCE)

**Root Cause**: The service continues sending heartbeats to the frontend even when the bud is offline.

**Evidence**:
- Service heartbeat interval (threads.ts:479-486) runs independently of bud connection state
- Frontend heartbeat check only validates that *some* event was received, not that data is flowing
- When bud disconnects, SSE stream stays alive, heartbeats continue, frontend never times out

**Why FE dev server kill works**:
- Killing FE dev server closes the EventSource entirely
- EventSource `onerror` fires immediately
- Frontend detects connection loss via SSE stream closure, not heartbeat timeout

**Fix**: Either:
- Stop sending heartbeats when bud is offline, OR
- Emit a `terminal.bud_offline` event when bud disconnects

---

### Hypothesis 2: No Event Emitted on Bud Disconnect (HIGH CONFIDENCE)

**Root Cause**: When a bud WebSocket closes, `handleClose()` in gateway.ts does not emit any event to the TerminalEventBus.

**Evidence**:
- `handleClose()` only calls `clearCachesForBud()` and `markBudOffline()`
- `clearCachesForBud()` in terminal-session-manager.ts (lines 1068-1083) clears Maps but emits nothing
- `markBudOffline()` only updates the database
- No `events.emit(sessionId, ...)` call anywhere in the disconnect path

**Contrast with closeSession()**: When `closeSession()` is called explicitly (line 266-272), it DOES emit an event:
```typescript
this.events.emit(sessionId, {
  event: "terminal.status",
  data: { state: "closed", reason },
  id: ulid()
});
```

**Fix**: In `handleClose()` or `clearCachesForBud()`, emit a `terminal.bud_offline` or `terminal.status` event for each affected session.

---

### Hypothesis 3: Frontend Only Detects SSE Stream Closure (MEDIUM CONFIDENCE)

**Root Cause**: The frontend reconnection logic primarily relies on EventSource error events, which only fire when the SSE stream itself breaks.

**Evidence** (line 694-697):
```typescript
source.onerror = (err) => {
  console.warn('[terminal] SSE error', { err, readyState: source.readyState })
  scheduleReconnect(`error ${JSON.stringify(err)}`)
}
```

**Why this matters**:
- Bud disconnect doesn't break the Frontend ↔ Service SSE connection
- EventSource `onerror` never fires because the SSE stream is still valid
- The stream just stops receiving terminal data (but still gets service heartbeats)

---

### Hypothesis 4: Missing Status Event Propagation (MEDIUM CONFIDENCE)

**Root Cause**: Terminal status changes (like bud going offline) aren't propagated through the event bus to SSE clients.

**Evidence**:
- `handleTerminalStatus()` in terminal-session-manager.ts emits `terminal.status` events
- But this is only called when the bud SENDS a `terminal_status` frame
- When bud disconnects abruptly, no `terminal_status` frame is sent
- No server-side mechanism generates synthetic status events on disconnect

**The gap**: Status updates flow from Bud → Service → Frontend, but there's no Service → Frontend flow when the Bud → Service link breaks.

---

### Hypothesis 5: Terminal Operation Failures Not Propagated to UI (LOW CONFIDENCE)

**Root Cause**: When terminal operations fail with `bud_offline` error, this is returned in HTTP responses but not pushed to SSE.

**Evidence** (terminal-session-manager.ts):
```typescript
const sent = sendFrameToBud(session.budId, payload);
if (!sent) {
  this.logger.warn({ sessionId }, "Failed to send terminal_input (bud offline)");
  return { ok: false, error: "bud_offline" };
}
```

**Why this is partial**: User would see "reconnecting" after trying to type (input fails with 503), but they wouldn't see it proactively before interacting.

---

## Recommended Fix

The most impactful fix is a combination of Hypothesis 1 and 2:

1. **When bud disconnects** (`handleClose()` in gateway.ts):
   - Find all terminal sessions for that bud
   - Emit `terminal.status` event with `state: "bud_offline"` for each session
   - This immediately notifies all connected SSE clients

2. **Frontend handling**:
   - Add handler for `terminal.status` with `state: "bud_offline"`
   - Set `terminalConnection` to `'reconnecting'`
   - Existing reconnection polling logic will handle recovery

3. **Optional enhancement** - conditional heartbeats:
   - Check bud connection state before sending heartbeats
   - If bud offline, either skip heartbeat or send `{ ts, bud_offline: true }`

## Implementation Notes

Key files to modify:
- `service/src/ws/gateway.ts` - Add event emission in `handleClose()`
- `service/src/runtime/terminal-session-manager.ts` - Add method to emit offline events for bud's sessions
- `web/src/routes/$budId/$threadId.tsx` - Handle new event type (may already work with existing `terminal.status` handler)

New state to consider:
- `'offline'` as a distinct state from `'reconnecting'` (user requested this as new scope)
- After N reconnect attempts or M seconds, transition from `'reconnecting'` to `'offline'`

---

# Bud Offline at Startup

## Problem Statement

When the service/frontend start and the Bud is already offline, the frontend needs to detect this and show appropriate UI (reconnecting/offline), then recover when the bud comes online.

## Current Behavior

### Flow when Bud is Offline at Startup

1. Frontend loads `/$budId/$threadId` route
2. Terminal SSE `useEffect` runs (line ~472)
3. **FIRST**: Calls `POST /api/threads/:threadId/terminal` to ensure session
4. Service calls `terminalSessionManager.ensureSession()`
5. `ensureSession()` tries `sendFrameToBud()` → returns false (bud not connected)
6. Returns `{ ok: false, error: "bud_offline" }`
7. Service returns **503** with `{ error: "bud_offline" }`
8. Frontend sees `!ensureResp.ok`:
   ```typescript
   if (!ensureResp.ok || cancelled) {
     if (!cancelled) {
       console.warn('[terminal] Failed to ensure terminal session', { status: ensureResp.status })
       setTerminalConnection('disconnected')
       terminalConnectionRef.current = 'disconnected'
     }
     return  // ← STOPS HERE, never connects to SSE
   }
   ```
9. **Result**: User stuck in 'disconnected' state with NO retry mechanism

### Why Reconnection Polling Doesn't Activate

The polling useEffect (lines 709-742) only runs when `terminalConnection === 'reconnecting'`:

```typescript
useEffect(() => {
  if (terminalConnection !== 'reconnecting' || !threadId) return  // ← Guard
  // ... polling logic
}, [terminalConnection, threadId])
```

Since we set state to `'disconnected'` (not `'reconnecting'`), the polling never starts.

---

## Comparison with Original App.tsx

The original App.tsx handled this **differently**:

```typescript
// Original: Connect SSE FIRST, then ensure
source.addEventListener('open', () => {
  // ... set connected state, start heartbeat monitoring

  // Ensure is fire-and-forget, doesn't block SSE
  apiFetch(`/api/terminals/${budId}/ensure`, { method: 'POST' }).catch((err) => {
    console.error('Failed to ensure terminal', err)
  })
  // ... fetch history
})
```

**Key difference**: Original code connected to SSE regardless of ensure success. This meant:
- Heartbeat monitoring still worked
- Reconnection logic could still trigger
- SSE errors would still fire

**New code blocks on ensure**:
```typescript
// New: Ensure FIRST, then SSE (if successful)
const ensureResp = await apiFetch(`/api/threads/${threadId}/terminal`, { method: 'POST' })
if (!ensureResp.ok) {
  setTerminalConnection('disconnected')
  return  // Never connects to SSE!
}
// Only connect SSE if ensure succeeded
const source = new EventSource(...)
```

---

## Hypotheses for Startup Offline Issue

### Hypothesis 6: Blocking Ensure Prevents SSE Connection (HIGH CONFIDENCE)

**Root Cause**: The new route code blocks on `POST /terminal` before connecting SSE. If ensure fails (bud offline), SSE is never established, so no reconnection mechanism activates.

**Evidence**:
- Lines 514-525: ensure failure → return early, never reach line 551 (EventSource)
- Without SSE, heartbeat monitoring never starts
- Without heartbeat monitoring, no `scheduleReconnect()` calls
- Polling useEffect needs `'reconnecting'` state, but we set `'disconnected'`

**Fix Options**:
1. **Change state**: Set `'reconnecting'` instead of `'disconnected'` when ensure fails
2. **Non-blocking ensure**: Connect SSE first, ensure in background (like original)
3. **Expand polling**: Also poll when `terminalConnection === 'disconnected'`

---

### Hypothesis 7: No Bud Online Notification (MEDIUM CONFIDENCE)

**Root Cause**: There's no mechanism to notify the frontend when a bud comes online.

**Evidence**:
- Bud status is tracked in DB (online/offline) via gateway.ts
- When bud connects, `handleHelloProof()` updates DB to 'online'
- But no event is emitted to any bus
- Frontend has no way to know bud came online without polling

**The gap**: Even if we poll `/terminal` endpoint, we're just polling blindly. There's no push notification when bud state changes.

**Fix Options**:
1. **Emit bud_online event**: When bud connects, emit event for all its sessions
2. **Bud status SSE stream**: Add `/api/buds/:budId/status/stream` endpoint
3. **Include bud status in heartbeats**: `{ ts, bud_online: true/false }`

---

### Hypothesis 8: Missing Initial State Check (LOW CONFIDENCE)

**Root Cause**: Frontend doesn't check bud status on load, only terminal session status.

**Evidence**:
- `GET /api/buds` returns `{ status: 'online' | 'offline' }`
- But frontend doesn't use this to inform terminal connection state
- Could show "Bud offline" immediately without waiting for ensure to fail

**Fix**: Check bud status before/alongside terminal ensure, show appropriate UI immediately.

---

## Recommended Fix for Startup Case

### Primary Fix: Non-blocking Ensure (like original)

The original App.tsx architecture was correct: **SSE connection should be established first**, with ensure as a non-blocking background call. This is the recommended approach because:

1. **SSE provides reconnection infrastructure** - heartbeat monitoring, `scheduleReconnect()`, and error handlers all depend on having an active EventSource
2. **Resilient by design** - the SSE stream becomes the source of truth for connection state, not the ensure call
3. **Proven pattern** - the original code worked this way for good reason

**Implementation:**

```typescript
const connect = async () => {
  // Step 1: Create session record in DB (doesn't require bud to be online)
  try {
    const createResp = await apiFetch(`/api/threads/${threadId}/terminal/session`, {
      method: 'POST'
    })
    if (!createResp.ok) {
      // Handle error - but this is a service error, not bud offline
      return
    }
    const { session_id } = await createResp.json()
    currentSessionIdRef.current = session_id
  } catch (err) {
    console.error('[terminal] Failed to create session record', err)
    return
  }

  // Step 2: Connect to SSE immediately (session exists, won't 404)
  const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/terminal/stream`))

  source.addEventListener('open', () => {
    // SSE connected - monitoring infrastructure is now active
    setTerminalConnection('connected')
    terminalConnectionRef.current = 'connected'

    // Step 3: Ensure terminal is running on bud (fire-and-forget)
    apiFetch(`/api/threads/${threadId}/terminal/ensure`, { method: 'POST' })
      .then(resp => {
        if (!resp.ok) {
          console.warn('[terminal] Bud offline, terminal not ready yet')
          // Don't change connection state - SSE is still connected
          // Bud coming online will trigger terminal_status events
        }
      })
      .catch(err => console.error('[terminal] Failed to ensure', err))

    // Start heartbeat monitoring, fetch history, etc.
  })

  // Error/reconnect handlers work as before
  source.onerror = () => scheduleReconnect('error')
}
```

**Key insight**: "Bud offline" means the terminal won't work yet, but the **monitoring infrastructure remains in place** to detect when it does (via `terminal.status` events or heartbeat checks).

**API changes needed**:
- Split current `POST /api/threads/:threadId/terminal` into:
  - `POST /terminal/session` - create/get session record (DB only, no bud communication)
  - `POST /terminal/ensure` - ensure terminal running on bud (may fail if offline)
- OR modify existing endpoint to return success even if bud offline, with `{ session_id, bud_online: false }`

---

### Complementary Fix: Add Bud Status Events (Option C)

While non-blocking ensure fixes the startup case, adding bud status events provides **immediate notification** when bud state changes, rather than relying on polling or operation failures.

**Benefits beyond the startup fix:**

1. **Instant disconnect detection** - Frontend knows immediately when bud goes offline, not after heartbeat timeout or failed operation
2. **Instant reconnect notification** - When bud comes back online, frontend can immediately re-ensure and restore terminal
3. **Better UX** - Can show "Bud disconnected" vs "Reconnecting to service" vs "Terminal error"
4. **Enables offline→reconnecting→offline state machine** - Can track how long bud has been offline and transition states appropriately

**Implementation:**

1. **Service emits events on bud state change** (in gateway.ts):
   ```typescript
   // In handleClose() - bud disconnected
   await this.terminalSessionManager.emitBudOfflineForSessions(this.state.budId)

   // In handleHelloProof() - bud connected
   await this.terminalSessionManager.emitBudOnlineForSessions(budId)
   ```

2. **TerminalSessionManager emits to event bus**:
   ```typescript
   async emitBudOfflineForSessions(budId: string): Promise<void> {
     const sessions = await this.getSessionsForBud(budId)
     for (const session of sessions) {
       this.events.emit(session.sessionId, {
         event: "terminal.bud_offline",
         data: { budId, reason: "disconnected" },
         id: ulid()
       })
     }
   }
   ```

3. **Frontend handles events**:
   ```typescript
   source.addEventListener('terminal.bud_offline', () => {
     setTerminalConnection('reconnecting')
     setTerminalDisconnectTime(Date.now())
   })

   source.addEventListener('terminal.bud_online', () => {
     // Re-ensure terminal
     apiFetch(`/api/threads/${threadId}/terminal/ensure`, { method: 'POST' })
   })
   ```

---

### Fallback Option: Change to 'reconnecting' state

If the above changes are too invasive, a minimal fix is to change `'disconnected'` to `'reconnecting'` when ensure fails:

```typescript
if (!ensureResp.ok || cancelled) {
  if (!cancelled) {
    console.warn('[terminal] Failed to ensure terminal session', { status: ensureResp.status })
    setTerminalConnection('reconnecting')  // Changed from 'disconnected'
    terminalConnectionRef.current = 'reconnecting'
    setTerminalDisconnectTime(Date.now())
  }
  return
}
```

This activates the existing polling mechanism (lines 709-742), but is a **workaround** rather than a proper fix - it just polls ensure repeatedly without the benefits of SSE monitoring.

---

## Summary: All Issues

| Scenario | Root Cause | Quick Fix |
|----------|------------|-----------|
| Bud disconnects while connected | No event emitted, heartbeats mask | Emit `terminal.status` event |
| Bud offline at startup | Blocking ensure prevents SSE | Set `'reconnecting'` not `'disconnected'` |
| Bud comes back online | No notification mechanism | Emit event or check in heartbeat |
| Distinguish reconnecting vs offline | No timeout tracking | Add timer to transition states |
