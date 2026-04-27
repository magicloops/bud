# network-upgrade

Implementation planning documents for moving Bud's daemon-service networking from WebSocket-only JSON frames to a transport-independent protobuf protocol with HTTP/2 gRPC control, a data-plane selector that can prefer QUIC and fall back to HTTP/2 or bounded WebSocket compatibility, and product features built on that shared stream model.

## Purpose

This folder turns the analysis in:

- [../../review/network-upgrade.md](../../review/network-upgrade.md)
- [../../reference/protocol-transport-design-goals.md](../../reference/protocol-transport-design-goals.md)

into a phased implementation specification.

The plan assumes:

- web and mobile clients remain on service-owned REST plus SSE
- HTTP/2 gRPC is the required daemon control path
- HTTP/2 data streams are the required correctness fallback
- QUIC is the preferred long-term data stream carrier for file serving and web serving, but must reuse the same envelope and stream semantics
- WebSocket compatibility can be a worst-case fallback for terminal/file/web-serving bytes only with explicit degraded limits and no JSON-only product behavior
- WebSocket compatibility carries the same protobuf envelope and should not grow unique product behavior
- the current PR closes around the HTTP/2 upgrade plus stream foundations; file serving, QUIC, web serving, and WebSocket fallback are distinct follow-on tracks
- daemon local policy and service-side ownership checks are both required before file/web-serving features ship
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

### `current-pr-http2-upgrade-scope.md`

Current scope reset for the active PR.

Documents:

- current PR acceptance gate for the HTTP/2 daemon-service upgrade
- already-added file/proxy foundations that can remain without product exposure
- file serving, QUIC, web serving, and WebSocket fallback as follow-on tracks
- transport target of QUIC preferred, HTTP/2 fallback, and bounded WebSocket compatibility as worst-case fallback
- reprioritized sequence after Phase 4.4

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

### `phase-1.5-grpc-stack-interop-validation.md`

Intermediary validation phase covering:

- Buf as the schema/tooling standard
- Connect Node vs. `@grpc/grpc-js` as the daemon-gateway runtime decision
- Rust `tonic` interoperability with a Node native-gRPC-over-HTTP/2 server
- long-lived bidi stream, cancellation, deadline, metadata, status, drain, backpressure, churn, and attach-stream validation
- the decision gate before Phase 2 can implement the HTTP/2 control plane

### `phase-1.5-runtime-decision.md`

Accepted runtime decision for Phase 2:

- `@grpc/grpc-js` for the Node daemon gateway
- Rust `tonic` / `prost` for the Bud daemon
- Buf remains the schema/tooling standard
- Connect-ES remains available for non-daemon APIs, but is rejected for the daemon control gateway because tonic client-deadline bidi streams surface as cancellation / transport timeout

### `phase-1.5-connect-node-runtime-design.md`

Candidate design review for using Connect Node correctly in the daemon gateway spike, including native HTTP/2 server shape, handler-context timeout handling, bounded bidi queues, typed errors, and current Connect findings.

### `phase-1.5-grpc-js-runtime-design.md`

Candidate design review for using `@grpc/grpc-js` correctly in the daemon gateway spike, including stream status emission, pending async write coordination, cancellation, deadline behavior, backpressure, and current grpc-js findings.

### `phase-2-http2-grpc-control-plane.md`

Control-plane phase covering:

- `BudControl.Connect`
- daemon signed identity or transition mechanism
- gRPC control gateway/client
- heartbeat/offline detection
- capability and policy exchange
- operation control and reconciliation over HTTP/2

### `phase-2.1-control-hardening.md`

Local hardening slice between Phase 2 and Phase 3 covering service signal handling, gRPC tracker shutdown finalization, durable session closure, invalid credential validation, and the handoff assumptions for HTTP/2 data streams.

### `phase-2-deferred-hardening.md`

Deferred hardening backlog for the Phase 2 gRPC control slice, including hosted/front-door validation, device identity hardening, generated service bindings, status taxonomy, lifecycle/load validation, observability, operator controls, and file/web-serving security prerequisites.

### `phase-3-http2-data-fallback.md`

Data fallback phase covering:

- `BudData.Attach` or equivalent
- traffic classes
- stream credits
- bounded buffering
- terminal data migration
- WebSocket fallback for the same stream frames

### `phase-3.1-data-hardening.md`

Small hardening slice after the initial terminal-output data fallback:

- subordinate `h2_data` cleanup when the owning `h2_grpc` control session closes
- data tracker frame/byte counters and close-log context
- local control-fallback smoke coverage
- local large-output smoke coverage
- deferred stream-credit, reset propagation, and degraded-state work before file/web-serving streams

### `phase-4-localhost-proxy-and-file-reads.md`

Foundation phase that originally bundled proxy and file product work, now treated as a shared stream/security foundation for follow-on product PRs.

- generic stream foundation on top of `BudData.Attach`
- localhost HTTP proxy sessions
- service proxy edge
- daemon proxy adapter
- read-only file sessions
- file stat/read/range adapter
- default local policy
- audit events
- validation with QUIC disabled
- explicit fail-closed behavior when HTTP/2 data is unavailable
- current reprioritization that treats file-serving and web-serving productization as follow-on work

### `phase-5-quic-data-fast-path.md`

Preferred data fast-path phase covering:

- QUIC data gateway/client
- short-lived tokens bound to authenticated control sessions
- same envelope and stream lifecycle over QUIC
- stream scheduler
- health scoring and HTTP/2 fallback
- file-serving and web-serving transport selection without payload divergence

### `phase-6-websocket-compatibility-cleanup.md`

Cleanup phase covering:

- WebSocket compatibility policy
- degraded limits
- bounded file-serving and web-serving bytes over WebSocket fallback
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
- [../../reference/connect-vs-grpc-js.md](../../reference/connect-vs-grpc-js.md) - Buf/Connect/grpc-js daemon gateway decision note
- [current-pr-http2-upgrade-scope.md](./current-pr-http2-upgrade-scope.md) - current PR scope reset and follow-on split
- [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md) - follow-on file serving design
- [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md) - follow-on QUIC transport design
- [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md) - follow-on web serving design
- [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md) - follow-on WebSocket fallback design
- [../../spikes/grpc-interop/grpc-interop.spec.md](../../spikes/grpc-interop/grpc-interop.spec.md) - isolated Rust tonic to Node Connect/grpc-js interop spike for Phase 1.5
- [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md) - accepted daemon-gateway gRPC runtime decision
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
- Phase 2 initially uses isolated `@grpc/proto-loader` inside `service/src/grpc/`; switch to Buf-managed grpc-js TypeScript generation if the adapter becomes unsafe or noisy.
- Phase 2 uses the existing shared-secret challenge as a documented transition credential; keypair challenge, mTLS, or short-lived token binding remain required design work before file/web-serving capabilities depend on gRPC control.
- The QUIC gateway placement is still deferred until the stream semantics are stable, but QUIC is now the preferred long-term carrier for file serving and web serving rather than a generic optional nice-to-have.
- File serving, web serving, and WebSocket data fallback are intentionally follow-on product/transport PRs after the HTTP/2 upgrade.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
