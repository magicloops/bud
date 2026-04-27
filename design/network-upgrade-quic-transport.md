# Design: Network Upgrade QUIC Transport

## Context

The network-upgrade PR proves the daemon/service stream model over HTTP/2: gRPC control, `BudData.Attach`, durable operation/stream state, generic stream credits, typed reset/close semantics, terminal smoke coverage, and file/proxy foundation smokes.

QUIC is deferred to a follow-on PR. It should improve stream-heavy behavior, but it must not introduce a second protocol or become required for correctness.

## Goal

Add QUIC as the preferred data carrier for daemon-originated and daemon-served stream bytes while preserving HTTP/2 data fallback.

Target selector:

```text
QUIC data stream, if healthy
  -> HTTP/2 BudData.Attach fallback
  -> bounded WebSocket fallback, if explicitly enabled by the compatibility design
```

## Non-Goals

- replacing HTTP/2 gRPC control
- adding QUIC-only product behavior
- direct browser/mobile daemon connectivity
- bypassing service authorization
- removing HTTP/2 data fallback
- implementing WebSocket fallback

## Protocol Model

QUIC should carry the same protocol objects already used by HTTP/2 data:

- `BudEnvelope`
- stream IDs
- traffic classes
- `bud_operation` and `bud_stream` lifecycle
- stream credits
- stream reset/close semantics
- typed errors

QUIC-specific messages should be limited to transport-session negotiation, health, and diagnostics. Terminal, file, and web-serving payloads should not fork by transport.

## Negotiation

HTTP/2 gRPC control remains authoritative.

Proposed flow:

1. Daemon authenticates over `BudControl.Connect`.
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

HTTP/2 data remains the required fallback when:

- UDP is blocked
- QUIC token negotiation fails
- QUIC health score is poor
- stream reset/error rate exceeds threshold
- service is draining the QUIC gateway
- operator disables QUIC

Fallback must not change service-facing URLs or browser behavior.

## Security

- service authorization still happens before daemon stream open
- daemon local policy still happens before local side effects
- QUIC token binding must not outlive the authenticated control session
- session revocation must stop new streams promptly
- logs/audit should record selected transport and fallback reason
- QUIC must not expose local daemon endpoints directly to browsers

## Validation

- token binding tests
- control-session close revokes QUIC token/session
- same protobuf/envelope conformance over QUIC
- UDP-blocked fallback to HTTP/2
- unhealthy QUIC demotion and cooldown
- terminal input remains responsive during file/web bulk transfer
- file range reads work over QUIC and HTTP/2 fallback
- web-serving asset concurrency comparison when web serving is productized

## Exit Criteria

- QUIC can carry existing stream bytes without payload divergence
- disabling QUIC does not disable terminal, file, or web-serving contracts
- fallback is observable and auditable
- deployment docs describe how to enable, disable, and debug QUIC
