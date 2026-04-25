# network-upgrade

Implementation planning documents for moving Bud's daemon-service networking from WebSocket-only JSON frames to a transport-independent protobuf protocol with HTTP/2 gRPC control, HTTP/2 data fallback, optional QUIC data acceleration, and bounded WebSocket compatibility.

## Purpose

This folder turns the analysis in:

- [../../review/network-upgrade.md](../../review/network-upgrade.md)
- [../../reference/protocol-transport-design-goals.md](../../reference/protocol-transport-design-goals.md)

into a phased implementation specification.

The plan assumes:

- web and mobile clients remain on service-owned REST plus SSE
- HTTP/2 gRPC is the required daemon control path
- HTTP/2 data streams are the required data fallback
- QUIC is optional and should follow the first HTTP/2 proxy/file implementation
- WebSocket compatibility carries the same protobuf envelope and should not grow unique product behavior
- daemon local policy and service-side ownership checks are both required before proxy/file features ship
- tmux remains the first terminal backend during the transport migration

## Files

### `implementation-spec.md`

Parent implementation spec for the full network upgrade.

Documents:

- target architecture
- fixed decisions
- envelope/control/data model
- security model
- data model direction
- phase sequencing
- risks, rollout strategy, and definition of done

### `phase-0-protocol-envelope-and-transport-boundary.md`

Foundation phase covering:

- protobuf `BudEnvelope v1`
- typed payloads and errors
- cross-language conformance fixtures
- service daemon-transport router
- daemon transport client boundary
- WebSocket envelope carrier
- bounded terminal output chunks

### `phase-1-durable-control-and-reconciliation.md`

Durability phase covering:

- `device_session`
- `transport_session`
- `bud_operation`
- `bud_stream`
- daemon local journal
- reconnect reconciliation
- explicit `UNKNOWN` outcomes
- gateway drain semantics

### `phase-2-http2-grpc-control-plane.md`

Control-plane phase covering:

- `BudControl.Connect`
- daemon signed identity or transition mechanism
- gRPC control gateway/client
- heartbeat/offline detection
- capability and policy exchange
- operation control and reconciliation over HTTP/2

### `phase-3-http2-data-fallback.md`

Data fallback phase covering:

- `BudData.Attach` or equivalent
- traffic classes
- stream credits
- bounded buffering
- terminal data migration
- WebSocket fallback for the same stream frames

### `phase-4-localhost-proxy-and-file-reads.md`

Product-feature phase covering:

- localhost HTTP proxy sessions
- service proxy edge
- daemon proxy adapter
- read-only file sessions
- file stat/read/range adapter
- default local policy
- audit events
- validation with QUIC disabled

### `phase-5-quic-data-fast-path.md`

Optional acceleration phase covering:

- QUIC data gateway/client
- short-lived tokens bound to authenticated control sessions
- same envelope and stream lifecycle over QUIC
- stream scheduler
- health scoring and HTTP/2 fallback

### `phase-6-websocket-compatibility-cleanup.md`

Cleanup phase covering:

- WebSocket compatibility policy
- degraded limits
- operator controls
- metrics
- legacy JSON removal
- final WebSocket transport deletion when safe

### `progress-checklist.md`

Running implementation checklist for the network upgrade.

### `validation-checklist.md`

Manual and automated validation checklist for the network upgrade.

## Dependencies

- [../../review/network-upgrade.md](../../review/network-upgrade.md) - current implementation review and migration conclusions
- [../../reference/protocol-transport-design-goals.md](../../reference/protocol-transport-design-goals.md) - target transport requirements and goals
- [../../docs/proto.md](../../docs/proto.md) - current protocol documentation
- [../../bud/bud.spec.md](../../bud/bud.spec.md) - Bud daemon project spec
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - Bud source/module spec
- [../../service/service.spec.md](../../service/service.spec.md) - service project spec
- [../../service/src/src.spec.md](../../service/src/src.spec.md) - service source/module spec
- [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md) - current WebSocket gateway spec
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - service runtime spec
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - database schema spec
- [../../web/web.spec.md](../../web/web.spec.md) - web app spec
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The concrete protobuf/gRPC stack choice is intentionally left to Phase 0/2 spikes because it depends on code generation, Fastify coexistence, and deployment front-door support.
- The direct device identity migration shape is intentionally left open between keypair challenge, mTLS, and short-lived token binding until Phase 2 validates local and hosted constraints.
- The QUIC gateway placement is intentionally deferred until Phase 5 because HTTP/2 data fallback must be product-complete first.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
