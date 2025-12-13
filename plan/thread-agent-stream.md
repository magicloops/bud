# Plan: Thread-Level Agent Event Stream

## Context

- Related issue: `debug/agent-sse-404.md`
- Related cleanup: `plan/legacy-code-removal.md`
- Spec files to update:
  - `service/src/routes/routes.spec.md`
  - `service/src/runtime/runtime.spec.md`
  - `service/src/agent/agent.spec.md`
  - `web/src/routes/$budId/budId.spec.md`
  - `docs/proto.md`

## Objective

Create a dedicated **thread-level agent event stream** at `/api/threads/:threadId/agent/stream` that:

1. Is independent of terminal session availability
2. Uses `threadId` as the channel identifier (not terminal `sessionId`)
3. Supports offline scenarios (bud offline, message queued)
4. Cleanly separates conversation events from terminal I/O events

### Event Types on Agent Stream

| Event | Data | Description |
|-------|------|-------------|
| `agent.tool_call` | `{ name, args, id }` | Agent is invoking a tool |
| `agent.tool_result` | `{ name, output, readiness, ... }` | Tool execution completed |
| `agent.message` | `{ text }` | Agent's response text (streaming) |
| `final` | `{ status, text? }` | Agent turn complete |
| `heartbeat` | `{ ts }` | Keep-alive |

### Stream Lifecycle

```
User sends message
       │
       ▼
POST /api/threads/:threadId/messages
       │
       ├─► Returns { messageId }
       │
       ▼
Frontend opens GET /api/threads/:threadId/agent/stream
       │
       ├─► Receives agent.tool_call, agent.tool_result, agent.message
       │
       ▼
Agent emits 'final' event
       │
       ▼
Frontend closes stream, fetches final messages
```

## Architecture

### Current State (Broken)

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Service                                   │
│                                                                      │
│  AgentService ─────emit(sessionId)────► TerminalEventBus            │
│                                              │                       │
│                                              ▼                       │
│                     /api/threads/:id/terminal/stream (terminal only) │
│                                                                      │
│                     /api/sessions/:id/stream ──── DELETED ────X     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│                                                                      │
│  Terminal Stream ◄──── /api/threads/:id/terminal/stream (works)     │
│                                                                      │
│  Agent Stream ◄──────── /api/sessions/:id/stream (404 ERROR)        │
└─────────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Service                                   │
│                                                                      │
│  AgentService ─────emit(threadId)─────► AgentEventBus               │
│       │                                      │                       │
│       │                                      ▼                       │
│       │                /api/threads/:id/agent/stream (NEW)          │
│       │                                                              │
│       └──────────────────────────► TerminalSessionManager           │
│                                              │                       │
│  TerminalSessionManager ──emit(sessionId)──► TerminalEventBus       │
│                                              │                       │
│                                              ▼                       │
│                     /api/threads/:id/terminal/stream                 │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│                                                                      │
│  Terminal Stream ◄──── /api/threads/:id/terminal/stream             │
│  (persistent, terminal I/O)                                          │
│                                                                      │
│  Agent Stream ◄──────── /api/threads/:id/agent/stream (NEW)         │
│  (ephemeral per turn, conversation events)                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation

### Phase 1: Server - Create AgentEventBus

**File: `service/src/runtime/event-bus.ts`**

Add new event bus class (trivial - just extend base class):

```typescript
export type AgentEvent = SseEvent;
export class AgentEventBus extends SseEventBus {}
```

### Phase 2: Server - Wire Up AgentEventBus

**File: `service/src/server.ts`**

```typescript
// Add import
import { RunEventBus, TerminalEventBus, AgentEventBus } from "./runtime/event-bus.js";

// Create instance (after terminalEvents)
const agentEvents = new AgentEventBus();

// Update AgentService constructor
const agentService = new AgentService(
  openai,
  terminalSessionManager,
  agentEvents,  // Changed from terminalEvents
  agentLogger,
  config.agentDebug,
  config.agentOpenaiDebug
);

// Update registerThreadRoutes call
await registerThreadRoutes(server, runManager, agentService, agentEvents);
```

### Phase 3: Server - Update AgentService

**File: `service/src/agent/agent-service.ts`**

Change constructor parameter type:
```typescript
import { AgentEventBus } from "../runtime/event-bus.js";

// Constructor
constructor(
  client: OpenAI,
  terminalSessionManager: TerminalSessionManager,
  events: AgentEventBus,  // Changed from TerminalEventBus
  logger: FastifyBaseLogger,
  ...
)
```

Change all `emit()` calls to use `threadId` instead of `sessionId`:

```typescript
// Before
this.events.emit(sessionId, { event: "agent.tool_call", data: { ... } });

// After
this.events.emit(threadId, { event: "agent.tool_call", data: { ... } });
```

Specific locations to change:
- Line 271: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`
- Line 302: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`
- Line 331: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`
- Line 336: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`
- Line 359: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`
- Line 370: `this.events.emit(sessionId, ...)` → `this.events.emit(threadId, ...)`

### Phase 4: Server - Add Agent Stream Endpoint

**File: `service/src/routes/threads.ts`**

Add new function signature:
```typescript
export async function registerThreadRoutes(
  server: FastifyInstance,
  _runManager: RunManager,
  agentService: AgentService,
  agentEvents: AgentEventBus  // NEW parameter
): Promise<void> {
```

Add agent stream endpoint (after message routes, before terminal routes):
```typescript
// GET /api/threads/:threadId/agent/stream - SSE for agent events
server.get("/api/threads/:threadId/agent/stream", (request, reply) => {
  const params = ThreadParamsSchema.parse(request.params);

  // Subscribe to agent events for this thread
  const detach = agentEvents.attach(params.threadId, reply);

  // Send periodic heartbeat
  const heartbeatMs = process.env.NODE_ENV === "production" ? 5000 : 1000;
  const heartbeatInterval = setInterval(() => {
    try {
      reply.sse({ event: "heartbeat", data: JSON.stringify({ ts: Date.now() }) });
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, heartbeatMs);

  // Cleanup on close
  reply.raw.on("close", () => {
    clearInterval(heartbeatInterval);
    detach();
  });
});
```

### Phase 5: Server - Update Message Response

**File: `service/src/routes/threads.ts`**

Simplify the response - no longer need to return sessionId for agent stream:

```typescript
// Before (line 347)
reply.code(201).send({ messageId: message.messageId, sessionId });

// After
reply.code(201).send({ messageId: message.messageId });
```

Note: `startUserMessage()` still returns sessionId internally for its own use, but we don't expose it.

### Phase 6: Frontend - Update Agent Stream Connection

**File: `web/src/routes/$budId/$threadId.tsx`**

#### 6.1 Update connectAgentStream function (line ~343)

Change URL from session-based to thread-based:

```typescript
// Before
const connectAgentStream = useCallback((sessionId: string, agentThreadId: string) => {
  agentSessionIdRef.current = sessionId
  agentThreadIdRef.current = agentThreadId
  const source = new EventSource(buildApiUrl(`/api/sessions/${sessionId}/stream`))
  // ...
}

// After
const connectAgentStream = useCallback((agentThreadId: string) => {
  agentThreadIdRef.current = agentThreadId
  const source = new EventSource(buildApiUrl(`/api/threads/${agentThreadId}/agent/stream`))
  // ...
}
```

#### 6.2 Remove agentSessionIdRef (no longer needed)

```typescript
// Remove this line (~line 87)
const agentSessionIdRef = useRef<string | null>(null)

// Update all references to check agentThreadIdRef instead
```

#### 6.3 Update reconnection logic (line ~372-376)

```typescript
// Before
if (agentSessionIdRef.current && agentThreadIdRef.current) {
  connectAgentStream(agentSessionIdRef.current, agentThreadIdRef.current)
}

// After
if (agentThreadIdRef.current) {
  connectAgentStream(agentThreadIdRef.current)
}
```

#### 6.4 Update handleSubmit (line ~929-942)

```typescript
// Before
const { sessionId } = (await messageResp.json()) as { messageId: string; sessionId: string }
// ... later ...
connectAgentStream(sessionId, threadId)

// After
await messageResp.json() as { messageId: string }
// ... later ...
connectAgentStream(threadId)
```

#### 6.5 Update cancelAgentTurn (line ~856-877)

```typescript
// Before
agentSessionIdRef.current = null
agentThreadIdRef.current = null
// ...

// After
agentThreadIdRef.current = null
// ...
```

## Files Changed Summary

| File | Changes |
|------|---------|
| `service/src/runtime/event-bus.ts` | Add `AgentEventBus` class |
| `service/src/server.ts` | Create `agentEvents`, pass to routes |
| `service/src/agent/agent-service.ts` | Use `AgentEventBus`, emit with `threadId` |
| `service/src/routes/threads.ts` | Add `/agent/stream` endpoint, update message response |
| `web/src/routes/$budId/$threadId.tsx` | Update stream URL, remove sessionId dependency |

## Spec Files to Update

After implementation:

| Spec File | Updates |
|-----------|---------|
| `service/src/routes/routes.spec.md` | Add agent stream endpoint |
| `service/src/runtime/runtime.spec.md` | Add `AgentEventBus` |
| `service/src/agent/agent.spec.md` | Update event emission docs |
| `web/src/routes/$budId/budId.spec.md` | Fix stream URL reference |
| `docs/proto.md` | Add section 2.4 for agent stream |

## Cleanup Action Items

After testing the new stream, clean up remaining legacy references:

### Frontend Files

- [x] `web/src/routes/$budId/budId.spec.md:65` - Update stream URL reference
- [ ] `web/src/components/components.spec.md:52` - Review sessionId mention
- [ ] `web/src/lib/api.ts:52` - Review if `session_id` in Thread type still needed
- [ ] `web/src/components/workbench/thread-panel.tsx:21` - Review session_id prop
- [ ] `web/src/components/debug-panel.tsx` - Consider if sessionId display is useful

Note: Many `session_id` references are for **terminal sessions** (not agent sessions) and should remain.

### Database

- [x] Drop `currentSessionId` column from `thread` table (via `drizzle-kit push`)

## Test Plan

### Unit Tests

1. Verify `AgentEventBus` extends `SseEventBus` correctly
2. Verify agent emits to correct channel (threadId)

### Integration Tests

1. Send message, verify agent stream connects to `/api/threads/:id/agent/stream`
2. Verify `agent.tool_call`, `agent.tool_result`, `agent.message`, `final` events received
3. Verify terminal stream continues to receive `terminal.*` events independently
4. Verify stream closes cleanly on `final`

### Offline Scenario Tests

1. With bud offline, send message
2. Verify agent stream connects (service is up)
3. Verify agent can report "bud offline" via stream
4. When bud comes online, verify terminal operations resume

### Reconnection Tests

1. Simulate service restart during agent turn
2. Verify frontend reconnects to agent stream
3. Verify buffered events replayed

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Events lost during transition | Implement atomically, test thoroughly |
| Frontend race conditions | Keep stream lifecycle simple |
| Buffer overflow on long-running agents | AgentEventBus has 1000 event buffer limit |

---

*Created: 2025-12-12*
*Status: Complete*
*Tested: 2025-12-12 (local testing confirmed working)*

## Implementation Summary

Completed 2025-12-12:

1. **Phase 1**: Added `AgentEventBus` class to `event-bus.ts`
2. **Phase 2**: Wired up `AgentEventBus` in `server.ts`, passed to `AgentService` and routes
3. **Phase 3**: Updated `AgentService` to emit with `threadId` instead of `sessionId`
4. **Phase 4**: Added `GET /api/threads/:threadId/agent/stream` endpoint
5. **Phase 5**: Simplified message response (removed `sessionId`)
6. **Phase 6**: Updated frontend to use new thread-based agent stream URL

Spec files updated:
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `docs/proto.md`

Database cleanup completed 2025-12-12:
- Dropped `currentSessionId` column from `thread` table via `drizzle-kit push`
- See `debug/drizzle-migration-not-applied.md` for notes on migration vs push workflow

Remaining low-priority cleanup:
- Review frontend `session_id` references (may be for terminal sessions, which are valid)
