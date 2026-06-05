# grpc

HTTP/2 gRPC daemon-gateway implementation for the network-upgrade control and data planes.

## Purpose

This folder keeps grpc-js/proto-loader details isolated from the rest of the service. Runtime, route, and DB code continue to speak JSON-shaped daemon frames through the transport router while this layer adapts those frames to `BudEnvelope` messages on `BudControl.Connect` and the opt-in `BudData.Attach` bidirectional stream.

HTTP/2 remains an optional carrier adapter. The WebSocket baseline stays correct when gRPC is disabled or unhealthy, and carrier policy/health in [../transport/transport.spec.md](../transport/transport.spec.md) decides when these streams are preferred or demoted.

## Files

### `control-gateway.ts`

Opt-in grpc-js server for daemon control streams.

- loads [../../../proto/bud/v1/bud.proto](../../../proto/bud/v1/bud.proto) with `@grpc/proto-loader`
- exposes `bud.v1.BudControl.Connect`
- authenticates daemon `hello` / `hello_proof` traffic with the device-secret challenge flow and the dev-only `DEV_BUD_TOKEN_BYPASS` token path
- registers durable `device_session` and `transport_session` rows with `transport_kind = "h2_grpc"`
- registers durable/session trackers before sending `hello_ack`, so post-auth frames cannot arrive before the service can route them
- handles heartbeat, reconnect reconciliation, and terminal result/status/output frames, including optional terminal result `host_cwd` persistence
- handles daemon `proxy_open_result`, `file_open_result`, `file_resolve_result`, and `local_llm_open_result` frames and delivers them to the proxy/file/local-LLM runtime bridges
- records Bud online/offline transitions through the same terminal manager side effects used by WebSocket
- starts process-local gateway drain and ends active gRPC streams during service shutdown, with a short force-shutdown fallback
- explicitly finalizes active gRPC trackers during gateway shutdown so durable `device_session` / `transport_session` rows close before DB pools stop
- configures grpc-js message-size and HTTP/2 tuning knobs from `config.ts`

The implementation deliberately keeps `@grpc/grpc-js` stream objects inside this module and `transport/grpc-daemon-router.ts`.

### `data-gateway.ts`

Opt-in grpc-js server for daemon data streams.

- loads [../../../proto/bud/v1/bud.proto](../../../proto/bud/v1/bud.proto) with `@grpc/proto-loader`
- exposes `bud.v1.BudData.Attach`
- requires the first inbound frame to be `data_attach`
- binds the data stream to the active authenticated `BudControl.Connect` tracker using `bud_id` and `device_session_id`
- registers a subordinate durable `transport_session` row with `transport_kind = "h2_data"`
- currently accepts negotiated `terminal_output` frames and forwards them to `TerminalSessionManager.handleTerminalOutput(...)`
- enforces the configured terminal-output data chunk limit before storing output
- closes the data transport row on data-stream shutdown
- finalizes subordinate data streams when the owning control tracker closes, drains, times out, or is superseded
- resets registered runtime streams during data-session finalization so active proxy/file/local-LLM callers do not hang on transport loss
- records active data frame and byte counters for smoke assertions and close-log context
- handles Phase 4.0 generic `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` frames for registered runtime streams
- enforces generic stream offset, chunk-size, and credit windows before acknowledging consumed bytes
- invokes registered runtime-stream callbacks so proxy/file/local-LLM callers can consume bytes, observe resets, and close HTTP responses before credit is re-granted
- rejects mismatched `stream_close.final_offset` values through the shared data-plane runtime instead of promoting them to clean close

### `data-gateway.test.ts`

Focused unit coverage for data-attach parsing, generic stream-data parsing, active-control binding checks, and control-owned data session finalization.

### `envelope-codec.ts`

Adapter between proto-loader message objects and the service's existing JSON-shaped frame handlers.

- encodes outbound daemon frames as typed `BudEnvelope` oneof payloads carrying transitional `frame_json`, including Phase 5 `proxy_ws_*` payload tags
- decodes inbound `LegacyJsonPayload` or typed `frame_json` payloads back to `Record<string, unknown>`
- stamps gRPC transport metadata as `TRANSPORT_KIND_H2_GRPC` or `TRANSPORT_KIND_H2_DATA`
- remains the bounded gRPC proto-loader compatibility bridge while WebSocket binary frames move active terminal/control and core stream lifecycle payloads to direct protobuf fields; file resolve frames are mapped through typed payload tags with transitional `frame_json`

### `envelope-codec.test.ts`

Unit coverage for the proto-loader object adapter and typed-payload compatibility bridge.

### `control-gateway.test.ts`

Focused unit coverage for gRPC tracker finalization during service shutdown.

## Dependencies

- [../transport/transport.spec.md](../transport/transport.spec.md) - daemon transport routing boundary
- [../ws/ws.spec.md](../ws/ws.spec.md) - shared frame schemas and legacy auth flow
- [../runtime/runtime.spec.md](../runtime/runtime.spec.md) - durable daemon session and terminal runtime state
- [../../../docs/proto.md](../../../docs/proto.md) - protocol documentation
- [../../../plan/swappable-transport/implementation-spec.md](../../../plan/swappable-transport/implementation-spec.md) - active swappable-transport implementation spec
- [../../../plan/swappable-transport/phase-6-landing-correctness-and-fallback-policy.md](../../../plan/swappable-transport/phase-6-landing-correctness-and-fallback-policy.md) - landing correctness and fallback policy
- [../../../plan/swappable-transport/phase-8-optional-transport-upgrades.md](../../../plan/swappable-transport/phase-8-optional-transport-upgrades.md) - optional-carrier parity, health, and fallback expectations

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace proto-loader dynamic objects with Buf-managed generated TypeScript bindings if the adapter becomes noisy or unsafe.
- Move from the shared-secret transition credential to the planned device keypair challenge before exposing proxy/file capabilities.
- Add richer per-stream scheduler/fairness metrics once multiple high-volume proxy/file streams are common.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
