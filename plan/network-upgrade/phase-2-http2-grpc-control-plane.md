# Phase 2: HTTP/2 gRPC Control Plane

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Runtime Decision**: [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md)
**Status**: Planned

---

## Objective

Move daemon authentication, heartbeat, policy, negotiation, operation control, cancellation, and reconciliation from WebSocket to HTTP/2 gRPC.

## Context

After Phase 0, control payloads are transport-independent. After Phase 1, operation/session state is durable enough to survive reconnects. Phase 1.5 selected `@grpc/grpc-js` for the Node daemon gateway and Rust `tonic` / `prost` for the Bud daemon.

This phase introduces the required HTTP/2 gRPC control transport without moving stream-heavy data traffic yet. The service remains the control plane for auth, device/session registration, operation state, policy, audit, and browser REST/SSE. Larger multiplexed stream work, including possible QUIC data-plane separation, remains later-phase work.

## Scope

### In Scope

- `@grpc/grpc-js` daemon gateway on the service
- Rust `tonic` daemon control client
- gRPC control service definition
- service gRPC control endpoint or adjacent gateway listener
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
- broad service process split unless HTTP/2/front-door constraints require it

## Fixed Decisions

- `BudControl.Connect` is a bidirectional stream carrying `BudEnvelope` messages.
- The service implementation uses `@grpc/grpc-js`, not Connect-ES, for the daemon gateway.
- The daemon implementation uses Rust `tonic` / `prost`.
- Buf remains the schema/tooling standard and CI guardrail.
- Connect-ES may be used for non-daemon APIs, but not for the daemon control stream.
- Control is logically separate from data, even if initially hosted in the same service process.
- WebSocket remains a temporary compatibility path for older daemons.
- New daemon versions should prefer HTTP/2 control when configured service support exists.
- Authentication must be bound to the device identity and the control session.
- The daemon gateway must expose native gRPC over HTTP/2 end to end.
- QUIC is a later data-plane option and should not change the Phase 2 control contract.

## Phase 2 Review Notes

The runtime decision narrows Phase 2:

- No Connect server adapter work is needed for daemon control.
- The service should host a grpc-js server either adjacent to Fastify in the same process or as a deliberately separate listener/process if deployment requires that.
- Browser REST/SSE should remain on the existing Fastify path.
- grpc-js lifecycle handling should be treated as product code, not handwritten per handler.
- Data-plane APIs should not be over-designed in Phase 2; the control stream only needs enough stream metadata to negotiate later HTTP/2 data and QUIC candidates.

## Implementation Tasks

### Task 1: Confirm grpc-js deployment support

Use the Phase 1.5 decision record to confirm:

- grpc-js can coexist with Fastify in local development or run adjacent to it
- local dev can run HTTP/2 control cleanly
- staging/front-door topology can route HTTP/2 gRPC
- TLS and proxy headers are available as needed
- graceful shutdown can drain control streams

Do this before broad control-plane implementation. If staging cannot route gRPC to the existing service process cleanly, introduce a separate daemon-gateway listener or process while keeping ownership/session state in the service database.

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

The service name can still use `Connect` as the RPC name; this does not imply Connect-ES. It is a Bud control-stream name implemented by grpc-js and consumed by tonic.

### Task 3: Choose service binding generation shape

Keep this isolated to the daemon-gateway module.

Default implementation path:

- Buf owns schema linting, formatting, breaking checks, and generation commands.
- Rust uses tonic/prost generation.
- Service may initially use `@grpc/proto-loader` as in the spike, isolated behind typed adapters.
- If proto-loader dynamic shapes become noisy or unsafe, switch the service binding layer to a Buf-managed grpc-js TypeScript generator before other service modules depend on it.

Do not let grpc-js/proto-loader message shapes leak into runtime, DB, or route modules.

### Task 4: Implement daemon identity transition

Preferred target:

- daemon generates keypair during claim or migration
- service stores public key
- daemon signs challenge
- service verifies signature
- old shared-secret daemons continue through WebSocket compatibility during rollout

If direct migration is too large, record a deliberate transition step and do not let that step bypass proxy/file policy requirements later.

### Task 5: Implement service control gateway

The service control gateway should:

- authenticate daemon control streams
- register `device_session` and `transport_session`
- update Bud online/offline state
- route incoming control events to the operation/stream registry
- route outgoing operations through the transport router
- drain gracefully
- emit metrics/audit events

grpc-js-specific requirements:

- return typed statuses via grpc-js server error/trailer semantics
- track pending async writes before ending a stream
- distinguish inbound half-close, cancellation, drain, and terminal errors
- set explicit max send/receive message sizes
- keep max concurrent streams, session memory, channelz, and keepalive knobs configurable
- ensure browser request handling cannot attach to daemon streams before ownership authorization

### Task 6: Implement daemon control client

The daemon control client should:

- prefer HTTP/2 control by default when configured
- authenticate with signed challenge or transition credential
- send capability manifest and policy version
- send heartbeat
- process operation offers
- process policy updates
- report reconciliation state on reconnect
- fall back to WebSocket when configured/allowed

### Task 7: Cut terminal control messages to gRPC

Move terminal lifecycle/control messages where appropriate:

- ensure session
- observe request metadata
- send request metadata
- cancellation
- status updates

Keep bulk output/data movement for Phase 3.

### Task 8: Update observability and docs

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
- new `service/src/grpc/` or `service/src/daemon-gateway/`
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
- grpc-js stream lifecycle tests for status emission, cancellation, deadline, half-close, pending writes, and drain
- WebSocket compatibility tests for older daemon path
- manual local dev run with daemon using gRPC control

## Exit Criteria

- daemon can connect and authenticate over HTTP/2 gRPC control
- service records device and transport sessions for gRPC control
- heartbeat/offline detection works without WebSocket
- operation control and reconciliation work over gRPC
- current browser REST/SSE behavior is unchanged
- WebSocket remains available only as a compatibility path
