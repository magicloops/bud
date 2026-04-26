# spikes

Experimental implementation spikes that validate architectural choices before they are folded into the production Bud daemon or service.

## Purpose

This folder keeps risky or comparison-oriented work isolated from production packages. Spikes should be reproducible, documented, and tied back to a plan or review document that explains the decision they support.

## Subfolders

- [grpc-interop/](./grpc-interop/grpc-interop.spec.md) - Phase 1.5 network-upgrade harness for validating Rust `tonic` interoperability against Node Connect native gRPC over HTTP/2 and a `@grpc/grpc-js` comparison server.

## Dependencies

- [../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md](../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md) - owning plan phase for the current gRPC interop spike.
- [../bud.spec.md](../bud.spec.md) - root architecture spec and documentation catalog.

## TODOs / Technical Debt

None.

---

*Referenced by: [../bud.spec.md](../bud.spec.md)*
