# Plan: Fix Agent Message Streaming to Web Client

## Problem Statement

Agent messages don't stream to the web client in real-time. Users must refresh the page to see agent responses.

## Background

This functionality **used to work** on `origin/main`. During the interactive sessions refactor, the streaming connection was likely broken or removed.

## Current Architecture (Broken)

```
Web Client                    Server                         Agent
    │                            │                              │
    │ POST /threads/:id/messages │                              │
    │───────────────────────────>│                              │
    │                            │ runAgentFlow()               │
    │                            │─────────────────────────────>│
    │                            │                              │
    │ status='streaming'         │                              │
    │ (no SSE connected!)        │                          [process]
    │                            │                              │
    │                            │<── emit(sessionId, msg) ─────│
    │ (nothing received)         │    (no listener for sessionId)
    │                            │                              │
    │                            │<── db.insert(message) ───────│
    │                            │                              │
    │ (waits... refreshes)       │                              │
    │                            │                              │
    │ GET /threads/:id/messages  │                              │
    │───────────────────────────>│                              │
    │<───────────────────────────│                              │
    │   (finally sees messages)  │                              │
```

## Investigation Needed

Before implementing a fix, we need to understand what changed:

### Questions to Answer

1. **What did the old streaming look like on `origin/main`?**
   - Was there a `/api/threads/:threadId/stream` endpoint?
   - Or did messages stream via `/api/runs/:runId/stream`?
   - How did the web client connect to receive agent messages?

2. **What SSE endpoints exist now?**
   - `/api/runs/:runId/stream` - Run-based streaming (legacy?)
   - `/api/sessions/:sessionId/stream` - Session streaming
   - `/api/terminals/:budId/stream` - Terminal output streaming
   - Is there a thread-level stream?

3. **How does the agent emit messages?**
   - `agent-service.ts:226-271` emits to `sessionId`
   - What's the `sessionId`? Is it the agent session or terminal session?
   - Should it emit to `threadId` instead?

4. **How did the web client receive messages before?**
   - Check `App.tsx` on `origin/main`
   - Was there an EventSource connection?
   - What events did it listen for?

## Investigation Commands

```bash
# Check what SSE endpoints exist on main
git show origin/main:service/src/server.ts | grep -A5 "stream"

# Check how web client handled streaming on main
git show origin/main:web/src/App.tsx | grep -A20 "EventSource\|stream"

# Check agent event emission on main
git show origin/main:service/src/agent/agent-service.ts | grep -A10 "emit"

# Diff the current vs main for relevant files
git diff origin/main -- service/src/server.ts
git diff origin/main -- web/src/App.tsx
git diff origin/main -- service/src/agent/agent-service.ts
```

## Potential Fixes

### Option A: Restore Previous Implementation

If streaming worked before, the simplest fix is to:
1. Identify what was removed/changed
2. Restore the working implementation
3. Adapt it to work with the new terminal-based architecture

### Option B: Add Thread-Level SSE Endpoint

If no thread streaming existed, add a new endpoint:

**Server (`service/src/server.ts`):**
```typescript
server.get("/api/threads/:threadId/stream", async (request, reply) => {
  const { threadId } = request.params as { threadId: string };

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const listener = (event: { event: string; data: unknown }) => {
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  // Subscribe to agent events for this thread
  agentService.events.on(threadId, listener);

  request.raw.on("close", () => {
    agentService.events.off(threadId, listener);
  });
});
```

**Agent Service (`service/src/agent/agent-service.ts`):**
```typescript
// Change emission from sessionId to threadId
this.events.emit(threadId, {  // Was: sessionId
  event: "agent.message",
  data: { text: directive.message }
});
```

**Web Client (`web/src/App.tsx`):**
```typescript
// Before posting message, connect SSE
const eventSource = new EventSource(`/api/threads/${threadId}/stream`);

eventSource.addEventListener("agent.message", (e) => {
  const data = JSON.parse(e.data);
  setMessages(prev => [...prev, {
    message_id: `temp_${Date.now()}`,
    role: "assistant",
    display_role: "Assistant",
    content: data.text,
    created_at: new Date().toISOString()
  }]);
});

eventSource.addEventListener("agent.tool_call", (e) => {
  // Update UI to show tool is being called
});

eventSource.addEventListener("agent.done", (e) => {
  eventSource.close();
  setStatus('idle');
  // Fetch final messages to ensure consistency
  await fetchMessages(threadId);
});

// Then post message
const resp = await fetch(`/api/threads/${threadId}/messages`, {
  method: 'POST',
  // ...
});
```

### Option C: Use Existing Session Stream

If the agent already emits to `sessionId` and there's a `/api/sessions/:sessionId/stream`:

1. Return `sessionId` from the POST `/api/threads/:threadId/messages` response
2. Client connects to `/api/sessions/${sessionId}/stream`
3. No server changes needed, just client-side wiring

## Implementation Plan

### Phase 1: Investigation

1. Run the investigation commands above
2. Document what existed on `origin/main`
3. Understand the current event flow
4. Decide which option to implement

### Phase 2: Server Changes (if needed)

Depends on investigation findings:
- If Option A: Restore removed code
- If Option B: Add new SSE endpoint
- If Option C: No server changes

### Phase 3: Web Client Changes

1. Add EventSource connection before posting message
2. Handle streaming events:
   - `agent.message` - Add assistant message to UI
   - `agent.tool_call` - Show tool execution status
   - `agent.error` - Handle errors
   - `agent.done` - Clean up, fetch final state
3. Update status indicators appropriately
4. Handle reconnection/error cases

### Phase 4: Testing

1. Send message, verify streaming works
2. Test error cases (agent fails, network issues)
3. Test multiple concurrent agent runs
4. Test page refresh during agent run

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/server.ts` | Add/restore SSE endpoint (if needed) |
| `service/src/agent/agent-service.ts` | Fix event emission target (if needed) |
| `web/src/App.tsx` | Add EventSource connection, handle events |

## Success Criteria

1. Agent messages appear in UI as they're generated (not after refresh)
2. Tool call status shown during execution
3. Error messages displayed if agent fails
4. Clean connection lifecycle (connect before POST, close on done/error)

## Dependencies

- Issue 2 & 3 fixes (agent output race condition) should be done first
- Agent needs to be producing correct output before we stream it

## Open Questions

1. What was the original streaming implementation on `origin/main`?
2. Should we stream to `threadId` or `sessionId`?
3. Do we need to handle multiple clients viewing the same thread?
4. Should tool call details (input/output) be streamed or just status?

## Next Steps

1. **Immediate:** Run investigation commands to understand what changed
2. **Then:** Choose implementation option based on findings
3. **Finally:** Implement and test

---

## Appendix: Code Locations

### Current Code

**Agent event emission:**
- `service/src/agent/agent-service.ts:226-227` - Tool call emission
- `service/src/agent/agent-service.ts:317-321` - Message emission

**SSE endpoints:**
- `service/src/server.ts:87-97` - Existing stream endpoints

**Web client message handling:**
- `web/src/App.tsx:772-789` - POST message, no SSE

### To Investigate on origin/main

```bash
git show origin/main:service/src/server.ts
git show origin/main:web/src/App.tsx
git show origin/main:service/src/agent/agent-service.ts
```
