# Phase 3: HTTP/2 Data Fallback

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make HTTP/2 data streams the required fallback data plane for interactive terminal traffic and future proxy/file streams before QUIC exists.

## Context

Control over HTTP/2 is not enough for web proxying or file range reads. The platform needs stream semantics, backpressure, traffic classes, chunk bounds, and typed resets that work over mandatory infrastructure. This phase proves those semantics using terminal traffic before product proxy/file features rely on them.

## Phase 2.1 Preconditions

Phase 3 assumes the Phase 2.1 control hardening slice is present:

- `BudControl.Connect` remains the lifecycle authority for auth, capabilities, stream-open directives, resets, reconnect reports, and drain notices.
- Service `SIGINT` / `SIGTERM` reaches Fastify `onClose`, so active gRPC control trackers are finalized before DB pools close.
- Durable `device_session` and `transport_session` rows close on service-driven drain with `grpc_control_gateway_shutdown`.
- Invalid daemon credentials receive a typed `AUTH_FAILED` protocol error.
- Data-plane streams are subordinate to an authenticated control session; they do not introduce an independent browser-visible authorization path.

## Scope

### In Scope

- `BudData.Attach` or equivalent data stream pool
- traffic class separation
- stream open/accept/reject/reset frames
- byte credits and backpressure
- max chunk sizes
- terminal output/input migration where appropriate
- terminal send/observe result migration if data-plane placement is chosen
- fallback selection between HTTP/2 data and WebSocket compatibility
- metrics for stream health, lag, credits, and resets

### Out Of Scope

- localhost proxy feature
- file viewer feature
- QUIC implementation
- generic blob storage replacement for terminal output

## Fixed Decisions

- HTTP/2 data must be feature-complete enough for proxy/file before QUIC is added.
- Terminal input and cancellation must have priority over output and bulk data.
- Data streams use the same `BudEnvelope` and `bud_stream` lifecycle.
- WebSocket compatibility uses the same stream frames with lower limits.
- Slow browser clients must not cause unbounded backend or daemon buffering.

## Implementation Tasks

### Task 1: Define data-plane service

Define `BudData.Attach` or equivalent:

- daemon-initiated stream attachment
- authentication binding to the active `BudControl.Connect` session
- service-initiated stream open metadata over control
- data frames over attached stream
- stream credit updates
- half-close semantics
- reset semantics
- transport health events

### Task 2: Add traffic classes

Initial classes:

- `control`
- `interactive`
- `proxy_active`
- `bulk`
- `telemetry`

Scheduling priority:

1. control resets/cancel/credit updates
2. terminal input
3. active proxy request/response bytes
4. terminal output
5. file/range bulk
6. telemetry

### Task 3: Implement credits and bounded buffering

Define:

- max chunk size
- initial stream window
- max in-flight bytes per stream
- max streams per Bud
- max streams per traffic class
- service buffer limits
- daemon buffer limits
- behavior on credit exhaustion

### Task 4: Implement service data-plane router

The router should:

- choose HTTP/2 data when available
- fall back to WebSocket compatibility only when allowed
- refuse data attachments that are not bound to an active authenticated control session
- update `bud_stream` state
- enforce per-Bud/user/session limits
- persist terminal output bytes where applicable
- emit SSE terminal events unchanged for web clients

### Task 5: Implement daemon data client

The daemon should:

- attach data streams after control authentication
- open/accept/reject streams based on local policy and capability
- enforce chunk limits
- honor credits
- prioritize interactive traffic
- report stream checkpoints on reconnect

### Task 6: Migrate terminal traffic

Move enough terminal traffic to prove parity:

- terminal output stream
- terminal input acknowledgement or error if needed
- terminal send/observe result payloads if not kept on control
- terminal resize/status data if appropriate

Preserve browser-facing SSE and history APIs.

### Task 7: Validate fallback behavior

Ensure:

- HTTP/2 data enabled path works
- HTTP/2 data unavailable path uses WebSocket compatibility if allowed
- WebSocket fallback has lower limits and clear degraded status
- terminal remains interactive during large output

## Files Likely Affected

### Service

- `service/src/transport/`
- `service/src/runtime/terminal/`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/`
- `service/src/db/schema.ts`
- `service/src/routes/threads/terminal.ts`

### Bud

- `bud/src/transport/`
- `bud/src/terminal/`
- `bud/src/protocol.rs`

### Web

- usually unchanged, except optional degraded-state metadata in existing APIs/SSE

## Test Plan

- data frame encode/decode conformance tests
- stream credit unit tests
- service stream router tests
- daemon chunking/backpressure tests
- terminal output persistence tests
- manual terminal session with large output while typing input
- forced fallback test with HTTP/2 data disabled

## Exit Criteria

- terminal traffic works over HTTP/2 data fallback
- browser REST/SSE terminal behavior is unchanged
- terminal input does not block behind output
- data streams have bounded chunking and backpressure
- WebSocket fallback carries the same stream frames with degraded limits
- metrics expose stream health and fallback state
