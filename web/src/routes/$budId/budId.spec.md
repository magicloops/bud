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
- Reuses `WorkspaceShell` so the top bar / split panes / composer frame stay aligned with the existing-thread route
- Loads `/api/models` through the shared `useAvailableModels()` hook using the normalized snake_case catalog contract (`service_default_model`, `default_model`, `default_reasoning_effort`, model `display_name`, `provider_model`, capabilities, and per-model `reasoning`)
- Normalizes the selected reasoning level against the selected model and default reasoning metadata, omitting model fields only if the model list has not loaded yet
- Generates a browser UUIDv7 `client_id` before the first message send
- Thread creation flow:
  1. POST `/api/threads` with `{ bud_id, model, reasoning_effort }` to create the thread and persist its initial model preference
  2. POST `/api/threads/:id/messages` to send first message with `{ text, client_id, model, reasoning_effort }` and read `{ message_id, client_id }`
  3. Navigate to `/$budId/$threadId`
- Terminal initialization (xterm.js) but no connection
- View mode toggle (terminal/web)
- The shared `ViewMode` type includes `file`, but new-thread mode does not surface the file toggle because no opened file exists yet
- Top bar title remains the static `New Thread`

**State**:
- `messageText` - Controlled input
- `status` - idle | dispatching | streaming
- `error` - Error messages
- `reasoningEffort` - Agent thinking level, normalized from selected model metadata
- `viewMode` - terminal | web

### `$threadId.tsx`

**Route**: `/$budId/$threadId`

Main thread view with chat, terminal, and workspace composition behavior (~375 lines after the runtime/presentation split).

**IMPORTANT**: See bidirectional comment in file header linking to `new.tsx`. These routes share layout structure and must be updated together.

**Loader**:
```typescript
loader: async ({ params }) => {
  const [messagePage, agentState, thread] = await Promise.all([
    apiFetchJson(`/api/threads/${params.threadId}/messages?limit=100`),
    apiFetchJson(`/api/threads/${params.threadId}/agent/state`),
    apiFetchJson(`/api/threads/${params.threadId}`)
  ])
  return { messagePage, agentState, thread }
}
```

**Major Features**:

1. **Chat Timeline**
   - Loads the latest paged transcript window from loader data
   - Loads `/agent/state` in parallel for the current in-flight bootstrap snapshot
   - Loads canonical thread detail in parallel so the Bud-level thread list can converge even if the title event was missed before attach
   - Delegates transcript/message-state ownership to `useThreadMessages(...)` in `web/src/features/threads/`
   - Passes the hook-owned chronological `ApiMessage[]` directly into `ChatTimeline` instead of creating an extra route-local mapped/sorted copy
   - Updates via SSE agent stream
   - Role-based rendering (user, assistant, tool)
   - Consumes the paged `{ messages, page }` API contract
   - Prepends older history through `before=<page.before_cursor>` and preserves the visible scroll anchor while doing so
   - Canonical latest-page refetches preserve already-loaded older history instead of replacing the whole local transcript window
   - Timeline row UI state (expand/copy/payload/overflow) is now message-local and memoized inside `ChatTimeline`, reducing whole-list churn during streaming and interaction

2. **Terminal Integration**
   - Delegates xterm/session/reconnect ownership to `useTerminalSession(...)` in `web/src/features/threads/`
   - The hook owns xterm.js + `FitAddon`, terminal SSE attach/reconnect/recovery, keyboard/paste translation, and terminal history replay
   - Delegates terminal overlays, the status bar, and terminal menu rendering to `ThreadTerminalPane` in `web/src/components/workbench/`

3. **Agent Stream**
   - Runtime bootstrap from `/api/threads/:id/agent/state`
   - Delegates SSE attach/resume/reconnect/resync ownership to `useAgentStream(...)` in `web/src/features/threads/`
   - Parses `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `thread.title`, `agent.resync_required`, and `final`
   - Keeps the stream attached across `final`, so the same thread view remains ready for the next turn without a close/reopen race
   - Applies `thread.title` patches into the Bud-level thread-summary state so the thread list and workspace top bar update live
   - Shared auth-expiry detection before reconnecting, including reconnect-loop aborts after redirect

4. **Bud-Level Thread State**
   - Parent `/$budId` route now owns mutable `threads` state rather than treating loader data as immutable
   - Child routes receive `threads`, `upsertThreadSummary(...)`, `patchThreadSummary(...)`, and `removeThreadSummary(...)` through a Bud-route React context
   - Thread-detail upserts merge canonical fields like `title` and `last_message_preview` without clobbering session fields that only come from the thread-list join

5. **Connection Management**
   - Terminal connection states: connected, reconnecting, offline, disconnected
   - Automatic reconnection on SSE close
   - Heartbeat monitoring
   - Active recovery polling while the browser is stranded in reconnecting/offline
   - Disconnect overlay during prolonged outages

6. **Terminal Features**
   - Input buffering and batching for explicit browser-derived terminal bytes only
   - Raw `Ctrl+C` over the normal terminal input path from both keyboard and the terminal menu
   - History backfill on connect
   - Scroll-to-top detection for truncated-history affordances

7. **Shared Workspace Frame**
   - Reuses `WorkspaceShell` with the same top bar, left/right pane contract, composer slot, and debug-panel slot as `/$budId/new`
   - Reuses `useAvailableModels()` so model fetching/default selection and per-model reasoning normalization match the new-thread flow
   - Initializes the selector from the loaded thread's `effective_model` and `effective_reasoning_effort`
   - Persists selector changes through `PATCH /api/threads/:threadId/model-preference` and optimistically patches Bud-level thread-summary state
   - The route now primarily composes `useThreadMessages(...)`, `useAgentStream(...)`, `useTerminalSession(...)`, `useFileViewer(...)`, `ThreadTerminalPane`, and `FileViewerPane`

8. **File Viewer**
   - Assistant message file actions call `useFileViewer(...)` only after a user click
   - `POST /api/threads/:threadId/files/open` creates the short-lived session, then the hook fetches `HEAD` and `GET` through the existing `/api/files/:fileSessionId` edge
   - Opening a file switches the right pane to `file` mode; close returns to `terminal`
   - File mode preserves the mounted `ThreadTerminalPane` underneath an overlay so the xterm DOM instance is not destroyed while previewing files
   - Repeated clicks reuse ready non-expired entries, while reload and expired entries create a fresh audited session
   - Absolute POSIX candidates are supported by the web open flow and normalize to the backend-returned workspace-relative session path
   - Markdown previews can open absolute POSIX links with `source.kind = "markdown_preview"` while unsupported local/relative preview links stay inert
   - The first pass supports Markdown, source/code, and unknown UTF-8 text; binary/image/PDF preview and line scrolling remain follow-ups

**State**:
```typescript
// UI state
status: 'idle' | 'dispatching' | 'streaming'
messages: ApiMessage[]
messagePage: ApiMessagePage['page']
viewMode: 'terminal' | 'web' | 'file'
terminalMenuOpen: boolean

// Feature-hook state exposed to the route
terminalState: string
terminalConnection: 'connected' | 'reconnecting' | 'offline' | 'disconnected'
terminalReadiness: { ready, confidence, trigger, hints }
terminalHasOutput: boolean
terminalOutputTruncated: boolean
activeFileEntry: FileViewerEntry | null
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
- If the SSE stream remains open but the Bud is offline, the terminal hook keeps polling `terminal/ensure`; if the stream itself closes, reconnect attempts are driven only by the backoff timer

## Types

From `@/lib/api-types` / `@/lib/terminal-data`:
- `ApiMessage` - Message from API (`message_id`, `client_id`, role, content)
- `ApiMessagePage` - Paged transcript window with opaque cursors
- `decodeTerminalData()` - Base64 decode helper

## Dependencies

| Import | Purpose |
|--------|---------|
| `@tanstack/react-router` | Route definition, navigation |
| `@/components/workbench/*` | UI components |
| `@/components/debug-panel` | Dev-only debug info |
| `@/contexts/layout-context` | Thread panel toggle |
| `@/contexts/bud-status-context` | Bud online status |
| `@/features/threads/*` | Extracted transcript, agent-stream, and terminal session hooks |
| `@/lib/file-paths` | File-open candidate payload type |
| `@/lib/transport`, `@/lib/api-types`, `@/lib/messages`, `@/lib/models`, `@/lib/auth-redirect` | Split API/runtime helpers |
| `lucide-react` | Icons |

---

*Referenced by: [../routes.spec.md](../routes.spec.md)*
