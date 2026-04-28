# Phase 1: Carrier-Neutral Data-Plane Runtime

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Priority**: Urgent

---

## Objective

Refactor the service data-plane runtime so file/proxy stream code depends on carrier-neutral concepts instead of `GrpcData*` names and `h2_data` availability.

Phase 0 owns the existing terminal/control `BudEnvelope` payload cutover. This phase assumes that terminal-over-envelope works and focuses on the data-plane runtime needed for file/proxy streams and optional second data carriers.

## Current Problem

The runtime concepts are mostly useful, but they are named and selected as HTTP/2 gRPC data:

- `GrpcDataSessionTracker`
- `grpcDataSessions`
- `registerGrpcDataRuntimeStream`
- `sendGrpcDataFrame`
- `getActiveGrpcDataSessionTracker`
- `GRPC_DATA_UNAVAILABLE`

As long as these concepts are gRPC-specific, WebSocket remains a special case and file/proxy routes cannot become WebSocket-first.

There are two important clarifications from the Phase 0 review:

- File/proxy edge code must stop sending `file_open` and `proxy_open` through the gRPC control router directly. The control frame must be sent through the control side associated with the selected carrier, which is the authenticated WebSocket for the default WebSocket carrier and gRPC control for the HTTP/2 data carrier.
- The shared runtime is not just a selector rename. Stream lifecycle handlers for `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` need to be carrier-neutral so both HTTP/2 and WebSocket dispatch paths use the same validation, credit, callback, and durable-state code.

## Target Model

Introduce service runtime concepts such as:

- `DataPlaneSessionTracker`
- `DataPlaneRuntimeStream`
- `registerDataPlaneRuntimeStream(...)`
- `sendDataPlaneFrame(...)`
- `getActiveDataPlaneSessionForBud(...)`
- `selectDataPlaneCarrier(...)`

The selected carrier should expose:

- `transport_kind`
- carrier roles: control, data, or control+data
- `device_session_id`
- `transport_session_id`
- `control_transport_session_id`
- `data_transport_session_id`
- supported stream families
- max frame bytes
- max in-flight bytes
- current drain/degraded state

## Implementation Steps

1. Add carrier-neutral types around the existing gRPC data tracker.
2. Preserve the existing HTTP/2 data implementation behind an adapter.
3. Model one default WebSocket as control+data capable, while permitting a future data-only WebSocket.
4. Extract shared generic stream lifecycle handlers from the HTTP/2 data gateway into the carrier runtime.
5. Replace file/proxy route readiness checks with a data-plane selector.
6. Replace public `GRPC_CONTROL_UNAVAILABLE` and `GRPC_DATA_UNAVAILABLE` errors in file/proxy paths with carrier-neutral errors:
   - `DATA_PLANE_UNAVAILABLE`
   - `STREAM_FAMILY_UNSUPPORTED`
   - `TRANSPORT_DEGRADED`
7. Keep durable `transport_session.transport_kind` values intact.
8. Make stream-family support explicit for:
   - `file_read`
   - `localhost_http_proxy`
9. Send `file_open` and `proxy_open` over the selected carrier's control route instead of hard-coding gRPC control.
10. Add focused unit tests for selector behavior:
   - no carrier
   - WebSocket carrier only
   - WebSocket control+data carrier
   - optional WebSocket data-only carrier
   - HTTP/2 carrier only
   - both carriers, with policy preference
   - carrier present but stream family unsupported

## Acceptance Criteria

- [x] File/proxy code no longer imports gRPC data trackers directly.
- [x] Existing HTTP/2 data behavior still works through the carrier-neutral adapter.
- [x] Carrier selection can return WebSocket once Phase 2 registers it.
- [x] Carrier selection can distinguish control+data from data-only without product-route branches.
- [x] File/proxy readiness errors are carrier-neutral.
- [x] File/proxy open control frames use the selected carrier route.
- [x] HTTP/2 and WebSocket stream lifecycle dispatch use the same carrier-neutral handlers.
- [x] Tests cover carrier selection and unavailable/unsupported cases.

## Validation

- Targeted service unit tests passed:
  - `src/transport/data-plane-router.test.ts`
  - `src/transport/grpc-data-router.test.ts`
  - `src/grpc/data-gateway.test.ts`
  - `src/files/file-session.test.ts`
  - `src/proxy/proxy-session.test.ts`
  - `src/ws/bud-connection.test.ts`
- `pnpm --dir /Users/adam/bud/service build` passed.
- `rg "GrpcData|GRPC_DATA_UNAVAILABLE" service/src/files service/src/proxy service/src/transport service/src/runtime` only finds adapter/test compatibility names.

## Specs To Update

- [x] [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md)
- [x] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [x] [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [x] [../../service/src/proxy/proxy.spec.md](../../service/src/proxy/proxy.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md) if error codes or stream-family names change

## Non-Goals

- Full removal of HTTP/2 gRPC code.
- Field-level protobuf payload dispatch beyond the terminal/control cutover handled in Phase 0.
- QUIC implementation.
