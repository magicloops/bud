# Debug: Missing User/Assistant Messages in UI

**Date:** 2025-12-03
**Branch:** `adam/interactive-sessions`
**Status:** ✅ ROOT CAUSE FOUND

## Symptom

User and assistant messages are created in the database but don't appear in the chat UI. When the user sends a message:
- The DB query script shows messages exist (user, tool, assistant)
- The frontend shows older messages but not the latest ones
- The last visible message in UI is from a previous conversation turn

## Database Evidence

From running `service/scripts/query-messages.ts`:

```
Messages (10):
  - [assistant] Bud Agent: Haiku about hello-world.txt contents...  (00:49:29)
  - [tool] Tool: {"tool":"terminal.run",...}                        (00:49:26)
  - [user] User: cat hello-world.txt and then write a haiku...      (00:49:18)
  - [assistant] Bud Agent: hello-world.txt whispers...              (00:47:58)
  - [user] User: Write a haiku about hello-world.txt                (00:47:53)
  ...
```

Messages ARE being persisted correctly. The issue is on the frontend side.

## Analysis: Message Fetch Flow

### Normal Flow

1. User types message and clicks send
2. `handleSendMessage()` adds optimistic message to state
3. `POST /api/threads/:threadId/messages` creates user message, starts agent
4. Server returns `{ messageId, sessionId }`
5. Client connects to `/api/sessions/${sessionId}/stream` (SSE)
6. Agent runs, emits `agent.tool_call`, `agent.message`, `final` events
7. On `final` event, client calls `fetchMessages(threadId)` to refresh from DB
8. Messages should now be up to date

### Relevant Code

**Frontend (`web/src/App.tsx`):**
```typescript
// Line 828-834
source.addEventListener('final', () => {
  source.close()
  agentEventSourceRef.current = null
  setStatus('idle')
  // Fetch final messages to get real IDs and ensure consistency
  fetchMessages(threadIdForHandlers)
})
```

**Backend (`service/src/agent/agent-service.ts`):**
```typescript
// Line 322-326
this.events.emit(sessionId, {
  event: "final",
  data: { status: directive.status, text: directive.message },
  id: ulid()
});
```

**Event Bus (`service/src/runtime/event-bus.ts`):**
- Events are buffered per channelId (lines 26-33)
- When client attaches, buffered events are replayed (lines 55-62)

## Hypotheses

### Hypothesis 1: SSE `final` Event Not Reaching Client (MOST LIKELY)

The frontend relies on the `final` event to trigger `fetchMessages()`. If this event never reaches the client, messages won't be refreshed.

**Possible causes:**
1. **Timing race:** Agent completes BEFORE client connects to SSE stream
   - Client sends POST, gets sessionId
   - Agent runs fast, emits `final` before SSE connection opens
   - Event is buffered but... (check buffer logic)

2. **SSE connection closed prematurely:**
   - Network issue or Vite proxy termination
   - Client's EventSource closes without receiving `final`

3. **Event not emitted:**
   - Exception thrown before reaching `this.events.emit(sessionId, { event: "final", ... })`
   - Check server logs for exceptions in agent flow

**Verification:**
- Check server logs for `SSE event emit` with `event: "final"` for the session
- Check browser dev tools Network tab for SSE events received
- Add console.log in `source.addEventListener('final', ...)` handler

### Hypothesis 2: Session ID Mismatch

The client connects to `/api/sessions/${sessionId}/stream` but the agent emits to a different sessionId.

**Verification:**
- Compare sessionId in HTTP response vs sessionId in server logs
- Check `ensureThreadSession()` is returning consistent sessionIds

### Hypothesis 3: fetchMessages Not Being Called

Even if `final` event is received, `fetchMessages()` might not execute or might fail silently.

**Verification:**
- Add console.log before/after `fetchMessages()` call
- Check for JavaScript errors in browser console

### Hypothesis 4: Optimistic Message Deduplication Issue

The optimistic message uses a temporary ID (`temp_${uuid}`). When `fetchMessages()` returns real data, the old optimistic message might not be properly replaced, or the state might not update.

**Verification:**
- Check if `setMessages(data)` is actually called after fetch
- Verify `fetchMessages` returns the full list including new messages

### Hypothesis 5: React State Not Updating

The `fetchMessages` function calls `setMessages(data)`, but React might not re-render if there's a state closure issue with the ref-based `threadIdForHandlers`.

**Relevant code:**
```typescript
const threadIdForHandlers = currentThreadId  // Line 799
// ...later...
fetchMessages(threadIdForHandlers)  // Line 833
```

If `threadIdForHandlers` captured an old/wrong threadId, messages would be fetched for the wrong thread.

**Verification:**
- Log `threadIdForHandlers` vs actual `threadId` state
- Check if multiple threads are involved

## Recommended Debugging Steps

### Step 1: Add Client-Side Logging

In `web/src/App.tsx`, add console.logs:

```typescript
source.addEventListener('final', (evt) => {
  console.log('[SSE] Received final event:', evt)
  source.close()
  agentEventSourceRef.current = null
  setStatus('idle')
  console.log('[SSE] Calling fetchMessages for thread:', threadIdForHandlers)
  fetchMessages(threadIdForHandlers)
    .then(() => console.log('[SSE] fetchMessages completed'))
    .catch((err) => console.error('[SSE] fetchMessages failed:', err))
})
```

### Step 2: Check Server Logs for `final` Event

Look for log entries like:
```
SSE event emit
  channelId: "sess_..."
  event: "final"
```

If this log doesn't appear, the event isn't being emitted.

### Step 3: Check Browser Network Tab

1. Open DevTools > Network tab
2. Filter by "EventStream" or look for `/stream` requests
3. Click on the SSE request and view the "EventStream" tab
4. Look for `event: final` in the stream

### Step 4: Verify Agent Completion

In server logs, look for:
```
Agent final response
  sessionId: "sess_..."
  status: "succeeded"
```

If this appears but no corresponding SSE emit, there's a bug in the emit path.

## Key Code Paths

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Send message | `web/src/App.tsx` | 732-849 | `handleSendMessage()` |
| SSE handlers | `web/src/App.tsx` | 801-842 | Event listeners |
| Fetch messages | `web/src/App.tsx` | 432-444 | `fetchMessages()` |
| Agent flow | `service/src/agent/agent-service.ts` | 196-365 | `runAgentFlow()` |
| Emit final | `service/src/agent/agent-service.ts` | 322-326 | `events.emit("final")` |
| SSE bus | `service/src/runtime/event-bus.ts` | 16-77 | Event buffering/emit |
| SSE route | `service/src/server.ts` | 93-97 | `/api/sessions/:sessionId/stream` |

## ROOT CAUSE FOUND

**The bug is in `service/src/routes/threads.ts` line 192:**

```typescript
const rows = await db
  .select()
  .from(messageTable)
  .where(eq(messageTable.threadId, thread.threadId))
  .orderBy(asc(messageTable.createdAt))  // <-- BUG: ascending order
  .limit(query.limit);  // limit defaults to 200
```

The query orders by `createdAt` **ascending** (oldest first) and then applies `.limit(200)`.

With 213 messages in the thread and a limit of 200, **the newest 13 messages are cut off**.

### Fix Options

**Option 1: Change to descending order + reverse in client**
```typescript
.orderBy(desc(messageTable.createdAt))
```
Then the client reverses to get chronological order. (Client already sorts by createdAt so this should work.)

**Option 2: Remove limit or increase it significantly**
```typescript
.limit(query.limit ?? 1000)
```

**Option 3: Use a subquery to get latest N then re-sort**
More complex, probably overkill.

### Recommended Fix

Change line 192 from `asc` to `desc`:
```typescript
.orderBy(desc(messageTable.createdAt))
```

The client (`ChatTimeline`) already re-sorts messages by `createdAt` ascending (line 39 in `chat-timeline.tsx`), so it will display them in the correct order.

## Related Issues

- Issue 4: OpenAI YAML response format - could affect message content but not visibility
- Issue 3: Agent stale output - fixed, unrelated to message visibility
