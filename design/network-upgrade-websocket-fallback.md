# Design: Network Upgrade WebSocket Baseline And Compatibility

## Context

The network-upgrade PR now treats WebSocket as the mandatory open-source daemon/service baseline. The daemon still uses protobuf `BudEnvelope` semantics and generic stream frames; WebSocket is the default carrier for both control and data unless an operator enables optional HTTP/2 or future QUIC carriers.

This matters for constrained self-hosting deployments. Some environments expose only HTTP/1.1 to the app process or make long-lived HTTP/2 bidi streams and UDP difficult, while long-lived WebSockets are supported and operationally simple.

This design captures the baseline policy for terminal, file, and web-serving stream frames over WebSocket with explicit bounded limits, while keeping optional carriers swappable.

## Goal

Allow WebSocket to act as the bounded default carrier for the same Bud envelope and stream frames used by optional HTTP/2 and future QUIC.

The baseline supports terminal traffic and the file/proxy stream foundations. Product exposure still needs feature-specific validation because proxy traffic is broader and easier to misuse than terminal/file reads.

## Non-Goals

- preserving legacy JSON behavior indefinitely
- adding carrier-specific product features
- bypassing gRPC-era operation/stream/session state
- bypassing service authorization or daemon local policy
- making HTTP/2 or QUIC required for correctness
- browser direct-to-daemon networking

## Baseline Policy

WebSocket must carry the same protobuf envelope and typed payloads:

- `BudEnvelope`
- stream open/accept/reject
- `stream_data`
- `stream_credit`
- `stream_reset`
- `stream_close`
- typed errors

It must not grow JSON-only file or web-serving behavior.

Feature gates and capability negotiation should distinguish:

- WebSocket control/data capability
- protobuf envelope over WebSocket
- terminal data over WebSocket
- file bytes over WebSocket
- web-serving bytes over WebSocket
- legacy JSON compatibility

## Recommended Limits

WebSocket baseline should remain bounded:

- lower max concurrent streams per Bud
- smaller chunks than HTTP/2/QUIC
- lower max in-flight bytes
- lower max file bytes per session
- shorter stream/session TTL
- conservative web-serving response limits
- no request-body proxying by default
- no optional proxy WebSocket upgrades until separately validated
- no QUIC promotion from WebSocket-only control without an explicit authenticated carrier attach

File bytes and loopback `GET`/`HEAD` proxy bytes now have WebSocket-only smokes. Product UI should still stay behind Phase 5 ownership, audit, and limit validation.

## Architecture

The service transport selector should treat WebSocket as the baseline transport session:

```text
WebSocket control+data
  -> optional HTTP/2 BudData.Attach when configured and healthy
  -> future QUIC data stream when configured and healthy
```

The durable state model should not change:

- `transport_session.transport_kind = "websocket"`
- same `bud_operation` rows
- same `bud_stream` transitions
- same ownership checks before browser-visible work
- same daemon local policy before local side effects

Carrier preference is an operator policy. The open-source default should prefer WebSocket for simplicity; hosted deployments may prefer QUIC or HTTP/2 once those carriers pass parity checks.

## Security

- service resolves viewer ownership before opening streams
- daemon revalidates local file/proxy policy
- selected carrier and degraded/unavailable reasons are logged/audited
- limits are enforced on both sides
- legacy JSON cannot access new file/web-serving payloads
- operators can disable WebSocket compatibility entirely
- WebSocket baseline must not become an unbounded public file/proxy path

## Validation

Minimum validation for file over WebSocket:

- run with HTTP/2 data unavailable
- create an owned file session
- read file bytes over WebSocket envelope frames
- verify chunk, byte, credit, TTL, and close limits
- verify unauthenticated `401` and non-owner `404`
- verify daemon path policy still rejects unsafe paths
- verify selected-carrier/degraded telemetry is emitted

Additional validation for web-serving over WebSocket:

- run with HTTP/2 data unavailable
- proxy a loopback `GET` / `HEAD` through WebSocket frames
- enforce lower response/session limits
- reject request bodies by default
- reject proxy WebSocket upgrades unless explicitly enabled
- verify unsafe targets still fail before local side effects

## Exit Criteria

- WebSocket baseline has explicit gates, limits, metrics, and operator controls
- file bytes work over the WebSocket baseline
- web-serving bytes are explicitly validated and gated before UI exposure
- legacy JSON removal has a separate measured gate
- enabling optional HTTP/2/QUIC carriers leaves WebSocket baseline behavior green
