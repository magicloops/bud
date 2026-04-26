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
- Add HTTP/2 gRPC control and HTTP/2 data router implementations in later network-upgrade phases.
- Replace the transitional typed-payload `frame_json` bridge with generated field-level protobuf payload mapping once current terminal/control payloads are fully mapped.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
