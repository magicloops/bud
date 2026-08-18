# runtime

Runtime managers for thread terminals and agent-stream state, plus shared SSE event buses.

## Purpose

Orchestrates terminal sessions and agent-stream state across connected bud daemons. Handles:
- Thread-scoped terminal sessions (stem-backed, terminal proto 0.3)
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
- `draft_assistant` (`client_id`, `text`, `started_at`, `updated_at`)
- `draft_reasoning` (array of visible in-flight reasoning segments with `client_id`, `text`, `llm_call_id`, `index`, `provider`, `provider_model`, `started_at`, and `updated_at`)
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
- `setDraftReasoning(...)` mirrors live `agent.reasoning_*` stream progress into `/agent/state.draft_reasoning`; finalization and failed/canceled turn cleanup clear the draft array
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
| `attachCallback(channelId, callback, { lastEventId?, replay? })` | Attach callback function as listener; `replay: false` skips the in-memory buffer replay (used by the terminal stream's byte-offset resume, which replays output from durable storage instead) |

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
- runtime snapshots expose `started_at` on `draft_assistant` so reconnecting clients can calculate active assistant draft duration from service timestamps
- runtime snapshots expose draft reasoning segments so reconnecting clients can recover in-flight provider reasoning before the persisted `reasoning` row is emitted
- runtime snapshots expose `started_at` on `pending_tool` so long-running tool waits remain diagnosable after reconnect
- runtime snapshots expose effective terminal wait modes on `pending_tool.args.wait_for`, including default settled `terminal.send` waits
- runtime snapshots expose model-facing `terminal.send` gesture args (`command`, `raw_text`, or `key`) instead of the Bud wire `text`/`submit` fields
- runtime snapshots expose `waiting_for_user` with a pending `ask_user_questions` tool while a turn is paused for a structured response
- `advanceCursor(...)` preserves in-flight runtime state while acknowledging external thread events already emitted on the shared cursor stream

### `event-bus.test.ts`

Standalone Node test coverage for the generic replay contract still used by terminal streams and shared runtime listeners.

### `terminal-session-manager.test.ts`

Standalone Node tests for the proto 0.3 terminal-session-manager composition layer.

**Current Coverage**:
- `terminal_event` routing: `mode_changed` updates runtime context, `prompt_ready` persists cwd, unknown events are ignored for processing but still forwarded verbatim as `terminal.event` SSE, `child_exited` closes the session locally
- `command_started` / `command_finished` persistence with owner stamping inherited from the session
- S-C1 ownership guard: terminal output / event / send-result / observe-result / status frames from a bud that does not own the session (or for unknown sessions) are dropped before any write, emit, or pending-request resolution
- `ensureSession(...)` forwards the durable stored end offset as `resume_from_offset`
- `getPathContextForSession(...)` returns cached cwd metadata (`reported_by: "prompt_ready_osc7"`) without daemon access

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
| `getPathContextForSession(sessionId)` | Return cached daemon cwd as `terminal_cwd_v1` metadata (`reported_by: "prompt_ready_osc7"`) when available |
| `getPathContextForThread(threadId)` | Return cached daemon cwd for the active thread session without querying Bud |
| `getSessionContext(sessionId)` | Daemon-reported runtime facts: `mode`, `integration`, latest `cwd` |
| `ensureSession(sessionId)` | Send `terminal_ensure` with `resume_from_offset` = highest durably stored end offset |
| `sendInput(sessionId, data, options)` | Forward raw browser input (`terminal_input { session_id, data }`) with user audit metadata |
| `sendResize(sessionId, cols, rows)` | Resize terminal |
| `closeSession(sessionId, reason)` | Close session |
| `observeTerminal(sessionId, { view, lines })` | Explicit grid-backed delta/screen/history observation request-response (results may carry the `ringNextOffset` stream watermark) |
| `sendInteraction(sessionId, { text?, submit?, key?, await? }, options)` | Request-response gesture dispatch; resolves `{ dispatched, outcome }` |
| `interruptThreadTerminal(threadId)` | Send `ctrl+c` as a dispatch-only terminal send, reject older pending waits as `interrupted`, and return dispatch metadata for human interrupt controls |
| `tailOutput(sessionId, maxBytes)` | Most recent stored output (byte-budget paginated) |
| `readOutputRange(sessionId, { startOffset, endOffset?, maxBytes })` | Offset-exact range read with covering-chunk trim and explicit truncation/continuation |
| `getStoredOutputBytes(sessionId)` | Total durably stored output bytes |
| `getCommandOutput(commandId, { maxBytes? })` | Internal API for agent tools: `terminal_command` row plus lossy-UTF-8 output slice by byte range (tail-kept when capped) |
| `getLatestCommandForSession(sessionId)` | Most recent `terminal_command` row for a session (started_at order, command_id tie-break); lets still-running `terminal.run` reports carry the dispatched command_id |
| `handleTerminalStatus(budId, sessionId, payload)` | Bud reports session state (ownership-asserted) |
| `handleTerminalOutput(budId, sessionId, payload)` | Idempotently store and broadcast offset-addressed output (ownership-asserted) |
| `handleTerminalEvent(budId, sessionId, payload)` | Route proto 0.3 semantic events, persist command rows, forward `terminal.event` SSE verbatim (ownership-asserted) |
| `handleObserveResult(budId, sessionId, payload)` | Observe result received; updates runtime mode facts before resolving the pending observe (ownership-asserted) |
| `handleSendResult(budId, sessionId, payload)` | Send result received; resolves `{ dispatched, outcome }` (ownership-asserted) |
| `startIdleChecks()` / `stopIdleChecks()` | Periodic idle-state management; destructive cleanup runs only when explicitly configured |
| `rejectPendingRequestsForThread(threadId, errorMessage)` | Reject in-flight terminal waits for the active thread session |
| `rejectPendingRequestsForBud(budId, errorMessage)` | Reject in-flight terminal waits for all active sessions on an offline Bud |

**Ownership Guard (review finding S-C1)**:
Every inbound terminal frame handler takes the authenticated connection's `budId`, resolves the session, and asserts `session.budId === budId` before any write, SSE emit, or pending-request resolution. Mismatches and unknown sessions are logged and dropped. Gateways (`ws/bud-connection.ts`, `grpc/control-gateway.ts`, `grpc/data-gateway.ts`) only invoke these handlers for authenticated (`connected` / attached) connections.

**Session States**:
```
pending → creating → ready ↔ active ↔ idle → closed
```

**Lifecycle Notes**:
- A thread may accumulate multiple historical `terminal_session` rows over time.
- Only one non-closed session may exist for a thread at once.
- Explicit close produces a closed historical row; revisiting the thread creates a fresh session row.
- Non-closed sessions persist across Bud/service reconnects.
- The daemon terminal runtime is `stem`-backed; only the service-owned `session_id` and backend-neutral status metadata survive in the contract.
- A `child_exited` terminal event closes the session locally (mark closed, reject pending waits, emit `terminal.status: closed`) without sending `terminal_close` back to the daemon.

**Terminal Event Routing (proto 0.3, docs/proto.md §6.7.3)**:

`handleTerminalEvent(...)` processes the semantic event stream:
- `prompt_ready` → latest `cwd` cached on runtime state and persisted to `terminal_session.cwd`
- `mode_changed` → runtime `mode` / `integration` facts updated
- `command_started` / `command_finished` → `terminal_command` rows minted/finalized (idempotent on daemon `command_id`)
- `output_gap` → logged as a truncation warning
- `settled` → no service-side action (awaited outcomes arrive on `terminal_send_result.outcome`)
- `child_exited` → local session close
- unknown `event` values are ignored for processing (additive evolution)

Every `terminal_event` (including unknown ones) is forwarded verbatim to the thread's terminal SSE stream as `terminal.event`.

Ctrl+C note:
- server-side callers should reuse `sendInteraction(sessionId, { key: "ctrl+c" })` rather than adding a dedicated interrupt transport
- human interrupt controls use `interruptThreadTerminal(threadId)`, which sends `key: "ctrl+c"` as a dispatch-only send (no `await`) and rejects any older pending send/observe wait with `error: "interrupted"` so the agent can record a conservative tool result instead of waiting out the awaited budget

**Observe Protocol (0.3)**:

1. Service sends `terminal_observe` with `request_id`, `view` (`delta` | `screen` | `history`), and `lines`
2. Bud answers from the emulator grid: full visible grid (`screen`), damage-region text (`delta`), or recent scrollback (`history`)
3. Bud sends `terminal_observe_result` with matching `request_id` plus `mode` / `integration` / `alt_screen` / cursor facts
4. Promise resolves with the decoded text and mode facts; observe never waits server-side beyond the 30s local budget

**Send Protocol (0.3)**:

1. Service sends `terminal_send` with one structured gesture: `text` with optional `submit`, or one semantic `key`, plus optional `await: "command" | "settled"`
2. Bud dispatches through `stem`; when `await` was requested it resolves the request on the terminating event (`command_finished` or `settled`)
3. Bud sends `terminal_send_result` with `dispatched`, the mirrored `outcome` event (or `null`), and `error`
4. The service owns the timeout budget locally (`timeout_ms` is gone from the wire); byte-exact output history remains a service-side read from `terminal_session_output`

**Terminal SSE Payload Notes (§6.7.7)**:
- `terminal.output` carries `data` and `byte_offset` only (no `seq`); its SSE `id` is the stringified end offset so `Last-Event-ID` is the byte-offset resume cursor
- `terminal.event` forwards `terminal_event` frames verbatim (`session_id`, `event`, `data`, `ts`); it carries no SSE id, as do `terminal.status` / `terminal.bud_offline` / `terminal.bud_online`, so the browser cursor always remains an output byte offset
- `terminal.ready` is retired along with `terminal_ready`
- `terminal.bud_offline` and `terminal.bud_online` carry `bud_id` in snake_case
- the thread history route accepts `since_offset` at the HTTP boundary and serves it through `readOutputRange(...)` with explicit `truncated` / `next_offset` continuation
- `prompt_ready.cwd` updates `terminal_session.cwd`; message writers read the cached value later and do not query the daemon when stamping message metadata
- terminal freshness compares cached output bytes and cwd through service-owned DB/runtime state before provider calls; this path never sends a daemon observe request

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
| `./terminal/*` | Extracted lifecycle/dispatch/output/command/runtime/idle helpers |
| `./daemon-state.js` | Phase 1 daemon operation/stream/session persistence helpers |

## Configuration Used

- `config.terminalIdleTimeoutMinutes` - Mark idle after (default: 30)
- `config.terminalIdleCleanupHours` - Close after idle only when explicitly enabled (default: 0 / disabled)
- `config.terminalIdleCheckIntervalMinutes` - Check frequency (default: 5)

---

*Referenced by: [../src.spec.md](../src.spec.md)*
