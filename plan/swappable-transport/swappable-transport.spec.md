# swappable-transport

Implementation planning documents for reframing the network-upgrade branch around a WebSocket-first open-source baseline with protobuf/gRPC-style semantics carried over swappable daemon-service transports.

## Purpose

This folder turns the review in [../../review/network-upgrade-websocket-first-pr-review.md](../../review/network-upgrade-websocket-first-pr-review.md) and the current branch review in [../../review/network-upgrade/current-branch-review.md](../../review/network-upgrade/current-branch-review.md) into an actionable phased implementation plan.

The plan assumes:

- WebSocket is the mandatory baseline carrier for self-hosted deployments.
- The current PR closes on the existing terminal path over binary `BudEnvelope` WebSocket plus the carrier-neutral/WebSocket stream-frame prerequisites and validated file/proxy foundation smokes before file/proxy product work starts.
- One authenticated WebSocket carries control plus data by default, while the carrier/session model leaves room for an optional dedicated data WebSocket later.
- The protocol semantics are transport-independent: `BudEnvelope`, typed payload tags, stream IDs, credits, close/reset, durable stream state, and reconciliation.
- HTTP/2 gRPC control/data stays useful as an optional advanced carrier, but is no longer the definition of correctness.
- QUIC is deferred as a data-plane optimization for hosted or advanced deployments.
- File viewing and localhost web proxying have foundation smokes over WebSocket binary protobuf envelopes; Phase 5 has added route-auth coverage, bounded service limits, audit observability, and product handoff docs before UI/API exposure.
- Phase 6 and Phase 7 are branch-landing cleanup phases for carrier policy/correctness and protobuf debt. Phase 8 adds optional-carrier health/fallback observability and QUIC token-binding design without productizing file viewer or web proxy UX.
- Browser and mobile clients keep using service-owned REST plus SSE; they do not connect directly to daemons.
- File viewer and web proxy product work must not learn carrier-specific behavior.

## Files

### `implementation-spec.md`

Parent implementation spec for the swappable-transport pivot.

Documents:

- revised goals and fixed decisions
- target architecture
- carrier-neutral protocol model
- security model
- phase sequencing
- rollout risks and definition of done

### `phase-0-pr-scope-reset-and-transport-contract.md`

Scope-reset phase covering:

- replacing HTTP/2-required assumptions with a WebSocket-first baseline
- naming the current branch as a protocol/stream-foundation branch
- investigating field-level terminal/control payload cutover so active terminal traffic does not depend on whole-frame `frame_json`
- rejecting legacy JSON terminal compatibility after binary-envelope capability negotiation
- returning typed unsupported-payload protocol errors for unknown envelope payload fields
- closing the current PR around terminal-over-envelope with gRPC disabled
- defining the canonical carrier contract
- modeling one default control+data WebSocket plus an optional future data-only WebSocket
- preserving already useful gRPC and stream work without making it mandatory

### `phase-1-carrier-neutral-data-plane-runtime.md`

Runtime-refactor phase covering:

- renaming `GrpcData*` concepts to `DataPlane*`
- carrier-neutral session/stream registries
- stream-family capability negotiation
- transport selection and error taxonomy

### `phase-2-websocket-stream-carrier.md`

WebSocket carrier phase covering:

- registering the authenticated default WebSocket as a control+data session
- keeping room for an optional future data-only WebSocket
- dispatching `stream_data`, `stream_credit`, `stream_reset`, and `stream_close`
- routing file/proxy result frames from WebSocket into the shared runtimes
- preserving the terminal-over-envelope baseline from Phase 0

### `phase-3-file-stream-over-websocket.md`

File-foundation phase covering:

- making file session readiness carrier-neutral
- sending `file_open` through the selected control carrier
- streaming stat/read/range bytes over WebSocket
- validating the real-daemon file smoke with gRPC disabled

### `phase-4-web-proxy-stream-over-websocket.md`

Proxy-foundation phase covering:

- making proxy session readiness carrier-neutral
- sending `proxy_open` through the selected control carrier
- streaming loopback GET/HEAD responses over WebSocket
- validating the real-daemon proxy smoke with gRPC disabled

### `phase-5-productization-handoff-and-hardening.md`

Productization gate covering:

- route ownership and non-owner tests
- bounded WebSocket limits and operator controls
- file viewer handoff requirements
- web proxy handoff requirements
- audit and observability requirements before product UI lands
- lazy-on-click file session and explicit user-action proxy session product decisions

### `phase-6-landing-correctness-and-fallback-policy.md`

Landing-correctness phase covering:

- explicit carrier preference/fallback policy
- alignment between control and data carrier selection
- daemon gRPC fallback behavior
- `stream_close.final_offset` validation
- durable cleanup for file/proxy open send failures and invalid accepted results
- WebSocket/gRPC handshake registration ordering
- ownerless legacy enrollment-token cleanup

### `phase-7-protobuf-layer-cleanup.md`

Protocol cleanup phase covering:

- `frame_json` and `LegacyJsonPayload` inventory
- generated vs. manual codec decision
- core stream lifecycle payload cleanup
- conformance fixture expansion
- safe JavaScript `uint64` handling
- documentation of any remaining compatibility bridge

### `phase-8-optional-transport-upgrades.md`

Optional carrier phase covering:

- keeping HTTP/2 gRPC as an adapter, not the baseline
- adding QUIC as a data-plane adapter later
- validating fallback between QUIC, HTTP/2, and WebSocket without product contract changes

### `progress-checklist.md`

Running implementation checklist for the swappable-transport pivot.

### `validation-checklist.md`

Manual and automated validation checklist for WebSocket-first stream behavior and later optional carrier parity.

## Dependencies

- [../../review/network-upgrade-websocket-first-pr-review.md](../../review/network-upgrade-websocket-first-pr-review.md) - PR review that motivates the pivot
- [../../review/network-upgrade/current-branch-review.md](../../review/network-upgrade/current-branch-review.md) - current branch review that motivates Phase 6 and Phase 7 cleanup
- [../network-upgrade/implementation-spec.md](../network-upgrade/implementation-spec.md) - superseded HTTP/2-first implementation plan retained as historical context
- [../network-upgrade/current-pr-http2-upgrade-scope.md](../network-upgrade/current-pr-http2-upgrade-scope.md) - superseded current-PR scope reset retained as historical context
- [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md) - follow-on file viewer design context
- [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md) - follow-on web proxy design context
- [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md) - deferred QUIC data-plane design context
- [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md) - previous WebSocket fallback notes to be reframed as baseline-carrier policy
- [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto) - canonical daemon-service protobuf schema
- [../../docs/proto.md](../../docs/proto.md) - current wire protocol documentation
- [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md) - service transport boundary spec
- [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md) - service WebSocket gateway spec
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - service runtime state spec
- [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md) - file session/service foundation spec
- [../../service/src/proxy/proxy.spec.md](../../service/src/proxy/proxy.spec.md) - proxy session/service foundation spec
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon source/module spec
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The old `plan/network-upgrade/` documents are now marked superseded and retained only as origin context for the HTTP/2-first work. Keep this folder as the forward implementation plan unless the team explicitly reopens that direction.
- Transitional `frame_json` payload bodies still exist for optional gRPC adapter paths and proxy/file open-result frames. Phase 7 moved core stream lifecycle frames to direct typed payload fields and tracks the remaining protocol bridge before optional carriers or product surfaces copy it forward.
- File viewing and web proxy product UI can now build on Phase 5 ownership, limit, audit, and operator-hardening foundations, but still need feature-specific frontend/UX validation before exposure.
- The QUIC data adapter is intentionally deferred until the runtime/deployment design is approved; current Phase 8 coverage is selector/router health fallback plus token-binding design.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
