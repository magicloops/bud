# grpc-interop

Self-contained Phase 1.5 spike for validating the daemon-gateway gRPC runtime choice before Bud's production HTTP/2 control plane is implemented.

## Purpose

This spike proves whether a Rust `tonic` daemon client can reliably maintain long-lived bidirectional native gRPC-over-HTTP/2 streams against Node daemon-gateway candidates. It includes both a Connect-ES server and a `@grpc/grpc-js` server with the same semantics.

The accepted Phase 1.5 result is `@grpc/grpc-js` for the Node daemon gateway. Connect-ES remains in the spike as a diagnostic/reference candidate.

The spike is intentionally not imported by the production `bud/` or `service/` packages.

## Files

- [README.md](./README.md) - runbook, matrix, commands, and decision-record template.
- [package.json](./package.json) - Node dependencies and scripts for Buf generation plus Connect/grpc-js servers.
- [tsconfig.json](./tsconfig.json) - TypeScript config for the spike Node server code.
- [buf.yaml](./buf.yaml) - Buf module and lint config for the spike schema.
- [buf.gen.yaml](./buf.gen.yaml) - Buf generation template for protobuf-es TypeScript output.
- [.gitignore](./.gitignore) - local generated/dependency artifacts ignored by the spike.

## Subfolders

- [proto/](./proto/proto.spec.md) - interop-only protobuf schema.
- [service/](./service/service.spec.md) - Node gateway candidate servers.
- [daemon/](./daemon/daemon.spec.md) - Rust tonic client harness.

## Dependencies

- [../../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md](../../plan/network-upgrade/phase-1.5-grpc-stack-interop-validation.md) - owning implementation phase.
- [../../reference/connect-vs-grpc-js.md](../../reference/connect-vs-grpc-js.md) - runtime decision note that defines the required interop matrix.

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Add a separate abrupt client-cancellation churn stress test if Phase 2 needs to validate repeated non-clean stream teardown.

---

*Referenced by: [../spikes.spec.md](../spikes.spec.md)*
