# proto

Shared protocol schema and conformance fixtures for Bud daemon-service networking.

## Purpose

This folder owns the transport-independent protobuf contract that service and daemon implementations share while the codebase migrates away from WebSocket JSON as the canonical protocol.

## Subfolders

### `bud/` -> [bud/bud.spec.md](./bud/bud.spec.md)

Bud protocol namespace.

### `fixtures/`

Checked-in conformance fixtures used by both service and daemon tests.

## Dependencies

- [../docs/proto.md](../docs/proto.md) - human-readable protocol documentation
- [../plan/swappable-transport/implementation-spec.md](../plan/swappable-transport/implementation-spec.md) - current swappable-transport implementation plan

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
