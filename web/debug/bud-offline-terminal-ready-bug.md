# Bug: Terminal Shows Ready When Bud is Offline

## Problem Statement

When the bud is offline (either at startup or after disconnecting), the frontend still shows the terminal as "ready" or "idle" and allows xterm.js interaction. The disconnected/reconnecting overlay does not appear.

## Root Cause Analysis

### The Bug: ensureSession Returns Success Without Checking Bud Status

In `service/src/runtime/terminal-session-manager.ts` lines 202-205:

```typescript
async ensureSession(sessionId: string): Promise<{ ok: boolean; resumed: boolean; ... }> {
  // ...

  // If already ready/active/idle, just return success (resumed)
  if (session.state === "ready" || session.state === "active" || session.state === "idle") {
    return { ok: true, resumed: true };  // ← BUG: Returns success without checking bud!
  }

  // Only reaches here if state is "pending" or "creating"
  const sent = sendFrameToBud(session.budId, payload);
  if (!sent) {
    return { ok: false, resumed: false, error: "bud_offline" };
  }
  // ...
}
```

**The problem**: If the session state in the database is "ready", "active", or "idle" (from a previous successful connection), `ensureSession` returns `{ ok: true }` **without verifying the bud is actually online**.

### Why Session State Persists

When a bud disconnects (`handleClose()` in gateway.ts):

```typescript
private async handleClose() {
  if (this.state.kind === "connected") {
    sessions.delete(this.state.budId);
    await this.terminalSessionManager.clearCachesForBud(this.state.budId);  // Only clears in-memory caches
    await this.terminalSessionManager.emitBudOfflineForSessions(this.state.budId);  // Emits events
    await markBudOffline(this.state.budId, this.server);  // Updates bud status in DB
  }
  // ← NO update to terminal session states in DB!
}
```

The session states in the database are **NOT updated** when a bud disconnects. Sessions remain in "ready/active/idle" state indefinitely.

### The Flow That Causes the Bug

1. **Previous session**: User had a working terminal session, state is "ready" in DB
2. **Bud disconnects**: Gateway clears caches, emits events, but session state stays "ready"
3. **Frontend loads** (new page load or reconnect):
   - Creates session record (already exists, returns existing)
   - Connects to SSE stream
   - Calls `POST /terminal/ensure`
   - `ensureSession` sees state is "ready", returns `{ ok: true, resumed: true }`
   - Frontend thinks terminal is ready, stays in "connected" state
4. **User tries to type**: Input fails with 503, but by then they've already seen a "ready" terminal

### Secondary Issue: Event Buffer Replay

The `TerminalEventBus` buffers up to 1000 events and replays them when a client connects:

```typescript
// In event-bus.ts attach()
const buffer = this.buffers.get(channelId) ?? [];
for (const event of buffer) {
  listener(event);  // Replays ALL old events
}
```

This means:
- Old `terminal.status` events with state "ready" get replayed
- Frontend's `handleStatus` sets `terminalState` to "ready"
- Even if we correctly detect bud offline in ensure, buffered events can override it

---

## Hypotheses

### Hypothesis 1: ensureSession Short-Circuits on DB State (CONFIRMED - ROOT CAUSE)

`ensureSession()` checks DB state and returns success if "ready/active/idle" without verifying bud is online.

**Evidence**: Lines 202-205 in terminal-session-manager.ts
```typescript
if (session.state === "ready" || session.state === "active" || session.state === "idle") {
  return { ok: true, resumed: true };
}
```

**Fix**: Always check bud online status, or update session states when bud disconnects.

---

### Hypothesis 2: Session States Not Updated on Bud Disconnect (CONFIRMED - CONTRIBUTING)

When bud disconnects, `handleClose()` doesn't update terminal session states in the database.

**Evidence**: `handleClose()` only calls:
- `clearCachesForBud()` - clears in-memory state only
- `emitBudOfflineForSessions()` - emits events only
- `markBudOffline()` - updates bud status only

**Fix**: Update all terminal sessions for the bud to a suspended/disconnected state.

---

### Hypothesis 3: Event Buffer Replays Old "Ready" Status (MEDIUM CONFIDENCE)

Old `terminal.status` events in the buffer get replayed, overriding any state we set.

**Evidence**: `event-bus.ts` replays all buffered events on attach (lines 60-67)

**Fix**: Either:
- Clear buffer for session when bud disconnects
- Filter out stale status events
- Send a fresh status event after bud_offline that takes precedence

---

### Hypothesis 4: Race Between Ensure Response and Buffered Events (LOW CONFIDENCE)

The ensure call is async, and buffered events might arrive after we set state.

**Sequence**:
1. SSE connects, buffered events start flowing
2. 'open' fires, we call ensure (async)
3. Buffered `terminal.status` arrives, sets state to "ready"
4. Ensure response arrives (even if it would fail, it's too late)

**Fix**: Handle terminal state more carefully, don't let status events override bud_offline state.

---

## Recommended Fixes

### Fix 1: Update Session States When Bud Disconnects (Primary)

In `handleClose()` or a new method, update all sessions for the bud:

```typescript
async suspendSessionsForBud(budId: string): Promise<void> {
  await db
    .update(terminalSessionTable)
    .set({ state: "suspended" })  // New state
    .where(
      and(
        eq(terminalSessionTable.budId, budId),
        inArray(terminalSessionTable.state, ["ready", "active", "idle"]),
        isNull(terminalSessionTable.closedAt)
      )
    );
}
```

This ensures `ensureSession` won't short-circuit on stale "ready" state.

### Fix 2: Check Bud Online Status in ensureSession (Alternative)

```typescript
async ensureSession(sessionId: string): Promise<...> {
  const session = await this.getSession(sessionId);
  // ...

  // Even if state looks ready, verify bud is online
  if (session.state === "ready" || session.state === "active" || session.state === "idle") {
    // Check if we can actually reach the bud
    const budOnline = isBudOnline(session.budId);  // Check sessions Map
    if (!budOnline) {
      return { ok: false, resumed: false, error: "bud_offline" };
    }
    return { ok: true, resumed: true };
  }
  // ...
}
```

### Fix 3: Clear Event Buffer on Bud Disconnect (Complementary)

Add method to clear stale events:

```typescript
// In TerminalEventBus
clearBuffer(channelId: string): void {
  this.buffers.delete(channelId);
}

// In handleClose
for (const session of sessions) {
  terminalEvents.clearBuffer(session.sessionId);
}
```

### Fix 4: Frontend State Priority (Defensive)

In frontend, don't let `terminal.status` events override `bud_offline` state:

```typescript
const handleStatus = (event: MessageEvent) => {
  // Don't let status events override bud_offline
  if (terminalConnectionRef.current === 'reconnecting' ||
      terminalConnectionRef.current === 'offline') {
    return;
  }
  // ... existing logic
}
```

---

## Summary

| Issue | Severity | Fix |
|-------|----------|-----|
| ensureSession short-circuits on DB state | HIGH | Check bud online status or update states on disconnect |
| Session states not updated on disconnect | HIGH | Update to "suspended" state in handleClose |
| Event buffer replays old status | MEDIUM | Clear buffer on disconnect |
| Frontend state override race | LOW | Add state priority logic |

The primary fix should be updating session states when bud disconnects (Fix 1), combined with either Fix 2 (verify bud online in ensureSession) or Fix 3 (clear event buffer).
