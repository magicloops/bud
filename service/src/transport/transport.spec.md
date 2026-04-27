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
- prefers `h2_grpc` for outbound frames when a gRPC control stream is active
- falls back to WebSocket for compatibility daemons

### `grpc-daemon-router.ts`

gRPC-backed adapter for active `BudControl.Connect` streams.

- owns the in-memory gRPC session tracker map
- sends outbound frames as typed `BudEnvelope` payloads with transitional `frame_json`
- reports transport status as `h2_grpc`
- applies process-local gateway drain blocking to long-lived work just like the WebSocket adapter
- tracks gRPC backpressure and refuses additional frames while a stream is still draining
- marks trackers as finalizing/finalized during gateway shutdown so router online checks stop treating draining control streams as usable

### `grpc-data-router.ts`

Process-local tracker map for active `BudData.Attach` streams.

- keys data streams by `bud_id` and `device_session_id`
- records the subordinate `h2_data` transport session id and negotiated stream families
- records active terminal-output frame and byte counters for local validation and gateway close logs
- owns Phase 4.0 runtime stream state for generic proxy/file stream ids, offsets, receive credits, send credits, and close/reset flags
- lets callers register per-stream data/reset/close callbacks for active HTTP proxy/file consumers
- exports write helpers that send generic `stream_*` frames only over active `h2_data`
- exposes helpers for registering, looking up, and deleting active data stream trackers
- deliberately does not implement browser-facing authorization; data streams are accepted only after `grpc/data-gateway.ts` binds them to an authenticated control tracker

### `websocket-daemon-router.ts`

Current WebSocket-backed adapter for the router interface. It reuses the existing WebSocket session tracker and sends protobuf `BudEnvelope` binary frames to daemons that advertised `bud_envelope.websocket_binary`; legacy sessions still receive JSON text frames.

This adapter is the compatibility carrier for Phase 0/1. Capable sessions now dispatch known frames through typed protobuf oneof payload tags while preserving the current JSON-shaped frame body under each typed payload's `frame_json` transition field.

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
- [../../../plan/network-upgrade/implementation-spec.md](../../../plan/network-upgrade/implementation-spec.md) - phased network-upgrade plan

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace the transitional typed-payload `frame_json` bridge with generated field-level protobuf payload mapping once current terminal/control payloads are fully mapped.
- Add per-class fair scheduling and durable metrics once concurrent proxy/file data volumes require more than per-stream credit windows.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
