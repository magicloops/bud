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

These helpers are intentionally transport-neutral. Current WebSocket compatibility still accepts legacy JSON frames, but capable daemon sessions now carry JSON-shaped frame bodies inside typed protobuf `BudEnvelope` payloads.

### `wire.ts`

Small protobuf wire encoder/decoder for the `BudEnvelope` WebSocket compatibility carrier.

Exports:
- `makeLegacyJsonEnvelope(...)`
- `encodeBudEnvelope(...)`
- `decodeBudEnvelope(...)`
- `decodeBudEnvelopePayloadCase(...)`
- `encodeLegacyJsonFrame(...)`
- `decodeLegacyJsonFrame(...)`

The shared schema is [../../../proto/bud/v1/bud.proto](../../../proto/bud/v1/bud.proto). It now defines the Phase 2 `BudControl.Connect` bidirectional gRPC stream plus the transport-independent `BudEnvelope`. Known frame types dispatch through typed oneof payload fields such as `terminal_ensure`, `terminal_output`, `reconnect_report`, `reconciliation_decision`, the Phase 4 generic stream frames, Phase 4.2 `proxy_open` / `proxy_open_result`, and Phase 4.4 `file_open` / `file_open_result`. During this transition each typed payload also carries `frame_json` so the existing JSON-shaped handlers remain reusable. `LegacyJsonPayload` remains decode-compatible and can still be forced in conformance tests.

### `wire.test.ts`

Conformance coverage against [../../../proto/fixtures/legacy-terminal-ensure.json](../../../proto/fixtures/legacy-terminal-ensure.json), shared with the Rust daemon tests.

## Dependencies

- [../../../plan/network-upgrade/implementation-spec.md](../../../plan/network-upgrade/implementation-spec.md) - phased network-upgrade plan
- [../../../docs/proto.md](../../../docs/proto.md) - current wire protocol documentation

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Replace the in-repo compatibility wire codec with generated protobuf types after the HTTP/2 gRPC stack choice is validated.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
