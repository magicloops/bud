# Phase 6: WebSocket Compatibility Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md)
**Status**: Planned

---

## Objective

Reduce WebSocket from a migration bridge to a constrained compatibility path, allow it to act as a bounded worst-case data fallback where explicitly enabled, then remove it when supported daemon versions and deployment environments no longer need it.

## Context

WebSocket starts as the only daemon transport, becomes a carrier for the common envelope, and then becomes fallback as HTTP/2 control/data and QUIC mature. The target product selector is QUIC first, HTTP/2 fallback, and WebSocket only as a bounded worst-case compatibility carrier if explicitly enabled. File bytes should be allowed over this fallback once limits and validation exist, because that is useful for constrained self-hosting deployments. Web-serving bytes require a separate enablement decision because proxy traffic is broader and easier to misuse.

## Scope

### In Scope

- WebSocket compatibility policy
- degraded limits for WebSocket data
- version/capability gates
- operator switch to disable WebSocket compatibility
- metrics for remaining WebSocket usage
- bounded file-serving bytes over WebSocket fallback
- explicit decision on whether web-serving bytes may use WebSocket fallback by default
- removal checklist
- final deletion when safe

### Out Of Scope

- deleting WebSocket before HTTP/2 paths are stable
- WebSocket-only file-serving or web-serving features
- keeping legacy JSON behavior indefinitely

## Fixed Decisions

- WebSocket compatibility carries the same envelope and stream frames.
- WebSocket must not bypass auth, policy, ownership, operation, or stream state.
- WebSocket fallback can have lower limits than HTTP/2/QUIC.
- WebSocket fallback for file serving or web serving must be feature-gated and auditable; it is not implicit just because a WebSocket daemon is connected.
- File bytes are an intended fallback use case once bounded validation exists.
- Web-serving bytes should default to disabled until a web-serving fallback smoke proves the limits and policy are sufficient.
- Legacy JSON support must have a specific removal gate.
- Operators should be able to disable WebSocket compatibility after confidence is high.

## Implementation Tasks

### Task 1: Define compatibility policy

Document:

- supported daemon versions
- supported envelope versions
- legacy JSON sunset
- feature restrictions
- exact file-serving fallback limits
- whether web serving is allowed over WebSocket fallback by default
- degraded limits
- removal metrics

### Task 2: Add degraded limits

Recommended WebSocket limits:

- lower max concurrent streams
- smaller chunks
- lower bulk throughput
- file-serving bytes allowed only behind explicit fallback config and limits
- web serving disabled by default unless a follow-on PR explicitly enables bounded WebSocket fallback
- no QUIC promotion from WebSocket-only control

The exact limits should be product-driven, but they must be explicit.

### Task 3: Add operator controls

Add config for:

- allow WebSocket compatibility
- allow legacy JSON
- allow file serving over WebSocket compatibility
- allow web serving over WebSocket compatibility
- maximum fallback stream counts

Defaults should become stricter as rollout progresses.

### Task 4: Add usage metrics and warnings

Track:

- active WebSocket daemon count
- legacy JSON frame count
- WebSocket envelope frame count
- WebSocket fallback file-serving attempts
- WebSocket fallback web-serving attempts
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
