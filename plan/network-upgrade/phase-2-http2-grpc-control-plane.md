# Phase 2: HTTP/2 gRPC Control Plane

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Move daemon authentication, heartbeat, policy, negotiation, operation control, cancellation, and reconciliation from WebSocket to HTTP/2 gRPC.

## Context

After Phase 0, control payloads are transport-independent. After Phase 1, operation/session state is durable enough to survive reconnects. This phase introduces the required control transport without moving stream-heavy data traffic yet.

## Scope

### In Scope

- gRPC control service definition
- daemon gRPC control client
- service gRPC control endpoint or gateway
- device keypair authentication or explicit transition mechanism
- capability manifest exchange
- policy update messages
- heartbeat/offline detection over control stream
- operation control messages over gRPC
- reconciliation over gRPC
- transport candidate advertisement
- WebSocket control compatibility during rollout

### Out Of Scope

- HTTP/2 data stream migration
- proxy/file data traffic
- QUIC implementation
- broad service process split unless required by gRPC stack

## Fixed Decisions

- `BudControl.Connect` is a bidirectional stream carrying `BudEnvelope` messages.
- Control is logically separate from data, even if initially hosted in the same service process.
- WebSocket remains a temporary compatibility path for older daemons.
- New daemon versions should prefer HTTP/2 control when configured service support exists.
- Authentication must be bound to the device identity and the control session.

## Implementation Tasks

### Task 1: Validate service stack and deployment support

Run a narrow spike to confirm:

- chosen Node gRPC stack can coexist with Fastify or run adjacent to it
- local dev can run HTTP/2 control cleanly
- staging/front-door topology can route HTTP/2 gRPC
- TLS and proxy headers are available as needed
- graceful shutdown can drain control streams

Document the chosen topology before broad implementation.

### Task 2: Define `BudControl.Connect`

The control stream should support:

- client hello
- service challenge
- signed proof
- authenticated acknowledgement
- heartbeat
- capability manifest
- policy update
- operation offer/accept/reject/progress/finish
- cancellation
- stream open metadata
- reconciliation report/decision
- transport candidate advertisement
- typed error

### Task 3: Implement daemon identity transition

Preferred target:

- daemon generates keypair during claim or migration
- service stores public key
- daemon signs challenge
- service verifies signature
- old shared-secret daemons continue through WebSocket compatibility during rollout

If direct migration is too large, record a deliberate transition step and do not let that step bypass proxy/file policy requirements later.

### Task 4: Implement service control gateway

The service control gateway should:

- authenticate daemon control streams
- register `device_session` and `transport_session`
- update Bud online/offline state
- route incoming control events to the operation/stream registry
- route outgoing operations through the transport router
- drain gracefully
- emit metrics/audit events

### Task 5: Implement daemon control client

The daemon control client should:

- prefer HTTP/2 control by default when configured
- authenticate with signed challenge or transition credential
- send capability manifest and policy version
- send heartbeat
- process operation offers
- process policy updates
- report reconciliation state on reconnect
- fall back to WebSocket when configured/allowed

### Task 6: Cut terminal control messages to gRPC

Move terminal lifecycle/control messages where appropriate:

- ensure session
- observe request metadata
- send request metadata
- cancellation
- status updates

Keep bulk output/data movement for Phase 3.

### Task 7: Update observability and docs

Add:

- control connection metrics
- auth failure metrics
- heartbeat/offline metrics
- transport kind in logs
- control protocol docs
- specs for new service/daemon modules

## Files Likely Affected

### Service

- `service/package.json`
- `service/src/server.ts`
- `service/src/config.ts`
- `service/src/transport/`
- `service/src/proto/`
- `service/src/ws/`
- `service/src/runtime/`
- `service/src/db/schema.ts` if Phase 1 needs additions

### Bud

- `bud/Cargo.toml`
- `bud/src/config.rs`
- `bud/src/identity.rs`
- `bud/src/claim.rs`
- `bud/src/app.rs`
- `bud/src/transport/`
- `bud/src/protocol.rs`

## Test Plan

- daemon-service gRPC control integration test where feasible
- service auth verification tests
- daemon signed-challenge tests
- heartbeat/offline tests
- control reconnect/reconcile tests
- WebSocket compatibility tests for older daemon path
- manual local dev run with daemon using gRPC control

## Exit Criteria

- daemon can connect and authenticate over HTTP/2 gRPC control
- service records device and transport sessions for gRPC control
- heartbeat/offline detection works without WebSocket
- operation control and reconciliation work over gRPC
- current browser REST/SSE behavior is unchanged
- WebSocket remains available only as a compatibility path

