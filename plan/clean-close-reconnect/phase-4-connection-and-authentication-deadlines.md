# Phase 4: Connection and authentication deadlines

## Context and status

Implemented; automated verification recorded in the
[validation checklist](validation-checklist.md#phase-4-connection-deadlines).
Physical sleep/resume and network-restoration acceptance remain pending.
Phases 1–3 fixed teardown after a known
disconnect. The installed v0.1.25 daemon subsequently remained at `Connecting
to backend` for over eleven hours after successful teardown. Restart restored
the same production identity. See the [incident evidence](../../debug/daemon-connection-handshake-stall.md).

Related specs: [daemon](../../bud/bud.spec.md),
[source](../../bud/src/src.spec.md), [tests](../../bud/tests/tests.spec.md),
and [service WebSocket ownership](../../service/src/ws/ws.spec.md).

## Objective

Every transport setup and Bud authentication attempt completes or fails within
a bounded budget. Failure disposes of that attempt and resumes existing retry
behavior. A healthy authenticated session can remain connected indefinitely.

## Design / Approach

Use internal constants initially; no new environment flags or CLI settings.
Tests may inject shorter budgets. Measure deadlines and elapsed time with a
monotonic clock.

| Stage | Proposed budget | Boundary |
| --- | --- | --- |
| WebSocket transport setup | 30 seconds | DNS/TCP/TLS/HTTP upgrade through `connect_async` completion |
| Bud authentication | 20 seconds | Sending hello, challenge/proof exchange and receiving `hello_ack` |
| Optional gRPC control setup | 30 seconds | Endpoint connection and Connect RPC response headers |
| Optional gRPC data attachment setup | 10 seconds | Endpoint connection and Attach RPC response headers |

Authentication has one absolute deadline. Ping traffic, unexpected frames and
repeated challenges must not reset it. Bound sends as well as reads by wrapping
the complete network authentication exchange. Persist enrollment credentials
after receiving the ack, outside the network timeout, so expiration cannot
interrupt a truncate/write of valid credentials. Keep interactive device claim approval
outside these budgets. Local capability discovery is a separate preflight;
log the transport stage only once preflight completes.

Apply budgets to startup stages, never the full `connect_once*` functions:
those also run the established session. Preserve the existing reconnect delay
(normally five seconds). Optional gRPC setup/authentication transport failures
retain the existing WebSocket fallback; explicit `AUTH_FAILED` retains its
existing authentication policy and must not be reclassified as a timeout.

### Attempt ownership and cleanup

- Drop the timed-out WebSocket future/socket without waiting for a graceful
  close handshake with a silent peer.
- Own gRPC setup writer tasks with cancellation-safe cleanup. Abort them on
  timeout, early return or caller cancellation; join them on ordinary cleanup.
  Do not await receiver closure while retaining `frame_tx` or sender clones.
- Do not publish a session sender to managers until authentication succeeds.
  A failed attempt cannot leave an active writer or a superseded sender.
- Bound optional data setup so it cannot indefinitely delay the authenticated
  control loop and heartbeats. Preserve current terminal-output fallback and
  explicit failure for generic streams requiring the unavailable data carrier.
  Changing data-attachment acknowledgement/readiness semantics is out of scope.
- A timeout is a transport failure: preserve the claimed identity and secret.
  Only existing explicit authentication rejection rules may invalidate identity.
- If service acceptance happened but the acknowledgement was lost, reconnect
  with the same identity and existing session-generation/reconciliation rules.
  Do not replay human input or accepted business operations as a timeout repair.
- Preserve persistent terminal holders, output offsets and browser profiles.
  Use existing transport-disconnect authority/cleanup behavior for old sessions.

### Diagnostics

Log stage start, completion and timeout with transport, stage, elapsed time,
budget and retry/fallback disposition. Distinguish transport establishment from
Bud authentication. Log no secret, token, proof, challenge payload or credential
URL. A timeout should produce one actionable warning per failed attempt.

### Implementation surfaces

- `bud/src/app.rs`: stage boundaries, timeout classification, attempt ownership,
  authentication and retry/fallback integration.
- `bud/src/grpc_control.rs` and `bud/src/grpc_data.rs`: existing connection/RPC
  setup is bounded at the owning `app.rs` call sites; no adapter edits needed.
- Focused app tests and, if needed, a daemon connection-recovery integration
  test. Prefer small helpers over a new transport framework.

## Separate follow-up: established-connection liveness

Current writers can await a network send indefinitely, and heartbeat enqueue
success is not delivery confirmation. These require a separate acceptance gate;
startup deadlines alone do not solve them.

For WebSocket, investigate bounded writes plus an active, correlated Ping/Pong
probe and a monotonic response deadline. Ensure the session notices writer
termination and returns to existing teardown/retry. For gRPC, verify HTTP/2
keepalive and stream failure semantics before choosing corresponding settings.
Do not disconnect a healthy idle session merely because no application frames
arrive: today the service need not reply to each Bud heartbeat. No new heartbeat
acknowledgement protocol is proposed in Phase 4.

## Spec Files to Update

- [x] `bud/src/src.spec.md`: startup deadlines and task ownership.
- [x] `bud/bud.spec.md`: reconnect behavior and diagnostics.
- Tests live in `app.rs`; no new integration file or tests-folder spec change.
- [x] This folder's progress and validation checklists with actual evidence.

## Impacted Contracts

- Daemon lifecycle changes only; existing service supports this implementation.
- WSS/gRPC message shapes, SSE, DB schema, agent tools, web and mobile: unchanged.
- No ownership/authentication relaxation, credential migration or input retry.

## Test Plan

1. A TCP peer accepts but never completes WebSocket upgrade; setup expires and
   the socket is disposed. Cover a stalled TLS handshake where practical.
2. Upgraded WebSocket sends no challenge, or sends a challenge but no ack;
   authentication expires. Pings/unexpected frames cannot extend the deadline.
3. Delayed valid authentication within budget succeeds. A healthy idle session
   remains connected longer than both startup budgets.
4. First attempt stalls, second accepts/authenticates: verify automatic retry,
   same identity and reconciliation, with no retained attempt tasks/sockets.
5. gRPC setup/auth stalls clean up writers and exercise existing fallback;
   explicit auth rejection follows its existing policy. Stalled optional data
   setup cannot prevent control heartbeats or silently route unsupported data.
6. Shutdown during setup/auth cancels promptly, including spawned gRPC writers.
7. Persistent terminal reattachment preserves offsets/output and does not
   resubmit commands. Existing disconnect-cleanup regressions still pass.

Run daemon tests and appropriate Rust formatting/clippy checks. Use isolated
temporary state and loopback fixtures, never production identity credentials.
Record exact command failures and resolve them before completing validation.

Manual acceptance: silent-peer recovery, macOS sleep/resume during connection
setup, and network loss/restoration. Verify retry after resume; monotonic timer
behavior during OS suspension must be tested, not inferred from unit tests.
Keep installed production and checkout development state independent.

## Rollout and completion

Daemon-only release/install/restart after implementation and validation, with
separate user authorization for release actions. No service deployment, mobile
rebuild, DB migration or state migration is required.

Complete Phase 4 when deterministic tests prove bounded attempts and cleanup,
normal authentication/reconciliation remains intact, and manual recovery evidence
is recorded. Track established-connection liveness separately rather than
claiming this phase fixes all offline/reconnect failures.
