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
- runtime snapshots expose `client_id` on both `pending_tool` and `draft_assistant`

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
- `pendingCaptures` - Map of requestId → { resolve, reject, timeout }
- `pendingRuns` - Map of requestId → { resolve, reject, timeout } (for terminal_run)

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
| `capturePane(sessionId, options)` | Execute capture-pane |
| `runCommand(sessionId, input, options)` | Request-response command execution |
| `tailOutput(sessionId, bytes, options)` | Get recent output from DB |
| `setPendingCommand(sessionId, command)` | Track REPL program execution |
| `handleTerminalStatus(sessionId, payload)` | Bud reports session state |
| `handleTerminalOutput(sessionId, payload)` | Store and broadcast output |
| `handleTerminalReady(sessionId, assessment)` | Readiness assessment received |
| `handleCaptureResponse(sessionId, payload)` | Capture result received |
| `handleRunResult(sessionId, payload)` | Run command result received |
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

When agent sends commands like `python`, `node`, `claude`, the manager:
1. Stores as `pendingCommand` with timestamp
2. Provides `getContext(sessionId)` for agent to understand terminal state
3. Uses `known-programs.ts` registry for program-specific hints

**Capture Protocol**:

1. Service sends `terminal_capture` with `request_id`
2. Bud executes `tmux capture-pane`
3. Bud sends `terminal_capture_response` with matching `request_id`
4. Promise resolves with capture result

**Run Protocol** (request-response for terminal.run):

1. Service sends `terminal_run` with `request_id`, `input`, `mode`
2. Bud sends input to tmux
3. Bud waits for readiness:
   - Shell mode: quiescence-based (watches log file for quiet period)
   - REPL mode: activity-based (compares capture-pane hashes)
4. Bud sends `terminal_run_result` with output, readiness assessment
5. Promise resolves with `RunResult`

This pattern replaces the previous approach of `sendInput` + `waitForReadiness` + `tailOutput`, providing cleaner ownership boundaries where Bud handles all terminal state.

**Terminal SSE Payload Notes**:
- `terminal.output` carries `seq`, `data`, and `byte_offset`
- `terminal.bud_offline` and `terminal.bud_online` now carry `bud_id` in snake_case
- the thread history route accepts `since_offset` at the HTTP boundary even though the internal helper still uses a camelCase option name
- `runCommand()` returns Bud-owned `truncated` / `outputBytes` values for `terminal.run`
- `capturePane()` currently has no separate truncation flag; agent tool payloads treat capture output as not truncated
- `tailOutput(maxBytes)` underlies `terminal.interrupt` tool payloads, so interrupt truncation is a service backfill-window concern rather than a Bud runtime limit

**Ownership Notes**:
- `createRunRecord()` stamps `run.created_by_user_id` from the caller or owning thread
- `createSessionForThread()` stamps `terminal_session.created_by_user_id`
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
