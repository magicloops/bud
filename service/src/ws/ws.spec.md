# ws

WebSocket gateway for bud daemon connections.

## Purpose

Handles real-time communication between the service and bud daemons via WebSocket:
- Daemon connections and authentication
- Device-secret reauth after browser-mediated claim bootstrap
- Command dispatch and output streaming
- Terminal session management (tmux-backed)

## Files

### `gateway.ts`

Main bud daemon WebSocket gateway (~800 lines).

**Connection Lifecycle**:

```
Browser/Client                 Service                      Bud Daemon
     │                           │                              │
     │                           │◄───── WS Connect ────────────│
     │                           │                              │
     │                           │◄───── hello ─────────────────│
     │                           │                              │
     │                           │  (legacy token enrollment OR │
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
| `TerminalStatusSchema` | Terminal state changes |
| `TerminalOutputSchema` | Terminal output chunks |
| `TerminalReadySchema` | Readiness assessments |
| `TerminalObserveResultSchema` | Delta-first observe results with explicit screen/history modes |
| `TerminalSendResultSchema` | Send-first acknowledgements plus fast post-send delta |

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

**Active-Tracker Guardrails**:

- session registration now clears any superseded tracker's timeout before replacing the active map entry
- a successful replacement closes the superseded socket so only one live Bud session remains authoritative
- heartbeat handling now ignores superseded sockets instead of refreshing the active tracker's timeout/presence
- timeout and close cleanup now check that the tracker being cleaned up is still the active map entry before deleting the Bud session or emitting offline side effects
- real offline cleanup still clears caches, clears event buffers, suspends sessions, emits `terminal.bud_offline`, and marks the Bud offline, but only for the active tracker

### `gateway.test.ts`

Standalone Node test coverage for the active-tracker helpers in `gateway.ts`.

**Current Coverage**:
- replacing the active tracker clears the previous timeout
- stale cleanup from a superseded tracker is ignored
- only the currently registered tracker is treated as authoritative

**Exported Functions**:

| Function | Purpose |
|----------|---------|
| `registerWsGateway(server, ...)` | Setup `/ws` route |
| `getActiveBudIds()` | List connected bud IDs |
| `isBudOnline(budId)` | Check if bud is connected |
| `sendFrameToBud(budId, frame)` | Send message to specific bud |
| `registerActiveSessionTracker(...)` | Replace the active tracker for a Bud while retiring the superseded timeout |
| `getActiveSessionTracker(...)` | Check whether a tracker is still the authoritative active entry for a Bud |
| `deleteSessionTrackerIfCurrent(...)` | Ignore stale timeout/close cleanup from superseded sockets |

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

3. **Claim Completion Sync**:
   - Bud `hello` frames now include `installation_id`
   - successful challenge auth can mark matching `device_auth_flow` rows as `completed`
   - approved claim secrets are cleared only after the daemon reconnects successfully
   - `terminal.bud_online` notifications are emitted only after `hello_ack` has been sent and the Bud has been registered in the in-memory session map, so follow-up `terminal_ensure` calls can route immediately

**Important**: Browser-mediated claim bootstrap now happens over HTTP (`/api/device-auth/*`) before `/ws`; `/ws` remains the long-lived daemon transport and challenge-response path.

**Hello Payload**:

Bud `hello` frames now include:
```typescript
{
  installation_id?: string;
  token?: string;
  bud_id?: string;
}
```

If a stored Bud already has an `installationId`, the gateway rejects a mismatched `installation_id` during challenge setup.

**Frame Routing**:

| Frame Type | Handler |
|------------|---------|
| `hello` | `handleHello()` - Start auth flow |
| `hello_proof` | `handleHelloProof()` - Verify HMAC |
| `heartbeat` | Update lastHeartbeat timestamp |
| `stdout` / `stderr` | `runManager.handleStreamChunk()` |
| `run_finished` | `runManager.handleRunFinished()` |
| `terminal_status` | `terminalSessionManager.handleStatus()` |
| `terminal_output` | `terminalSessionManager.handleOutput()` |
| `terminal_ready` | `terminalSessionManager.handleTerminalReady()` |
| `terminal_observe_result` | `terminalSessionManager.handleObserveResult()` |
| `terminal_send_result` | `terminalSessionManager.handleSendResult()` with optional additive `delta` (`changed`, `text`, `truncated`) |

**Capabilities Tracking**:

Bud's `hello` frame includes capabilities:
```typescript
{
  max_concurrency: number;
  shell_default?: string;
  terminal: boolean;
  terminal_proto?: string;      // "0.2"
  terminal_backends: string[];  // ["tmux"]
  tmux_version?: string;
}
```

## Configuration Used

- `config.heartbeatSec` - Expected heartbeat interval (default: 30)
- `config.offlineGraceSec` - Grace period before marking offline (default: 90)
- `config.devTokenBypass` - Dev-mode token bypass
- `config.enrollmentHashSecret` - Token hashing secret
- `/api/device-auth/*` routes - Claim bootstrap surfaces that feed the post-approval `/ws` reconnect path

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
- No rate limiting on WebSocket messages
- Dev token bypass should be removed for production

---

*Referenced by: [../src.spec.md](../src.spec.md)*
