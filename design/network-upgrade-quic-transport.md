# Design: Network Upgrade QUIC Transport

## Context

The network-upgrade PR proves the daemon/service stream model over the WebSocket baseline, with optional HTTP/2 adapters preserved behind the same carrier-neutral runtime: binary `BudEnvelope`, durable operation/stream state, generic stream credits, typed reset/close semantics, terminal smoke coverage, and file/proxy foundation smokes.

QUIC is deferred to a follow-on PR. It should improve stream-heavy behavior, but it must not introduce a second protocol or become required for correctness.

## Goal

Add QUIC as an optional high-performance data carrier for daemon-originated and daemon-served stream bytes while preserving the WebSocket baseline and optional HTTP/2 data carrier.

Target selector:

```text
QUIC data stream, if healthy
  -> WebSocket control+data baseline, or HTTP/2 BudData.Attach when operator policy prefers it
```

## Non-Goals

- replacing WebSocket control/data correctness
- adding QUIC-only product behavior
- direct browser/mobile daemon connectivity
- bypassing service authorization
- removing the WebSocket baseline

## Protocol Model

QUIC should carry the same protocol objects already used by the WebSocket and HTTP/2 data carriers:

- `BudEnvelope`
- stream IDs
- traffic classes
- `bud_operation` and `bud_stream` lifecycle
- stream credits
- stream reset/close semantics
- typed errors

QUIC-specific messages should be limited to transport-session negotiation, health, and diagnostics. Terminal, file, and web-serving payloads should not fork by transport.

The foundation PR still leaves some transitional `frame_json` use in optional gRPC adapter paths and in stream/proxy/file families that are not productized yet. QUIC should not copy that debt forward. Before QUIC carries a product stream family, shared conformance tests should prove that the same typed protobuf fields are used on WebSocket, HTTP/2, and QUIC for that family.

## Negotiation

The authenticated control session remains authoritative. In the open-source baseline that control session is the daemon WebSocket; hosted deployments may also bind QUIC to an authenticated gRPC control session.

Proposed flow:

1. Daemon authenticates over WebSocket or `BudControl.Connect`.
2. Service advertises QUIC endpoint candidates and capability metadata over control.
3. Service issues a short-lived QUIC token bound to the authenticated control session.
4. Daemon probes candidates and opens QUIC data transport.
5. Service records a `transport_session` with `transport_kind = "quic"`.
6. Daemon and service report health over control.
7. Transport selector promotes eligible streams to QUIC only while health is acceptable.

Token and session requirements:

- token TTL is short
- token is bound to Bud, device session, control transport session, and expected endpoint metadata
- token revokes when the owning control session drains/closes
- early data is disabled for non-idempotent effects

## Token Binding Contract

The approved pre-implementation contract is a service-issued, short-lived, signed bearer token delivered only over the already-authenticated control carrier. The token is not a product credential and must not be accepted by REST/SSE/browser routes.

Token claims:

- `token_id`: ULID used for revocation/audit lookup
- `bud_id`: authenticated Bud id
- `device_session_id`: active durable device session id
- `control_transport_session_id`: active WebSocket or `h2_grpc` control transport session id
- `allowed_transport_kind`: `quic`
- `allowed_stream_families`: stream families the QUIC attach may negotiate
- `endpoint_candidates`: service-advertised QUIC host/port/alpn candidates
- `not_before`, `expires_at`: short validity window
- `nonce`: random anti-replay value

Validation rules:

- reject missing, expired, malformed, replayed, or wrong-kind tokens
- reject if `bud_id`, `device_session_id`, or `control_transport_session_id` no longer matches the active authenticated control tracker
- reject if the owning control transport is draining, closed, or superseded
- reject stream families outside `allowed_stream_families`
- bind the created durable `transport_session` to the validated `token_id`
- revoke outstanding QUIC tokens when the owning control session finalizes

Health scoring:

- a successful QUIC attach starts as `healthy(100)`
- UDP/connectivity probe failures are `unhealthy(0)` with reason such as `udp_blocked`
- gateway drain is `unhealthy(0)` for new streams
- elevated reset/error rates should demote to `degraded(<50)` or `unhealthy(0)` depending on threshold
- cooldown prevents rapid promotion/demotion loops

The Phase 8 implementation adds selector-level health/fallback behavior and synthetic QUIC demotion tests, but intentionally does not add token issuance or a QUIC gateway. The gateway/runtime stack selection remains the next approval point.

## Follow-On Implementation Plan

This document is the design guardrail for a future QUIC pass, not the implementation checklist for that pass. Before opening a QUIC implementation PR, create a dedicated plan under `plan/` that turns the remaining choices into testable work items.

Example checklist:

- [ ] Select the QUIC runtime shape:
  - main service process vs. adjacent gateway process
  - Node/Rust/library choice
  - local development startup path
- [ ] Define control-plane frame shapes:
  - service-advertised endpoint candidates
  - token issuance/revocation frames
  - daemon QUIC attach status/health reports
- [ ] Implement token storage and revocation:
  - signed token format
  - replay protection for `token_id` / `nonce`
  - revocation on control-session drain/close/supersede
  - audit events for issued, accepted, rejected, and revoked tokens
- [ ] Add service configuration:
  - enable/disable QUIC
  - bind host/port
  - public endpoint candidates
  - TLS/certificate settings
  - health thresholds and cooldowns
- [ ] Add daemon configuration:
  - enable/disable QUIC probing
  - endpoint candidate handling
  - fallback to WebSocket/HTTP2 by service policy
  - operator-visible logs for failed probe/fallback reasons
- [ ] Implement the data adapter:
  - register `transport_session.transport_kind = "quic"`
  - register `DataPlaneSessionTracker` with health metadata
  - carry `stream_data`, `stream_credit`, `stream_reset`, and `stream_close`
  - preserve the same offset, credit, reset, close, and final-offset validation rules
- [ ] Add conformance coverage:
  - same protobuf payload fields as WebSocket for each stream family QUIC carries
  - no new file/proxy product payloads
  - unsafe integer handling parity with the WebSocket codec
- [ ] Add fallback and health tests:
  - UDP blocked
  - token expired/replayed/wrong session
  - QUIC gateway draining
  - high reset/error demotion and cooldown
  - WebSocket baseline remains green when QUIC is disabled or unhealthy
- [ ] Add smoke validation:
  - file range read over QUIC
  - proxy GET/HEAD over QUIC
  - terminal output/input responsiveness during file/proxy traffic
  - HTTP/2 fallback path when policy prefers H2 after QUIC demotion
- [ ] Add deployment docs:
  - UDP/front-door requirements
  - TLS/certificate model
  - metrics/log fields
  - operational rollback steps

## Gateway Placement

Open implementation choice:

- run QUIC in the main service process if the Node stack is reliable and deployment-friendly
- run QUIC in an adjacent gateway process if Node QUIC support, UDP handling, or operational isolation makes that safer

The PR should record:

- selected QUIC library or gateway stack
- certificate/TLS model
- UDP/front-door requirements
- local development ergonomics
- hosted deployment support
- metrics/logging plan

## Scheduling

Initial stream priority order:

1. cancel/reset/credit
2. terminal input
3. active web-serving HTML/API responses
4. terminal output
5. web-serving static assets
6. file reads and range reads
7. bulk transfer
8. telemetry

The scheduler should protect terminal interactivity during file and web-serving traffic. Lower-priority streams should pause or demote before terminal input becomes delayed.

## Fallback

WebSocket remains the correctness baseline. HTTP/2 data is an optional advanced carrier and should be validated before QUIC is added, but neither HTTP/2 nor QUIC is required for open-source correctness.

Before implementing QUIC, the optional carrier parity work should cover:

- HTTP/2 terminal smoke with WebSocket still available as the baseline
- forced HTTP/2 control/data failure with clean fallback to WebSocket
- carrier-status telemetry and audit fields that explain why HTTP/2 was demoted
- parity assertions that HTTP/2 uses the same envelope semantics as WebSocket for the validated stream families

QUIC data should fall back when:

- UDP is blocked
- QUIC token negotiation fails
- QUIC health score is poor
- stream reset/error rate exceeds threshold
- service is draining the QUIC gateway
- operator disables QUIC

Fallback must not change service-facing URLs, browser behavior, or daemon-local policy. Depending on operator policy, fallback may choose WebSocket directly or HTTP/2 data first; the WebSocket baseline must remain green either way.

## Security

- service authorization still happens before daemon stream open
- daemon local policy still happens before local side effects
- QUIC token binding must not outlive the authenticated control session
- session revocation must stop new streams promptly
- logs/audit should record selected transport and fallback reason
- QUIC must not expose local daemon endpoints directly to browsers

## Validation

- HTTP/2 terminal smoke passes with the optional carrier enabled
- forced HTTP/2 control/data failure falls back to WebSocket without breaking terminal/file/proxy baseline behavior
- token binding tests
- control-session close revokes QUIC token/session
- same protobuf/envelope conformance over QUIC
- UDP-blocked fallback to the configured non-QUIC carrier, with WebSocket always available as the baseline
- unhealthy QUIC demotion and cooldown
- terminal input remains responsive during file/web bulk transfer
- file range reads work over QUIC and HTTP/2 fallback
- web-serving asset concurrency comparison when web serving is productized

## Exit Criteria

- QUIC can carry existing stream bytes without payload divergence
- disabling QUIC does not disable terminal, file, or web-serving contracts
- fallback is observable and auditable
- deployment docs describe how to enable, disable, and debug QUIC
