# runtime

Runtime managers for runs, sessions, and terminal sessions, plus event bus infrastructure.

## Purpose

Orchestrates execution of commands and terminal sessions across connected bud daemons. Handles:
- Command dispatch and result tracking
- PTY session lifecycle (legacy)
- Thread-scoped terminal sessions
- SSE event broadcasting

## Files

### `event-bus.ts`

Generic SSE event bus with buffering for replay.

**Classes**:
- `SseEventBus` - Base class with channel-keyed listeners and buffers
- `RunEventBus` - For run execution events
- `SessionEventBus` - For legacy PTY session events
- `TerminalEventBus` - For terminal session events

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
| `createRun(request)` | Create run record and dispatch to bud |
| `createRunRecord(threadId, options)` | DB record creation only |
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

### `session-manager.ts`

Legacy PTY session management (non-tmux).

**SessionManager Class**:

**State**:
- `sessions` - Map of sessionId → SessionContext (in-memory)

**SessionContext**:
```typescript
{
  sessionId: string;
  budId: string;
  threadId: string;
  backend: "pty" | "tmux";
  attachToken: string;
  status: "opening" | "open" | "closed" | "failed";
  writer: WebSocket | null;
  spectators: Set<WebSocket>;
  logsBytes: number;
  // ...
}
```

**Key Methods**:

| Method | Description |
|--------|-------------|
| `createSession(options)` | Create session, send `session_open` to bud |
| `ensureThreadSession(threadId)` | Get or create session for thread |
| `handleOpened(sessionId, backend)` | Bud confirmed session ready |
| `handleOutput(sessionId, seq, dataB64)` | Process session output |
| `handleClosed(sessionId, ...)` | Session terminated |
| `sendInput(sessionId, data)` | Send input to session |
| `sendInputDirect(sessionId, data)` | Send without readiness waiting |
| `takeWriter(sessionId)` | Claim exclusive write access |
| `close(sessionId)` | Request session close |

### `terminal-session-manager.ts`

Thread-scoped terminal session management using tmux (~800 lines).

**TerminalSessionManager Class**:

**State**:
- `readiness` - Map of sessionId → { assessment, updatedAt }
- `lastOffsets` - Map of sessionId → last known byte offset
- `pendingCommands` - Map of sessionId → PendingCommand (for REPL context)
- `pendingCaptures` - Map of requestId → { resolve, reject, timeout }

**Key Methods**:

| Method | Description |
|--------|-------------|
| `createSessionForThread(threadId, budId)` | Create session in DB |
| `getSessionForThread(threadId)` | Get active session |
| `getSession(sessionId)` | Get by ID |
| `ensureSession(sessionId)` | Send `terminal_ensure` to bud |
| `sendInput(sessionId, data, options)` | Send input with optional readiness waiting |
| `sendInterrupt(sessionId)` | Send Ctrl+C |
| `sendResize(sessionId, cols, rows)` | Resize terminal |
| `closeSession(sessionId, reason)` | Close session |
| `capture(sessionId, options)` | Execute capture-pane |
| `tailOutput(sessionId, bytes, options)` | Get recent output from DB |
| `handleStatus(sessionId, state, info)` | Bud reports session state |
| `handleOutput(sessionId, seq, dataB64, byteOffset)` | Store and broadcast output |
| `handleReady(sessionId, assessment)` | Readiness assessment received |
| `handleCaptureResponse(sessionId, payload)` | Capture result received |
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
- `SessionManager` (legacy PTY) may be redundant with `TerminalSessionManager`
- Both managers coexist but serve different use cases (legacy vs thread-scoped)
- Consider consolidating once thread-scoped is fully validated

---

*Referenced by: [../src.spec.md](../src.spec.md)*
