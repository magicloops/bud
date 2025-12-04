# Agent Progress Indicators - Debug Investigation

**Date:** 2025-12-03
**Issue:** Frontend stops showing loading indicators while agent is still running in backend
**Related:** Multiple confusing status indicators in UI

## Problem Statement

When the agent runs multiple steps (tool calls followed by more tool calls), the frontend loading indicators stop showing progress even though the agent is still actively working in the backend. Additionally, there are 4-6 different status indicators in the UI which creates confusion.

## ROOT CAUSE IDENTIFIED

**The session SSE stream has NO heartbeat, while the terminal stream does.**

```typescript
// Terminal stream (line 99-118 in server.ts) - HAS HEARTBEAT
server.get("/api/terminals/:budId/stream", (request, reply) => {
  const detach = terminalEvents.attach(budId, reply);
  const heartbeatInterval = setInterval(() => {
    reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
  }, heartbeatMs);
  // ...
});

// Session stream (line 93-97 in server.ts) - NO HEARTBEAT!
server.get("/api/sessions/:sessionId/stream", (request, reply) => {
  const detach = sessionEvents.attach(sessionId, reply);
  reply.raw.on("close", detach);
  // No heartbeat!
});
```

When the agent is calling OpenAI (which can take 5-30+ seconds), no events are emitted. Without a heartbeat:
1. Vite's dev proxy may close the connection as "stale"
2. Browser may close idle SSE connections
3. The frontend `error` event fires, setting `status = 'idle'`

**Evidence:** The terminal stream works reliably because it has a heartbeat. The session stream fails during long model invocations.

## FIX REQUIRED

Add heartbeat to session stream, matching terminal stream pattern:

```typescript
server.get("/api/sessions/:sessionId/stream", (request, reply) => {
  const sessionId = (request.params as { sessionId: string }).sessionId;
  const detach = sessionEvents.attach(sessionId, reply);

  // Add heartbeat like terminal stream
  const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
  const heartbeatInterval = setInterval(() => {
    try {
      reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, heartbeatMs);

  reply.raw.on("close", () => {
    clearInterval(heartbeatInterval);
    detach();
  });
});
```

---

## Current UI Status Indicators (Count: 6+)

| # | Indicator | Location | States | Purpose |
|---|-----------|----------|--------|---------|
| 1 | **Status Badge** | WorkspaceTopBar | "Dispatching", "Streaming", "Idle" | Agent execution state |
| 2 | **Send Button Spinner** | CommandComposer | Spinner when not idle | Visual feedback on submit button |
| 3 | **Cancel/Stop Button** | Main panel | Visible during streaming/dispatching | Stop agent execution |
| 4 | **Terminal Connection Dot** | Status bar | Green/Yellow/Red | Terminal SSE health |
| 5 | **Terminal Readiness** | Status bar | Ready/Waiting/Processing + icons | Terminal input state |
| 6 | **Reconnect Banner** | Terminal overlay | "Reconnecting to terminal..." | Terminal reconnection |
| 7 | **Truncation Warning** | Terminal overlay | "Earlier output truncated" | History truncation |

**User Confusion Points:**
- Status badge vs Terminal readiness (both show "Processing" or similar)
- Connection dot vs reconnect banner (both indicate connection issues)
- Multiple spinners/indicators compete for attention
- No clear hierarchy of what's most important

## Agent Event Flow Analysis

### Current Event Emissions

```
POST /api/threads/:id/messages (creates session)
    |
    ├─> Frontend: status = 'dispatching'
    |
    v
SSE connect to /api/sessions/:sessionId/stream
    |
    ├─> Frontend: status = 'streaming'  (on first event received)
    |
    v
AGENT LOOP:
  Step 1: Invoke OpenAI
    |
    └─> (NO EVENT - frontend doesn't know model is being called)
    |
    v
  Step 1: Tool call detected
    |
    ├─> EMIT: agent.tool_call { id, name, args }
    |   └─> Frontend: console.log only (NOT shown in UI)
    |
    v
  Step 1: Execute tool
    |
    ├─> EMIT: agent.tool_result { name, output, ... }
    |   └─> Frontend: console.log only (NOT shown in UI)
    |
    v
  Step 2: Invoke OpenAI again
    |
    └─> (NO EVENT - frontend doesn't know agent is still working!)
    |
    v
  ... more steps ...
    |
    v
  Final: EMIT: agent.message { text }
    |
    └─> Frontend: adds to chat
    |
    v
  EMIT: final { status }
    |
    └─> Frontend: status = 'idle'
```

### Identified Gaps

1. **No `agent.started` event**
   - Agent begins executing but frontend has no signal
   - Can't distinguish "HTTP in flight" from "agent actually running"

2. **No step tracking events**
   - Agent can run N steps but frontend has no visibility
   - No `agent.step_start` or `agent.step_complete` events

3. **Tool events not displayed in UI**
   - `agent.tool_call` and `agent.tool_result` only logged to console
   - User can't see what the agent is doing between steps

4. **No "calling AI" indicator**
   - When agent invokes OpenAI, no event is emitted
   - This is where the frontend thinks "nothing is happening"

5. **Status stuck on "streaming"**
   - Status goes to "streaming" on first SSE event
   - Stays there until `final` event
   - Doesn't reflect actual activity (calling model vs waiting vs executing tool)

## Root Cause

The core issue is that **status transitions are too coarse**:

```
idle → dispatching → streaming → idle
```

But actual agent activity is more granular:

```
idle → dispatching → invoking_model → tool_executing → invoking_model → tool_executing → ... → complete → idle
```

The frontend goes to `streaming` and stays there, but:
- There's no feedback during "invoking_model" phases
- Tool call/result events ARE emitted but not displayed
- Frontend appears "stuck" even though backend is working

## Proposed Solution

### Option A: Minimal Fix (Show Tool Events)

Update frontend to display `agent.tool_call` and `agent.tool_result` events in the chat timeline instead of just logging to console. This immediately shows progress.

**Pros:** Quick, uses existing events
**Cons:** Doesn't show "calling AI" phase

### Option B: Add Model Invocation Events

Add new events to agent-service.ts:

```typescript
// Before calling OpenAI
this.events.emit(sessionId, { event: "agent.invoking_model", data: { step } });

// After OpenAI returns
this.events.emit(sessionId, { event: "agent.model_response", data: { step, has_tool_call } });
```

Frontend can show "Thinking..." during model invocation.

**Pros:** Complete visibility into agent phases
**Cons:** More events, more complexity

### Option C: Unified Status Model

Replace multiple indicators with a single hierarchical status:

```typescript
type AgentPhase =
  | { phase: 'idle' }
  | { phase: 'dispatching' }
  | { phase: 'invoking_model', step: number }
  | { phase: 'executing_tool', tool: string, step: number }
  | { phase: 'complete', status: 'succeeded' | 'failed' }
```

Single status indicator shows current phase with optional details.

**Pros:** Clear, unified UX
**Cons:** Larger refactor

### Recommended: Option A + B Combined

1. **Immediately:** Show tool events in chat (Option A)
2. **Add:** `agent.invoking_model` event before each OpenAI call
3. **Update:** Status indicator to show:
   - "Calling AI..." when invoking model
   - "Running [tool]..." when executing tool
   - Current step number (Step 1/N)

## Current Code References

### Backend Event Emission (agent-service.ts)

```typescript
// Line 262: Tool call event
this.events.emit(sessionId, {
  event: "agent.tool_call",
  data: { id: callId, name: toolName, args: { input, cwd } },
  id: ulid()
});

// Line 295/324: Tool result event
this.events.emit(sessionId, {
  event: "agent.tool_result",
  data: { name: toolName, ...result },
  id: ulid()
});

// Line 354: Final message event
this.events.emit(sessionId, {
  event: "agent.message",
  data: { text: directive.message },
  id: ulid()
});

// Line 359: Final status event
this.events.emit(sessionId, {
  event: "final",
  data: { status: directive.status, text: directive.message },
  id: ulid()
});
```

### Frontend Event Handling (App.tsx)

```typescript
// Lines 829-870: SSE event handler
es.onmessage = (ev) => {
  const payload = JSON.parse(ev.data)

  if (payload.event === 'agent.tool_call') {
    console.log('[sse] agent.tool_call', payload.data)  // NOT DISPLAYED
  }
  if (payload.event === 'agent.tool_result') {
    console.log('[sse] agent.tool_result', payload.data)  // NOT DISPLAYED
  }
  if (payload.event === 'agent.message') {
    // This one IS added to messages and displayed
    setMessages((prev) => [...prev, { ... }])
  }
  if (payload.event === 'final') {
    setStatus('idle')
    fetchMessages()
  }
}
```

### Status Variable (App.tsx)

```typescript
// Line 65
const [status, setStatus] = useState<'idle' | 'dispatching' | 'streaming'>('idle')

// Line 774: On submit
setStatus('dispatching')

// Line 826: On SSE connect/first event
setStatus('streaming')

// Line 861: On final event
setStatus('idle')
```

## UI Indicator Consolidation Proposal

Reduce from 6+ indicators to 3:

| Indicator | Purpose | States |
|-----------|---------|--------|
| **Agent Status** | What agent is doing | Idle, Calling AI (step N), Running tool X (step N), Complete |
| **Terminal Connection** | SSE health | Connected (green dot), Reconnecting (yellow), Disconnected (red) |
| **Terminal Input** | Can type? | Ready, Waiting for process |

Remove or merge:
- Status badge → Merge into Agent Status
- Send button spinner → Keep, but driven by Agent Status
- Cancel button → Keep, shown when not idle
- Truncation warning → Move to toast/notification
- Reconnect banner → Merge into Terminal Connection

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/agent/agent-service.ts` | Add `agent.invoking_model` event before OpenAI calls |
| `web/src/App.tsx` | Display tool events in chat, update status states |
| `web/src/components/workbench/chat-timeline.tsx` | Render tool call/result messages |
| `web/src/App.tsx` | Consolidate status indicators |

## Next Steps

1. Decide on approach (A, B, C, or combination)
2. Implement event additions in backend
3. Update frontend to display tool events
4. Consolidate status indicators
5. Test multi-step agent flows
