# Implementation Spec: Swappable Transport

**Status**: Implemented through Phase 8; QUIC data adapter remains deferred pending approved runtime/deployment design
**Created**: 2026-04-27
**Review Doc**: [../../review/network-upgrade-websocket-first-pr-review.md](../../review/network-upgrade-websocket-first-pr-review.md)
**Current Branch Review**: [../../review/network-upgrade/current-branch-review.md](../../review/network-upgrade/current-branch-review.md)
**Folder Spec**: [swappable-transport.spec.md](./swappable-transport.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-pr-scope-reset-and-transport-contract.md](./phase-0-pr-scope-reset-and-transport-contract.md)
**Phase 1**: [phase-1-carrier-neutral-data-plane-runtime.md](./phase-1-carrier-neutral-data-plane-runtime.md)
**Phase 2**: [phase-2-websocket-stream-carrier.md](./phase-2-websocket-stream-carrier.md)
**Phase 3**: [phase-3-file-stream-over-websocket.md](./phase-3-file-stream-over-websocket.md)
**Phase 4**: [phase-4-web-proxy-stream-over-websocket.md](./phase-4-web-proxy-stream-over-websocket.md)
**Phase 5**: [phase-5-productization-handoff-and-hardening.md](./phase-5-productization-handoff-and-hardening.md)
**Phase 6**: [phase-6-landing-correctness-and-fallback-policy.md](./phase-6-landing-correctness-and-fallback-policy.md)
**Phase 7**: [phase-7-protobuf-layer-cleanup.md](./phase-7-protobuf-layer-cleanup.md)
**Phase 8**: [phase-8-optional-transport-upgrades.md](./phase-8-optional-transport-upgrades.md)

---

## Context

The active `network-upgrade` branch added valuable protocol and runtime foundations:

- shared protobuf schema and `BudEnvelope`
- WebSocket binary envelope compatibility
- daemon/service transport boundaries
- durable device, transport, operation, and stream state
- HTTP/2 gRPC control/data adapters
- file and localhost proxy stream foundations
- typed oneof payload tags, with active WebSocket terminal/control and core stream lifecycle payloads now moved to direct protobuf fields while proxy/file open families still carry transitional `frame_json`

The original plan treated HTTP/2 gRPC as the required daemon-service control/data path and WebSocket as a worst-case fallback. That no longer matches the deployment priority.

The open-source baseline should be one service process on an ordinary host where WebSocket is guaranteed to work. Many useful self-hosted environments either do not expose HTTP/2 to the application, do not support long-lived HTTP/2 bidi streams reliably, or are simpler to operate with one WebSocket endpoint. Render is the motivating example because its load balancer can force HTTP/1.1 between the edge and application.

The new target is therefore:

```text
Protocol semantics: BudEnvelope + durable stream lifecycle
Baseline carrier: WebSocket
Optional carrier: HTTP/2 gRPC
Future data optimization: QUIC
Product contract: carrier-neutral REST/SSE service APIs
```

This plan supersedes the forward implementation direction in [../network-upgrade/implementation-spec.md](../network-upgrade/implementation-spec.md), while preserving that folder as historical context for thinking that informed the current shape. The old folder is not an active checklist.

The current PR should now close on the existing terminal path plus the carrier prerequisites for future file/proxy product work:

- WebSocket remains the default daemon-service carrier.
- Existing terminal/control traffic uses binary `BudEnvelope` over WebSocket.
- Phase 0 removes whole-frame `frame_json` from the active WebSocket terminal/control path by mapping terminal/control frames to typed protobuf fields.
- Phase 7 removes whole-frame `frame_json` from the core data-plane lifecycle payloads on the WebSocket binary carrier.
- Phase 1/2 make data-plane selection and WebSocket stream-frame dispatch carrier-neutral.
- File viewing and web proxy productization remain follow-on work after WebSocket-only file/proxy smokes and Phase 5 hardening are proven.

## Objective

Make the daemon-service transport stack swappable while keeping WebSocket as the mandatory baseline.

By the end of this plan:

- WebSocket binary protobuf envelopes carry current terminal/control behavior.
- One WebSocket is the default carrier for control plus data, while an optional second data WebSocket can be added without changing product code.
- File/proxy stream foundations use the same WebSocket baseline once terminal-over-envelope is proven.
- File/proxy route readiness no longer requires active gRPC control or `h2_data`.
- Service stream code routes through carrier-neutral `DataPlane*` abstractions instead of `GrpcData*` runtime types.
- The daemon advertises file/proxy capability when the active carrier supports the required protobuf stream frames, not only when gRPC URLs are configured.
- HTTP/2 gRPC remains available as an optional carrier implementation.
- QUIC can be added later as a data-plane adapter without changing file viewer or web proxy product APIs.
- Product work for file viewer and web proxy can proceed on top of WebSocket-first stream foundations.

## Fixed Decisions

- WebSocket is the mandatory baseline daemon-service carrier.
- One authenticated WebSocket should be enough by default and may carry both control and data roles.
- A second dedicated data WebSocket should be optional later; carrier/session modeling must not make one physical socket a permanent assumption.
- The daemon-service protocol uses protobuf envelopes and typed stream/control semantics regardless of carrier.
- "gRPC semantics" means envelope, stream IDs, backpressure credits, typed reset/close, durable operation/stream state, and reconciliation. It does not require `@grpc/grpc-js` to be present.
- HTTP/2 gRPC control/data remains opt-in for advanced or hosted deployments.
- QUIC is deferred until file/proxy behavior works over the baseline carrier.
- Carrier fallback policy must be explicit before optional carriers are treated as production posture.
- Ownerless legacy enrollment cannot be part of production browser-visible Bud inventory.
- Core stream lifecycle payloads should not depend indefinitely on whole-frame `frame_json`.
- Browser and mobile clients continue to use service-owned REST plus SSE.
- File viewer and web proxy product APIs must not expose transport selection.
- New file/proxy routes require binary `BudEnvelope` stream-frame support; they do not support legacy JSON WebSocket frames.
- The current terminal path should move to binary `BudEnvelope` before file/proxy product paths are implemented.
- Phase 0 found the active terminal/control payloads can remove the whole-frame `frame_json` bridge and cut the WebSocket path over to field-level protobuf payloads for terminal/control frames.
- Nested dynamic blobs such as `capabilities_json`, `readiness_json`, `delta_json`, or `assessment_json` may remain as explicit typed payload fields when they represent genuinely dynamic subdocuments. The debt to avoid is the whole-frame `frame_json` compatibility body.
- File reads remain read-only and daemon-policy checked.
- Web proxy remains loopback HTTP `GET`/`HEAD` first.
- Device identity hardening remains important, but the WebSocket-first pivot should not block on replacing the existing claim/shared-secret path unless a product exposure decision requires it.

## Target Architecture

```text
Web / mobile
  REST + SSE
      |
      v
Service product APIs
  - ownership checks
  - session creation
  - stream edge endpoints
  - file/proxy viewer contracts
      |
      v
Daemon transport router
  - control carrier selector
  - data-plane carrier selector
  - operation registry
  - runtime stream registry
      |
      +-- WebSocket binary BudEnvelope: baseline control plus data
      +-- Optional second WebSocket: future dedicated data carrier
      +-- HTTP/2 gRPC: optional control/data adapter
      +-- QUIC: future data adapter
      |
      v
Bud daemon
  - local policy
  - terminal backend
  - file read adapter
  - localhost proxy adapter
```

## Carrier Contract

Every carrier must provide the same logical behavior:

- authenticated device session
- transport session record
- explicit role support: control, data, or control+data
- capability manifest
- frame send with typed delivery outcome
- inbound frame dispatch into shared handlers
- drain/finalize callback
- stream-family advertisement
- max frame bytes and max in-flight bytes
- ordered per-stream `seq`
- reset/close propagation

Suggested service-side shape:

```ts
type TransportKind = "websocket" | "h2_grpc" | "h2_data" | "quic";
type TransportRole = "control" | "data";
type StreamFamily = "terminal_output" | "file_read" | "localhost_http_proxy";

interface ControlCarrier {
  kind: TransportKind;
  roles: Set<TransportRole>;
  budId: string;
  deviceSessionId: string;
  transportSessionId: string;
  sendControlFrame(frame: BudFrame): Promise<SendResult>;
  supports(frameType: string): boolean;
}

interface DataPlaneCarrier {
  kind: TransportKind;
  roles: Set<TransportRole>;
  budId: string;
  deviceSessionId: string;
  transportSessionId: string;
  streamFamilies: Set<StreamFamily>;
  maxFrameBytes: number;
  maxInFlightBytes: number;
  sendDataFrame(frame: BudFrame): Promise<SendResult>;
}
```

Names can differ during implementation, but the boundary should make these concepts explicit.

## Security Model

Service-side authorization remains the first gate:

- resolve the authenticated viewer before creating file/proxy sessions
- scope Bud/thread/session reads to the viewer in SQL
- return `401` only for unauthenticated browser requests
- return `404` for signed-in users accessing another user's resources
- authorize before attaching to stream edges or opening daemon streams

Daemon-side local policy remains mandatory:

- file reads must stay inside approved roots or approved handles
- file reads must reject symlinks, non-regular files, stale content identity, and over-limit ranges
- proxy requests must remain loopback-only and method-limited
- proxy headers must be sanitized before local forwarding
- daemon denials must become first-class typed stream results

Transport security:

- WebSocket baseline must require the same daemon authentication as current control.
- Optional HTTP/2/QUIC carriers must bind to an authenticated device/control session before carrying data.
- QUIC tokens, when added, should be short-lived and tied to the active authenticated daemon session.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 0 | [phase-0-pr-scope-reset-and-transport-contract.md](./phase-0-pr-scope-reset-and-transport-contract.md) | Urgent | Reframe the PR around terminal `BudEnvelope` over WebSocket, investigate field-level terminal payload cutover, and define the carrier contract |
| 1 | [phase-1-carrier-neutral-data-plane-runtime.md](./phase-1-carrier-neutral-data-plane-runtime.md) | Urgent | Refactor `GrpcData*` runtime concepts into carrier-neutral data-plane abstractions |
| 2 | [phase-2-websocket-stream-carrier.md](./phase-2-websocket-stream-carrier.md) | Urgent | Make authenticated WebSocket connections first-class data-plane carriers for stream frames |
| 3 | [phase-3-file-stream-over-websocket.md](./phase-3-file-stream-over-websocket.md) | High | Prove file stat/read/range foundations over WebSocket with gRPC disabled |
| 4 | [phase-4-web-proxy-stream-over-websocket.md](./phase-4-web-proxy-stream-over-websocket.md) | High | Prove loopback GET/HEAD proxy foundations over WebSocket with gRPC disabled |
| 5 | [phase-5-productization-handoff-and-hardening.md](./phase-5-productization-handoff-and-hardening.md) | High | Close security, limits, audit, and product handoff gates before file viewer/web proxy UI |
| 6 | [phase-6-landing-correctness-and-fallback-policy.md](./phase-6-landing-correctness-and-fallback-policy.md) | Urgent | Clarify carrier policy, close stream correctness gaps, and remove/quarantine ownerless enrollment before branch landing |
| 7 | [phase-7-protobuf-layer-cleanup.md](./phase-7-protobuf-layer-cleanup.md) | High | Clean up transitional protobuf/frame_json debt and add conformance/safe-integer rules |
| 8 | [phase-8-optional-transport-upgrades.md](./phase-8-optional-transport-upgrades.md) | Medium | Keep HTTP/2/QUIC as carrier adapters behind the same product contracts |

## Expected Files And Areas

### Service

- `service/src/transport/`
- `service/src/ws/`
- `service/src/grpc/`
- `service/src/runtime/daemon-state.ts`
- `service/src/files/`
- `service/src/proxy/`
- `service/src/proto/`
- `service/src/db/schema.ts` only if durable session fields need carrier-neutral renames or additions

### Bud Daemon

- `bud/src/transport.rs`
- `bud/src/app.rs`
- `bud/src/proto_wire.rs`
- `bud/src/files/`
- `bud/src/proxy/`
- `bud/src/grpc_control.rs`
- `bud/src/grpc_data.rs`

### Protocol / Docs

- `proto/bud/v1/bud.proto`
- `docs/proto.md`
- affected service and daemon specs
- this plan folder
- old `plan/network-upgrade/` docs only as historical context; do not use them as active tracking docs

### Product Follow-On Areas

- `web/src/` file viewer components and routes
- `web/src/` web proxy open/preview UX
- service REST/SSE route contracts for file/proxy product flows

## Sequencing Notes

- Phase 0 inventoried the current terminal/control frame shapes against [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto), added the missing reconnect metadata fields, and implemented field-level terminal/control payload mapping for WebSocket binary envelopes.
- The current PR closes on terminal-over-envelope plus WebSocket-first file/proxy stream foundations and hardening.
- Do not start file viewer or web proxy UI until WebSocket-only real-daemon smokes and Phase 5 route/limit/audit validation pass.
- Phase 1 now preserves the current HTTP/2 data behavior behind an adapter while exposing the public runtime through carrier-neutral `DataPlane*` concepts.
- Phase 2 now registers the default physical WebSocket as both control-capable and data-capable when the daemon advertises binary envelope stream support, while leaving the registry open for a future dedicated data WebSocket.
- Phase 3 proved that file sessions are no longer coupled to gRPC data by passing the real-daemon WebSocket-only file smoke with gRPC disabled.
- Phase 4 reused the same data-plane selector and stream callbacks as Phase 3 and passed the real-daemon WebSocket-only proxy smoke with gRPC disabled.
- Phase 5 added route-auth coverage, bounded data-plane limits, service/daemon denial audit events, generic reset/close audit events, and WebSocket-first product handoff docs.
- Phase 6 landed the explicit carrier policy, daemon gRPC-to-WebSocket fallback, final-offset validation, file/proxy failure cleanup, handshake ordering, and dev-only legacy token quarantine.
- Phase 7 moved core data-plane lifecycle payloads off whole-frame `frame_json`, bounded the remaining gRPC/proxy/file bridge, and added safe-`uint64` coverage.
- Phase 8 added optional-carrier health and fallback observability, selector/router failure tests for HTTP/2 and synthetic QUIC demotion, and finalized the QUIC token-binding design. QUIC should improve performance, not define correctness, and its data adapter remains a later approved implementation.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The branch keeps HTTP/2-only assumptions under new names | Medium | High | Validate file/proxy real-daemon smokes with all gRPC env vars unset |
| WebSocket stream bytes overwhelm self-hosted deployments | Medium | High | Add explicit degraded limits and default-safe max frame/in-flight settings |
| Control and data on one WebSocket cause head-of-line pressure | Medium | Medium | Default to one socket, but model carrier roles so an optional second data WebSocket can register later |
| Renaming `GrpcData*` creates a large noisy diff | High | Medium | Refactor in layers: adapter names first, mechanical rename second if needed |
| Remaining proxy/file `frame_json` becomes permanent | Medium | Medium | Keep field-level payload cutover in the proxy/file open-result cleanup phase |
| File/proxy product work starts before auth and limits are proven | Medium | High | Phase 5 blocks product UI on ownership, non-owner, audit, and limit validation |
| Optional HTTP/2/QUIC carrier behavior drifts from WebSocket | Medium | High | Shared conformance fixtures and carrier parity tests for every stream lifecycle event |

## Rollout Strategy

1. Document the pivot and make WebSocket-first the explicit baseline.
2. Inventory terminal/control payload fields and remove the whole-frame `frame_json` bridge from the active WebSocket terminal path.
3. Cut existing terminal/control traffic to binary `BudEnvelope` over WebSocket with gRPC disabled, rejecting post-negotiation JSON compatibility frames.
4. Refactor service data-plane naming and selectors without changing product behavior.
5. Teach the WebSocket gateway to carry generic stream lifecycle frames.
6. Validate file sessions over WebSocket.
7. Validate proxy sessions over WebSocket.
8. Close branch landing gaps around fallback policy, stream close correctness, file/proxy edge cleanup, handshake ordering, and enrollment ownership.
9. Clean the protobuf layer enough that optional carriers do not copy transitional `frame_json` debt forward.
10. Build file viewer and web proxy against carrier-neutral REST/SSE contracts in separate product follow-ons.
11. Add QUIC as an optional data-plane adapter later.

## Current PR Closeout Gate

- [x] Terminal/control frame shapes are inventoried against typed protobuf payload fields.
- [x] Any missing terminal/control payload fields are added to the schema or explicitly documented as blockers.
- [x] The active WebSocket terminal path uses binary `BudEnvelope`.
- [x] The active terminal path does not depend on `LegacyJsonPayload` or whole-frame `frame_json`.
- [x] The service rejects legacy JSON terminal WebSocket frames from new daemons with a useful protocol/capability error.
- [x] A real-daemon terminal ensure/send/output/reconnect smoke passes with gRPC disabled.
- [x] File/proxy product paths remain deferred.

## Definition Of Done

- [x] WebSocket is documented as the mandatory open-source baseline carrier.
- [x] One default WebSocket can register as control+data, and the carrier model allows a future dedicated data WebSocket.
- [x] Existing terminal behavior works over binary `BudEnvelope` with gRPC disabled.
- [x] Active terminal/control payloads use field-level protobuf messages unless Phase 0 records a concrete blocker.
- [x] File/proxy readiness no longer returns `GRPC_*_UNAVAILABLE` when a capable WebSocket daemon is connected.
- [x] WebSocket inbound dispatch handles generic stream lifecycle frames and file/proxy result frames.
- [x] File/proxy open directives use the selected control carrier, not a gRPC-only router.
- [x] Daemon file/proxy capabilities are carrier-based rather than gRPC-URL-based.
- [x] Existing HTTP/2 gRPC code remains optional and adapter-backed.
- [x] Real-daemon terminal, file, and proxy smokes pass with gRPC disabled.
- [x] Ownership, non-owner denial, limits, audit, and stream reset/close behavior are validated before product UI.
- [x] Relevant protocol docs and specs match shipped behavior.
- [x] Carrier/fallback policy is explicit and tested before optional carriers are promoted.
- [x] Stream close and file/proxy open failure paths leave durable operation/stream rows in terminal states.
- [x] Production-visible Bud enrollment cannot create ownerless browser-visible devices.
- [x] Core data-plane protobuf payloads have a documented cleanup path away from whole-frame `frame_json`.
