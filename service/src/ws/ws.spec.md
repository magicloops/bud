# ws

WebSocket gateway for bud daemon connections.

## Purpose

Handles real-time communication between the service and bud daemons via WebSocket:
- Daemon connections and authentication
- Device-secret reauth after browser-mediated claim bootstrap
- Terminal session management (tmux-backed)
- Terminal send/observe result routing plus Bud presence tracking

## Files

### `gateway.ts`

Thin Bud WebSocket gateway entrypoint.

Current responsibilities:
- expose `/ws`
- install the gateway-scoped debug logger
- export public tracker/query helpers (`getActiveBudIds()`, `isBudOnline()`, `sendFrameToBud()`) as compatibility wrappers over the composite daemon transport router
- construct the extracted `BudConnection` runtime for each accepted socket

### `bud-connection.ts`

Primary Bud daemon connection state machine extracted from `gateway.ts`.

Owns:
- hello / hello_proof auth flow
- protobuf `BudEnvelope` binary-frame decode/encode when the daemon advertises `bud_envelope.websocket_binary`
- durable `device_session` / `transport_session` registration for authenticated daemon connections
- daemon reconnect-report handling and reconciliation-decision replies
- heartbeat handling
- terminal frame parsing and routing
- active-session tracker registration and timeout scheduling
- Bud offline transition side effects

### `protocol.ts`

Shared Zod schemas and type unions for `/ws` frames and connection states.

### `session-trackers.ts`

In-memory active-Bud tracker registry and helper functions used by both the gateway shell and the extracted Bud connection runtime.

Trackers now carry the durable `deviceSessionId`, durable `transportSessionId`, negotiated binary-envelope capability, and drain state for the active WebSocket transport.

### `../transport/gateway-drain.ts`

Gateway drain state is owned by the transport layer and re-exported through `gateway.ts` for operator/test callers. While drain is active, the WebSocket router refuses new long-lived daemon work and the Bud connection close path marks affected durable operation/stream rows `unknown` when the active transport is cut short.

### `debug.ts`

Small gateway logger helper used by both `gateway.ts` and `bud-connection.ts`.

The actual WebSocket-backed send implementation now lives behind `service/src/transport/websocket-daemon-router.ts`, and Phase 2 gRPC control streams live behind `service/src/transport/grpc-daemon-router.ts`; runtime modules depend on the composite transport router instead of importing this gateway directly.

**Connection Lifecycle**:

```
Browser/Client                 Service                      Bud Daemon
     │                           │                              │
     │                           │◄───── WS Connect ────────────│
     │                           │                              │
     │                           │◄───── hello ─────────────────│
     │                           │                              │
     │                           │   (enrollment token or       │
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
| `TerminalStatusSchema` | Terminal state changes |
| `TerminalOutputSchema` | Terminal output chunks |
| `TerminalReadySchema` | Readiness assessments |
| `TerminalObserveResultSchema` | Delta-first observe results with explicit screen/history modes |
| `TerminalSendResultSchema` | Send-first acknowledgements with settled-by-default timing, additive delta, and timeout-aware readiness |
| `ReconnectReportSchema` | Daemon journal summary used after reconnect for operation/stream reconciliation |

`TerminalStatusSchema` still tolerates deprecated `info.tmux_session` from older daemons during rollout, but the gateway no longer treats tmux session identity as part of the normal terminal contract.

**WebSocket Carrier Modes**:
- legacy daemons exchange UTF-8 JSON text frames
- capable daemons advertise `capabilities.bud_envelope = { version: 1, websocket_binary: true }`
- after capability negotiation, the service and daemon exchange protobuf `BudEnvelope` binary frames
- known frame types dispatch through typed payload oneof fields; the transitional payload body remains JSON-shaped `frame_json`
- `LegacyJsonPayload` remains decode-compatible for older binary fixtures and downgrade testing

**Connection States**:

```typescript
type ConnectionState =
  | { kind: "awaiting_hello" }
  | { kind: "awaiting_proof"; budId; deviceSecret; nonce; hello }
  | { kind: "connected"; budId; sessionId; hello }
  | { kind: "closed" };
```

**Session Tracking** now lives in `session-trackers.ts` for WebSocket sessions. The composite transport router also consults the gRPC session tracker when deciding active Bud routing.

**Active-Tracker Guardrails**:

- session registration now clears any superseded tracker's timeout before replacing the active map entry
- a successful replacement closes the superseded socket so only one live Bud session remains authoritative
- heartbeat handling now ignores superseded sockets instead of refreshing the active tracker's timeout/presence
- timeout and close cleanup now check that the tracker being cleaned up is still the active map entry before deleting the Bud session or emitting offline side effects
- active transport close/timeout marks in-flight durable operations and streams `unknown`
- real offline cleanup still clears caches, clears event buffers, suspends sessions, emits `terminal.bud_offline`, and marks the Bud offline, but only for the active tracker

### `gateway.test.ts`

Standalone Node test coverage for the active-tracker helpers re-exported through `gateway.ts`.

**Current Coverage**:
- replacing the active tracker clears the previous timeout
- stale cleanup from a superseded tracker is ignored
- only the currently registered tracker is treated as authoritative
- `sendFrameToBud(...)` only writes to the authoritative open socket and refuses missing/closed Bud sessions
- capable sessions receive protobuf envelope binary frames through the compatibility carrier
- gateway drain refuses new long-lived daemon work

### `bud-connection.test.ts`

Direct regression coverage for the extracted Bud connection runtime.

**Current Coverage**:
- offline transitions reject pending terminal waits before cache clearing, suspend, and offline emission side effects run

**Exported Functions**:

| Function | Purpose |
|----------|---------|
| `registerWsGateway(server, ...)` | Setup `/ws` route and construct `BudConnection` instances |
| `getActiveBudIds()` | List connected bud IDs |
| `isBudOnline(budId)` | Check if bud is connected |
| `sendFrameToBud(budId, frame)` | Compatibility wrapper that sends a message to a specific Bud through the composite daemon transport router |
| `startGatewayDrain(...)` / `clearGatewayDrain()` | Process-local drain controls for refusing new long-lived daemon work during gateway shutdown/deploy |
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
| `terminal_status` | `terminalSessionManager.handleStatus()` |
| `terminal_output` | `terminalSessionManager.handleOutput()` |
| `terminal_ready` | `terminalSessionManager.handleTerminalReady()` with the parsed readiness assessment |
| `terminal_observe_result` | `terminalSessionManager.handleObserveResult()` |
| `terminal_send_result` | `terminalSessionManager.handleSendResult()` with optional additive `delta` (`changed`, `text`, `truncated`) plus settled/timeout readiness assessment |
| `reconnect_report` | `DaemonStateStore.reconcileReconnectReport()` then `reconciliation_decision` reply |

Enrollment-token validation now routes through the shared `auth/enrollment-token.ts` helper so seed/bootstrap writes and gateway checks use the same hash contract.

**Capabilities Tracking**:

Bud's `hello` frame includes capabilities:
```typescript
{
  max_concurrency: number;
  shell_default?: string;
  sessions: boolean;
  terminal: boolean;
  terminal_proto?: string;      // "0.2"
}
```

The gateway still tolerates deprecated tmux-shaped hello fields from older daemons during rollout, but it now strips those compatibility fields before persisting `bud.capabilities`.

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
| `crypto` | Challenge-response HMAC and nonce generation |
| `../db/client.js` | Database access |
| `../db/schema.js` | Bud/token tables |
| `../config.js` | Configuration |
| `../auth/enrollment-token.js` | Shared enrollment-token hashing |
| `../runtime/*.js` | Terminal runtime and presence routing |
| `../transport/composite-daemon-router.js` | Daemon transport adapter that prefers active gRPC control streams and falls back to WebSocket |

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- No rate limiting on WebSocket messages
- Dev token bypass should be removed for production

---

*Referenced by: [../src.spec.md](../src.spec.md)*
