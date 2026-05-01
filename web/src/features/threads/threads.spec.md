# threads

Thread-scoped browser runtime modules.

## Purpose

Owns thread-scoped browser runtime behavior that was previously embedded directly inside `web/src/routes/$budId/$threadId.tsx`.

## Files

### `use-thread-messages.ts`

Message/transcript ownership for the existing-thread route.

**Responsibilities**:
- bootstrap transcript state from loader-provided `{ messages, page }` plus `/agent/state` overlays
- preserve prepended-scroll position when older history loads
- fetch older transcript pages through `before=<cursor>`
- create and reconcile optimistic user messages
- apply runtime pending-tool and draft-assistant overlays
- reconcile canonical assistant/tool messages from the agent stream
- keep visible assistant draft text in the timeline when a tool call arrives, so text streamed before or between tool calls is not removed while waiting for the persisted assistant row
- clear per-turn synthetic rows when a turn finishes or fails

**Exports**:
- `THREAD_MESSAGE_PAGE_LIMIT`
- `useThreadMessages(...)`

**Route contract**:
- the route still owns loader fetches, terminal presentation, and top-level status/error state
- this hook owns transcript mutation behavior and exposes narrow callbacks for the route’s stream handlers

### `thread-message-state.ts`

Pure transcript/message reconciliation helpers shared by `use-thread-messages.ts`.

**Responsibilities**:
- stable `client_id` identity comparison and chronological sorting
- optimistic user-message reconciliation into canonical persisted ids
- pending-tool / draft-assistant synthetic-row detection and cleanup
- `/agent/state` overlay application
- latest-bootstrap merges that preserve older already-loaded transcript history
- per-turn finalization cleanup rules

**Exports**:
- `applyAgentStateOverlay(...)`
- `mergeLatestBootstrapState(...)`
- `reconcileMessagePersistence(...)`
- `finalizeTurnMessages(...)`
- supporting pure helpers for message upsert/synthetic-row detection

### `thread-message-state.test.ts`

Node-runner coverage for transcript reconciliation rules.

**Coverage**:
- optimistic → canonical id reconciliation
- stale synthetic overlay replacement
- latest-bootstrap preservation of older history/cursors
- turn finalization cleanup semantics

### `use-file-viewer.ts`

Thread-scoped file viewer state and fetch flow for user-clicked transcript paths.

**Responsibilities**:
- create file sessions through `POST /api/threads/:threadId/files/open`
- keep file entries keyed by workspace-relative path so repeated clicks can route back to a valid existing entry
- recreate missing/expired sessions, including reload actions
- fetch file metadata with `HEAD` before `GET`
- enforce the 1 MiB display cap client-side from metadata and fetched bytes
- decode UTF-8, sniff unsupported binary content, and select Markdown/code/text rendering hints
- map edge response failures into viewer statuses (`invalid_path`, `not_found`, `denied`, `too_large`, `expired`, `offline`, `content_changed`, `unsupported_binary`, `error`)

**Exports**:
- `useFileViewer(...)`
- `FileViewerEntry`
- `FileViewerKind`
- `FileViewerStatus`

## Dependencies

| Import | Purpose |
|--------|---------|
| `react` | Hook state, refs, memoization |
| `@/lib/transport` | Paginated message fetch |
| `@/lib/messages` | Optimistic `client_id` generation |
| `@/lib/api-types` | Thread message, agent-state, and file-viewer contracts |
| `@/lib/file-paths` | File-open candidate payload types |

### `use-agent-stream.ts`

Agent SSE ownership for the existing-thread route.

**Responsibilities**:
- attach to `/api/threads/:threadId/agent/stream`
- resume from the latest known stream cursor
- monitor heartbeats and reconnect stale/closed streams
- dedupe reconnect scheduling and heartbeat watchdog installation so browser-managed EventSource reconnects do not stack multiple stale-watch intervals inside one hook instance, and suppress stale-heartbeat escalation while the browser is already reconnecting the source
- handle explicit `agent.resync_required` by calling back into a route-provided bootstrap refresh
- parse `agent.tool_call`, `agent.tool_result`, `agent.message_*`, `thread.title`, and `final` events
- accept `agent.message` for both intermediate assistant text segments and final assistant rows
- tolerate additive tool timing fields such as `started_at`, `finished_at`, and `duration_ms` on tool events
- pass through effective terminal tool args such as `wait_for: "settled"` so presentation code can key terminal-progress UI off the server-owned wait mode
- emit narrow callback events to the route/message feature modules instead of mutating route-local state directly

**Exports**:
- `useAgentStream(...)`

**Route contract**:
- the route still owns the initial loader fetches plus the top-level `status`/`error` state
- the hook owns EventSource lifecycle, cursor tracking, reconnect behavior, and event parsing

### `thread-stream-timing.ts`

Pure reconnect/heartbeat timing helpers shared by the agent and terminal stream hooks.

**Responsibilities**:
- reconnect backoff calculation
- development vs production heartbeat/check interval policy
- stale-heartbeat and stale-terminal-status threshold decisions

**Exports**:
- `getThreadStreamReconnectDelay(...)`
- `getThreadStreamHeartbeatConfig(...)`
- `hasMissedThreadStreamHeartbeat(...)`
- `shouldTreatTerminalStatusAsStale(...)`

### `thread-stream-timing.test.ts`

Node-runner coverage for reconnect delay and heartbeat/staleness thresholds used by both live stream hooks.

### `use-terminal-session.ts`

Terminal session/xterm ownership for the existing-thread route.

**Responsibilities**:
- initialize and dispose the xterm instance plus `FitAddon`
- translate browser keyboard/paste events into explicit terminal input bytes
- batch terminal input and post resize/input mutations to thread-scoped terminal endpoints
- create or reuse the terminal session record, attach to terminal SSE, and reconnect on stale/closed streams
- recover terminal state through `terminal/ensure` plus terminal history replay after reconnects
- expose narrow terminal UI state such as connection status, readiness assessment, truncation, and disconnect overlay visibility

**Exports**:
- `useTerminalSession(...)`
- `TerminalConnectionState`
- `TerminalReadinessAssessment`

**Route contract**:
- the route still owns terminal-specific presentation such as the overlays, status bar, and terminal menu wiring
- the hook owns xterm lifecycle, terminal transport, reconnect policy, and Bud online/offline recovery behavior

## TODO

- Add deeper hook/integration coverage for transcript reconciliation flows beyond the extracted pure helper tests
- Add deeper hook/integration coverage for agent-stream heartbeat timeout, reconnect, and explicit resync-required behavior
- Add deeper hook/integration coverage for terminal reconnect/recovery behavior beyond the shared timing policy tests
- Add component/hook integration coverage for the file viewer open/reuse/error paths beyond parser and service-route tests

---

*Referenced by: [../features.spec.md](../features.spec.md)*
