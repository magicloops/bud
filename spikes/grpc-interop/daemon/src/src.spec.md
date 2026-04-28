# src

Executable Rust tonic client harness for Phase 1.5 gRPC runtime validation.

## Purpose

The harness opens Bud-like control and attach streams against the Node candidate gateway. Subcommands cover the interop matrix items that matter before selecting Connect Node or `@grpc/grpc-js` for the production daemon gateway, including metadata echo, status metadata, max-message errors, attach-style proxy/file chunks, churn, and reconnect under attach load.

## Files

- [main.rs](./main.rs) - generated-client imports, command dispatch, control-stream tests, metadata/status/max-message checks, cancellation/deadline/drain tests, clean open/close stream churn, attach concurrency, proxy/file attach-shape validation, and reconnect-under-load exercise.

## Dependencies

- `tonic` / `prost` generated clients from [../../proto/bud/interop/v1/interop.proto](../../proto/bud/interop/v1/interop.proto).
- Node candidate servers under [../../service/src/](../../service/src/src.spec.md).

## TODOs / Technical Debt

None.

---

*Referenced by: [../daemon.spec.md](../daemon.spec.md)*
