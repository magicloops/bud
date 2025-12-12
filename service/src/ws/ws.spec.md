# ws

WebSocket gateways for bud daemon connections and browser terminal access.

## Purpose

Handles real-time communication:
1. **Bud Gateway** (`/ws`) - Daemon connections, command dispatch, output streaming
2. **Term Gateway** (`/term`) - Browser WebSocket for legacy PTY sessions

## Files

### `gateway.ts`

Main bud daemon WebSocket gateway (~700 lines).

**Connection Lifecycle**:

```
Browser/Client                 Service                      Bud Daemon
     │                           │                              │
     │                           │◄───── WS Connect ────────────│
     │                           │                              │
     │                           │◄───── hello ─────────────────│
     │                           │                              │
     │                           │  (token enrollment OR        │
     │                           │   challenge-response auth)   │
     │                           │                              │
     │                           │────── hello_ack ────────────►│
     │                           │                              │
     │                           │◄───── heartbeat ─────────────│
     │                           │       (periodic)             │
```

**Zod Schemas**:

| Schema | Purpose |
|--------|---------|
| `EnvelopeSchema` | Base frame validation (proto v0.1) |
| `TerminalEnvelopeSchema` | Terminal frame validation (proto v0.2) |
| `HelloSchema` | Initial handshake from bud |
| `HelloProofSchema` | HMAC challenge response |
| `StreamSchema` | stdout/stderr chunks |
| `RunFinishedSchema` | Command completion |
| `SessionOpenedSchema` | Legacy session ready |
| `SessionOutputSchema` | Legacy session output |
| `SessionClosedSchema` | Legacy session closed |
| `TerminalStatusSchema` | Terminal state changes |
| `TerminalOutputSchema` | Terminal output chunks |
| `TerminalReadySchema` | Readiness assessments |
| `TerminalCaptureResponseSchema` | Capture-pane results |

**Connection States**:

```typescript
type ConnectionState =
  | { kind: "awaiting_hello" }
  | { kind: "awaiting_proof"; budId; deviceSecret; nonce; hello }
  | { kind: "connected"; budId; sessionId; hello }
  | { kind: "closed" };
```

**Session Tracking**:

```typescript
const sessions = new Map<string, SessionTracker>();

interface SessionTracker {
  budId: string;
  sessionId: string;
  lastHeartbeat: number;
  socket: WebSocket;
  timeout?: TimeoutHandle;
}
```

**Exported Functions**:

| Function | Purpose |
|----------|---------|
| `registerWsGateway(server, ...)` | Setup `/ws` route |
| `getActiveBudIds()` | List connected bud IDs |
| `isBudOnline(budId)` | Check if bud is connected |
| `sendFrameToBud(budId, frame)` | Send message to specific bud |

**Authentication Flow**:

1. **Token Enrollment** (new bud):
   - Bud sends `hello` with `token`
   - Service validates token, creates bud record
   - Service sends `hello_ack` with `bud_id` and `device_secret`
   - Bud persists identity for future connections

2. **Challenge-Response** (returning bud):
   - Bud sends `hello` with `bud_id`
   - Service sends `hello_challenge` with random `nonce`
   - Bud computes HMAC-SHA256 of nonce with device_secret
   - Bud sends `hello_proof` with `hmac`
   - Service verifies, sends `hello_ack`

**Frame Routing**:

| Frame Type | Handler |
|------------|---------|
| `hello` | `handleHello()` - Start auth flow |
| `hello_proof` | `handleHelloProof()` - Verify HMAC |
| `heartbeat` | Update lastHeartbeat timestamp |
| `stdout` / `stderr` | `runManager.handleStreamChunk()` |
| `run_finished` | `runManager.handleRunFinished()` |
| `session_opened` | `sessionManager.handleOpened()` |
| `session_output` | `sessionManager.handleOutput()` |
| `session_closed` | `sessionManager.handleClosed()` |
| `session_error` | `sessionManager.handleError()` |
| `terminal_status` | `terminalSessionManager.handleStatus()` |
| `terminal_output` | `terminalSessionManager.handleOutput()` |
| `terminal_ready` | `terminalSessionManager.handleReady()` |
| `terminal_capture_response` | `terminalSessionManager.handleCaptureResponse()` |

**Capabilities Tracking**:

Bud's `hello` frame includes capabilities:
```typescript
{
  max_concurrency: number;
  supports_pty: boolean;
  shell_default?: string;
  sessions: boolean;
  sessions_backends: string[];  // ["pty", "tmux"]
  terminal: boolean;
  terminal_proto?: string;      // "0.2"
  terminal_backends: string[];  // ["tmux"]
  tmux_version?: string;
}
```

### `term-gateway.ts`

Browser WebSocket gateway for legacy PTY sessions.

**Route**: `GET /term?session_id=...&attach_token=...`

**Client Message Types**:

| Type | Schema | Purpose |
|------|--------|---------|
| `input` | `{ type: "input", data: string }` | Send input to session |
| `resize` | `{ type: "resize", rows, cols }` | Resize terminal |
| `close` | `{ type: "close" }` | Close session |

**Flow**:

```
Browser                        Service                      Bud Daemon
   │                              │                              │
   │── WS /term?session_id&token─►│                              │
   │                              │                              │
   │◄─── { type: "output", ... }──│◄───── session_output ────────│
   │                              │                              │
   │── { type: "input", data } ──►│───── session_input ─────────►│
   │                              │                              │
   │── { type: "resize", ... } ──►│───── session_resize ────────►│
   │                              │                              │
   │── { type: "close" } ────────►│───── session_close ─────────►│
```

**Writer/Spectator Model**:

- Only one client can be "writer" at a time
- Other clients are "spectators" (read-only)
- `takeWriter` API allows claiming write access

## Configuration Used

- `config.heartbeatSec` - Expected heartbeat interval (default: 30)
- `config.offlineGraceSec` - Grace period before marking offline (default: 90)
- `config.devTokenBypass` - Dev-mode token bypass
- `config.enrollmentHashSecret` - Token hashing secret

## Dependencies

| Import | Purpose |
|--------|---------|
| `fastify` | Server types |
| `ws` | WebSocket types |
| `zod` | Frame validation |
| `crypto` | Token hashing, HMAC |
| `../db/client.js` | Database access |
| `../db/schema.js` | Bud/token tables |
| `../config.js` | Configuration |
| `../runtime/*.js` | Managers for event routing |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- `term-gateway.ts` is for legacy PTY sessions; consider deprecating once thread-scoped terminals are stable
- No rate limiting on WebSocket messages
- Dev token bypass should be removed for production

---

*Referenced by: [../src.spec.md](../src.spec.md)*
