# runtime

Runtime managers for runs and terminal sessions, plus event bus infrastructure.

## Purpose

Orchestrates execution of commands and terminal sessions across connected bud daemons. Handles:
- Command dispatch and result tracking
- Thread-scoped terminal sessions (tmux-backed)
- Generic SSE event broadcasting for run/terminal streams
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

**Snapshot Shape**:
- `active`
- `turn_id`
- `phase`
- `can_cancel`
- `stream_cursor`
- `pending_tool` (`client_id`, `call_id`, `name`, `args`)
- `draft_assistant` (`client_id`, `text`, `updated_at`)
- `updated_at`

**Phase Values**:
- `idle`
- `starting`
- `thinking`
- `tool_running`
- `streaming_message`

**Replay / Cursor Notes**:
- no-cursor agent attach is live-only
- `/agent/state` always exposes a resumable `stream_cursor`
- event-frame `id:` values on the agent stream are the same opaque runtime cursors
- replay is intentionally bounded and process-local
- resume misses surface explicit resync instead of silent live-only fallback
- non-agent thread events such as `thread.title` can advance the same cursor space without mutating the active turn phase, pending tool, or draft assistant snapshot

### `event-bus.ts`

Generic SSE event bus with buffering for replay.

**Classes**:
- `SseEventBus` - Base class with channel-keyed listeners and buffers
- `RunEventBus` - For run execution events
- `TerminalEventBus` - For terminal session events
- `AgentEventBus` - Legacy generic agent bus export retained for compatibility/tests; production agent-thread streaming now uses `agent-runtime-state.ts`

**Key Features**:
- **Buffering**: Stores up to 1000 events per channel for replay
- **Cursor-aware replay on attach**: New listeners receive buffered events, or only the events after a provided `last_event_id` / `Last-Event-ID` cursor when available
- **Opt-in live-only attach**: `attach(...)` and `attachCallback(...)` accept `replayBuffered: false` so terminal-specific routes can bypass generic buffered replay
- **Replay miss fallback**: If a resume cursor is not present in the in-memory buffer, the attach falls back to live-only delivery and relies on canonical history for recovery
- **Immediate stream priming**: Any attach with zero replayable events emits a heartbeat frame so `fastify-sse-v2` opens the stream before the route returns
- **Auto-cleanup**: Empty listener sets are removed

**Methods**:

| Method | Description |
|--------|-------------|
| `emit(channelId, event)` | Broadcast event to listeners and buffer |
| `clearBuffer(channelId)` | Clear buffer (e.g., on bud disconnect) |
| `attach(channelId, reply, { lastEventId?, replayBuffered? })` | Attach Fastify reply as SSE listener with optional cursor-aware replay or explicit live-only mode |
| `attachCallback(channelId, callback, { lastEventId?, replayBuffered? })` | Attach callback function as listener with the same replay semantics |

### `agent-runtime-state.test.ts`

Standalone Node test coverage for the agent runtime snapshot and bounded-resume contract.

**Current Coverage**:
- idle snapshots expose resumable cursors
- active turns have a cursor before any visible event
- no-cursor attach is live-only
- attach after a known cursor replays only newer visible events
- stale cursors produce explicit resync
- finishing a turn returns the snapshot to idle with a fresh cursor
- runtime snapshots expose `client_id` on both `pending_tool` and `draft_assistant`
- `advanceCursor(...)` preserves in-flight runtime state while acknowledging external thread events already emitted on the shared cursor stream

### `event-bus.test.ts`

Standalone Node test coverage for the generic replay contract still used by run/terminal streams.

### `run-manager.ts`

Manages standalone command execution on buds.

**RunManager Class**:

**State**:
- `activeRuns` - Map of runId → RunContext (in-flight runs)

**Key Methods**:

| Method | Description |
|--------|-------------|
| `createRun(request)` | Create an owned run record and dispatch to bud |
| `createRunRecord(threadId, options)` | DB record creation only, inheriting thread ownership when needed |
| `dispatchShellCommand(params)` | Send run frame to bud, return deferred promise |
| `handleStreamChunk(runId, stream, dataB64, seq)` | Process stdout/stderr chunks |
| `handleRunFinished(runId, payload)` | Complete run, resolve promise |

**Events Emitted**:
- `status` - Phase changes (`planning`, `running`)
- `exec.stdout` / `exec.stderr` - Output chunks
- `final` - Completion with status and exit code

**Tail Tracking**:
- Keeps last 4KB of stdout/stderr in memory for quick access
- Full logs stored in `run_log` table up to `config.runLogMaxBytes`

### `terminal-session-manager.ts`

Thread-scoped terminal session management using tmux (~800 lines).

**TerminalSessionManager Class**:

**State**:
- `readiness` - Map of sessionId → { assessment, updatedAt }
- `lastOffsets` - Map of sessionId → last known byte offset
- `pendingCommands` - Map of sessionId → PendingCommand (for REPL context)
- `pendingObserves` - Map of requestId → { resolve, reject, timeout }
- `pendingSends` - Map of requestId → { resolve, reject, timeout }

**Key Methods**:

| Method | Description |
|--------|-------------|
| `createSessionForThread(threadId, budId, createdByUserId?)` | Create a fresh session row when the thread has no active session, with thread-owner stamping |
| `getSessionForThread(threadId)` | Get the active (non-closed) session |
| `getSession(sessionId)` | Get by ID |
| `ensureSession(sessionId)` | Send `terminal_ensure` to bud |
| `sendInput(sessionId, data, options)` | Send input with optional readiness waiting and user audit metadata |
| `sendInterrupt(sessionId)` | Send Ctrl+C |
| `sendResize(sessionId, cols, rows)` | Resize terminal |
| `closeSession(sessionId, reason)` | Close session |
| `observeTerminal(sessionId, options)` | Explicit delta/screen/history observation request-response |
| `capturePane(sessionId, options)` | Compatibility wrapper used by context sync |
| `captureBootstrap(sessionId)` | Build rich browser bootstrap data from `terminal_observe(view: "screen")` for `/terminal/state.bootstrap` |
| `sendInteraction(sessionId, interaction, options)` | Request-response interactive input / keypress dispatch, including structured-source pending-command tracking |
| `tailOutput(sessionId, bytes, options)` | Get recent output from DB |
| `setPendingCommand(sessionId, command)` | Track REPL program execution |
| `handleTerminalStatus(sessionId, payload)` | Bud reports session state |
| `handleTerminalOutput(sessionId, payload)` | Store and broadcast output |
| `handleTerminalReady(sessionId, assessment)` | Readiness assessment received |
| `handleObserveResult(sessionId, payload)` | Observe result received |
| `handleSendResult(sessionId, payload)` | Send result received |
| `startIdleChecks()` / `stopIdleChecks()` | Periodic idle-state management; destructive cleanup runs only when explicitly configured |

**Session States**:
```
pending → creating → ready ↔ active ↔ idle → closed
```

**Lifecycle Notes**:
- A thread may accumulate multiple historical `terminal_session` rows over time.
- Only one non-closed session may exist for a thread at once.
- Explicit close produces a closed historical row; revisiting the thread creates a fresh session row.
- Non-closed sessions persist across Bud/service reconnects.

**REPL Context Tracking**:

When agent or browser structured send launches commands like `python`, `node`, or `claude`, the manager:
1. Stores them as `pendingCommand` with timestamp and source taxonomy (`agent`, `human`, `emulator_protocol`, `system`)
2. Provides `getContext(sessionId)` for agent/runtime code to understand terminal state
3. Uses `known-programs.ts` registry for program-specific hints

**Observe Protocol**:

1. Service sends `terminal_observe` with `request_id`
2. Bud optionally waits using `shell_ready`, `changed`, or `settled`, then reuses that capture for the response when possible
3. For `view: "screen"`, Bud now also attaches exact visible-screen metadata (`screen_state`) with pane geometry, capture scope, cursor position, and row-preserved screen lines
4. Bud sends `terminal_observe_result` with matching `request_id`
5. Promise resolves with delta by default, or full screen/history when explicitly requested

**Send Protocol**:

1. Service sends `terminal_send` with structured `text` / `submit` / `keys` plus optional nested `observe`
2. Bud dispatches literal text and special keys to tmux
3. If `observe` is present, Bud captures a fast post-send delta baseline after `observe.after_ms` (default `1000ms`)
4. If `observe` requests a wait, Bud optionally waits for `shell_ready`, `changed`, or `settled`
5. Bud sends `terminal_send_result` immediately for dispatch-only sends, or with additive delta/readiness when observation was requested

Reference-web Phase 10 notes:
- the browser now suppresses xterm-generated `emulator_protocol` instead of forwarding it as pane input
- previously raw human control/escape sequences now stay on `sendInteraction()` through `terminal_send.text`
- the low-level `sendInput()` path remains available, but it is no longer part of normal reference-web interaction

These request-response paths replace the previous overloaded `terminal_run` / `terminal_capture` contract. The active model-facing contract is now send-first: shell and interactive input both flow through `terminal.send`, while `terminal.observe` is the explicit inspection hatch.

**Terminal SSE Payload Notes**:
- `terminal.output` carries `seq`, `data`, and `byte_offset`
- `terminal.bud_offline` and `terminal.bud_online` now carry `bud_id` in snake_case
- thread routes now bootstrap from a richer `/terminal/state.bootstrap` union (`grid` / `text` / `unavailable`) without a parallel legacy snapshot field, then resume with `after_offset=<last_rendered_byte_offset>` against durable output rather than generic event-bus replay
- no-cursor terminal attaches are intentionally live-only; terminal routes opt out of generic buffered replay with `replayBuffered: false`
- the thread history route accepts `since_offset` at the HTTP boundary even though the internal helper still uses a camelCase option name
- `sendInteraction()` now normalizes a nested optional `observe` object: browser typing uses `observe: null` for low-latency dispatch-only sends, while agent/tool callers can opt into `{}` or explicit wait parameters for post-send evidence
- `handleSendResult()` now resolves a minimal send contract centered on `submitted`, `delta`, and readiness
- `observeTerminal()` now gives the daemon the requested timeout budget plus a local `1000ms` grace window so normal `changed` / `settled` results do not orphan as quickly
- `observeTerminal()` defaults to `view: "delta"` and only returns full capture content for explicit `screen` / `history` requests; `view: "screen"` now surfaces exact visible-screen metadata that `/terminal/state` reuses for rich bootstrap
- `tailOutput(maxBytes)` underlies `terminal.interrupt` tool payloads, so interrupt truncation is a service backfill-window concern rather than a Bud runtime limit

**Ownership Notes**:
- `createRunRecord()` stamps `run.created_by_user_id` from the caller or owning thread
- `createSessionForThread()` stamps `terminal_session.created_by_user_id`
- `sendInput(..., { userId })` writes the acting human id into `terminal_session_input_log.user_id`
- browser structured send now passes explicit `source` through the runtime so pending-command inference no longer treats browser-emitted terminal protocol as human intent
- `TerminalInputSource` still includes `emulator_protocol` for historical/runtime taxonomy, but the reference web client now suppresses xterm-generated emulator replies before they reach the runtime

## Dependencies

| Import | Purpose |
|--------|---------|
| `fastify` | Logger types |
| `ulid` | ID generation |
| `drizzle-orm` | Query helpers |
| `../db/client.js` | Database access |
| `../db/schema.js` | Table schemas |
| `../config.js` | Configuration values |
| `../ws/gateway.js` | `sendFrameToBud()`, `isBudOnline()` |
| `../terminal/types.js` | Type definitions |
| `../terminal/known-programs.js` | REPL detection |

## Configuration Used

- `config.runLogMaxBytes` - Max bytes to store per run
- `config.terminalIdleTimeoutMinutes` - Mark idle after (default: 30)
- `config.terminalIdleCleanupHours` - Close after idle only when explicitly enabled (default: 0 / disabled)
- `config.terminalIdleCheckIntervalMinutes` - Check frequency (default: 5)

---

*Referenced by: [../src.spec.md](../src.spec.md)*
