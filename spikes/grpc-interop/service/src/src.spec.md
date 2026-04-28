# src

TypeScript source for the Node gRPC interop candidate servers.

## Purpose

The handlers in this folder model the long-lived Bud daemon control stream and attach-style data stream used by the Phase 1.5 validation matrix. They are intentionally small and deterministic so cancellation, deadlines, metadata, drain, and backpressure can be compared between Connect Node and `@grpc/grpc-js`.

## Files

- [async-queue.ts](./async-queue.ts) - minimal async iterable queue used by the Connect streaming handler to decouple request reads from response writes.
- [connect-server.ts](./connect-server.ts) - Connect Node server over native HTTP/2 for the primary runtime candidate; exposes diagnostic deadline modes for validating tonic deadline behavior.
- [grpc-js-server.ts](./grpc-js-server.ts) - `@grpc/grpc-js` server for comparison if Connect behavior is ambiguous or failing; exposes env-configurable HTTP/2/channel options for churn diagnostics.

Generated protobuf-es output is written to `service/src/gen/` by `pnpm generate` from the spike root and is intentionally ignored.

## Dependencies

- `@connectrpc/connect` and `@connectrpc/connect-node` for the Connect candidate.
- `@grpc/grpc-js` and `@grpc/proto-loader` for the comparison server.
- [../../proto/bud/interop/v1/interop.proto](../../proto/bud/interop/v1/interop.proto) for the service contract.

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Generated `service/src/gen/` code must be produced before TypeScript checking or running the Connect server.

---

*Referenced by: [../service.spec.md](../service.spec.md)*
