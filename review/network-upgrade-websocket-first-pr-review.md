# Network Upgrade PR Review: WebSocket-First Baseline

Date: 2026-04-27

Compared: `origin/main...HEAD` on branch `network-upgrade`

Related docs:

- [network-upgrade.md](./network-upgrade.md)
- [../plan/network-upgrade/current-pr-http2-upgrade-scope.md](../plan/network-upgrade/current-pr-http2-upgrade-scope.md)
- [../design/network-upgrade-file-serving-productization.md](../design/network-upgrade-file-serving-productization.md)
- [../design/network-upgrade-web-serving-productization.md](../design/network-upgrade-web-serving-productization.md)
- [../design/network-upgrade-websocket-fallback.md](../design/network-upgrade-websocket-fallback.md)

## Revised Goal

The open-source baseline should work in the simplest deployment shape:

- one service process on an EC2-style VM, Render-style service, or similar
- daemon connects directly to the public service endpoint
- WebSocket is always supported for daemon control and stream data
- HTTP/2 gRPC and QUIC remain optional upgrades, not correctness requirements

This changes the earlier network-upgrade framing. WebSocket should not be treated as a temporary fallback after HTTP/2. It is the baseline carrier for self-hosted deployments, while the protocol carried over that socket should become the same protobuf-envelope, stream-credit, typed-reset model used by HTTP/2 and QUIC.

## Executive Conclusion

This branch is worth keeping, but not as an "off WebSockets" branch. It should be reframed as a protocol/stream-foundation branch that still needs a WebSocket-first carrier pass before file viewing or web proxying product work lands.

What is strong:

- The branch added a real shared protobuf schema in [../proto/bud/v1/bud.proto](../proto/bud/v1/bud.proto).
- WebSocket-capable peers can already exchange protobuf `BudEnvelope` binary frames using typed oneof payload tags with transitional JSON bodies.
- Service runtime code now has a daemon transport router seam for existing terminal/control traffic.
- The daemon now has a `TransportSender` seam that can wrap WebSocket, gRPC control, and optional gRPC data.
- Durable `device_session`, `transport_session`, `bud_operation`, `bud_stream`, `proxy_session`, `file_session`, and `audit_event` tables are useful regardless of carrier.
- The file and localhost proxy daemon adapters are good foundations.

What is not yet aligned:

- File/proxy readiness and edge streaming require active gRPC control plus `h2_data`.
- File/proxy open directives bypass the composite transport router and call the gRPC daemon router directly.
- The WebSocket gateway does not dispatch generic stream frames or file/proxy result frames back into the file/proxy runtimes.
- The daemon only advertises file/proxy capability when gRPC control and gRPC data URLs are configured.
- The current data runtime is named and shaped as `GrpcData*`, not as a transport-independent data-plane session.

Net: keep the protocol, durable state, stream model, file/proxy adapters, and spike evidence. Refactor the carrier assumptions before building file viewer or web proxy UX.

## Branch Delta Snapshot

The branch is broad: `161 files changed`, with most volume from protobuf/gRPC spike code, Drizzle snapshots, plan/review docs, service gRPC gateways, service file/proxy routes, and daemon file/proxy/gRPC adapters.

Major additions:

- [../proto/bud/v1/bud.proto](../proto/bud/v1/bud.proto): canonical protobuf envelope, control/data services, stream frames, proxy/file payload tags.
- [../service/src/proto/wire.ts](../service/src/proto/wire.ts) and [../bud/src/proto_wire.rs](../bud/src/proto_wire.rs): protobuf envelope carrier codecs for WebSocket compatibility.
- [../service/src/transport/](../service/src/transport/): daemon transport router boundary plus gRPC/WebSocket adapters.
- [../service/src/grpc/](../service/src/grpc/): grpc-js control/data gateways.
- [../bud/src/grpc_control.rs](../bud/src/grpc_control.rs) and [../bud/src/grpc_data.rs](../bud/src/grpc_data.rs): tonic clients.
- [../service/src/runtime/daemon-state.ts](../service/src/runtime/daemon-state.ts): durable operation/session/stream repository.
- [../service/src/files/](../service/src/files/) and [../bud/src/files/](../bud/src/files/): file session and daemon file read foundation.
- [../service/src/proxy/](../service/src/proxy/) and [../bud/src/proxy/](../bud/src/proxy/): localhost proxy foundation.
- `spikes/grpc-interop/`: Connect vs grpc-js validation harness.

## Does It Have gRPC Semantics?

Partially.

| Area | Current status | Assessment |
| --- | --- | --- |
| Protobuf envelope | `BudEnvelope` exists and is used by WebSocket binary carrier and gRPC gateways | Keep |
| Typed payload dispatch | Known frame types use typed oneof tags, but the payload content is still `frame_json` | Good transitional semantics, not final field-level protobuf |
| Control stream semantics | gRPC control has long-lived bidi behavior; WebSocket control still has its own state machine | Keep concepts, reduce duplication over time |
| Stream lifecycle | `bud_operation`, `bud_stream`, `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` exist | Keep |
| Data carrier abstraction | HTTP/2 data has a concrete runtime, but it is gRPC-specific | Refactor |
| WebSocket carrier | WebSocket can carry protobuf envelopes for existing control/terminal frames | Extend to stream frames |
| File/proxy product paths | Route and daemon foundations exist, but service requires gRPC control/data | Refactor before productization |

The important nuance: "gRPC semantics" should mean protobuf envelope, stream IDs, credits, typed resets, durable stream state, and bidi-ish long-lived carrier behavior. It should not require the `@grpc/grpc-js` server to be present for the open-source baseline.

## What To Keep

### Keep The Protobuf Contract

[../proto/bud/v1/bud.proto](../proto/bud/v1/bud.proto) is the right shared contract. It already includes `TransportKind.WEBSOCKET`, `H2_GRPC`, `H2_DATA`, and `QUIC`, plus terminal, stream, proxy, and file payload tags.

The transitional `frame_json` fields are acceptable for this branch if we explicitly label them as a compatibility bridge. They give us typed payload tags and conformance fixtures without requiring a flag-day rewrite of every terminal/control payload.

### Keep The WebSocket Binary Envelope Work

The service WebSocket gateway decodes protobuf binary frames into JSON frame bodies before dispatching existing handlers, and it sends binary envelopes when the daemon advertises `capabilities.bud_envelope.websocket_binary`.

Relevant current code:

- decode path in [../service/src/ws/bud-connection.ts](../service/src/ws/bud-connection.ts)
- send path in [../service/src/transport/websocket-daemon-router.ts](../service/src/transport/websocket-daemon-router.ts)
- daemon WebSocket sender in [../bud/src/transport.rs](../bud/src/transport.rs)

This is exactly the piece we need for WebSocket-first protocol semantics.

### Keep Durable Operation And Stream State

The new DB/session model in [../service/src/db/schema.ts](../service/src/db/schema.ts) is transport-neutral enough to keep:

- `device_session`
- `transport_session`
- `bud_operation`
- `bud_stream`
- `proxy_session`
- `file_session`
- `audit_event`

The schema has some naming/usage polish left, but the model is useful for WebSocket, HTTP/2, and QUIC.

### Keep File And Proxy Foundations

The daemon-side file/proxy adapters are useful because they already enforce important local policy boundaries:

- file adapter rejects unsafe workspace paths, non-regular files, symlinks, range over-limit, and stale content identity
- proxy adapter restricts to `http://127.0.0.1:<port>`, `GET`/`HEAD`, no redirects, and sanitized headers

The service routes and session tables are also useful, but their transport readiness checks must become carrier-neutral before they are the product path.

### Keep The gRPC Spike And grpc-js Implementation As Optional Carrier Evidence

The Connect vs grpc-js work answered a real question. It is still useful for hosted/advanced deployments. The mistake would be making it the baseline carrier.

## Where WebSocket Is Still A Special Case

### 1. File/Proxy Readiness Is gRPC-Only

File sessions require an active gRPC control tracker plus active gRPC data tracker:

- [../service/src/files/file-session.ts](../service/src/files/file-session.ts)
- [../service/src/proxy/proxy-session.ts](../service/src/proxy/proxy-session.ts)

When those trackers are absent, the routes return `GRPC_CONTROL_UNAVAILABLE` or `GRPC_DATA_UNAVAILABLE`. In a WebSocket-only deployment, file/proxy sessions are therefore marked unavailable even if the daemon is connected and capable over WebSocket.

### 2. File/Proxy Edges Require `h2_data`

The file/proxy edge streams look up `getActiveGrpcDataSessionTracker(...)` and return `424` when it is missing:

- [../service/src/files/file-edge.ts](../service/src/files/file-edge.ts)
- [../service/src/proxy/proxy-edge.ts](../service/src/proxy/proxy-edge.ts)

That blocks the immediate WebSocket-first file viewer and web proxy goals.

### 3. File/Proxy Opens Bypass The Composite Router

The edge code sends `file_open` / `proxy_open` through `grpcDaemonTransportRouter.sendFrameToBud(...)`, not through the composite router or a selected control carrier.

That means even if a Bud is online via WebSocket, file/proxy open directives will not be sent.

### 4. WebSocket Gateway Does Not Dispatch Stream Frames

The WebSocket gateway decodes protobuf envelopes, but its inbound dispatch currently handles hello/auth/heartbeat, terminal frames, and reconnect reports. It does not route:

- `stream_data`
- `stream_credit`
- `stream_reset`
- `stream_close`
- `proxy_open_result`
- `file_open_result`

The daemon can already handle `file_open` and `proxy_open` in its normal server-frame dispatcher, and a WebSocket `TransportSender` can write `stream_data` frames. The missing half is service-side WebSocket dispatch into the existing proxy/file runtimes.

### 5. Daemon Capabilities Gate File/Proxy On gRPC URLs

The daemon advertises:

- `proxy.localhost_http = grpc_control_url && grpc_data_url`
- `files.workspace_read = grpc_control_url && grpc_data_url`

That should become "stream carrier supports file/proxy frames", not "gRPC URLs exist".

### 6. Data Runtime Names And Types Are gRPC-Specific

The runtime concepts are mostly right, but the implementation is named and keyed as gRPC data:

- `GrpcDataSessionTracker`
- `grpcDataSessions`
- `registerGrpcDataRuntimeStream`
- `sendGrpcDataFrame`

For WebSocket-first, these should become a carrier-neutral data-plane registry with WebSocket, HTTP/2, and later QUIC implementations.

### 7. Daemon Chooses gRPC Or WebSocket, Not Fallback

If `BUD_GRPC_CONTROL_URL` is set, the daemon uses gRPC control. Otherwise it uses WebSocket. It does not try gRPC and fall back to WebSocket after failure.

That is acceptable if WebSocket remains the default and gRPC is opt-in, but it conflicts with any claim that gRPC is the universal baseline.

## Recommended Pivot

### New Transport Principle

Use this framing:

```text
Protocol: BudEnvelope + typed stream/control payloads
Baseline carrier: WebSocket
Optional control carrier: HTTP/2 gRPC
Optional data carrier: QUIC
Mandatory behavior: same stream lifecycle, credits, reset, policy, auth, and audit regardless of carrier
```

HTTP/2 gRPC should be one carrier implementation, not the definition of correctness.

### Immediate Refactor Before File Viewer/Web Proxy Product Work

1. Introduce a carrier-neutral data-plane interface in service.

   Suggested shape:

   - `DataPlaneSessionTracker`
   - `DataPlaneRuntimeStream`
   - `registerDataPlaneRuntimeStream(...)`
   - `sendDataPlaneFrame(...)`
   - `getActiveDataPlaneSessionForBud(...)`
   - `transport_kind: "websocket" | "h2_data" | "quic"`
   - negotiated stream families: `terminal_output`, `file_read`, `localhost_http_proxy`

2. Make WebSocket an active data-plane session.

   For a new daemon that advertises `bud_envelope.websocket_binary`, the authenticated `/ws` connection should register a `transport_session` that can carry both control and data frames. It can be the same physical socket; the logical data-plane registry can still treat it as a carrier with stream families and limits.

3. Extend WebSocket inbound dispatch.

   The WebSocket gateway should route:

   - `stream_data` into the runtime stream registry
   - `stream_credit` into daemon/service stream writers
   - `stream_reset` into runtime reset callbacks
   - `stream_close` into runtime close callbacks
   - `proxy_open_result` into proxy runtime
   - `file_open_result` into file runtime

4. Make file/proxy readiness use the data-plane selector.

   Replace "active gRPC control plus h2_data" with:

   - active authenticated control carrier
   - active data-capable carrier for the requested stream family
   - selected carrier's limits and degraded status

5. Send file/proxy opens through the selected control carrier.

   If the Bud is WebSocket-only, send `file_open` / `proxy_open` over WebSocket. If gRPC control is active and selected, send over gRPC. The route should not know which one won.

6. Update daemon capabilities.

   File/proxy capability should be true when the daemon can handle the stream family over the active carrier. For WebSocket baseline, that means binary-envelope WebSocket plus stream frame support should be enough.

7. Add WebSocket-first smokes.

   Before building product UI:

   - real-daemon terminal smoke over WebSocket binary envelope
   - real-daemon file stat/read/range smoke over WebSocket stream frames
   - real-daemon proxy GET/HEAD smoke over WebSocket stream frames
   - force gRPC disabled in these smokes

## Proposed Next Implementation Sequence

1. **Carrier-neutral data runtime**

   Rename/refactor `GrpcData*` runtime pieces into `DataPlane*` while preserving the existing HTTP/2 implementation behind an adapter.

2. **WebSocket stream carrier**

   Register data-capable WebSocket sessions and dispatch generic stream frames through the same runtime callbacks.

3. **File stream over WebSocket smoke**

   Make existing file foundation work with gRPC disabled. This is the best proof that the branch now supports the open-source baseline.

4. **Proxy stream over WebSocket smoke**

   Make existing localhost proxy foundation work with gRPC disabled.

5. **File viewer productization**

   Build the user-clicked path-open flow and markdown/code/text viewer on the WebSocket baseline. Keep the route contract transport-agnostic.

6. **Web proxy productization**

   Build local web-server open UX and harden route/auth/policy. Start with WebSocket, then validate HTTP/2/QUIC as upgrades.

7. **QUIC data carrier**

   Add QUIC as a data-plane adapter using the same `DataPlaneSessionTracker` and stream lifecycle. It should not change file/proxy routes.

## Technical Debt Accrued In This Branch

### Transitional Payload Debt

The branch defines typed protobuf payload messages, but the active path still carries JSON frame bodies under `frame_json`. This is acceptable for the pivot, but it should be called what it is: typed envelope semantics, not full generated field-level protobuf dispatch.

### gRPC Naming Leakage

Service file/proxy/session code leaks `GrpcData` and `GRPC_*` names into readiness, errors, tests, smoke scripts, and route behavior. Those names need to move behind carrier adapters.

### Duplicate Control State Machines

WebSocket and gRPC control both implement auth, heartbeat, online/offline state, reconnect handling, and frame dispatch in separate modules. Some duplication is unavoidable at the carrier boundary, but application-level control handling should converge so the two paths do not drift.

### Shallow Route Tests

The route tests currently verify route registration. They do not yet prove `401`/`404`, owner scoping, non-owner denial, or edge-stream authorization behavior for file/proxy routes.

### Audit Gaps

Session create/revoke and stream-open audit events exist, but reset/close/deny/expire coverage is not complete enough for product exposure.

### Device Identity Still Transitional

The branch keeps the existing shared-secret challenge model for daemon auth. That is probably fine for internal/dev and WebSocket-first foundation work, but public file/proxy exposure still needs a deliberate device-identity hardening decision.

### Large Branch Surface

The branch includes a lot of planning, spike code, generated Drizzle snapshots, service/daemon code, and product-foundation routes. This is manageable if we keep it, but the PR description should be explicit that it is a foundation pivot, not a finished transport replacement or finished file/web-serving product.

## Keep / Refactor / Defer

| Area | Recommendation |
| --- | --- |
| Protobuf schema and fixtures | Keep |
| Manual WebSocket protobuf codecs | Keep for now; replace with generated field-level payloads later |
| `@grpc/grpc-js` control/data gateways | Keep as optional advanced carrier; do not make baseline |
| Durable operation/session/stream DB | Keep |
| File/proxy session tables | Keep |
| File/proxy daemon adapters | Keep |
| File/proxy service routes | Keep only as foundation; refactor transport readiness before product UI |
| gRPC interop spike | Keep in `spikes/` as decision evidence |
| Current HTTP/2-only file/proxy smokes | Keep, but add WebSocket-first smokes and make those the baseline |
| QUIC design docs | Keep, but position as data-plane optimization |
| "move off WebSockets" wording | Replace with "move off JSON-only WebSocket semantics" |

## Open Questions

1. Should new daemons require protobuf binary envelopes on WebSocket, with JSON only for older compatibility daemons?
2. Should one WebSocket carry both control and data frames, or should advanced self-hosted deployments be able to open a second data WebSocket?
3. Should a WebSocket `transport_session` be both control and data, or should we model a logical child `transport_session` for stream data on the same socket?
4. What degraded limits do we want for WebSocket data: max concurrent streams, max chunk size, max file bytes, and proxy response limits?
5. Do we still want HTTP/2 gRPC control for hosted/advanced users, or should future work focus on WebSocket control plus QUIC data?
6. When QUIC is available, should control remain WebSocket and only file/proxy bytes move to QUIC?
7. How much of the transitional `frame_json` bridge should remain before first public file viewer/web proxy exposure?
8. Should the file viewer product create sessions lazily on click, or pre-create openable references when rendering agent/terminal output?
9. What hosting environments are officially in-scope for the first open-source baseline: EC2 direct, Render, Fly, Cloudflare Tunnel/Workers, nginx/Caddy reverse proxy?

## Bottom Line

Do not throw the branch away. It contains the right protocol and stream foundations.

Do not continue directly into frontend file viewer or web proxy productization yet. First make the existing file/proxy foundations work over WebSocket binary envelopes with gRPC disabled. That is the smallest proof that the branch supports the revised open-source baseline.

After that, file viewer and web proxy can be built once against a transport-neutral service contract, with QUIC added later as a data-plane optimization rather than a prerequisite.
