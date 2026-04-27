# grpc

HTTP/2 gRPC daemon-gateway implementation for the network-upgrade control plane.

## Purpose

This folder keeps grpc-js/proto-loader details isolated from the rest of the service. Runtime, route, and DB code continue to speak JSON-shaped daemon frames through the transport router while this layer adapts those frames to `BudEnvelope` messages on the `BudControl.Connect` bidirectional stream.

## Files

### `control-gateway.ts`

Opt-in grpc-js server for daemon control streams.

- loads [../../../proto/bud/v1/bud.proto](../../../proto/bud/v1/bud.proto) with `@grpc/proto-loader`
- exposes `bud.v1.BudControl.Connect`
- authenticates daemon `hello` / `hello_proof` traffic with the existing enrollment-token and device-secret challenge flow
- registers durable `device_session` and `transport_session` rows with `transport_kind = "h2_grpc"`
- handles heartbeat, reconnect reconciliation, and terminal result/status/output frames
- records Bud online/offline transitions through the same terminal manager side effects used by WebSocket
- starts process-local gateway drain and ends active gRPC streams during service shutdown, with a short force-shutdown fallback
- explicitly finalizes active gRPC trackers during gateway shutdown so durable `device_session` / `transport_session` rows close before DB pools stop
- configures grpc-js message-size and HTTP/2 tuning knobs from `config.ts`

The implementation deliberately keeps `@grpc/grpc-js` stream objects inside this module and `transport/grpc-daemon-router.ts`.

### `envelope-codec.ts`

Adapter between proto-loader message objects and the service's existing JSON-shaped frame handlers.

- encodes outbound daemon frames as typed `BudEnvelope` oneof payloads carrying transitional `frame_json`
- decodes inbound `LegacyJsonPayload` or typed `frame_json` payloads back to `Record<string, unknown>`
- stamps gRPC transport metadata as `TRANSPORT_KIND_H2_GRPC`

### `envelope-codec.test.ts`

Unit coverage for the proto-loader object adapter and typed-payload compatibility bridge.

### `control-gateway.test.ts`

Focused unit coverage for gRPC tracker finalization during service shutdown.

## Dependencies

- [../transport/transport.spec.md](../transport/transport.spec.md) - daemon transport routing boundary
- [../ws/ws.spec.md](../ws/ws.spec.md) - shared frame schemas and legacy auth flow
- [../runtime/runtime.spec.md](../runtime/runtime.spec.md) - durable daemon session and terminal runtime state
- [../../../docs/proto.md](../../../docs/proto.md) - protocol documentation
- [../../../plan/network-upgrade/phase-2-http2-grpc-control-plane.md](../../../plan/network-upgrade/phase-2-http2-grpc-control-plane.md) - implementation phase spec

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace proto-loader dynamic objects with Buf-managed generated TypeScript bindings if the adapter becomes noisy or unsafe.
- Move from the shared-secret transition credential to the planned device keypair challenge before exposing proxy/file capabilities.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
