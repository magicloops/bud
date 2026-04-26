# Phase 1.5 Runtime Decision: daemon gateway gRPC stack

**Status**: Accepted  
**Decision Date**: 2026-04-26  
**Interop Phase**: [phase-1.5-grpc-stack-interop-validation.md](./phase-1.5-grpc-stack-interop-validation.md)  
**Connect Review**: [phase-1.5-connect-node-runtime-design.md](./phase-1.5-connect-node-runtime-design.md)  
**grpc-js Review**: [phase-1.5-grpc-js-runtime-design.md](./phase-1.5-grpc-js-runtime-design.md)  
**Spike**: [../../spikes/grpc-interop/](../../spikes/grpc-interop/)  

---

## Decision

Use `@grpc/grpc-js` for the Node daemon gateway and Rust `tonic` / `prost` for the Bud daemon.

Keep Buf as the schema/tooling standard. Connect-ES remains acceptable for non-daemon APIs, admin/debug APIs, or frontend-adjacent RPCs, but it should not implement the daemon's long-lived native gRPC bidi control stream.

## Rationale

Bud's daemon control plane needs reliable native gRPC-over-HTTP/2 semantics for long-lived bidi streams. Durable operation state must distinguish cancellation from deadline expiry without transport-specific guessing.

The Connect-ES candidate passed basic native gRPC interop and maps explicit `ConnectError(Code.DeadlineExceeded)` correctly. It failed the client-deadline bidi case that matters for daemon control: tonic received cancellation / transport timeout, and the Connect handler saw `ctx.signal.reason` as `Code.Canceled` from HTTP/2 `CANCEL`, not `DeadlineExceeded`. Catching the abort and throwing `DeadlineExceeded` still did not change what tonic received.

The grpc-js candidate passed the required clean matrix after fixing spike lifecycle bugs. It exposed more Node stream mechanics, but those mechanics are explicit and controllable enough for a daemon gateway.

## Evidence

Environment captured during the spike:

- OS: Darwin arm64 `24.6.0`
- Node: `v22.14.0`
- pnpm: `10.11.0`
- Rust: `rustc 1.92.0`
- protoc: `libprotoc 34.1`
- Packages: `@connectrpc/connect` `2.1.1`, `@connectrpc/connect-node` `2.1.1`, `@grpc/grpc-js` `1.14.3`, `@grpc/proto-loader` `0.7.15`, `@bufbuild/buf` `1.68.4`, `@bufbuild/protoc-gen-es` `2.12.0`, `@bufbuild/protobuf` `2.12.0`

Connect result:

- Passed: native gRPC smoke, control stream, metadata, client cancellation, server cancellation, status metadata, drain smoke.
- Failed: tonic client deadline on bidi stream returned cancellation / transport timeout instead of `DeadlineExceeded`.
- Confirmation: immediate explicit `DeadlineExceeded` maps correctly, so the issue is the deadline-abort path, not generic status mapping.

grpc-js result:

- Passed: control stream, server directive during heartbeats, metadata, client cancellation, server cancellation, status metadata, deadline exceeded, max message size, drain smoke, concurrent attach streams with slow echo, proxy/file fallback frames, reconnect under attach load, and 1000 clean stream open/close cycles.
- Fixed during spike: server status emission must use grpc-js's stream `error` path, not `call.destroy(error)`.
- Fixed during spike: attach/control handlers must wait for pending async writes before ending response streams.
- Clarified during spike: cancellation-style churn is distinct from clean open/close churn and should have a separate stress test if needed.

## Required Phase 2 Posture

- Run the daemon gateway on `@grpc/grpc-js` with native gRPC over HTTP/2.
- Generate Rust daemon clients with `tonic` / `prost` from the canonical `.proto` files.
- Keep Buf as the schema source of truth and CI guardrail.
- Isolate grpc-js binding details inside the service daemon-gateway module.
- Set explicit max send/receive message sizes.
- Keep HTTP/2 / grpc-js knobs configurable for diagnostics, including max concurrent streams, session memory, and channelz.
- Implement stream lifecycle helpers for pending writes, inbound half-close, cancellation, typed errors, and drain.
- Prefer a separate listener or gateway boundary for daemon gRPC instead of mixing it into browser REST/SSE routing.
- Preserve WebSocket compatibility only as a bounded rollout path.

## Follow-Ups

- Add an abrupt client-cancellation churn test if production needs to measure repeated non-clean stream teardown.
- Confirm staging/front-door support for end-to-end HTTP/2 gRPC before enabling Phase 2 outside local development.
- Decide whether the initial service binding uses isolated `@grpc/proto-loader` as in the spike or a Buf-managed grpc-js TypeScript generation plugin. Do not let dynamic proto-loader objects leak beyond the gateway adapter.
- Keep QUIC as a separate data-plane decision. QUIC should carry Bud protobuf envelopes/stream frames directly and should not depend on Connect-ES or grpc-js.

## References

- Connect deadline confirmation: [../../debug/connect-deadline-confirmation.md](../../debug/connect-deadline-confirmation.md)
- grpc-js churn investigation: [../../debug/grpc-js-churn-goaway.md](../../debug/grpc-js-churn-goaway.md)
- Connect signal behavior PR: <https://github.com/connectrpc/connect-es/pull/1282>
- Related Connect issues: <https://github.com/connectrpc/connect-es/issues/1117>, <https://github.com/connectrpc/connect-es/issues/1253>
