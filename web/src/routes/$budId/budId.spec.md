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
  const threads = await apiFetchJson(`/api/threads?bud_id=${params.budId}`)

  if (threads.length === 0) {
    throw redirect({ to: '/$budId/new' })
  }

  const mostRecent = threads.reduce(/* by last_activity_at */)
  throw redirect({ to: '/$budId/$threadId', params: { threadId: mostRecent.thread_id } })
}
```

**Features**:
- Fetches threads for the current bud
- Inherits auth gating from parent `/$budId`
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
- Loads `/api/models` using the normalized snake_case contract (`default_model`, model `display_name`, optional `is_alias`)
- Thread creation flow:
  1. POST `/api/threads` to create thread and read `{ thread_id }`
  2. POST `/api/threads/:id/messages` to send first message and read `{ message_id }`
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
  const messagePage = await apiFetchJson(`/api/threads/${params.threadId}/messages?limit=100`)
  return { messagePage }
}
```

**Major Features**:

1. **Chat Timeline**
   - Loads the latest paged transcript window from loader data
   - Updates via SSE agent stream
   - Role-based rendering (user, assistant, tool)
   - Consumes the paged `{ messages, page }` API contract
   - Prepends older history through `before=<page.before_cursor>` and preserves the visible scroll anchor while doing so
   - Canonical latest-page refetches preserve already-loaded older history instead of replacing the whole local transcript window

2. **Terminal Integration**
   - xterm.js instance with FitAddon
   - SSE connection to `/api/threads/:id/terminal/stream`
   - Input forwarding to `/api/threads/:id/terminal/input`
   - Resize handling via `/api/threads/:id/terminal/resize` (only when dimensions change)
   - Reconnection logic with exponential backoff
   - Idempotent recovery helper that re-runs `terminal/ensure`, reloads terminal state, and replays stored history after reconnects
   - Shared auth-aware EventSource creation before reconnect logic takes over
   - Stops reconnect and polling loops once the browser has already redirected for expired auth
   - Failed session-record fetches now re-enter the same reconnect backoff path instead of falling into a separate `/api/threads/:id/terminal` polling loop

3. **Agent Stream**
   - SSE connection to `/api/threads/:id/agent/stream`
   - Event handling: `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `final`
   - Builds one per-turn draft assistant row from `agent.message_start` / `agent.message_delta`
   - Treats `agent.message_done` as the final draft snapshot before canonical persistence
   - Uses backend-provided `call_id`, `message_id`, and canonical `message` payloads to reconcile live events into the transcript
   - Replaces draft assistant rows with the canonical persisted assistant row when `agent.message` arrives
   - Reconnects pass the last seen SSE frame id back as `last_event_id` so the server can replay only newer buffered events when available
   - Replaces the optimistic user-row id with the real `message_id` returned by `POST /messages`
   - Healthy successful turns no longer require a mandatory `final` refetch just to learn assistant/tool message ids
   - Shared auth-expiry detection before reconnecting, including reconnect-loop aborts after redirect

4. **Connection Management**
   - Terminal connection states: connected, reconnecting, offline, disconnected
   - Automatic reconnection on SSE close
   - Heartbeat monitoring
   - Active recovery polling while the browser is stranded in reconnecting/offline
   - Disconnect overlay during prolonged outages

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
messagePage: ApiMessagePage['page']
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
| `output` | Decode base64, write to xterm (no resize - xterm handles rendering) |
| `status` | Update terminal state |
| `ready` | Update readiness indicators |
| `terminal.bud_offline` / `terminal.bud_online` | Update Bud status from snake_case `bud_id` payloads and trigger recovery |
| `heartbeat` | Track last event time |
| `history` | Backfill initial output |

**Resize Optimization**: Terminal resize requests are only sent when dimensions actually change (window resize, panel toggle). Output events don't trigger resize - xterm handles content rendering internally. Dimension tracking via `lastSentDimensionsRef` prevents redundant requests.

**Connection Recovery**:
- SSE close → Start reconnect timer
- Exponential backoff: 1s, 2s, 4s, ... up to 30s
- On reconnect: rerun `terminal/ensure`, fetch authoritative session state, backfill history, and only then return to `connected`
- If the SSE stream remains open but the Bud is offline, the route keeps polling `terminal/ensure`; if the stream itself closes, reconnect attempts are driven only by the backoff timer

## Types

From `@/lib/api`:
- `ApiMessage` - Message from API
- `ApiMessagePage` - Paged transcript window with opaque cursors
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
