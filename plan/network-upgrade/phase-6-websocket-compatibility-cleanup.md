# Phase 6: WebSocket Compatibility Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Reduce WebSocket from a migration bridge to a constrained compatibility path, then remove it when supported daemon versions and deployment environments no longer need it.

## Context

WebSocket starts as the only daemon transport, becomes a carrier for the common envelope, and then becomes fallback as HTTP/2 control/data and optional QUIC mature. If it remains feature-equivalent forever, the network upgrade will keep two production transport surfaces indefinitely.

## Scope

### In Scope

- WebSocket compatibility policy
- degraded limits for WebSocket data
- version/capability gates
- operator switch to disable WebSocket compatibility
- metrics for remaining WebSocket usage
- removal checklist
- final deletion when safe

### Out Of Scope

- deleting WebSocket before HTTP/2 paths are stable
- WebSocket-only proxy/file features
- keeping legacy JSON behavior indefinitely

## Fixed Decisions

- WebSocket compatibility carries the same envelope and stream frames.
- WebSocket must not bypass auth, policy, ownership, operation, or stream state.
- WebSocket fallback can have lower limits than HTTP/2/QUIC.
- Legacy JSON support must have a specific removal gate.
- Operators should be able to disable WebSocket compatibility after confidence is high.

## Implementation Tasks

### Task 1: Define compatibility policy

Document:

- supported daemon versions
- supported envelope versions
- legacy JSON sunset
- feature restrictions
- degraded limits
- removal metrics

### Task 2: Add degraded limits

Recommended WebSocket limits:

- lower max concurrent streams
- smaller chunks
- lower bulk throughput
- proxy/file disabled or heavily limited if HTTP/2 data is unavailable
- no QUIC promotion from WebSocket-only control

The exact limits should be product-driven, but they must be explicit.

### Task 3: Add operator controls

Add config for:

- allow WebSocket compatibility
- allow legacy JSON
- allow proxy/file over WebSocket compatibility
- maximum fallback stream counts

Defaults should become stricter as rollout progresses.

### Task 4: Add usage metrics and warnings

Track:

- active WebSocket daemon count
- legacy JSON frame count
- WebSocket envelope frame count
- WebSocket fallback proxy/file attempts
- unsupported daemon version count
- users/Buds affected by disabling compatibility

### Task 5: Remove legacy JSON

After metrics show no active dependency:

- delete legacy JSON parser/serializer
- remove JSON-only tests
- update protocol docs
- keep protobuf envelope carrier only if WebSocket fallback still exists

### Task 6: Remove WebSocket daemon transport

When supported:

- delete daemon WebSocket client path
- delete service WebSocket gateway path
- remove `@fastify/websocket` if no other use remains
- remove WebSocket config
- update deployment docs
- update root and child specs

## Files Likely Affected

### Service

- `service/src/ws/`
- `service/src/transport/`
- `service/src/config.ts`
- `service/src/server.ts`
- `service/package.json`

### Bud

- `bud/src/transport/`
- `bud/src/config.rs`
- `bud/Cargo.toml`

### Docs

- `docs/proto.md`
- affected specs
- deployment/operator docs

## Test Plan

- compatibility policy tests
- config default tests
- legacy JSON removal tests
- WebSocket disabled startup/runtime tests
- final HTTP/2-only daemon smoke test
- audit of package dependencies after removal

## Exit Criteria

- WebSocket compatibility has explicit limits and metrics
- legacy JSON is removed when safe
- operators can disable WebSocket compatibility
- final removal deletes unused WebSocket code/dependencies
- protocol docs no longer describe WebSocket as a primary transport

