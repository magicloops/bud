# proto

Protocol-level TypeScript helpers for the daemon-network upgrade.

## Purpose

This folder defines service-owned types and the current in-repo protobuf wire codec for the transport-independent Bud protocol envelope.

## Files

### `envelope.ts`

Defines the Phase 0 envelope constants and TypeScript types:

- `BUD_ENVELOPE_VERSION`
- `TrafficClass`
- `TransportKind`
- `StreamType`
- `BudError`
- `BudEnvelope`
- small runtime guards for traffic classes, transport kinds, and envelope-shaped values

These helpers are intentionally transport-neutral. Active WebSocket daemon sessions now require binary `BudEnvelope` capability and carry terminal/control frames as direct typed protobuf payload fields; legacy JSON support is retained only for pre-negotiation error handling, fixtures, and conformance tests.

### `wire.ts`

Small protobuf wire encoder/decoder for the `BudEnvelope` WebSocket compatibility carrier.

Exports:
- `makeLegacyJsonEnvelope(...)`
- `encodeBudEnvelope(...)`
- `decodeBudEnvelope(...)`
- `decodeBudEnvelopePayloadCase(...)`
- `decodeBudEnvelopePayloadEncoding(...)`
- `UnsupportedBudEnvelopePayloadError`
- `encodeBudFrame(...)`
- `decodeBudFrame(...)`
- `encodeLegacyJsonFrame(...)`
- `decodeLegacyJsonFrame(...)`

The shared schema is [../../../proto/bud/v1/bud.proto](../../../proto/bud/v1/bud.proto). It defines the Phase 2 `BudControl.Connect` bidirectional gRPC stream plus the transport-independent `BudEnvelope`. Active WebSocket terminal/control frame types dispatch through typed oneof payload fields such as `terminal_ensure`, `terminal_output`, `reconnect_report`, and `reconciliation_decision`, and those payloads now encode direct protobuf fields instead of whole-frame `frame_json`. Core data-plane lifecycle payloads (`data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, `stream_close`) also use direct protobuf fields on the WebSocket BudEnvelope carrier. Unknown top-level payload oneof fields in the reserved payload range throw `UnsupportedBudEnvelopePayloadError`, allowing the WebSocket gateway to send a typed `UNSUPPORTED_PAYLOAD` error. Proxy/file open payloads and the grpc-js adapter still dispatch through typed payload tags with transitional `frame_json` until generated bindings replace the compatibility bridge. `LegacyJsonPayload` remains decode-compatible and can still be forced in conformance tests, but it is not part of active WebSocket daemon sessions.

### `wire.test.ts`

Conformance coverage against [../../../proto/fixtures/legacy-terminal-ensure.json](../../../proto/fixtures/legacy-terminal-ensure.json), shared with the Rust daemon tests, plus assertions that terminal/control and core data-plane lifecycle frames use typed fields rather than nested `frame_json`, unsafe `uint64` values are rejected before JS rounding, and unknown payload fields fail with typed unsupported-payload behavior.

## Dependencies

- [../../../plan/swappable-transport/implementation-spec.md](../../../plan/swappable-transport/implementation-spec.md) - current swappable-transport plan
- [../../../docs/proto.md](../../../docs/proto.md) - current wire protocol documentation

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace the in-repo compatibility wire codec with generated protobuf types after the HTTP/2 gRPC stack choice is validated.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
