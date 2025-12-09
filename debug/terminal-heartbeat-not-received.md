# Debug: Terminal Heartbeat Not Received - SSE Reconnect Loop

**Date:** 2025-12-08
**Status:** Active Investigation
**Symptoms:**
- Frontend logs: `[terminal] no heartbeat received for 3s, connection is stale`
- SSE reconnects every ~3 seconds in an infinite loop
- Terminal connects but keeps reconnecting
- Causes excessive network requests and poor UX

---

## Root Cause Hypothesis

**The SSE stream subscribes to events by `sessionId`, but the heartbeat is sent unconditionally - the heartbeat is ALWAYS being sent. The issue is that the frontend is NOT receiving the heartbeat events.**

### Key Observation

Looking at the SSE stream route in `threads.ts:474-480`:

```typescript
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  if (now - lastHeartbeat >= heartbeatMs) {
    reply.raw.write(`event: heartbeat\ndata: {}\n\n`);
    lastHeartbeat = now;
  }
}, heartbeatMs);
```

This code:
1. Runs a setInterval that sends heartbeats
2. The conditional `if (now - lastHeartbeat >= heartbeatMs)` should ALWAYS be true on first run since `lastHeartbeat = Date.now()` was set before the interval
3. However, `lastHeartbeat` is updated by the callback at line 483, which only fires when terminal events arrive

**Wait - this logic is actually correct.** The heartbeat should always fire on interval.

### Alternative Hypothesis: SSE Connection Never Fully Establishes

The issue might be that `reply.raw.write()` is not actually sending data to the client because:

1. **Fastify/SSE buffering issue:** `reply.raw.flushHeaders()` is called but subsequent writes may be buffered
2. **Missing flush after writes:** Unlike the old implementation using `reply.sse()`, the new manual `reply.raw.write()` may need explicit flushing

### Comparison: Old vs New Implementation

**Old implementation (`server.ts` on `origin/main`):**
```typescript
server.get("/api/terminals/:budId/stream", (request, reply) => {
  const budId = (request.params as { budId: string }).budId;
  const detach = terminalEvents.attach(budId, reply);  // Uses reply.sse()

  const heartbeatInterval = setInterval(() => {
    try {
      reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, heartbeatMs);
  ...
});
```

**New implementation (`threads.ts`):**
```typescript
server.get("/api/threads/:threadId/terminal/stream", async (request, reply) => {
  ...
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    if (now - lastHeartbeat >= heartbeatMs) {
      reply.raw.write(`event: heartbeat\ndata: {}\n\n`);  // Manual write
      lastHeartbeat = now;
    }
  }, heartbeatMs);

  const detach = terminalEvents.attachCallback(session.sessionId, (event) => {
    lastHeartbeat = Date.now();
    reply.raw.write(`event: ${event.event}\ndata: ...`);  // Manual write
  });
  ...
});
```

### Key Differences

| Aspect | Old | New |
|--------|-----|-----|
| SSE method | `reply.sse()` (fastify-sse-v2) | `reply.raw.write()` (manual) |
| Heartbeat data | `{ ts: Date.now() }` | `{}` |
| Headers | Set by fastify-sse-v2 | Set manually |
| Flushing | Handled by plugin | **Not explicitly called** |

---

## Primary Hypothesis: Missing Flush After Write

**`reply.raw.write()` buffers data but doesn't immediately flush to the network.**

In Node.js HTTP streams, `res.write()` may buffer data. For SSE to work correctly, data must be flushed immediately.

### Evidence

Looking at other SSE implementations and the Node.js docs:
- SSE requires data to be sent immediately, not buffered
- `res.flushHeaders()` only flushes headers, not subsequent writes
- Each `write()` may need explicit flushing for real-time delivery

### Solution Options

1. **Use `reply.raw.flush()` or equivalent after each write** (if available)
2. **Switch back to `reply.sse()` from fastify-sse-v2** which handles this internally
3. **Use `reply.raw.cork()` / `reply.raw.uncork()` pattern**
4. **Set socket options:** `reply.raw.socket?.setNoDelay(true)`

---

## Secondary Hypothesis: Event Key Mismatch

Less likely, but worth verifying:

The SSE stream subscribes to `session.sessionId`:
```typescript
const detach = terminalEvents.attachCallback(session.sessionId, (event) => { ... });
```

Events are emitted with `sessionId` in `terminal-session-manager.ts`:
```typescript
this.events.emit(sessionId, { event: "terminal.output", ... });
```

This should match, so this is probably NOT the issue.

---

## Verification Steps

1. **Check if heartbeat is being written:** Add logging to the heartbeat interval
2. **Check if client receives ANY data:** Use browser DevTools Network tab to inspect SSE stream
3. **Test with explicit flush:** Try `reply.raw.socket?.write()` or other flush mechanisms
4. **Compare with working SSE:** The `/api/sessions/:sessionId/stream` endpoint uses `reply.sse()` and works

---

## Files Involved

| File | Issue |
|------|-------|
| `service/src/routes/threads.ts:434-496` | Manual SSE implementation may not flush |
| `service/src/server.ts:115-134` | Old `/api/terminals/:budId/stream` - uses `reply.sse()` |
| `web/src/App.tsx:860-864` | Frontend heartbeat timeout detection |

---

## Recommended Fix

Switch from manual `reply.raw.write()` to using the registered `fastify-sse-v2` plugin's `reply.sse()` method, similar to the old implementation. This ensures proper SSE semantics including flushing.

Alternatively, keep the manual implementation but call the appropriate flush method after each write.
