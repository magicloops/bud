# Phase 6: Optional Transport Upgrades

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft
**Priority**: Medium

---

## Objective

Keep HTTP/2 gRPC and future QUIC as carrier adapters behind the same protocol and product contracts.

This phase is intentionally after the WebSocket-first correctness work. Optional carriers should improve performance or hosted reliability without changing file viewer or web proxy behavior.

## HTTP/2 gRPC Position

Keep:

- `@grpc/grpc-js` service gateway
- Rust tonic daemon client
- existing interop spike evidence
- control/data adapter code where it continues to pass validation

Do not require:

- HTTP/2 support from self-hosted front doors
- gRPC to open file/proxy sessions
- product routes to know whether gRPC is enabled

## QUIC Position

Add QUIC later as a data-plane adapter when:

- WebSocket baseline file/proxy streams pass
- carrier-neutral stream lifecycle is stable
- hosted deployment shape is known
- token binding and session auth are designed

QUIC must carry the same logical frames:

- `BudEnvelope`
- `stream_data`
- `stream_credit`
- `stream_reset`
- `stream_close`
- file/proxy result frames where applicable

## Implementation Steps

1. Keep HTTP/2 gRPC carrier registration behind the carrier-neutral interfaces from Phase 1.
2. Add carrier preference policy:
   - baseline: WebSocket
   - hosted advanced: QUIC data if healthy
   - optional: HTTP/2 data/control if configured and healthy
3. Add health scoring and fallback tests for all configured carriers.
4. Add QUIC token-binding design before implementation.
5. Implement QUIC data adapter only after the design is approved.
6. Validate forced carrier failure:
   - QUIC unavailable falls back to WebSocket or HTTP/2 by policy
   - HTTP/2 unavailable does not break WebSocket baseline
   - WebSocket baseline unavailable reports offline/unavailable normally

## Acceptance Criteria

- [ ] Product routes do not branch on carrier type.
- [ ] HTTP/2 gRPC remains optional and adapter-backed.
- [ ] QUIC design requires no new file/proxy product payloads.
- [ ] Carrier failure tests prove fallback does not change product semantics.
- [ ] Operators can tell which carrier was selected and why.

## Validation

- Carrier-selection unit tests.
- Forced HTTP/2 failure with WebSocket baseline still passing file/proxy smokes.
- Forced QUIC failure once QUIC exists.
- Hosted deployment smoke only after front-door support is known.

## Specs To Update

- [ ] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [ ] [../../service/src/grpc/grpc.spec.md](../../service/src/grpc/grpc.spec.md)
- [ ] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [ ] [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md)
- [ ] [../../docs/proto.md](../../docs/proto.md)

## Non-Goals

- Removing WebSocket.
- Making QUIC required.
- Reintroducing transport-specific file/proxy product branches.
