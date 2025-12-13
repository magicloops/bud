# Debug: Agent SSE Stream 404 After Legacy Code Removal

## Environment

- Service: Node.js/Fastify
- Web: React/Vite
- Changes: Legacy code removal (see `plan/legacy-code-removal.md`)

## Repro Steps

1. Navigate to a thread in the web UI
2. Send a message to trigger the agent
3. Observe server logs and browser console

## Observed

**Server logs:**
```
Route GET:/api/sessions/sess_01KC06JN4P320JCD8AHMGWKNXM/stream not found
```

**Browser console:**
```
[agent-sse] reconnecting {sessionId: 'sess_01KC06JN4P320JCD8AHMGWKNXM', reason: 'connection_error', attempt: 30, delay: 5000}
GET http://localhost:5173/api/sessions/sess_01KC06JN4P320JCD8AHMGWKNXM/stream 404 (Not Found)
```

The frontend continuously retries connecting to a non-existent endpoint.

## Expected

Agent events should flow through the terminal stream or a dedicated working endpoint.

## Root Cause Analysis

### The Removed Endpoint

During the legacy code removal, we deleted:
- `service/src/routes/sessions.ts` - contained the `/api/sessions/:sessionId/stream` SSE endpoint
- `service/src/ws/term-gateway.ts` - legacy WebSocket gateway
- `service/src/runtime/session-manager.ts` - legacy `SessionEventBus`

### Current Event Flow

**Server-side (after refactor):**
1. `POST /api/threads/:threadId/messages` returns `{ sessionId }` from `agentService.startUserMessage()`
2. `startUserMessage()` gets/creates a terminal session and returns its `sessionId`
3. `runAgentFlow()` emits events to `TerminalEventBus` using `sessionId` as channel:
   - `agent.tool_call`
   - `agent.tool_result`
   - `agent.message`
   - `final`
4. `/api/threads/:threadId/terminal/stream` subscribes to `TerminalEventBus` using `session.sessionId`

**This means agent events ARE being emitted to the same event bus and channel as terminal events.**

**Frontend-side (still using old pattern):**
1. Opens terminal SSE: `GET /api/threads/:threadId/terminal/stream`
   - Listens for: `terminal.output`, `terminal.status`, `terminal.ready`, `heartbeat`
2. After message submit, opens SEPARATE agent SSE: `GET /api/sessions/${sessionId}/stream`
   - Listens for: `agent.tool_call`, `agent.tool_result`, `agent.message`, `final`

### The Mismatch

The frontend expects two separate SSE streams:
1. Terminal stream (working) - receives terminal events
2. Agent stream (BROKEN) - endpoint was removed

But the server now emits ALL events (terminal AND agent) to the SAME event bus and channel (`session.sessionId`).

## Solution Options

### Option A: Frontend merges listeners onto terminal stream (Recommended)

The agent events are already being emitted to `TerminalEventBus` with `sessionId`. Since the terminal stream subscribes to the same channel, the frontend just needs to:

1. Remove the separate `connectAgentStream()` function
2. Add agent event listeners to the terminal stream
3. Update state management to handle agent lifecycle through terminal stream

**Pros:**
- Single SSE connection (simpler, more efficient)
- No server changes needed
- Aligns with the refactored architecture

**Cons:**
- Requires frontend refactor
- Agent events and terminal events mixed on one stream (already happening server-side)

### Option B: Create new agent stream endpoint

Add a new endpoint like `/api/threads/:threadId/agent/stream` that also subscribes to `TerminalEventBus`.

**Pros:**
- Minimal frontend changes (just update URL)
- Keeps separation of concerns in frontend

**Cons:**
- Two SSE connections per thread
- Duplicates event subscription
- More complex reconnection logic

### Option C: Restore legacy endpoint at new location

Create `/api/threads/:threadId/session/stream` that forwards to terminal event bus.

**Pros:**
- Cleaner URL structure
- Moderate frontend changes

**Cons:**
- Still two connections
- Conceptually confusing (what is "session" vs "terminal"?)

## Recommended Fix (Option A)

### Files to Modify

**`web/src/routes/$budId/$threadId.tsx`:**

1. Remove `agentEventSourceRef`, `agentReconnectTimerRef`, `agentReconnectAttemptRef`, `lastAgentEventTimeRef`, `agentSessionIdRef`, `agentThreadIdRef`

2. Remove `connectAgentStream()` function entirely (lines ~343-473)

3. Add agent event listeners to terminal stream (in the `connect()` function around line 559):
```typescript
source.addEventListener('agent.tool_call', (evt) => {
  lastSseEventTimeRef.current = Date.now()
  try {
    const data = JSON.parse(evt.data)
    console.log('[terminal] agent.tool_call', data.name, data.args)
  } catch (e) {
    console.warn('[terminal] failed to parse agent.tool_call', e)
  }
})

source.addEventListener('agent.tool_result', () => {
  lastSseEventTimeRef.current = Date.now()
})

source.addEventListener('agent.message', (evt) => {
  lastSseEventTimeRef.current = Date.now()
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
    console.warn('[terminal] failed to parse agent.message', e)
  }
})

source.addEventListener('final', (evt) => {
  lastSseEventTimeRef.current = Date.now()
  console.log('[terminal] final event received')
  setStatus('idle')
  if (threadId) {
    fetchMessages(threadId).catch((err) => {
      console.error('[terminal] failed to fetch final messages', err)
    })
  }
})
```

4. Update `handleSubmit()` (around line 892):
   - Remove the call to `connectAgentStream(sessionId, threadId)`
   - The terminal stream is already connected and will receive agent events
   - Keep setting `setStatus('streaming')` to show agent is active

5. Update `cancelAgentTurn()`:
   - Remove agent stream cleanup (it no longer exists)
   - Keep the API call to `POST /api/threads/:threadId/cancel`

### Verification Steps

1. Server: Agent events are emitted to `TerminalEventBus.emit(sessionId, event)`
2. Server: Terminal stream subscribes to `terminalEvents.attach(session.sessionId, reply)`
3. Verify `session.sessionId` matches the `sessionId` returned by `startUserMessage()`
4. Frontend: Terminal stream receives both terminal AND agent events

## Code References

- Agent emits events: `service/src/agent/agent-service.ts:271-370`
- Terminal stream subscribes: `service/src/routes/threads.ts:469-500`
- Frontend terminal stream: `web/src/routes/$budId/$threadId.tsx:476-788`
- Frontend agent stream (to remove): `web/src/routes/$budId/$threadId.tsx:343-473`
- Message submit handler: `web/src/routes/$budId/$threadId.tsx:892-948`

---

*Created: 2025-12-12*
*Status: Analysis Complete - Ready for Implementation*
