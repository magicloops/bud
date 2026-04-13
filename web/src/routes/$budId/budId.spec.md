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
- Fetches threads for the current bud
- Redirects to the most recent thread by `last_activity_at` (fallback `created_at`)
- Redirects to `/$budId/new` if the bud has no threads
- Inherits auth gating from the parent `/$budId` route

### `new.tsx`

**Route**: `/$budId/new`

New thread creation view.

**Features**:
- Empty terminal display with placeholder message
- Message composer for the first user message
- Loads `/api/models` using the normalized snake_case contract (`default_model`, model `display_name`, optional `is_alias`)
- Generates a browser UUIDv7 `client_id` before the first message send
- Creates a thread via `POST /api/threads`, then writes the first message via `POST /api/threads/:id/messages`
- Navigates to `/$budId/$threadId` after the first send succeeds

### `$threadId.tsx`

**Route**: `/$budId/$threadId`

Main thread view with chat, terminal streaming, and reconnect/recovery behavior.

**Loader**:
```typescript
loader: async ({ params }) => {
  const [messagePage, agentState, thread] = await Promise.all([
    apiFetchJson(`/api/threads/${params.threadId}/messages?limit=100`),
    apiFetchJson(`/api/threads/${params.threadId}/agent/state`),
    apiFetchJson(`/api/threads/${params.threadId}`),
  ])
  return { messagePage, agentState, thread }
}
```

**Major features**:

1. **Chat timeline**
- Loads the latest paged transcript window plus `/agent/state` and canonical thread detail in parallel
- Prepends older history through `before=<page.before_cursor>` while preserving scroll position
- Reconciles optimistic, runtime, and canonical rows by stable `client_id`
- Applies `thread.title` patches into the Bud-level thread-summary state

2. **Terminal bootstrap and transport**
- Initializes xterm.js plus FitAddon once and keeps the terminal mounted across view switches
- Uses a browser-side terminal controller instead of forwarding raw xterm `onData(...)` directly to the service
- Creates or reuses the thread terminal session row via `POST /terminal`
- Recovers terminal readiness via `POST /terminal/ensure`
- Bootstraps xterm from `GET /terminal/state` rather than replaying `/terminal/history` through xterm on every open/reconnect
- Treats `bootstrap.kind: "grid"` as the preferred restore path, using pane geometry, capture scope, explicit cursor position, and exact visible rows from the service
- Degrades grid bootstrap to text when the local xterm geometry does not match the captured pane geometry
- Restricts the trailing-blank trim workaround to degraded/text bootstrap paths instead of applying it to full-fidelity grid restores
- Routes normal browser typing and modeled keys through `POST /terminal/send` with dispatch-only semantics (`observe: null`)
- Keeps `POST /terminal/input` only as a narrow raw fallback for unsupported human sequences and emulator protocol traffic
- Sends resize updates only when terminal dimensions actually change
- Uses the existing interrupt route for Ctrl+C
- Includes dev-only diagnostics around bootstrap application, fit timing, stream attach offsets, and tab visibility restore while the richer contract is being validated

3. **Terminal stream semantics**
- Connects to `GET /terminal/stream` in live-only mode when no durable cursor is available
- Resumes with `?after_offset=<last_rendered_byte_offset>` after safe bootstrap or reconnect catch-up
- Writes `terminal.output` through the controller so overlapping durable replay bytes are trimmed before rendering
- Handles explicit `terminal.resync_required` by reloading `/terminal/state` and reattaching instead of replaying stale history blindly
- Keeps `terminal.status`, `terminal.ready`, `terminal.bud_offline`, `terminal.bud_online`, and heartbeat handling on the live SSE path

4. **Agent stream**
- Uses `/agent/state` for best-effort bootstrap and `/agent/stream` for live transport plus bounded resume
- Builds per-turn draft assistant rows from `agent.message_start` and `agent.message_delta`
- Replaces pending draft/tool rows with canonical persisted messages when `agent.message` / `agent.tool_result` arrive
- Refetches `/messages` plus `/agent/state` on `agent.resync_required`

5. **Connection management**
- Tracks terminal connection state as `connected`, `reconnecting`, `offline`, or `disconnected`
- Uses exponential-backoff reconnect scheduling for closed terminal streams
- Polls `terminal/ensure` only while the SSE stream is still open but the Bud is offline/reconnecting
- Shows a dimming reconnect overlay during prolonged outages

**Terminal event handling**:

| Event | Action |
|-------|--------|
| `terminal.output` | Trim overlapping bytes by `byte_offset`, then write through the controller |
| `terminal.status` | Update terminal state |
| `terminal.ready` | Update readiness indicators |
| `terminal.bud_offline` / `terminal.bud_online` | Update Bud status and trigger recovery |
| `terminal.resync_required` | Reload `/terminal/state`, mark truncation, and reattach |
| `heartbeat` | Track last event time for stale-connection detection |

**State highlights**:
```typescript
status: 'idle' | 'dispatching' | 'streaming'
messages: ApiMessage[]
messagePage: ApiMessagePage['page']
viewMode: 'terminal' | 'web'
terminalState: string
terminalConnection: 'connected' | 'reconnecting' | 'offline' | 'disconnected'
terminalReadiness: { ready, confidence, trigger, hints } | null
terminalHasOutput: boolean
terminalOutputTruncated: boolean
```

## Types

From `@/lib/api`:
- `ApiMessage` - Message from API (`message_id`, `client_id`, role, content)
- `ApiMessagePage` - Paged transcript window with opaque cursors
- `ApiTerminalState` - Safe terminal bootstrap response with richer `bootstrap` kinds
- `ApiTerminalSendRequest` - Structured browser terminal send contract

From `@/lib/thread-terminal-controller`:
- `ThreadTerminalController` - Browser terminal transport controller

## Dependencies

| Import | Purpose |
|--------|---------|
| `@tanstack/react-router` | Route definition and navigation |
| `xterm` | Terminal emulator |
| `xterm-addon-fit` | Auto-fit terminal size |
| `@/components/workbench/*` | UI components |
| `@/components/debug-panel` | Dev-only debug info |
| `@/contexts/layout-context` | Thread panel toggle |
| `@/contexts/bud-status-context` | Bud online status |
| `@/lib/api` | API utilities and terminal route types |
| `@/lib/terminal-xterm-input` | xterm input classification |
| `@/lib/thread-terminal-controller` | Browser terminal transport controller |
| `lucide-react` | Icons |

---

*Referenced by: [../routes.spec.md](../routes.spec.md)*
