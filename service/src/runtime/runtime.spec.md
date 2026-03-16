# runtime

Runtime managers for runs and terminal sessions, plus event bus infrastructure.

## Purpose

Orchestrates execution of commands and terminal sessions across connected bud daemons. Handles:
- Command dispatch and result tracking
- Thread-scoped terminal sessions (tmux-backed)
- SSE event broadcasting

## Files

### `event-bus.ts`

Generic SSE event bus with buffering for replay.

**Classes**:
- `SseEventBus` - Base class with channel-keyed listeners and buffers
- `RunEventBus` - For run execution events
- `TerminalEventBus` - For terminal session events
- `AgentEventBus` - For agent conversation events (tool calls, messages, final)

**Key Features**:
- **Buffering**: Stores up to 1000 events per channel for replay
- **Replay on attach**: New listeners receive buffered events
- **Auto-cleanup**: Empty listener sets are removed

**Methods**:

| Method | Description |
|--------|-------------|
| `emit(channelId, event)` | Broadcast event to listeners and buffer |
| `clearBuffer(channelId)` | Clear buffer (e.g., on bud disconnect) |
| `attach(channelId, reply)` | Attach Fastify reply as SSE listener |
| `attachCallback(channelId, callback)` | Attach callback function as listener |

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
| `createSessionForThread(threadId, budId, createdByUserId?)` | Create session in DB with thread-owner stamping |
| `getSessionForThread(threadId)` | Get active session |
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
| `startIdleChecks()` / `stopIdleChecks()` | Periodic idle session cleanup |

**Session States**:
```
pending → creating → ready ↔ active ↔ idle → closed
```

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
- `config.terminalIdleCleanupHours` - Close after idle (default: 24)
- `config.terminalIdleCheckIntervalMinutes` - Check frequency (default: 5)

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Terminal session cleanup could be more aggressive for long-idle sessions

---

*Referenced by: [../src.spec.md](../src.spec.md)*
