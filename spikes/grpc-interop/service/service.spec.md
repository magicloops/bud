# service

Node daemon-gateway candidate servers for the gRPC interop spike.

## Purpose

This folder hosts spike-only Node service code that exposes the same protobuf services through both Connect Node and `@grpc/grpc-js`. The implementations intentionally share protocol behavior so differences observed by the Rust tonic harness are attributable to runtime stack behavior rather than product logic.

## Files

No direct source files live in this folder. Runtime TypeScript files are under [src/](./src/src.spec.md).

## Subfolders

- [src/](./src/src.spec.md) - Connect server, grpc-js server, and local async queue helper.

## Dependencies

- [../package.json](../package.json) - Node dependencies and scripts.
- [../proto/proto.spec.md](../proto/proto.spec.md) - source protobuf schema.
- [../buf.gen.yaml](../buf.gen.yaml) - generation target for `service/src/gen/`.

## TODOs / Technical Debt

None.

---

*Referenced by: [../grpc-interop.spec.md](../grpc-interop.spec.md)*
