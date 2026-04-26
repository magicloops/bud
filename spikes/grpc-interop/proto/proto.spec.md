# proto

Interop-only protobuf schema for the Phase 1.5 gRPC runtime spike.

## Purpose

This folder defines the minimal service and message shapes needed to test native gRPC-over-HTTP/2 semantics between a Rust `tonic` client and Node gateway candidates. It models Bud-like control and attach streams without importing production protocol code.

## Files

No direct schema files live at this level.

## Subfolders

- [bud/](./bud/bud.spec.md) - Bud-owned interop protobuf packages.

## Dependencies

- [../buf.yaml](../buf.yaml) - Buf module and lint configuration.
- [../buf.gen.yaml](../buf.gen.yaml) - TypeScript generation template.
- [../service/src/src.spec.md](../service/src/src.spec.md) - Node handlers consume generated TypeScript descriptors.
- [../daemon/daemon.spec.md](../daemon/daemon.spec.md) - Rust crate generates tonic clients from this schema at build time.

## TODOs / Technical Debt

None.

---

*Referenced by: [../grpc-interop.spec.md](../grpc-interop.spec.md)*
