# transport

Transport-routing boundary for daemon-facing service traffic.

## Purpose

This folder is the Phase 0 service seam for moving daemon traffic away from direct WebSocket gateway dependencies. Runtime code should depend on `DaemonTransportRouter` rather than importing `ws/gateway` send helpers directly.

## Files

### `daemon-router.ts`

Defines the transport-neutral router interface:

- list active Bud IDs
- report Bud online state
- send a daemon payload
- report transport status and transport kind

### `composite-daemon-router.ts`

Phase 2 router composition used by runtime code.

- returns the union of active gRPC and WebSocket Bud ids
- treats a Bud as online if either transport has an active authoritative session
- sends outbound frames according to the explicit `DAEMON_TRANSPORT_POLICY` carrier order
- defaults to the WebSocket baseline and falls back across active authenticated carriers when a preferred router refuses or throws

### `carrier-policy.ts`

Explicit service-side carrier policy for daemon control and data-plane selection.

- default `websocket_baseline`: WebSocket first, then HTTP/2 fallbacks
- `h2_preferred`: HTTP/2 data/control first, then WebSocket fallback
- `quic_preferred`: future QUIC data first for data-plane selection, then HTTP/2/WebSocket fallback
- shared by the composite control router and data-plane selector so control/data choices do not drift

### `carrier-health.ts`

Lightweight optional-carrier health vocabulary used by data-plane selection.

- normalizes carrier health as `healthy`, `degraded`, or `unhealthy` with a bounded `0..100` score
- keeps current WebSocket and HTTP/2 sessions healthy by default unless a gateway/adaptor marks them otherwise
- lets future QUIC probes demote a low-score or unhealthy candidate without changing product routes
- serializes candidate health/reasons so file/proxy transport responses and audits can explain selected or skipped carriers

### `grpc-daemon-router.ts`

gRPC-backed adapter for active `BudControl.Connect` streams.

- owns the in-memory gRPC session tracker map
- sends outbound frames as typed `BudEnvelope` payloads with transitional `frame_json`
- reports transport status as `h2_grpc`
- applies process-local gateway drain blocking to long-lived work just like the WebSocket adapter
- tracks gRPC backpressure and refuses additional frames while a stream is still draining
- marks trackers as finalizing/finalized during gateway shutdown so router online checks stop treating draining control streams as usable

### `grpc-data-router.ts`

HTTP/2 data adapter for active `BudData.Attach` streams.

- keys data streams by `bud_id` and `device_session_id`
- records the subordinate `h2_data` transport session id and negotiated stream families
- records active terminal-output frame and byte counters for local validation and gateway close logs
- delegates generic runtime stream state to `data-plane-router.ts`
- exports write helpers that send generic `stream_*` frames only over active `h2_data`
- exposes helpers for registering, looking up, and deleting active data stream trackers
- deliberately does not implement browser-facing authorization; data streams are accepted only after `grpc/data-gateway.ts` binds them to an authenticated control tracker

### `data-plane-router.ts`

Carrier-neutral data-plane registry and runtime stream dispatcher.

- represents WebSocket control+data, HTTP/2 data, and future QUIC/data-only carriers behind `DataPlaneSessionTracker`
- selects carriers for stream families such as `file_read` and `localhost_http_proxy`
- applies explicit carrier policy order plus per-carrier health, demoting unhealthy or low-score preferred carriers to the next eligible candidate
- returns selected-carrier health, candidate summaries, and selection reasons so operators can see why WebSocket/H2/QUIC was chosen
- owns generic stream runtime state for stream ids, offsets, receive/send credits, close/reset flags, and per-stream callbacks
- counts active runtime streams per Bud/stream family for file/proxy concurrency enforcement
- caps accumulated outbound stream credit to the selected carrier's max in-flight byte limit
- dispatches `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` for both WebSocket and HTTP/2 paths
- validates `stream_close.final_offset` exactly against the runtime stream's accepted receive offset and resets on mismatch
- finalizes logical data-plane sessions when their underlying control transport closes
- records generic stream reset/close audit events with carrier metadata
- exposes carrier-neutral file/proxy readiness errors: `DATA_PLANE_UNAVAILABLE`, `STREAM_FAMILY_UNSUPPORTED`, and `TRANSPORT_DEGRADED`

### `data-plane-router.test.ts`

Focused unit coverage for data-plane selection, explicit carrier policy ordering, QUIC/H2/WebSocket health fallback, generic stream dispatch, credit capping, and final-offset mismatch resets.

### `composite-daemon-router.test.ts`

Focused unit coverage for control-router fallback when a preferred HTTP/2 carrier refuses or throws, and for normal unavailable behavior when no control carrier is online.

### `websocket-daemon-router.ts`

Current WebSocket-backed adapter for the router interface. It reuses the existing WebSocket session tracker and sends protobuf `BudEnvelope` binary frames to daemons that advertised `bud_envelope.websocket_binary`; sessions without binary-envelope support are refused rather than receiving JSON text fallback frames.

This adapter is the baseline carrier for Phase 0/1. Capable sessions now dispatch active terminal/control frames through typed protobuf oneof payload tags with direct payload fields. When a daemon advertises `bud_envelope.stream_frames`, the authenticated WebSocket is also registered as a control+data data-plane carrier for file/proxy stream frames.

During gateway drain, this adapter refuses new long-lived daemon work such as `terminal_ensure`, proxy-open, and file-open/read frames while still allowing short control traffic to continue.

### `gateway-drain.ts`

Process-local gateway drain state used by the current WebSocket router.

Exports:
- `startGatewayDrain(...)`
- `clearGatewayDrain()`
- `getGatewayDrainState()`
- `isGatewayDraining()`
- `shouldBlockNewDaemonWork(...)`

The drain state is deliberately small: it blocks new long-lived daemon streams on this gateway instance and lets transport close handling mark affected durable operation/stream rows `unknown` when a session is cut short.

## Dependencies

- [../ws/ws.spec.md](../ws/ws.spec.md) - current WebSocket gateway and session tracker
- [../runtime/runtime.spec.md](../runtime/runtime.spec.md) - terminal runtime that consumes the router
- [../proto/proto.spec.md](../proto/proto.spec.md) - transport-neutral envelope type helpers
- [../../../plan/swappable-transport/implementation-spec.md](../../../plan/swappable-transport/implementation-spec.md) - WebSocket-first swappable transport plan
- [../../../plan/swappable-transport/phase-8-optional-transport-upgrades.md](../../../plan/swappable-transport/phase-8-optional-transport-upgrades.md) - optional-carrier health/fallback validation and QUIC deferral

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace the remaining proxy/file open typed-payload `frame_json` bridge with field-level protobuf payload mapping as those WebSocket stream families are productized.
- Carrier health is currently process-local selection metadata. Add durable metrics/audit aggregation before using it for cross-instance hosted balancing.
- Add per-class fair scheduling and durable metrics once concurrent proxy/file data volumes require more than per-stream credit windows and per-Bud concurrency caps.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
