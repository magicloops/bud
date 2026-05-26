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
  2. POST `/api/threads/:id/messages` to send first message with `{ text, client_id, model, reasoning_effort }` and read `{ message_id, client_id, message }`
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
   - Consumes the paged `{ messages, page }` API contract and the create-message `{ message }` payload for canonical optimistic-row replacement
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
   - Keeps feature hook error callbacks stable so route rerenders do not
     retrigger web-view fetches or agent stream reconnects
   - Parses `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.tool_call`, `agent.tool_result`, `agent.message`, `agent.compaction_start`, `agent.compaction_done`, `agent.compaction_failed`, `thread.title`, `agent.resync_required`, and `final`
   - Renders pending `ask_user_questions` prompts in the timeline and submits responses to the thread-scoped question-response route
   - Keeps the stream attached across `final`, so the same thread view remains ready for the next turn without a close/reopen race
   - Applies `thread.title` patches into the Bud-level thread-summary state so the thread list and workspace top bar update live
   - Shared auth-expiry detection before reconnecting, including reconnect-loop aborts after redirect
   - Shows `Compacting context...` while automatic compaction is active, appends a subtle non-transcript timeline marker on completion/failure, applies `agent.compaction_done.context_budget` immediately when present, and refreshes `/agent/state.context_budget` after successful compaction

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
   - Tracks `context_budget` from `/agent/state`, passes it to the shared composer meter, applies post-compaction stream snapshots, and refreshes it after user sends, model preference changes, bootstrap resyncs, cancel requests, and final turn events
   - The route now primarily composes `useThreadMessages(...)`, `useAgentStream(...)`, `useTerminalSession(...)`, `useFileViewer(...)`, `useWebView(...)`, `ThreadTerminalPane`, `FileViewerPane`, and `WebViewPane`

8. **File Viewer**
   - Assistant message file actions call `useFileViewer(...)` only after a user click
   - `POST /api/threads/:threadId/files/open` creates the short-lived session, then the hook fetches `HEAD` and `GET` through the existing `/api/files/:fileSessionId` edge
   - Opening a file switches the right pane to `file` mode; close returns to `terminal`
   - File mode preserves the mounted `ThreadTerminalPane` underneath an overlay so the xterm DOM instance is not destroyed while previewing files
   - Repeated clicks reuse ready non-expired entries, while reload and expired entries create a fresh audited session
   - Absolute POSIX candidates are supported by the web open flow and normalize to the backend-returned workspace-relative session path
   - Markdown previews can open absolute POSIX links with `source.kind = "markdown_preview"` while unsupported local/relative preview links stay inert
   - The first pass supports Markdown, source/code, and unknown UTF-8 text; binary/image/PDF preview and line scrolling remain follow-ups

9. **Web View**
   - Delegates proxied-site and thread web-view state to `useWebView(...)`
   - The Web view tab can create or reuse an owned loopback proxied site for
     the current Bud
   - Existing owned sites can be attached to the thread so multiple threads can
     point at the same local app
   - The pane mints one-time viewer grants and loads the endpoint-host iframe
     through the hosted bootstrap URL
   - Terminal/Web tab switches preserve the mounted Web view pane so the iframe
     is not recreated with a consumed bootstrap URL
   - Standalone open uses a fresh grant and top-level navigation as the
     fallback for browsers that block embedded cookie access
   - Passes HTTP and WebSocket/HMR transport readiness through to the Web view
     pane so proxied-site failure states are visible in the right pane
   - When terminal recovery transitions back to connected, the route triggers a
     guarded Web view refresh only if an active Web view has an unavailable HTTP
     transport snapshot
   - Agent `web_view.*` tool-result rows switch the right pane to Web view and
     refresh proxied-site/thread attachment state

10. **Ask User Questions**
   - Pending `ask_user_questions` rows render the `QuestionRequestCard` inside the timeline
   - Submission posts `ask_user_questions_response_v1` payloads to `/api/threads/:threadId/agent/question-requests/:requestId/responses`
   - Submission reconciliation delegates to `submitQuestionResponseFlow(...)` in `web/src/features/threads/question-response-submit.ts`
   - Live continuations keep the stream connected while fallback/idempotent responses refresh the transcript/runtime bootstrap
   - The route maps `/agent/state.phase === "waiting_for_user"` and live `ask_user_questions` tool calls to a paused UI status
   - The global thinking indicator is hidden while paused for user input
   - Normal composer input stays enabled while a pending structured prompt is visible; follow-up sends use the normal message route and let the service close the prompt

**State**:
```typescript
// UI state
status: 'idle' | 'dispatching' | 'streaming' | 'waiting_for_user'
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
activeWebView: ApiThreadWebView | null
webViewStatus: 'idle' | 'loading' | 'ready' | 'error'
questionSubmitError: string | null
contextBudget: ApiContextBudget | null
activeCompaction: ApiAgentCompactionStartEvent | null
contextCompactionNotices: ChatTimelineNotice[]
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
- Web view recovery watches the terminal connection transition to `connected`
  and only refreshes the Web view REST snapshot when the current active Web view
  was gated by unavailable HTTP proxy transport

## Types

From `@/lib/api-types` / `@/lib/terminal-data`:
- `ApiMessage` - Message from API (`message_id`, `client_id`, role, content)
- `ApiMessagePage` - Paged transcript window with opaque cursors
- `ApiContextBudget` - Context meter snapshot attached to `/agent/state`
- `ApiAgentCompactionStartEvent` - Live compaction activity event used for the thinking label
- `decodeTerminalData()` - Base64 decode helper

From `@/components/workbench/chat-timeline`:
- `ChatTimelineNotice` - Non-transcript timeline marker state for route-owned activity notices

## Dependencies

| Import | Purpose |
|--------|---------|
| `@tanstack/react-router` | Route definition, navigation |
| `@/components/workbench/*` | UI components |
| `@/components/debug-panel` | Dev-only debug info |
| `@/contexts/layout-context` | Thread panel toggle |
| `@/contexts/bud-status-context` | Bud online status |
| `@/features/threads/*` | Extracted transcript, agent-stream, terminal session, file-viewer, and web-view hooks |
| `@/lib/file-paths` | File-open candidate payload type |
| `@/lib/transport`, `@/lib/api-types`, `@/lib/messages`, `@/lib/models`, `@/lib/auth-redirect` | Split API/runtime helpers |
| `lucide-react` | Icons |

---

*Referenced by: [../routes.spec.md](../routes.spec.md)*
