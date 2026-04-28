# Phase 5: QUIC-Preferred Data Streams

> **Superseded:** This HTTP/2-first implementation note is historical. The forward implementation plan is [../swappable-transport/implementation-spec.md](../swappable-transport/implementation-spec.md). Keep this file only for origin context; do not use it as an active checklist.


**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md)
**Status**: Planned

---

## Objective

Add QUIC as the preferred data stream carrier for already-proven stream semantics while preserving HTTP/2 data fallback feature parity.

## Context

By this phase, control is on HTTP/2 gRPC and terminal/file/proxy foundation semantics are proven over HTTP/2. QUIC should improve stream concurrency, head-of-line behavior, and range/web-serving performance when UDP is healthy. It must not become a second protocol or a required feature path.

The current PR can merge after proving the HTTP/2 daemon-service upgrade and stream foundations. If the team decides file serving or web serving must have QUIC before product exposure, this phase should run before those product PRs and should validate file reads as the first QUIC consumer.

## Scope

### In Scope

- QUIC data gateway
- daemon QUIC data client
- short-lived QUIC tokens bound to authenticated control session
- same `BudEnvelope` and `bud_stream` lifecycle over QUIC
- transport selector policy: QUIC preferred, HTTP/2 fallback, bounded WebSocket compatibility as worst-case fallback if enabled
- health scoring
- promotion/demotion between QUIC and HTTP/2 data
- stream scheduler and priorities
- observability and fallback metrics

### Out Of Scope

- QUIC-only product features
- QUIC control plane replacement
- early data for non-idempotent effects
- removal of HTTP/2 data fallback
- raw UDP exposure to browsers

## Fixed Decisions

- HTTP/2 control remains authoritative.
- HTTP/2 data remains the required fallback.
- QUIC uses the same envelope, stream IDs, traffic classes, credits, and reset semantics.
- QUIC session tokens are short-lived and bound to a live authenticated control session.
- QUIC early data is disabled for non-idempotent effects.
- UDP-blocked environments must lose performance, not features.
- File serving and web serving remain service REST/HTTPS contracts; clients do not become transport-aware.
- WebSocket compatibility is not automatically enabled for file/web-serving bytes; it requires the bounded fallback policy from Phase 6.

## Implementation Tasks

### Task 1: Validate QUIC stack and deployment support

Spike:

- Rust `quinn` or chosen QUIC library
- service-side QUIC implementation or gateway process
- certificate/TLS requirements
- hosted front-door UDP support
- local dev ergonomics
- operational logging and metrics

Record whether QUIC lives in the main service process or an adjacent gateway.

### Task 2: Add QUIC session negotiation

Over HTTP/2 control:

- service advertises QUIC endpoint candidates
- daemon probes candidate
- service issues short-lived token
- daemon authenticates QUIC data session
- service records `transport_session` for QUIC
- both sides report health

### Task 3: Implement QUIC envelope framing

Use the same:

- `BudEnvelope`
- stream lifecycle
- traffic class
- credit model
- reset reason model
- operation/stream IDs

Avoid QUIC-specific payloads except transport-session management metadata.

### Task 4: Add scheduler

Initial priority order:

1. cancel/reset/credit
2. terminal input
3. active proxy HTML/API
4. terminal output
5. proxy static assets
6. file/range reads
7. bulk
8. telemetry

The scheduler should demote or pause lower-priority streams rather than hurting active terminal input.

### Task 5: Add health scoring and fallback

Track:

- connection success/failure
- RTT
- packet loss if available
- stream reset rate
- throughput
- blocked UDP detection
- fallback count
- cooldown timers

Fallback to HTTP/2 data when QUIC is unavailable or unhealthy.

If WebSocket compatibility is enabled as a worst-case fallback, the selector must apply explicit degraded limits from [phase-6-websocket-compatibility-cleanup.md](./phase-6-websocket-compatibility-cleanup.md) and emit visible degraded/fallback telemetry.

### Task 6: Validate terminal/file behavior first, then web serving

Validate:

- file reads work over QUIC and fall back to HTTP/2 data without changing the file URL contract
- terminal remains interactive during file reads
- web-serving assets parallelize better when QUIC is healthy
- range reads improve but still work over HTTP/2
- forced QUIC failure falls back without user-visible feature loss

## Files Likely Affected

### Service

- `service/src/transport/`
- `service/src/config.ts`
- `service/src/server.ts` or new gateway entrypoint
- `service/src/db/schema.ts` if transport-session fields need expansion

### Bud

- `bud/Cargo.toml`
- `bud/src/config.rs`
- `bud/src/transport/`

### Docs

- `docs/proto.md`
- deployment docs/runbooks if QUIC requires front-door changes
- affected specs

## Test Plan

- QUIC token binding tests
- QUIC frame conformance tests
- scheduler unit tests
- health scoring tests
- fallback integration tests
- manual UDP-blocked validation
- file-serving throughput/fallback comparison with and without QUIC
- web-serving throughput comparison with and without QUIC when the follow-on product PR lands

## Exit Criteria

- QUIC can carry existing data streams without payload divergence
- disabling QUIC does not disable terminal/file/proxy foundations or follow-on product contracts
- web serving uses the same selector when it is productized
- unhealthy QUIC falls back to HTTP/2 data automatically
- terminal input remains responsive during bulk transfers
- deployment docs describe how QUIC is enabled and disabled
