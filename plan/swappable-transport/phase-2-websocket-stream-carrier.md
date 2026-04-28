# Phase 2: WebSocket Stream Carrier

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Priority**: Urgent

---

## Objective

Make the authenticated daemon WebSocket a first-class data-plane carrier for protobuf stream frames.

Phase 0 should already have proven the existing terminal/control path over binary `BudEnvelope`. This phase extends that baseline from terminal/control traffic to generic stream frames needed by future file/proxy work.

## Current Problem

WebSocket binary envelope compatibility exists, but dispatch only handles the existing control/terminal frame families. It does not yet route the generic stream lifecycle frames needed by file/proxy streams on both sides:

- `stream_data`
- `stream_credit`
- `stream_reset`
- `stream_close`
- `proxy_open_result`
- `file_open_result`

The daemon can send outbound stream frames through its WebSocket `TransportSender`, but the default WebSocket receive path still needs to understand `stream_credit`, `stream_reset`, `stream_close`, and unsupported inbound `stream_data` consistently with the HTTP/2 data reader. The service also needs to register the default WebSocket as a carrier and dispatch inbound lifecycle/result frames into the shared runtime.

## Target Behavior

When a daemon authenticates over `/ws` and advertises binary envelope stream support:

- the default connection registers as a control+data WebSocket carrier
- the carrier model also supports an optional future data-only WebSocket
- stream families are derived from daemon capabilities
- inbound stream frames enter the shared data-plane runtime
- outbound stream frames use the same send path as normal WebSocket envelope frames
- disconnect/drain closes or degrades the logical data-plane session
- the daemon advertises `bud_envelope.stream_frames` only when the active transport mode can actually carry stream frames
- daemon WebSocket receive handling applies credits/resets/closes to file/proxy managers just like the HTTP/2 data reader

## Implementation Steps

1. Extend WebSocket hello/capability parsing with explicit stream-frame support.
2. Register the default WebSocket `transport_session` with control+data roles after authentication.
3. Keep the registry shape compatible with a future dedicated data-only WebSocket.
4. Add WebSocket data-plane adapter methods:
   - send data frame
   - record send outcome
   - close/finalize
   - expose limits
5. Extend inbound WebSocket dispatch for:
   - `stream_data`
   - `stream_credit`
   - `stream_reset`
   - `stream_close`
   - `proxy_open_result`
   - `file_open_result`
6. Ensure dispatch goes through shared runtime handlers used by HTTP/2 data.
7. Extend daemon WebSocket receive handling for stream lifecycle frames:
   - apply `stream_credit` to proxy/file managers
   - apply `stream_reset` to proxy/file managers
   - log `stream_close`
   - reject unsupported inbound `stream_data` with `stream_reset`
8. Preserve the Phase 0 terminal-over-envelope behavior.
9. Add real-daemon stream-carrier validation with all gRPC env vars unset.

## Acceptance Criteria

- [x] A WebSocket-only daemon can register as a control+data carrier.
- [x] The carrier registry can represent a future data-only WebSocket.
- [x] WebSocket inbound stream frames reach the shared runtime registry.
- [x] WebSocket disconnect finalizes the logical data-plane session.
- [x] The daemon handles service-to-daemon WebSocket stream lifecycle frames.
- [x] Terminal traffic still works with binary envelopes over WebSocket after stream-carrier registration.
- [x] Stream-carrier validation passes with `BUD_GRPC_CONTROL_URL` and any gRPC data URL unset.

## Validation

- Unit tests for WebSocket stream-frame dispatch passed in `src/ws/bud-connection.test.ts`.
- Real-daemon WebSocket terminal smoke passed through `pnpm --dir /Users/adam/bud/service smoke:ws-terminal` after rerunning outside the sandbox for tsx IPC permissions:
  - service with gRPC disabled
  - daemon connected only through WebSocket
  - terminal ensure/send/output path succeeded
  - daemon advertised `bud_envelope.stream_frames: true`
  - active transport was `websocket`, with no active `h2_grpc` or `h2_data`
- Durable `transport_session` rows still use `transport_kind = "websocket"` for the default control+data carrier.

## Specs To Update

- [x] [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md)
- [x] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [x] [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md)

## Decisions

- Start with one physical WebSocket by default.
- Model that socket as control+data capable.
- Leave the registry and selector open for an optional future data-only WebSocket.
- Use the existing gRPC data chunk and initial-credit settings for the first WebSocket carrier pass. Rename or split those config keys in a later cleanup if the values need to diverge by carrier.
