# $budId

Nested routes for bud-specific views (new thread and existing thread).

## Purpose

Provides the route components under `/$budId/`:
- `/$budId/` (index) - Redirect to most recent thread or `/new`
- `/$budId/new` - New thread creation view
- `/$budId/$threadId` - Existing thread conversation view

## Files

### `index.tsx`

**Route**: `/$budId/`

Redirect-only route that auto-selects content based on thread availability.

**Behavior**:
```typescript
loader: async ({ params }) => {
  const threads = await fetch(`/api/threads?bud_id=${params.budId}`)

  if (threads.length === 0) {
    throw redirect({ to: '/$budId/new' })
  }

  const mostRecent = threads.reduce(/* by last_activity_at */)
  throw redirect({ to: '/$budId/$threadId', params: { threadId: mostRecent.thread_id } })
}
```

**Features**:
- Fetches threads for the current bud
- Redirects to most recent thread (by `last_activity_at`, fallback to `created_at`)
- Redirects to `/new` if no threads exist
- Error handling: throws on fetch failure (doesn't mask errors)

### `new.tsx`

**Route**: `/$budId/new`

New thread creation view - allows users to start a new conversation.

**IMPORTANT**: See bidirectional comment in file header linking to `$threadId.tsx`. These routes share layout structure and must be updated together.

**Features**:
- Empty terminal display with placeholder message
- Message composer for initial message
- Thread creation flow:
  1. POST `/api/threads` to create thread
  2. POST `/api/threads/:id/messages` to send first message
  3. Navigate to `/$budId/$threadId`
- Terminal initialization (xterm.js) but no connection
- View mode toggle (terminal/web)

**State**:
- `messageText` - Controlled input
- `status` - idle | dispatching | streaming
- `error` - Error messages
- `reasoningEffort` - Agent thinking level
- `viewMode` - terminal | web

### `$threadId.tsx`

**Route**: `/$budId/$threadId`

Main thread view with full chat and terminal functionality (~1000 lines).

**IMPORTANT**: See bidirectional comment in file header linking to `new.tsx`. These routes share layout structure and must be updated together.

**Loader**:
```typescript
loader: async ({ params }) => {
  const messagesResp = await fetch(`/api/threads/${params.threadId}/messages?limit=200`)
  return { messages }
}
```

**Major Features**:

1. **Chat Timeline**
   - Loads messages from loader data
   - Updates via SSE agent stream
   - Role-based rendering (user, assistant, tool)

2. **Terminal Integration**
   - xterm.js instance with FitAddon
   - SSE connection to `/api/threads/:id/terminal/stream`
   - Input forwarding to `/api/threads/:id/terminal/input`
   - Resize handling via `/api/threads/:id/terminal/resize`
   - Reconnection logic with exponential backoff

3. **Agent Stream**
   - SSE connection to `/api/threads/:id/agent/stream`
   - Event handling: `agent.tool_call`, `agent.tool_result`, `agent.message`, `final`
   - Message list updates from events

4. **Connection Management**
   - Terminal connection states: connected, reconnecting, offline, disconnected
   - Automatic reconnection on SSE close
   - Heartbeat monitoring
   - Disconnect overlay with manual reconnect

5. **Terminal Features**
   - Input buffering and batching
   - Ctrl+C interrupt button
   - Clear terminal option
   - History backfill on connect
   - Scroll-to-top detection for more history loading

**State**:
```typescript
// UI state
status: 'idle' | 'dispatching' | 'streaming'
messages: ApiMessage[]
viewMode: 'terminal' | 'web'

// Terminal state
terminalState: string
terminalConnection: 'connected' | 'reconnecting' | 'offline' | 'disconnected'
terminalReadiness: { ready, confidence, trigger, hints }
terminalHasOutput: boolean
terminalOutputTruncated: boolean
```

**Terminal Event Handling**:

| Event | Action |
|-------|--------|
| `output` | Decode base64, write to xterm |
| `status` | Update terminal state |
| `ready` | Update readiness indicators |
| `heartbeat` | Track last event time |
| `history` | Backfill initial output |

**Connection Recovery**:
- SSE close → Start reconnect timer
- Exponential backoff: 1s, 2s, 4s, ... up to 30s
- On reconnect: ensure session, backfill history, resubscribe

## Types

From `@/lib/api`:
- `ApiMessage` - Message from API
- `decodeTerminalData()` - Base64 decode helper

## Dependencies

| Import | Purpose |
|--------|---------|
| `@tanstack/react-router` | Route definition, navigation |
| `xterm` | Terminal emulator |
| `xterm-addon-fit` | Auto-fit terminal size |
| `@/components/workbench/*` | UI components |
| `@/components/debug-panel` | Dev-only debug info |
| `@/contexts/layout-context` | Thread panel toggle |
| `@/contexts/bud-status-context` | Bud online status |
| `@/lib/api` | API utilities |
| `lucide-react` | Icons |

---

*Referenced by: [../routes.spec.md](../routes.spec.md)*
