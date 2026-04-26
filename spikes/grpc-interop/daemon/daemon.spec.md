# daemon

Rust tonic client harness for the gRPC interop spike.

## Purpose

This crate exercises the Node gateway candidates from the daemon side using `tonic` and generated Rust protobuf clients. It is intentionally separate from the production Bud daemon crate so transport-runtime decisions can be validated without touching production CLI or terminal code.

## Files

- [Cargo.toml](./Cargo.toml) - Rust crate manifest and tonic/prost dependencies.
- [build.rs](./build.rs) - build-time protobuf generation from the shared spike schema.

## Subfolders

- [src/](./src/src.spec.md) - executable tonic client harness.

## Dependencies

- [../proto/bud/interop/v1/interop.proto](../proto/bud/interop/v1/interop.proto) - source schema compiled by `tonic-prost-build`.
- Node server candidates under [../service/](../service/service.spec.md).

## TODOs / Technical Debt

None.

---

*Referenced by: [../grpc-interop.spec.md](../grpc-interop.spec.md)*
