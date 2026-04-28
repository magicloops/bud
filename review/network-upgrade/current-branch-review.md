# Review: Network Upgrade Current Branch

Date: 2026-04-28

Branch reviewed: `network-upgrade`

Comparison base: `origin/main` at merge base `7ce31cf13510115120581f5cdf639abb3c4804ca`

## Scope

This is a current-branch review of the network-upgrade work after the direction changed from "move off WebSocket to HTTP/2 and QUIC" to "keep WebSocket as the baseline carrier while making the protocol transport-independent."

I reviewed the branch diff against `origin/main`, the prior review notes in `review/network-upgrade.md` and `review/network-upgrade-websocket-first-pr-review.md`, the current protocol/design/plan specs, and the main runtime paths in:

- `proto/bud/v1/bud.proto`
- `docs/proto.md`
- `plan/network-upgrade/`
- `plan/swappable-transport/`
- `design/network-upgrade-*.md`
- `service/src/proto/`
- `service/src/transport/`
- `service/src/ws/`
- `service/src/grpc/`
- `service/src/files/`
- `service/src/proxy/`
- `service/src/routes/files.ts`
- `service/src/routes/proxy.ts`
- `service/src/runtime/daemon-state.ts`
- `service/src/db/schema.ts`
- `bud/src/app.rs`
- `bud/src/transport.rs`
- `bud/src/proto_wire.rs`
- `bud/src/grpc_control.rs`
- `bud/src/grpc_data.rs`
- `bud/src/files/mod.rs`
- `bud/src/proxy/mod.rs`

The branch is large: `181 files changed`, about `50k` added lines. A meaningful part of that is documentation, checked-in migrations, protobuf compatibility code, smoke scripts, and the isolated gRPC interop spike.

## Overall Read

The important architectural correction has mostly happened. The newest code is no longer simply "file/proxy over gRPC." The service now has a carrier-neutral data-plane router, WebSocket sessions can register as a data-plane carrier, and file/proxy edge routes select the available carrier instead of hard-coding the gRPC data gateway. That resolves the central defect called out by the earlier WebSocket-first review.

What remains is cleanup and correctness hardening. The branch still carries multiple historical directions in docs and code, and several edge paths can leave durable operation/stream state misleading when a transport send fails, a stream close is malformed, or a peer races the handshake. None of that means the design is wrong. It means the branch should land as a clean WebSocket-baseline protocol foundation, not as a half-HTTP/2 migration branch with stale plans and optional carriers that look more mature than they are.

## What Is Worth Keeping

- The shared `BudEnvelope` schema and the idea that WebSocket, HTTP/2 gRPC, and future QUIC are carriers for the same logical protocol.
- The service `DaemonTransportRouter` and `DataPlaneSessionTracker` boundaries.
- The WebSocket binary-envelope path and rejection of active legacy JSON sessions.
- Durable `device_session`, `transport_session`, `bud_operation`, `bud_stream`, and `audit_event` tables.
- File/proxy session rows as service-owned, browser-auth-scoped contracts.
- The daemon `TransportSender` abstraction, even though its queue/backpressure behavior needs tuning.
- The gRPC control/data implementation as an optional adapter and validation artifact.
- The gRPC interop spike as evidence, if it is clearly marked as a spike and not product code.

## Prior Review Status

The most important issue in `review/network-upgrade-websocket-first-pr-review.md` is now mostly fixed:

- `service/src/files/file-edge.ts` and `service/src/proxy/proxy-edge.ts` no longer call the gRPC daemon router directly.
- `service/src/transport/data-plane-router.ts` provides a carrier-neutral registry and stream runtime.
- `service/src/ws/bud-connection.ts` registers the authenticated WebSocket as a stream carrier when `bud_envelope.stream_frames` is advertised.
- `service/src/routes/files.ts` and `service/src/routes/proxy.ts` resolve current transport status through file/proxy session helpers.

That older review should now be treated as historical context. The remaining findings below are about making the new shape clean and correct before merge.

## Findings

### 1. Blocker: the branch still contains two conflicting implementation narratives

The repo now contains both the older `plan/network-upgrade/` tree and the newer `plan/swappable-transport/` tree. They disagree on the core deployment model.

Examples:

- `plan/network-upgrade/implementation-spec.md` still says HTTP/2 gRPC is the mandatory daemon control transport and WebSocket is a worst-case compatibility carrier.
- `plan/swappable-transport/implementation-spec.md` says WebSocket is the mandatory open-source baseline and HTTP/2/QUIC are optional adapters.
- `design/network-upgrade-websocket-fallback.md` has been rewritten to describe a WebSocket baseline, but its filename and some older plan links still carry fallback-era terminology.

This is the largest "clean landing" issue because future agents and humans will read both plan trees and reasonably implement opposite policies.

Recommendation:

- Make `plan/swappable-transport/` the forward plan.
- Either delete `plan/network-upgrade/` before merge, move it under an explicitly historical archive, or add a top-of-file superseded banner to every stale phase doc.
- Rename or clearly alias `design/network-upgrade-websocket-fallback.md` to baseline-carrier terminology if the team is willing to touch links.
- Update `bud.spec.md` and relevant folder specs to point readers at the forward plan first.

Cleanup status, 2026-04-28: the plan cleanup has addressed the active-plan conflict without deleting the historical files. `plan/network-upgrade/` now carries superseded banners, `plan/swappable-transport/` is the forward implementation plan, and the root spec points readers at the new Phase 6/7/8 follow-up docs.

### 2. High: transport selection policy is underspecified and internally inconsistent

Current behavior:

- `service/src/transport/data-plane-router.ts` ranks data carriers as `websocket` first, then `h2_data`, then `quic`.
- `service/src/transport/composite-daemon-router.ts` ranks control routing as gRPC first when a gRPC control session is online, otherwise WebSocket.
- `bud/src/app.rs` chooses gRPC control exclusively when `BUD_GRPC_CONTROL_URL` is set; it does not automatically fall back to the WebSocket URL after gRPC failure.
- `docs/proto.md` says the control router prefers active gRPC control streams while file/proxy bytes default to WebSocket unless explicitly selected/configured.

This may be an acceptable default, but it is not yet a complete policy. In hosted deployments it is plausible that control goes over gRPC and data still goes over WebSocket because the selectors disagree. In self-hosted deployments, setting one gRPC env var opts the daemon out of WebSocket instead of giving it an easy fallback.

Recommendation:

- Define an explicit operator policy: `websocket_baseline`, `h2_preferred`, `quic_preferred`, or similar.
- Make control and data selection use the same policy object.
- Add tests for both "WebSocket remains baseline" and "hosted prefers HTTP/2/QUIC when healthy."
- If "easy fallback to WebSocket" is a requirement, add daemon-side fallback from failed gRPC connect to `BUD_SERVER_URL`, or document that gRPC env vars intentionally select a different transport mode with no automatic fallback.

### 3. High: `stream_close.final_offset` is accepted without validating received bytes

`service/src/transport/data-plane-router.ts` handles `stream_close` by marking the runtime stream remote-closed, setting `receiveOffset = max(receiveOffset, final_offset)`, calling `onClose`, and transitioning durable `bud_stream.receive_offset` to the reported final offset.

There is no check that `final_offset` equals the number of bytes actually accepted for that stream. A daemon can close a file/proxy stream at a future offset and the service will record a clean close even if bytes are missing. A lower final offset can also make durable state disagree with runtime state.

Recommendation:

- Treat `stream_close.final_offset !== stream.receiveOffset` as a protocol error.
- Send `stream_reset` with `protocol_error` on mismatch.
- Transition the durable stream to `reset`, not `closed`.
- Add tests for exact, future, and stale final offsets.

### 4. High: file/proxy open can leave durable rows dangling when the selected carrier send throws

`openFileEdgeStream(...)` and `openProxyEdgeStream(...)` create `bud_operation` / `bud_stream` rows and register a runtime stream before sending `file_open` or `proxy_open`. They handle `sendDataPlaneControlFrame(...) === false`, but the send call itself is not wrapped in `try/catch`.

The selected transport can throw:

- WebSocket router calls `session.socket.send(encodeBudFrame(payload))` without catching encode/send errors.
- gRPC routers call `call.write(...)` and can throw or enter a backpressured state.

If this happens, the HTTP request can become a generic 500 and the durable operation/stream rows may remain in `offered` / `opening` with an active runtime registration until timeout or process cleanup.

Recommendation:

- Wrap the open-frame send in `try/catch` in both file and proxy edge paths.
- On exception, call the same cleanup path used for refused sends: unregister runtime, transition stream to `reset`, transition operation to `rejected` or `failed`, append audit, clear session `activeStreamId`, and return a deterministic `424 DATA_PLANE_UNAVAILABLE`.
- Add tests with a carrier that throws during open.

### 5. High: invalid accepted open results clean up memory but not durable state

If the daemon returns `accepted: true` without `status_code`, both file and proxy edge paths call `cleanup()` and return 502, but they do not send a remote reset, transition the stream, transition the operation, or append an audit event.

That leaves durable rows looking like an offered/opening stream even though the browser request failed and the runtime was removed.

Recommendation:

- Treat accepted-without-status as `protocol_error`.
- Send `stream_reset` to the daemon if possible.
- Transition stream to `reset` and operation to `failed` or `rejected`.
- Add a focused unit/integration test for each edge runtime.

### 6. High: handshake ack is sent before service-side session registration completes

Both WebSocket and gRPC send `hello_ack` before setting the connection state and before registering the durable session/tracker:

- `service/src/ws/bud-connection.ts`
- `service/src/grpc/control-gateway.ts`

The daemon sends its reconnect report immediately after the handshake path installs the transport sender:

- WebSocket: `bud/src/app.rs` calls `send_reconnect_report(...)` at the start of `run_session`.
- gRPC: `bud/src/app.rs` does the same at the start of `run_grpc_session`.

Because the service writes the ack before durable registration is complete, there is a small race where the daemon can send heartbeat/reconnect/data-plane frames before the service has finished attaching all trackers and durable session metadata. That can make early frames reconcile against missing session state or get ignored by carrier selection.

Recommendation:

- Move local state/tracker registration before sending `hello_ack`, or buffer inbound post-auth frames until registration is complete.
- Add a regression test that injects `reconnect_report` immediately after ack and asserts durable device/transport session ids are available.

### 7. High: legacy enrollment-token flow still creates ownerless buds

The older enrollment-token path still inserts `bud` rows without `created_by_user_id` in both WebSocket and gRPC gateways. That conflicts with the current authenticated ownership model and with browser-facing file/proxy routes that require owner-scoped Bud access.

The browser-mediated device claim flow stamps ownership, so this is probably legacy debt. Because the service is not externally live, the cleanest landing may be to remove or quarantine token enrollment instead of carrying ownerless devices forward.

Recommendation:

- Decide whether enrollment-token bootstrap is still supported.
- If unsupported, remove it from the active daemon/service path and docs.
- If retained for internal/dev use, make it impossible to create production-visible ownerless Bud rows, or add an explicit follow-up claim step before browser-visible routes can use the Bud.

### 8. Medium: protobuf is still a manual transitional bridge, not one generated schema end to end

The branch has a canonical `proto/bud/v1/bud.proto`, but active codecs are still a mix:

- `service/src/proto/wire.ts` manually encodes/decodes WebSocket binary frames.
- `bud/src/proto_wire.rs` manually encodes/decodes WebSocket binary frames.
- `service/src/grpc/envelope-codec.ts` sends typed oneof wrappers with `frame_json` bytes for gRPC.
- Many stream/proxy/file payloads in `proto/bud/v1/bud.proto` still retain `bytes frame_json = 99`.
- `docs/proto.md` already documents this as transitional.

This is understandable for the pivot, but it is technical debt. It means the schema is not yet the only source of truth and conformance depends on parallel hand-written codecs.

Recommendation:

- Keep this debt explicit in the landing review and specs.
- Add shared fixture coverage for every payload family before productizing that family.
- Plan a generated-code or single-codec strategy for WebSocket too, or narrowly document why manual wire codecs are intentionally retained.
- Remove `frame_json` from file/proxy/stream families before those become product-facing APIs.

### 9. Medium: JavaScript `uint64` protobuf fields are decoded into `number`

`proto/bud/v1/bud.proto` uses `uint64` for byte offsets, sizes, timeouts, and counters. The service decodes many of these into JavaScript `number`, and the gRPC proto loader is configured with `longs: Number`.

The current file limits and chunk sizes are likely below `Number.MAX_SAFE_INTEGER`, but long-lived terminal output offsets and future large file/proxy streams can eventually exceed safe integer semantics. This will matter more if the durable stream model becomes a long-running data plane.

Recommendation:

- Define which counters are guaranteed to remain below `2^53 - 1`.
- For unbounded byte offsets, use `bigint` internally or strings at the JSON boundary.
- Add validation that rejects unsafe integer offsets before persistence or stream accounting.

### 10. Medium: daemon file reads prebuffer the selected file/range

`bud/src/files/mod.rs` reads the selected file/range into a `Vec<u8>` before streaming chunks. The service allows file sessions up to 1 GiB, while the daemon default is 64 MiB when `max_bytes` is absent.

For a foundation smoke this is acceptable. For product use it is not a streaming file server yet; it is a bounded prebuffer followed by chunked transport.

Recommendation:

- Before file viewer productization, stream from `tokio::fs::File` in chunks under credit instead of allocating the full selected range.
- Keep a stricter WebSocket default cap until true streaming reads land.
- Add a negative smoke for large ranges and memory behavior.

### 11. Medium: backpressure behavior can drop, hang, or over-constrain traffic depending on carrier

Current carrier behavior differs:

- Service gRPC data/control send helpers wait for `drain` without also racing close/error, so a stream that closes while backpressured can leave a pending promise.
- `grpcDaemonTransportRouter` marks a session backpressured and returns `false` for subsequent sends until `drain`, effectively dropping new control frames during that interval.
- Daemon `TransportSender` uses `try_send` for required data-plane frames and returns an error if the local data queue is full or closed.
- Terminal output has a control fallback; file/proxy stream frames do not.

This is a reasonable first pass, but it is not a complete flow-control story. Under load, file/proxy streams can fail due to local queue pressure instead of applying backpressure, while control frames may be dropped by router policy.

Recommendation:

- Race `drain` waits against close/error/finalization.
- Decide which traffic classes may drop, block, reset, or fall back.
- Add tests that simulate sustained backpressure for terminal output, file reads, proxy response data, stream credit, and stream reset.

### 12. Medium: `unavailable` file/proxy sessions do not recover when the transport does

`createFileSession(...)` and `createProxySession(...)` persist `state: "unavailable"` when no suitable carrier exists at creation time. The edge routes later reject if the persisted state is `unavailable` even if `resolve*TransportStatus(...)` now reports an available carrier.

That may be intentional if "unavailable" means "this session was never actually granted." But the route response also reports current dynamic transport status, which suggests it is a transient carrier state. The product contract is ambiguous.

Recommendation:

- Decide whether `unavailable` is terminal session state or a cached transport snapshot.
- If transient, stop persisting it or auto-promote to `ready` when a carrier is available.
- If terminal, return a stronger create-time error instead of creating an unusable session.

### 13. Medium: WebSocket/gRPC gateway logic is duplicated and will drift

`service/src/ws/bud-connection.ts` and `service/src/grpc/control-gateway.ts` duplicate substantial logic:

- token enrollment
- challenge-response auth
- hello ack
- durable session registration
- heartbeat handling
- terminal status/output/result dispatch
- reconnect report handling
- file/proxy open result dispatch
- finalization/offline cleanup

Some duplication is expected because one path is Fastify WebSocket and one path is grpc-js, but too much policy now lives in two places. This is already visible in capability enforcement differences: the WebSocket path explicitly requires binary-envelope capability, while the gRPC path relies on the carrier shape and transitional `frame_json`.

Recommendation:

- Extract shared authenticated-daemon session policy into a transport-neutral controller.
- Leave only carrier I/O and framing in the WebSocket/gRPC adapters.
- Add parity tests that run the same auth/reconnect/open-result cases through both carriers.

### 14. Medium: file/proxy route tests cover auth shape but not real edge streaming behavior

The route tests for files and proxy currently cover:

- route registration
- unauthenticated rejection
- non-owner 404 before daemon work
- owned-session serialization

Those are useful, but they do not validate the risky branch behavior:

- selected carrier throws during open
- carrier returns `false`
- daemon rejects open
- daemon accepts without status
- open timeout
- revoked/expired session during stream
- final offset mismatch
- credit and chunk accounting
- WebSocket-only real-daemon smoke in CI or a documented manual gate

Recommendation:

- Add focused tests for each failure class before exposing file/proxy product UI.
- Add at least one integration-style test that exercises `open*EdgeStream` through a fake data-plane carrier.

### 15. Medium: optional HTTP/2 carrier maturity is hard to read from the docs

The gRPC code is useful, but the current repo makes it look closer to product parity than it is. It is opt-in at runtime, but checked-in docs, smoke scripts, spikes, and adapters span a lot of surface area.

Known gaps:

- gRPC payloads still use typed `frame_json`.
- gRPC fallback to WebSocket is not automatic.
- Carrier health scoring and demotion are not implemented.
- HTTP/2 failure fallback is called out in the QUIC design but not implemented.
- The WebSocket baseline and gRPC optional mode have different payload encoding maturity.

Recommendation:

- Keep gRPC docs explicit: optional adapter, not current correctness baseline.
- Move HTTP/2 parity and fallback checks into the follow-on optional-carrier checklist.
- Avoid shipping docs that imply HTTP/2 is required or production-ready.

### 16. Medium: observability is mostly audit rows and local logs, not operator-visible transport health

The branch adds valuable audit rows, and smoke scripts help local validation. It does not yet expose the carrier health/fallback story to operators or product code.

Examples:

- no health score per carrier
- no fallback/demotion reason API
- no metrics for selected carrier, refused sends, resets by reason, or backpressure
- plan checklists still mention fallback/degraded metrics as open

Recommendation:

- Add minimal counters/log fields before optional carriers are promoted: selected carrier, refused open, stream reset reason, final-offset mismatch, carrier closed while active, backpressure wait/drop.
- Make file/proxy route responses include enough transport status for support/debug without leaking internal topology.

### 17. Low: spike and reference artifacts are useful but should be marked non-product

The `spikes/grpc-interop/` tree and `reference/connect-vs-grpc-js.md` preserve valuable decision evidence. They also add a lot of checked-in code, lockfiles, and generated-like scaffolding that is not part of the product runtime.

Recommendation:

- Keep the spike only if the team wants reproducible interop evidence in the repo.
- If kept, make the root and spike specs explicit that it is not built, deployed, or imported by product packages.
- If clean branch size matters more, move the spike result into `reference/` and drop the runnable harness.

## Open Questions

- Should WebSocket always be the default carrier even in hosted deployments, or should hosted deployments prefer QUIC/HTTP/2 when healthy?
- Should gRPC control being configured disable WebSocket entirely, or should the daemon automatically fall back to `BUD_SERVER_URL`?
- Is enrollment-token daemon bootstrap still a supported path now that browser-mediated claim exists?
- Are file/proxy routes intended to merge as internal product foundations only, or are they intended to be callable by first-party clients immediately?
- Should file/proxy sessions created while offline exist in an `unavailable` state, or should creation fail until a carrier is ready?
- What is the exact WebSocket baseline cap for file bytes and proxy bytes before true streaming file reads and stronger transport metrics land?
- Should WebSocket binary framing continue to use hand-written codecs, or should all carriers use generated protobuf bindings?
- What is the timeline for removing remaining `frame_json` payloads from gRPC and stream/proxy/file families?

## Recommended Landing Gate

Already addressed by the docs cleanup in this branch:

- `plan/network-upgrade/` is marked superseded and retained only as historical context.
- `plan/swappable-transport/` now owns the active follow-up phases.

Fix before merge if the goal is a clean branch:

- Define and test the carrier selection/fallback policy.
- Validate `stream_close.final_offset` before recording a clean close.
- Harden file/proxy open send failure and invalid accepted-result cleanup.
- Close or explicitly accept the `hello_ack` before registration race.
- Remove or quarantine ownerless enrollment-token Bud creation.
- Add focused tests for the new failure paths above.

Accept as known follow-up debt:

- Generated protobuf/codegen strategy.
- Full removal of `frame_json`.
- QUIC carrier implementation.
- HTTP/2 automatic fallback and health scoring.
- True chunk-by-chunk daemon file reads.
- Product UI for file viewer and localhost web proxy.
- Broader operator metrics and carrier diagnostics.
