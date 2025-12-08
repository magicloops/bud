# Plan: Fix Agent Message Streaming to Web Client

**Status: ✅ IMPLEMENTED (2025-12-02)**

## Problem Statement

Agent messages don't stream to the web client in real-time. Users must refresh the page to see agent responses.

## Background

This functionality **used to work** on `origin/main`. During the interactive sessions refactor, the streaming connection was broken.

## Solution Implemented

Used **Option A: Use Existing Session Stream** - wired up the web client to connect to `/api/sessions/:sessionId/stream` after posting a message.

**Changes made to `web/src/App.tsx`:**
1. Added `agentEventSourceRef` to track agent SSE connection
2. Updated `handleSendMessage` to capture `sessionId` from POST response and open EventSource
3. Added event handlers for `agent.tool_call`, `agent.message`, `final`, and `error`
4. Updated `cancelAgentTurn` to close SSE immediately
5. Updated cleanup effect to close agent SSE on unmount

---

## Investigation Results (2025-12-02)

### What `origin/main` Had (Working)

**1. Server (`service/src/server.ts`):**
- Single SSE endpoint: `/api/runs/:runId/stream`
- Agent emitted events to `runId`

**2. Agent Service (`service/src/agent/agent-service.ts`):**
```typescript
// Emitted to runId
this.events.emit(runId, {
  event: "agent.tool_call",
  data: { id, name: toolCall.tool, args: { command, cwd } }
});

this.events.emit(runId, {
  event: "agent.message",
  data: { text: directive.message }
});

this.events.emit(runId, {
  event: "final",
  data: { status, text }
});
```

**3. Web Client (`web/src/App.tsx`):**
```typescript
// After getting runId, connected to SSE
const source = new EventSource(`/api/runs/${id}/stream`)
eventSourceRef.current = source
setStatus('streaming')

source.addEventListener('status', (evt) => { ... })
source.addEventListener('exec.stdout', (evt) => { ... })
source.addEventListener('exec.stderr', (evt) => { ... })
// etc.
```

**Flow on `origin/main`:**
```
Web Client                    Server                         Agent
    │                            │                              │
    │ POST /threads/:id/messages │                              │
    │───────────────────────────>│                              │
    │                            │ returns { runId }            │
    │<───────────────────────────│                              │
    │                            │                              │
    │ GET /api/runs/:runId/stream│                              │
    │───────────────────────────>│ (SSE connected)              │
    │                            │                              │
    │                            │ runAgentFlow()               │
    │                            │─────────────────────────────>│
    │                            │                              │
    │                            │<── emit(runId, msg) ─────────│
    │<── SSE: agent.message ─────│                              │
    │    (message appears!)      │                              │
```

### What Changed in This Branch (Broken)

**1. Agent Service refactored:**
- Changed from `runId` to `sessionId`
- `startUserMessage()` returns `{ sessionId }` instead of `{ runId }`
- Agent emits to `sessionId` instead of `runId`

**2. Server added new SSE endpoint:**
- `/api/sessions/:sessionId/stream` exists and works
- Uses `SessionEventBus` (separate from `RunEventBus`)

**3. Web Client removed SSE connection:**
- Removed `eventSourceRef` for agent messages
- `POST /api/threads/:id/messages` now returns `{ sessionId }` but client ignores it
- Client just calls `fetchMessages()` after POST (polling, not streaming)

**Current broken flow:**
```
Web Client                    Server                         Agent
    │                            │                              │
    │ POST /threads/:id/messages │                              │
    │───────────────────────────>│                              │
    │                            │ returns { sessionId }        │
    │<───────────────────────────│                              │
    │                            │                              │
    │ (sessionId ignored!)       │                              │
    │ fetchMessages() - polling  │                              │
    │                            │                              │
    │                            │ runAgentFlow()               │
    │                            │─────────────────────────────>│
    │                            │                              │
    │                            │<── emit(sessionId, msg) ─────│
    │ (nothing received!)        │    (SSE endpoint exists but  │
    │                            │     client never connected!) │
```

### Root Cause

The refactor changed the identifier from `runId` to `sessionId` and added the SSE endpoint, but **forgot to update the web client** to:
1. Capture the `sessionId` from the POST response
2. Connect to `/api/sessions/:sessionId/stream`
3. Handle the streaming events

---

## Solution Options

### Option A: Use Existing Session Stream (Minimal Changes) ⭐ RECOMMENDED

The infrastructure already exists! We just need to wire up the client.

**Changes Required:**

1. **Web Client (`web/src/App.tsx`):** ~30 lines
   - Capture `sessionId` from POST response
   - Create EventSource to `/api/sessions/${sessionId}/stream`
   - Handle events: `agent.tool_call`, `agent.message`, `agent.error`, `final`
   - Close EventSource on `final` event or error

**Pros:**
- Minimal code changes
- Server-side infrastructure already works
- Event bus and SSE endpoint already tested

**Cons:**
- Need to maintain `sessionId` state in client
- One more SSE connection (already have terminal SSE)

---

### Option B: Emit to threadId, Add Thread Stream

Change agent to emit to `threadId` instead of `sessionId`, add `/api/threads/:threadId/stream`.

**Changes Required:**

1. **Agent Service:** Change all `emit(sessionId, ...)` to `emit(threadId, ...)`
2. **Server:** Add `/api/threads/:threadId/stream` endpoint
3. **Web Client:** Connect to thread stream (simpler - already have threadId)

**Pros:**
- Thread-centric (conceptually cleaner)
- Client already knows threadId
- Could support multiple sessions per thread

**Cons:**
- More changes than Option A
- Need to plumb threadId through more agent code
- Existing session infrastructure unused

---

### Option C: Hybrid - Agent Emits to Both

Agent emits to both `sessionId` (for existing session features) and `threadId` (for client streaming).

**Pros:**
- Backward compatible
- Flexibility

**Cons:**
- Duplicate events
- More complex
- Over-engineered

---

## Recommended Solution: Option A

Use the existing `/api/sessions/:sessionId/stream` endpoint. It requires the least changes and the infrastructure is already in place.

### Implementation Plan

#### Step 1: Update Web Client Message Posting

**File: `web/src/App.tsx`**

Update `handleSendMessage` to:
1. Capture `sessionId` from POST response
2. Connect EventSource before/after POST
3. Handle streaming events

```typescript
const handleSendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault()
  // ... existing validation and optimistic update ...

  try {
    // ... existing thread creation logic ...

    // Create SSE connection FIRST (so we don't miss events)
    // Use a ref to track the active session EventSource
    const sessionEventSource = new EventSource(
      buildApiUrl(`/api/sessions/${currentThreadId}/stream`)
    )

    // Wait for SSE to open before POST (or POST immediately with small delay)
    // Actually: POST first, get sessionId, then connect

    const messageResp = await fetch(`/api/threads/${currentThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmedMessage, reasoning_effort: reasoningEffort })
    })

    if (!messageResp.ok) {
      throw new Error(...)
    }

    const { sessionId } = await messageResp.json() as { messageId: string; sessionId: string }

    // Now connect to session stream
    const source = new EventSource(buildApiUrl(`/api/sessions/${sessionId}/stream`))
    agentEventSourceRef.current = source
    setStatus('streaming')

    source.addEventListener('agent.tool_call', (evt) => {
      const data = JSON.parse(evt.data)
      // Could show tool execution indicator
      console.log('Tool call:', data)
    })

    source.addEventListener('agent.message', (evt) => {
      const data = JSON.parse(evt.data) as { text: string }
      // Append assistant message to UI
      setMessages(prev => [...prev, {
        message_id: `streaming_${Date.now()}`,
        role: 'assistant',
        display_role: 'Assistant',
        content: data.text,
        created_at: new Date().toISOString(),
        metadata: null
      }])
    })

    source.addEventListener('final', (evt) => {
      source.close()
      agentEventSourceRef.current = null
      setStatus('idle')
      // Fetch final messages to get real IDs and ensure consistency
      fetchMessages(currentThreadId)
    })

    source.addEventListener('error', () => {
      source.close()
      agentEventSourceRef.current = null
      setStatus('idle')
      setError('Agent connection lost')
    })

  } catch (err) {
    // ... existing error handling ...
  }
}
```

#### Step 2: Add Agent EventSource Ref

```typescript
// Add near other refs
const agentEventSourceRef = useRef<EventSource | null>(null)

// Cleanup on unmount
useEffect(() => {
  return () => {
    agentEventSourceRef.current?.close()
    terminalEventSourceRef.current?.close()
    // ... other cleanup ...
  }
}, [])
```

#### Step 3: Handle Cancellation

Update `cancelAgentTurn` to also close the SSE:

```typescript
const cancelAgentTurn = async () => {
  if (!threadId) return
  agentEventSourceRef.current?.close()
  agentEventSourceRef.current = null
  // ... existing cancel logic ...
}
```

### Testing Plan

#### Manual Testing

1. **Basic streaming:**
   - Send message
   - Verify agent response appears in real-time (not after refresh)

2. **Tool calls:**
   - Ask agent to run a terminal command
   - Verify tool call events received (logged to console)

3. **Error handling:**
   - Stop agent mid-execution
   - Verify SSE closes cleanly

4. **Multiple messages:**
   - Send several messages in sequence
   - Verify each gets its own SSE that closes properly

5. **Page refresh during agent:**
   - Start agent, refresh page
   - Verify clean reconnection

#### Automated Test Cases (Future)

**Unit Tests (`web/src/App.test.tsx` or similar):**

1. **SSE Connection Lifecycle:**
   - Mock `EventSource` and `fetch`
   - Verify SSE opens after successful POST with correct URL (`/api/sessions/${sessionId}/stream`)
   - Verify SSE closes on `final` event
   - Verify SSE closes on `error` event
   - Verify SSE closes on component unmount

2. **Event Handling:**
   - `agent.message` event appends message to state with correct structure
   - `agent.tool_call` event logs to console (or updates UI state when implemented)
   - `final` event triggers `fetchMessages()` for consistency
   - Malformed event data doesn't crash (parse errors caught)

3. **Cancel Flow:**
   - `cancelAgentTurn()` closes SSE before calling cancel API
   - Status resets to `idle` after cancel

4. **Error Scenarios:**
   - POST fails → no SSE opened, error displayed
   - SSE connection error → SSE closed, status reset, messages fetched
   - Network timeout → graceful degradation

**Integration Tests (`service/src/agent/agent-service.test.ts`):**

1. **Event Emission:**
   - `startUserMessage()` returns valid `sessionId`
   - Agent emits `agent.tool_call` when invoking terminal tools
   - Agent emits `agent.message` with response text
   - Agent emits `final` with status on completion
   - Agent emits `final` with error on failure
   - Agent emits `final` with canceled status on cancellation

2. **SSE Endpoint (`/api/sessions/:sessionId/stream`):**
   - Returns 200 with correct Content-Type headers
   - Emitted events appear on SSE stream with correct format
   - Connection closes cleanly when client disconnects

**E2E Tests (Playwright or similar):**

1. **Full Flow:**
   - Send message via UI
   - Verify assistant message appears without refresh
   - Verify status transitions: `idle` → `dispatching` → `streaming` → `idle`

2. **Cancellation:**
   - Send message, click stop button mid-execution
   - Verify agent stops, status returns to `idle`

3. **Multiple Threads:**
   - Switch threads while agent is running
   - Verify old SSE closes, new thread loads correctly

---

## Files to Modify

| File | Changes |
|------|---------|
| `web/src/App.tsx` | Add `agentEventSourceRef`, update `handleSendMessage` to connect SSE, handle events |

No server changes needed - the `/api/sessions/:sessionId/stream` endpoint already exists and works.

---

## Success Criteria

1. ✅ Agent messages appear in UI as they're generated
2. ✅ Tool call events received (can log for now, UI indicator later)
3. ✅ `final` event closes SSE and updates status
4. ✅ Error events handled gracefully
5. ✅ Cancel closes SSE

---

## Open Questions (Resolved)

1. ~~What was the original streaming implementation?~~ → Used `/api/runs/:runId/stream`
2. ~~Should we stream to threadId or sessionId?~~ → Use existing `sessionId` infrastructure
3. ~~Do we need to handle multiple clients?~~ → Not for MVP; each client gets own session stream
4. ~~Should tool call details be streamed?~~ → Yes, already emitted; can add UI later

---

## Appendix: Key Code Locations

### Server (No Changes Needed)

**SSE Endpoint (already exists):**
- `service/src/server.ts:93-97`
```typescript
server.get("/api/sessions/:sessionId/stream", (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const detach = sessionEvents.attach(sessionId, reply);
  reply.raw.on("close", detach);
});
```

**POST returns sessionId (already works):**
- `service/src/routes/threads.ts:308-311`
```typescript
const { sessionId } = await agentService.startUserMessage(thread.threadId, {...});
reply.code(201).send({ messageId: message.messageId, sessionId });
```

**Agent emits to sessionId (already works):**
- `service/src/agent/agent-service.ts` - multiple emit calls

### Web Client (Needs Changes)

**Current (broken):**
- `web/src/App.tsx:772-782` - POST but ignores `sessionId`, no SSE

**Fix location:**
- Same function, add SSE connection after POST
