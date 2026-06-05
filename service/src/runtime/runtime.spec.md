# runtime

Runtime managers for thread terminals and agent-stream state, plus shared SSE event buses.

## Purpose

Orchestrates terminal sessions and agent-stream state across connected bud daemons. Handles:
- Thread-scoped terminal sessions (tmux-backed)
- Generic SSE event broadcasting for terminal streams
- Agent-thread runtime snapshots plus bounded resume state

## Files

### `agent-runtime-state.ts`

Dedicated runtime store for agent-thread in-flight state and bounded resume.

**Responsibilities**:
- Own the authoritative best-effort `/api/threads/:thread_id/agent/state` snapshot
- Allocate opaque monotonic `stream_cursor` values for active and idle snapshots
- Keep a bounded same-instance replay window with cursor checkpoints
- Support live-only no-cursor attach plus bounded cursor replay
- Require explicit `agent.resync_required` when a supplied resume cursor is too old or unknown
- Keep the runtime-owned snapshot limited to in-flight turn state, active Bud environment, client-safe active budget state, and the latest non-cancel runtime failure; browser routes may still recompute durable `environment` and `context_budget` snapshots after idle/final transitions

**Snapshot Shape**:
- `active`
- `turn_id`
- `phase`
- `can_cancel`
- `stream_cursor`
- `pending_tool` (`client_id`, `call_id`, `name`, `args`, `started_at`; terminal-tool args include the effective `wait_for` mode and `terminal.send` uses `command`, `raw_text`, or `key`)
- `pending_tool` may also contain the normalized `ask_user_questions_request_v1` payload while the agent is waiting for a user response
- `draft_assistant` (`client_id`, `text`, `updated_at`)
- `environment` (client-safe current Bud mode/status and tool availability while a turn is active; route responses refresh current environment for idle and active reads)
- `context_budget` (latest active context budget decision while a turn is running; cleared on new/final idle transitions)
- `last_error` (client-safe, in-memory non-cancel agent failure snapshot with `turn_id`, stable `code`, sanitized `message`, `retryable`, and `occurred_at`; cleared when a new turn starts)
- `updated_at`

The route-level `context_budget` response prefers this runtime-owned active snapshot while a turn is running. When runtime is idle, or when no active decision has been recorded yet, the threads route computes durable state after authorization from model/catalog metadata, persisted conversation state, provider diagnostics, and compaction checkpoints.

**Phase Values**:
- `idle`
- `starting`
- `thinking`
- `tool_running`
- `waiting_for_user`
- `streaming_message`

**Replay / Cursor Notes**:
- no-cursor agent attach is live-only
- `/agent/state` always exposes a resumable `stream_cursor`
- event-frame `id:` values on the agent stream are the same opaque runtime cursors
- replay is intentionally bounded and process-local
- resume misses surface explicit resync instead of silent live-only fallback
- non-agent thread events such as `thread.title` can advance the same cursor space without mutating the active turn phase, pending tool, or draft assistant snapshot
- service-owned activity events such as `agent.compaction_start`, `agent.compaction_done`, and `agent.compaction_failed` advance the cursor and keep the in-flight phase in `thinking` so reconnecting clients can resume after those markers
- `setEnvironment(...)` updates the runtime environment snapshot without emitting a standalone SSE event; `/agent/state` is the authoritative convergence surface for environment
- `setContextBudget(...)` and `clearContextBudget(...)` update the client-safe budget snapshot without emitting a standalone SSE event
- `setLastError(...)` and `clearLastError(...)` update the runtime-only failure snapshot without writing transcript rows; `finishTurn(...)` preserves it so `/agent/state` can recover missed fast failure events

### `event-bus.ts`

Generic SSE event bus with buffering for replay.

**Classes**:
- `SseEventBus` - Base class with channel-keyed listeners and buffers
- `TerminalEventBus` - For terminal session events
- `AgentEventBus` - Legacy generic agent bus export retained for compatibility/tests; production agent-thread streaming now uses `agent-runtime-state.ts`

**Key Features**:
- **Buffering**: Stores up to 1000 events per channel for replay
- **Cursor-aware replay on attach**: New listeners receive buffered events, or only the events after a provided `last_event_id` / `Last-Event-ID` cursor when available
- **Replay miss fallback**: If a resume cursor is not present in the in-memory buffer, the attach falls back to live-only delivery and relies on canonical history for recovery
- **Immediate stream priming**: Any attach with zero replayable events emits a heartbeat frame so `fastify-sse-v2` opens the stream before the route returns
- **Auto-cleanup**: Empty listener sets are removed

**Methods**:

| Method | Description |
|--------|-------------|
| `emit(channelId, event)` | Broadcast event to listeners and buffer |
| `clearBuffer(channelId)` | Clear buffer (e.g., on bud disconnect) |
| `attach(channelId, reply, { lastEventId? })` | Attach Fastify reply as SSE listener with optional cursor-aware replay |
| `attachCallback(channelId, callback, { lastEventId? })` | Attach callback function as listener with the same replay semantics |

### `agent-runtime-state.test.ts`

Standalone Node test coverage for the agent runtime snapshot and bounded-resume contract.

**Current Coverage**:
- idle snapshots expose resumable cursors
- active turns have a cursor before any visible event
- no-cursor attach is live-only
- attach after a known cursor replays only newer visible events
- stale cursors produce explicit resync
- finishing a turn returns the snapshot to idle with a fresh cursor
- context budget snapshots serialize during active turns and clear on new/final idle transitions
- environment snapshots serialize during active turns, can be updated mid-turn, and clear from runtime idle snapshots after finalization
- runtime failure snapshots serialize as `last_error`, survive failed-turn finalization, and clear when a new turn starts
- runtime snapshots expose `client_id` on both `pending_tool` and `draft_assistant`
- runtime snapshots expose `started_at` on `pending_tool` so long-running tool waits remain diagnosable after reconnect
- runtime snapshots expose effective terminal wait modes on `pending_tool.args.wait_for`, including default settled `terminal.send` waits
- runtime snapshots expose model-facing `terminal.send` gesture args (`command`, `raw_text`, or `key`) instead of the Bud wire `text`/`submit` fields
- runtime snapshots expose `waiting_for_user` with a pending `ask_user_questions` tool while a turn is paused for a structured response
- `advanceCursor(...)` preserves in-flight runtime state while acknowledging external thread events already emitted on the shared cursor stream

### `event-bus.test.ts`

Standalone Node test coverage for the generic replay contract still used by terminal streams and shared runtime listeners.

### `terminal-session-manager.test.ts`

Standalone Node tests for targeted terminal-session-manager context tracking regressions.

**Current Coverage**:
- non-shell readiness assessments do not clear pending REPL context
- observed shell readiness still clears pending REPL context

### `daemon-state.ts`

Phase 1 durable daemon-state helper for the network upgrade.

Owns:
- operation and stream lifecycle state constants/transition checks
- `DaemonStateStore` repository methods for `device_session`, `transport_session`, `bud_operation`, `bud_stream`, and `audit_event`
- optimistic state-transition updates
- helper to mark in-flight operations/streams `unknown` when a transport session outcome is uncertain
- heartbeat/close updates for durable device and transport sessions
- reconnect-report reconciliation helpers that compare daemon-reported operations/streams with service rows and produce `reconciliation_decision` payload data
- data-plane transport finalizers use this helper to mark logical stream loss when WebSocket or HTTP/2 carriers close before runtime streams complete

### `daemon-state.test.ts`

Standalone lifecycle tests for allowed operation and stream transitions, including `unknown` reconnect-recovery paths.

### `terminal-session-manager.ts`

Thread-scoped terminal session composition root.

**TerminalSessionManager Class**:

`TerminalSessionManager` now composes the extracted `runtime/terminal/*` helpers instead of directly owning every terminal concern.

**Key Methods**:

| Method | Description |
|--------|-------------|
| `ensureSessionRecordForThread(threadId, budId, createdByUserId?)` | Single concurrency-safe first-use session boundary shared by route and agent callers |
| `createSessionForThread(threadId, budId, createdByUserId?)` | Compatibility wrapper over `ensureSessionRecordForThread(...)` |
| `isBudOnline(budId)` / `getBudTransportStatus(budId)` | Expose current daemon transport availability for route/agent environment resolution |
| `getSessionForThread(threadId)` | Get the active (non-closed) session |
| `getSession(sessionId)` | Get by ID |
| `getPathContextForSession(sessionId)` | Return cached daemon cwd as `terminal_cwd_v1` metadata when available |
| `getPathContextForThread(threadId)` | Return cached daemon cwd for the active thread session without querying Bud |
| `getLatestReadiness(sessionId)` | Return the latest cached readiness assessment without querying Bud |
| `ensureSession(sessionId)` | Send `terminal_ensure` to bud |
| `sendInput(sessionId, data, options)` | Send input with optional readiness waiting and user audit metadata |
| `sendResize(sessionId, cols, rows)` | Resize terminal |
| `closeSession(sessionId, reason)` | Close session |
| `observeTerminal(sessionId, options)` | Explicit delta/screen/history observation request-response |
| `capturePane(sessionId, options)` | Compatibility wrapper used by context sync |
| `sendInteraction(sessionId, interaction, options)` | Request-response interactive input / keypress dispatch |
| `interruptThreadTerminal(threadId)` | Send `ctrl+c` as a terminal send, reject older pending waits as `interrupted`, and return dispatch metadata for human interrupt controls |
| `tailOutput(sessionId, bytes, options)` | Get recent output from DB |
| `setPendingCommand(sessionId, command)` | Track REPL program execution |
| `handleTerminalStatus(sessionId, payload)` | Bud reports session state |
| `handleTerminalOutput(sessionId, payload)` | Store and broadcast output |
| `handleTerminalReady(sessionId, payload)` | Readiness assessment received |
| `handleObserveResult(sessionId, payload)` | Observe result received; persists optional daemon-reported `hostCwd` before resolving a pending observe |
| `handleSendResult(sessionId, payload)` | Send result received; persists optional daemon-reported `hostCwd` before resolving a pending send |
| `startIdleChecks()` / `stopIdleChecks()` | Periodic idle-state management; destructive cleanup runs only when explicitly configured |
| `rejectPendingRequestsForThread(threadId, errorMessage)` | Reject in-flight terminal waits for the active thread session |
| `rejectPendingRequestsForBud(budId, errorMessage)` | Reject in-flight terminal waits for all active sessions on an offline Bud |

**Session States**:
```
pending → creating → ready ↔ active ↔ idle → closed
```

**Lifecycle Notes**:
- A thread may accumulate multiple historical `terminal_session` rows over time.
- Only one non-closed session may exist for a thread at once.
- Explicit close produces a closed historical row; revisiting the thread creates a fresh session row.
- Non-closed sessions persist across Bud/service reconnects.
- The service no longer derives or persists tmux session names as first-class runtime state; only the Bud-owned `session_id` and backend-neutral status metadata survive in the normal contract.

**REPL Context Tracking**:

When agent sends commands like `python`, `node`, `claude`, the manager:
1. Stores as `pendingCommand` with timestamp
2. Provides `getContext(sessionId)` for agent to understand terminal state
3. Uses `known-programs.ts` registry for program-specific hints

Ctrl+C note:
- server-side callers should reuse `sendInteraction(sessionId, { key: "ctrl+c" })` rather than adding a dedicated interrupt transport
- human interrupt controls use `interruptThreadTerminal(threadId)`, which sends `key: "ctrl+c"` with `waitFor: "none"` and rejects any older pending send/observe wait with `error: "interrupted"` so the agent can record a conservative tool result instead of waiting up to the settled timeout
- `sendInteraction(...)` still tolerates the older `keys: ["C-c"]` shape as a compatibility alias during rollout, but the canonical runtime model is now a single semantic `key`
- pending REPL/TUI context is preserved until a later observed shell return clears it via readiness or context sync

**Observe Protocol**:

1. Service sends `terminal_observe` with `request_id`
2. Bud optionally waits using `shell_ready`, `changed`, or `settled`; `changed` stays on the screen-diff path while `settled` waits on output quiescence before the final capture
3. Bud sends `terminal_observe_result` with matching `request_id`
4. Promise resolves with delta by default, or full screen/history when explicitly requested

**Send Protocol**:

1. Service sends Bud `terminal_send` with one structured gesture: `text` with optional `submit`, or one semantic `key`; the agent-facing executor adapts `command` / `raw_text` / `key` into this wire shape
2. Bud dispatches literal text and special keys through the current terminal backend adapter
3. Bud captures a pre-send baseline and, by default, waits for output quiescence before doing one final `capture-pane`
4. `observe_after_ms` is only relevant for explicit `wait_for: "none"` sends; `changed` remains available for first-visible-reaction waits
5. Bud sends `terminal_send_result` with dispatch status, additive delta, and timeout-aware readiness / partial-progress semantics

These request-response paths replace the previous overloaded `terminal_run` / `terminal_capture` contract. The active model-facing contract is now send-first: shell and interactive input both flow through `terminal.send`, while `terminal.observe` is the explicit inspection hatch.

**Terminal SSE Payload Notes**:
- `terminal.output` carries `seq`, `data`, and `byte_offset`
- `terminal.bud_offline` and `terminal.bud_online` now carry `bud_id` in snake_case
- the thread history route accepts `since_offset` at the HTTP boundary even though the internal helper still uses a camelCase option name
- `sendInteraction()` now defaults to `waitFor: "settled"` and resolves settled waits to the service-owned one-hour timeout before dispatching to Bud
- `sendInteraction()` still accepts `observeAfterMs`, but only uses the default `1000ms` fast-capture behavior when `waitFor: "none"` is requested explicitly
- `sendInteraction()` now treats interactive input as a single gesture and emits canonical `key` values such as `ctrl+c`; the older `interaction.keys` array is accepted only as a one-entry compatibility alias
- `handleSendResult()` now resolves a minimal send contract centered on `submitted`, `delta`, readiness, optional `hostCwd`, and conservative timeout summaries
- terminal result `hostCwd` values update `terminal_session.cwd`; message writers read the cached value later and do not query the daemon when stamping message metadata
- terminal freshness compares cached output bytes, cwd, and readiness through service-owned DB/runtime state before provider calls; this path never sends a daemon observe request
- pending send and observe rejections now log request id, wait mode, elapsed time, latest output offset, output event count, and current readiness summary for long-wait diagnostics
- `observeTerminal(waitFor: "settled")` uses the same one-hour settled budget as `sendInteraction()`, while non-settled observe modes keep the shorter default or trusted explicit timeout
- `observeTerminal()` now gives the daemon timeout budget plus a local `1000ms` grace window so normal results do not orphan as quickly
- `observeTerminal()` defaults to `view: "delta"` and only returns full capture content for explicit `screen` / `history` requests

### `terminal/` → [terminal/terminal.spec.md](./terminal/terminal.spec.md)

Internal terminal-runtime ownership helpers extracted from the old monolithic manager.

**Ownership Notes**:
- `ensureSessionRecordForThread()` stamps `terminal_session.created_by_user_id`
- `sendInput(..., { userId })` writes the acting human id into `terminal_session_input_log.user_id`

## Dependencies

| Import | Purpose |
|--------|---------|
| `fastify` | Logger types |
| `ulid` | ID generation |
| `drizzle-orm` | Query helpers |
| `../db/client.js` | Database access |
| `../db/schema.js` | Table schemas |
| `../config.js` | Configuration values |
| `../agent/context-budget-state.js` | Client-safe active context budget snapshot type |
| `../transport/*.js` | Daemon transport router interface and current WebSocket adapter |
| `../terminal/types.js` | Type definitions |
| `../terminal/known-programs.js` | REPL detection |
| `./terminal/*` | Extracted lifecycle/dispatch/output/runtime/idle helpers |
| `./daemon-state.js` | Phase 1 daemon operation/stream/session persistence helpers |

## Configuration Used

- `config.terminalIdleTimeoutMinutes` - Mark idle after (default: 30)
- `config.terminalIdleCleanupHours` - Close after idle only when explicitly enabled (default: 0 / disabled)
- `config.terminalIdleCheckIntervalMinutes` - Check frequency (default: 5)

---

*Referenced by: [../src.spec.md](../src.spec.md)*
