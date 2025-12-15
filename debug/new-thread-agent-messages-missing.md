# Debug: Agent Messages Not Appearing After New Thread Creation

## Environment

- Web UI (React 19, Vite, TanStack Router)
- Routes: `/$budId/new` → `/$budId/$threadId`
- Agent: OpenAI Responses API with SSE streaming

## Repro Steps

1. Navigate to `/$budId/new` (new thread view)
2. Type a message and submit
3. Observe: Navigation to `/$budId/$threadId`
4. Observe: Terminal streams output correctly
5. Observe: User message appears in chat
6. **Bug**: Agent messages (tool calls, assistant responses) do NOT appear
7. Refresh the page
8. Observe: All messages now appear correctly

## Observed

- Terminal output streams correctly (terminal SSE is working)
- Initial user message appears (added optimistically or from loader)
- Agent tool calls and responses are NOT displayed until page refresh
- After refresh, all messages appear (they were saved to DB, just not streamed)

## Expected

- Agent messages should stream in real-time as the agent processes
- Tool calls should appear as they happen
- Final assistant message should appear without requiring refresh

---

## Architecture Analysis

### Message Flow: new.tsx → Backend → $threadId.tsx

**Step 1: User submits in new.tsx** (lines 94-140)
```
handleSubmit()
  → POST /api/threads (create thread)
  → POST /api/threads/${threadId}/messages (post message)
  → navigate({ to: '/$budId/$threadId' })
```

**Step 2: Backend processes message** (threads.ts lines 319-353)
```
POST /api/threads/:threadId/messages
  → Insert message to DB
  → agentService.startUserMessage(threadId)  // Starts agent async
  → Return { messageId }  // Immediate response
```

**Step 3: Agent runs asynchronously** (agent-service.ts lines 237-245)
```
startUserMessage()
  → void this.runAgentFlow(...)  // Fire-and-forget
  → Events emitted to AgentEventBus as agent works
```

**Step 4: $threadId.tsx mounts**
```
loader: fetch messages  // May have 0-1 messages at this point
component mounts with:
  - status = 'idle'
  - messages = initialMessages (from loader)
  - Terminal SSE: auto-connects via useEffect
  - Agent SSE: NOT CONNECTED (only called from handleSubmit)
```

### Key Code Locations

| File | Lines | Purpose |
|------|-------|---------|
| `web/src/routes/$budId/new.tsx` | 94-140 | handleSubmit - creates thread, posts message, navigates |
| `web/src/routes/$budId/$threadId.tsx` | 26-30 | Loader - fetches messages |
| `web/src/routes/$budId/$threadId.tsx` | 352-480 | `connectAgentStream` - SSE connection setup |
| `web/src/routes/$budId/$threadId.tsx` | 483-795 | Terminal SSE auto-connect (useEffect) |
| `web/src/routes/$budId/$threadId.tsx` | 898-954 | `handleSubmit` - **only place** `connectAgentStream` is called |
| `service/src/routes/threads.ts` | 319-353 | POST message endpoint - triggers agent |
| `service/src/routes/threads.ts` | 355-377 | GET agent/stream - SSE endpoint |
| `service/src/agent/agent-service.ts` | 228-246 | `startUserMessage` - starts async agent flow |

---

## Hypotheses

### Hypothesis 1: Agent SSE Not Auto-Connecting on Navigation ⭐ PRIMARY

**Theory**: When navigating from `/$budId/new` to `/$budId/$threadId`, the agent SSE stream is never connected because `connectAgentStream` is only called from `handleSubmit` in `$threadId.tsx`.

**Evidence**:

In `$threadId.tsx`:
```typescript
// Line 352-480: connectAgentStream function is defined
const connectAgentStream = useCallback((agentThreadId: string) => {
  // Sets up EventSource for /api/threads/:id/agent/stream
  // Handles events: heartbeat, agent.tool_call, agent.tool_result, agent.message, final
}, [threadId, fetchMessages])

// Line 898-954: handleSubmit - THE ONLY PLACE connectAgentStream is called
const handleSubmit = async (e: React.FormEvent) => {
  // ...
  setStatus('streaming')
  connectAgentStream(threadId)  // <-- Only called here!
}
```

**Contrast with Terminal SSE** (which works):
```typescript
// Lines 483-795: useEffect that auto-connects terminal SSE
useEffect(() => {
  // Terminal SSE connects automatically when threadId changes
  const connect = async () => {
    // ...
    const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/terminal/stream`))
    // ...
  }
  connect()
}, [threadId, ...])
```

**Why this causes the bug**:
- Agent SSE has no equivalent useEffect for auto-connection
- Navigation from `new.tsx` doesn't call `handleSubmit` in `$threadId.tsx`
- Agent is running on backend, emitting events, but no client is subscribed

### Hypothesis 2: Loader Timing / Race Condition

**Theory**: The loader fetches messages at navigation time, but the agent may not have produced any messages yet. The initial render shows stale data, and there's no mechanism to catch up.

**Evidence**:

```typescript
// $threadId.tsx lines 26-30
loader: async ({ params }) => {
  const messagesResp = await fetch(`/api/threads/${params.threadId}/messages?limit=200`)
  const messages = messagesResp.ok ? await messagesResp.json() : []
  return { messages }  // Likely empty or just user message
}
```

Timeline:
```
T0: POST message completes
T1: agentService.startUserMessage() called (async, returns immediately)
T2: Navigate to /$budId/$threadId
T3: Loader fetches messages (agent still initializing, 0-1 messages)
T4: Component renders with stale data
T5+: Agent produces messages, but client not subscribed to SSE
```

### Hypothesis 3: Status Not Reflecting Agent Activity

**Theory**: When `$threadId.tsx` mounts after navigation, `status` initializes to `'idle'`. There's no mechanism to detect that an agent is currently running for this thread.

**Evidence**:

```typescript
// Line 46 - status always starts as 'idle'
const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')
```

The backend tracks running agents in `AgentService.cancellations` Map, but there's no API endpoint to query "is agent running for thread X?".

The SSE endpoint (`GET /api/threads/:threadId/agent/stream`) just subscribes and waits - it doesn't indicate whether an agent is currently active.

### Hypothesis 4: Events Lost During Navigation Transition

**Theory**: Events emitted by the agent between message POST and SSE connection are permanently lost because no client was subscribed.

**Evidence**:

Looking at the SSE endpoint (threads.ts lines 355-377):
```typescript
server.get("/api/threads/:threadId/agent/stream", (request, reply) => {
  const detach = agentEvents.attach(params.threadId, reply)
  // Just subscribes - no replay of missed events
})
```

The `AgentEventBus` doesn't buffer events. If no client is attached when an event is emitted, it's lost.

Timeline of lost events:
```
T0: Message POST returns
T1: Agent starts, emits first tool_call
T2: Navigation begins (no SSE connected yet)
T3: Agent emits tool_result, another tool_call
T4: SSE finally connects
T5: Events from T1-T3 are gone forever
```

---

## Affected Code Locations

| File | Lines | Issue |
|------|-------|-------|
| `web/src/routes/$budId/$threadId.tsx` | 352-480 | `connectAgentStream` exists but not auto-called |
| `web/src/routes/$budId/$threadId.tsx` | 898-954 | `handleSubmit` is only caller of `connectAgentStream` |
| `web/src/routes/$budId/$threadId.tsx` | 46 | `status` initializes to `'idle'` with no agent check |
| `web/src/routes/$budId/new.tsx` | 134-135 | Navigates away without passing "agent is running" state |

---

## Potential Fix Approaches

### Approach A: Auto-connect Agent SSE on Mount

Add a useEffect that connects to the agent SSE stream when `threadId` changes:

```typescript
// In $threadId.tsx, add after terminal SSE useEffect
useEffect(() => {
  if (!threadId) return

  // Connect to agent stream on mount
  // This will receive events if agent is running, heartbeats if not
  const cleanup = connectAgentStream(threadId)

  return cleanup
}, [threadId, connectAgentStream])
```

**Considerations**:
- Simple fix
- Will connect even when no agent is running (just receives heartbeats)
- Need to handle the case where agent finishes quickly (final event received)
- Need to set `status` appropriately based on events received

### Approach B: Check Agent Status and Connect Conditionally

Add an API endpoint to check if an agent is running, then connect SSE if so:

```typescript
// New endpoint: GET /api/threads/:threadId/agent/status
// Returns: { running: boolean }

// In $threadId.tsx
useEffect(() => {
  const checkAndConnect = async () => {
    const resp = await fetch(`/api/threads/${threadId}/agent/status`)
    const { running } = await resp.json()
    if (running) {
      setStatus('streaming')
      connectAgentStream(threadId)
    }
  }
  checkAndConnect()
}, [threadId])
```

**Considerations**:
- More complex (new API endpoint)
- Race condition: agent could finish between check and connect
- Cleaner: only connects SSE when needed

### Approach C: Pass State Through Navigation

Have `new.tsx` pass state indicating "agent is starting":

```typescript
// In new.tsx
navigate({
  to: '/$budId/$threadId',
  params: { budId, threadId },
  state: { agentStarting: true }  // TanStack Router state
})

// In $threadId.tsx
const { agentStarting } = Route.useSearch() // or useLocation().state
useEffect(() => {
  if (agentStarting) {
    setStatus('streaming')
    connectAgentStream(threadId)
  }
}, [agentStarting, threadId])
```

**Considerations**:
- Explicit state passing
- Only handles navigation from `new.tsx`, not other entry points
- Doesn't help if user directly loads `/$budId/$threadId` while agent is running

### Approach D: Hybrid - Auto-connect with Event-Based Status

Auto-connect to agent SSE, detect if agent is active from events:

```typescript
useEffect(() => {
  if (!threadId) return

  let isAgentActive = false
  const source = new EventSource(buildApiUrl(`/api/threads/${threadId}/agent/stream`))

  source.addEventListener('agent.tool_call', () => {
    if (!isAgentActive) {
      isAgentActive = true
      setStatus('streaming')
    }
  })

  source.addEventListener('final', () => {
    isAgentActive = false
    setStatus('idle')
    fetchMessages(threadId)
  })

  return () => source.close()
}, [threadId])
```

**Considerations**:
- Self-detecting: status updates based on events
- Always connected (receives heartbeats even when idle)
- May need to handle reconnection (like terminal SSE does)

---

## Recommended Fix

**Approach A** (auto-connect on mount) is the simplest and most robust:

1. It matches the terminal SSE pattern (already proven to work)
2. No new API endpoints needed
3. Works for all navigation paths (from `/new`, direct URL, browser back/forward)
4. Heartbeat-only connections are cheap

The key insight is that the terminal SSE works because it auto-connects via useEffect. The agent SSE should follow the same pattern.

---

## Investigation Round 2: Messages Appear After Timeout But Don't Stream

### New Observations

After the auto-connect fix:
- Messages DO appear eventually (after agent completes)
- Tool calls and agent messages do NOT stream into UI in real-time
- Terminal output streams correctly

### Architecture Deep Dive

**Backend Event Buffering** (event-bus.ts lines 54-74):

The `AgentEventBus` buffers events and replays them when a client connects:
```typescript
attach(channelId: string, reply: FastifyReply): () => void {
  // ...
  const buffer = this.buffers.get(channelId) ?? [];
  for (const event of buffer) {
    listener(event);  // Replay buffered events to new client
  }
}
```

This means even if we connect late, we should receive missed events.

**Frontend Event Handlers** ($threadId.tsx):

| Event | Handler Lines | Action | Updates Messages? |
|-------|---------------|--------|-------------------|
| `agent.tool_call` | 414-424 | Log to console, set status | ❌ NO |
| `agent.tool_result` | 426-428 | Update timestamp ref only | ❌ NO |
| `agent.message` | 430-447 | Add assistant message | ✅ YES |
| `final` | 449-463 | fetchMessages() | ✅ YES (replaces) |

**Backend Event Emission** (agent-service.ts lines 331-340):

```typescript
// These are emitted BACK-TO-BACK when agent finishes:
this.events.emit(threadId, {
  event: "agent.message",
  data: { text: directive.message },
});
this.events.emit(threadId, {
  event: "final",
  data: { status: directive.status, text: directive.message },
});
```

### Updated Hypotheses

#### Hypothesis 1: Tool Calls Intentionally Not Shown ⭐ ROOT CAUSE

The `agent.tool_call` handler in $threadId.tsx (lines 414-424) only logs to console:

```typescript
source.addEventListener('agent.tool_call', (evt) => {
  lastAgentEventTimeRef.current = Date.now()
  setStatus((prev) => prev === 'idle' ? 'streaming' : prev)
  try {
    const data = JSON.parse(evt.data) as { name: string; args: unknown }
    console.log('[agent-sse] tool_call', data.name, data.args)  // JUST LOGS!
  } catch (e) {
    console.warn('[agent-sse] failed to parse tool_call', e)
  }
})
```

It does NOT add the tool call to the messages array. Same with `agent.tool_result` - it does nothing visible.

**Why this causes the bug**: During agent execution, the user sees nothing because:
- Tool calls aren't added to messages (just logged)
- Tool results aren't added to messages
- Only `final` triggers `fetchMessages()` which shows everything at once

#### Hypothesis 2: agent.message Immediately Replaced

The `agent.message` event IS handled and adds a message:

```typescript
source.addEventListener('agent.message', (evt) => {
  // ...
  setMessages((prev) => [
    ...prev,
    { message_id: `streaming_${Date.now()}`, role: 'assistant', ... }
  ])
})
```

But `agent.message` and `final` are emitted back-to-back (see agent-service.ts lines 331-340). The `final` handler immediately calls `fetchMessages()` which replaces the entire messages array.

Timeline:
```
T0: agent.message received → adds message to array
T1: final received (~0ms later) → fetchMessages() replaces array
T2: User sees fetched messages (original optimistic message gone)
```

The optimistically added message is visible for ~0ms before being replaced.

#### Hypothesis 3: SSE Events Not Being Received

The EventSource might be connecting but not receiving events. Verification needed:
- Check browser console for `[agent-sse] connected` log
- Check for `[agent-sse] tool_call` logs (events ARE received if these appear)

#### Hypothesis 4: useCallback/useEffect Dependency Issues

The auto-connect useEffect depends on `[threadId, connectAgentStream]`. If `connectAgentStream` is recreated frequently, it could cause rapid connect/disconnect cycles.

However, analysis shows:
- `fetchMessages` has empty deps (stable)
- `connectAgentStream` deps are `[threadId, fetchMessages]` (stable unless threadId changes)
- Should be fine.

### Recommended Fix

**To show real-time tool call progress**, the handlers need to add tool calls to the messages array:

```typescript
source.addEventListener('agent.tool_call', (evt) => {
  lastAgentEventTimeRef.current = Date.now()
  setStatus((prev) => prev === 'idle' ? 'streaming' : prev)
  try {
    const data = JSON.parse(evt.data) as { name: string; args: unknown }
    // ADD TO MESSAGES instead of just logging:
    setMessages((prev) => [
      ...prev,
      {
        message_id: `tool_call_${Date.now()}`,
        role: 'tool',
        display_role: `Tool • ${data.name}`,
        content: JSON.stringify({ tool: data.name, ...data.args }),
        metadata: { tool: data.name, ...data.args },
        created_at: new Date().toISOString()
      }
    ])
  } catch (e) {
    console.warn('[agent-sse] failed to parse tool_call', e)
  }
})
```

Similar changes needed for `agent.tool_result`.

### Verification Steps

1. Open browser console
2. Navigate from /new after posting message
3. Check for:
   - `[agent-sse] connected` log (confirms connection)
   - `[agent-sse] tool_call` logs (confirms events received)
4. If logs appear but UI doesn't update → confirms Hypothesis 1
5. If no logs appear → suggests SSE connection issue

---

## Resolution (Attempt 1 - Incomplete)

**Root cause confirmed**: Hypothesis 1 (Agent SSE not auto-connecting on navigation)

**Fix applied**: Added useEffect to auto-connect agent SSE on mount, matching the terminal SSE pattern.

**Changes in `web/src/routes/$budId/$threadId.tsx`**:

1. Added useEffect after `connectAgentStream` function (lines 484-507):
```typescript
// Auto-connect agent SSE on mount to catch in-progress agent runs
// This handles the case where we navigate from /new after posting a message
useEffect(() => {
  if (!threadId) return

  // Close any existing connection first
  if (agentEventSourceRef.current) {
    agentEventSourceRef.current.close()
    agentEventSourceRef.current = null
  }
  // ... cleanup reconnect timer and attempt counter

  // Connect to agent stream - will receive events if agent is running
  const cleanup = connectAgentStream(threadId)

  return () => {
    cleanup()
    agentThreadIdRef.current = null
  }
}, [threadId, connectAgentStream])
```

2. Added status update in `agent.tool_call` handler (line 417):
```typescript
// Set status to streaming when we detect agent activity
setStatus((prev) => prev === 'idle' ? 'streaming' : prev)
```

**How it works**:
- When navigating from `/new` to `/$threadId`, the useEffect auto-connects to the agent SSE
- If an agent is running (from the message posted in `/new`), events will flow through
- The `agent.tool_call` handler detects agent activity and sets status to `'streaming'`
- The `final` handler (already existed) sets status back to `'idle'` and fetches messages

**Preserved behavior**:
- `handleSubmit` still closes and reconnects SSE (ensures fresh connection for new messages)
- Terminal SSE unchanged (already worked)
- All existing event handling preserved

---

## Resolution (Final)

**Root cause confirmed**: The `agent.tool_call` handler only logged to console and didn't add tool calls to the messages array. This meant users saw nothing during agent execution until the `final` event triggered `fetchMessages()`.

**Fix applied**: Modified the `agent.tool_call` event handler in `$threadId.tsx` (lines 414-437) to add tool calls to the messages array in real-time:

```typescript
source.addEventListener('agent.tool_call', (evt) => {
  lastAgentEventTimeRef.current = Date.now()
  setStatus((prev) => prev === 'idle' ? 'streaming' : prev)
  try {
    const data = JSON.parse(evt.data) as { name: string; args: unknown }
    console.log('[agent-sse] tool_call', data.name, data.args)
    // Add tool call to messages for real-time streaming display
    const argsObj = (typeof data.args === 'object' && data.args !== null)
      ? data.args as Record<string, unknown>
      : {}
    setMessages((prev) => [
      ...prev,
      {
        message_id: `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        role: 'tool',
        display_role: data.name,
        content: JSON.stringify({ tool: data.name, ...argsObj }),
        created_at: new Date().toISOString(),
        metadata: { tool: data.name, ...argsObj }
      }
    ])
  } catch (e) {
    console.warn('[agent-sse] failed to parse tool_call', e)
  }
})
```

**How it works**:
- When a tool call event is received, a new message is added to the messages array
- The message has `role: 'tool'` so ChatTimeline renders it with the tool content renderer
- The `metadata` field contains `{ tool: name, ...args }` for proper tool rendering
- A unique message ID is generated using timestamp + random string to prevent duplicates
- The `final` event still calls `fetchMessages()` which replaces these optimistic entries with canonical DB records

**Combined fixes applied**:
1. Auto-connect agent SSE on mount (from earlier fix) - handles navigation from /new
2. Add tool calls to messages array (this fix) - enables real-time streaming display

**Verified**: Tested by creating a new thread from `/$budId/new`, posting a message, and observing tool calls stream into the chat timeline in real-time.

---

*Created: 2025-12-14*
*Updated: 2025-12-14* - Final fix applied and verified
*Status: Resolved (Verified)*
