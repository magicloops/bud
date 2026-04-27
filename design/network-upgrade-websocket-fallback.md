# Design: Network Upgrade WebSocket Compatibility/Fallback

## Context

The HTTP/2 upgrade PR moves the daemon/service runtime toward protobuf envelopes, gRPC control, HTTP/2 data streams, durable stream state, and transport-independent stream semantics.

WebSocket compatibility remains important for migration and constrained self-hosting deployments. In particular, some self-hosters may run behind infrastructure such as Cloudflare Workers where long-lived WebSocket handling is simpler or better supported than native gRPC/HTTP/2 data or UDP.

This design covers a follow-on compatibility path for carrying terminal, file, and web-serving stream frames over WebSocket with explicit degraded limits.

## Goal

Allow WebSocket to act as a bounded worst-case compatibility carrier for the same Bud envelope and stream frames used by HTTP/2 and QUIC.

The fallback should ideally support file bytes, even if throughput and concurrency are lower. Web-serving fallback can be enabled only after tighter validation because proxy traffic is broader and easier to misuse.

## Non-Goals

- preserving legacy JSON behavior indefinitely
- adding WebSocket-only product features
- bypassing gRPC-era operation/stream/session state
- bypassing service authorization or daemon local policy
- replacing HTTP/2 or QUIC as preferred transports
- browser direct-to-daemon networking

## Compatibility Policy

WebSocket fallback must carry the same protobuf envelope and typed payloads:

- `BudEnvelope`
- stream open/accept/reject
- `stream_data`
- `stream_credit`
- `stream_reset`
- `stream_close`
- typed errors

It must not grow JSON-only file or web-serving behavior.

Feature gates should distinguish:

- WebSocket control compatibility
- protobuf envelope over WebSocket
- terminal data over WebSocket
- file bytes over WebSocket
- web-serving bytes over WebSocket
- legacy JSON compatibility

## Recommended Limits

WebSocket fallback should be visibly degraded:

- lower max concurrent streams per Bud
- smaller chunks than HTTP/2/QUIC
- lower max in-flight bytes
- lower max file bytes per session
- shorter stream/session TTL
- conservative web-serving response limits
- no request-body proxying by default
- no optional proxy WebSocket upgrades until separately validated
- no QUIC promotion from WebSocket-only control

File bytes should be allowed behind explicit config once tested. Web-serving bytes should default to disabled until a web-serving fallback smoke proves the constraints are sufficient.

## Architecture

The service transport selector should treat WebSocket as a last-resort transport session:

```text
QUIC data stream
  -> HTTP/2 BudData.Attach
  -> WebSocket compatibility, if feature gate and limits allow it
```

The durable state model should not change:

- `transport_session.transport_kind = "websocket"`
- same `bud_operation` rows
- same `bud_stream` transitions
- same ownership checks before browser-visible work
- same daemon local policy before local side effects

If both HTTP/2 data and WebSocket are active, HTTP/2 remains preferred unless explicit operator policy says otherwise.

## Security

- service resolves viewer ownership before opening streams
- daemon revalidates local file/proxy policy
- fallback reason is logged/audited
- limits are enforced on both sides
- legacy JSON cannot access new file/web-serving payloads
- operators can disable WebSocket compatibility entirely
- WebSocket fallback must not become an unbounded public file/proxy path

## Validation

Minimum validation for file fallback:

- force HTTP/2 data unavailable
- create an owned file session
- read file bytes over WebSocket envelope frames
- verify chunk, byte, credit, TTL, and close limits
- verify unauthenticated `401` and non-owner `404`
- verify daemon path policy still rejects unsafe paths
- verify degraded/fallback telemetry is emitted

Additional validation for web-serving fallback:

- force HTTP/2 data unavailable
- proxy a loopback `GET` / `HEAD` through WebSocket frames
- enforce lower response/session limits
- reject request bodies by default
- reject proxy WebSocket upgrades unless explicitly enabled
- verify unsafe targets still fail before local side effects

## Exit Criteria

- WebSocket compatibility has explicit gates, limits, metrics, and operator controls
- file bytes can use WebSocket fallback when enabled
- web-serving bytes are either explicitly validated and gated or explicitly disabled
- legacy JSON removal has a separate measured gate
- disabling WebSocket compatibility leaves the HTTP/2 path green
