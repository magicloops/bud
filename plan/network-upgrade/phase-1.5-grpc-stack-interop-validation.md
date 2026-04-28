# Phase 1.5: gRPC Stack Interop Validation

> **Superseded:** This HTTP/2-first implementation note is historical. The forward implementation plan is [../swappable-transport/implementation-spec.md](../swappable-transport/implementation-spec.md). Keep this file only for origin context; do not use it as an active checklist.


**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Complete
**Reference Note**: [../../reference/connect-vs-grpc-js.md](../../reference/connect-vs-grpc-js.md)
**Connect Design Review**: [phase-1.5-connect-node-runtime-design.md](./phase-1.5-connect-node-runtime-design.md)
**grpc-js Design Review**: [phase-1.5-grpc-js-runtime-design.md](./phase-1.5-grpc-js-runtime-design.md)
**Decision Record**: [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md)

---

## Objective

Choose the Node daemon-gateway gRPC runtime before Phase 2 implementation work begins.

Decision: use `@grpc/grpc-js` for the Node daemon gateway and Rust `tonic` / `prost` for the Bud daemon. Buf remains the schema/tooling standard.

## Context

Bud uses Buf as the source-of-truth protobuf toolchain. The remaining Phase 1.5 question was whether Connect Node was reliable and transparent enough for Bud's long-lived daemon streams compared with the more conservative `@grpc/grpc-js` path.

The daemon-facing contract must remain native gRPC over HTTP/2:

```text
Rust daemon tonic/prost
  <-> native gRPC over HTTP/2
  <-> Node daemon gateway
```

The spike showed that Connect can serve native gRPC over HTTP/2 for basic cases, but it does not preserve the required deadline semantics for tonic client-deadline expiry on native gRPC bidi streams. The daemon gateway should therefore use `@grpc/grpc-js`.

## Fixed Decisions

- Buf is the schema/tooling standard.
- Rust daemon gRPC code should use `tonic` / `prost`.
- The daemon gateway wire protocol must be native gRPC over HTTP/2.
- `@grpc/grpc-js` is the selected Node daemon-gateway runtime.
- Connect can still be used elsewhere for frontend-adjacent, admin, debug, or non-daemon APIs.
- QUIC remains a separate data-transport decision and should carry the same protobuf envelopes/stream frames directly rather than depending on Connect or `@grpc/grpc-js`.

## Scope

### In Scope

- Minimal Buf-generated protobuf service for the spike
- Rust `tonic` client harness
- Node Connect server exposing native gRPC over HTTP/2
- Optional `@grpc/grpc-js` baseline harness if Connect behavior is ambiguous
- Local HTTP/2 server setup matching the intended daemon gateway shape
- Stress and semantics tests for long-lived bidi control and attach-style streams
- Written decision record that selects `@grpc/grpc-js` for Phase 2

### Out Of Scope

- Production daemon control-plane implementation
- Device identity migration
- Proxy/file product behavior
- QUIC implementation
- Browser/mobile API changes
- Compatibility with legacy JSON or WebSocket-only daemon behavior

## Candidate Topology

### Candidate A: Connect Node

```text
proto/
  buf.yaml
  buf.gen.yaml

service spike:
  Node HTTP/2 server
  Connect Node/Fastify adapter
  native gRPC protocol enabled

daemon spike:
  Rust tonic client
  bidi stream to Node server
```

Connect is acceptable only if the Rust `tonic` client talks to it as normal gRPC over HTTP/2 and all required stream semantics work without bespoke protocol workarounds.

### Candidate B: `@grpc/grpc-js`

```text
proto/
  same Buf schema

service spike:
  Node @grpc/grpc-js server
  native gRPC over HTTP/2

daemon spike:
  Rust tonic client
  same bidi stream tests
```

This is the selected Phase 2 daemon-gateway runtime.

## Spike Protocol

Keep the spike protocol intentionally small. It should model behavior, not product payload detail.

Suggested services:

```proto
service BudControlInterop {
  rpc Connect(stream ClientControlEvent)
      returns (stream ServerControlDirective);
}

service BudAttachInterop {
  rpc Attach(stream DataFrame)
      returns (stream DataFrame);
}
```

Required payload concepts:

- hello/session metadata
- heartbeat
- server directive
- ack/result
- data chunk
- stream open
- stream close
- stream reset/error
- drain notice

Do not preserve the transitional `LegacyJsonPayload` or `frame_json` bridge in this spike. Use real generated protobuf messages.

## Test Matrix

Each test should be automated or scriptable enough to rerun during Phase 2 upgrades.

| Test | Acceptance Criteria |
|------|---------------------|
| Long-lived bidi control stream | One Rust tonic client holds a stream open for at least the configured test window while both sides exchange messages without stalls or leaks. |
| Server directive while client streams heartbeats | Node sends a directive while Rust continues periodic heartbeats; both directions preserve order within their side of the stream. |
| Client cancellation | Rust cancels the stream; Node observes cancellation promptly and releases handlers/resources. |
| Server cancellation | Node cancels/resets the stream; Rust receives a clear `Status` and reconnect path can start. |
| Deadline exceeded | Rust deadline propagates to Node and returns the expected gRPC deadline status. |
| Max message size | Oversized client and server messages fail with predictable status; configured accepted sizes pass. |
| Metadata propagation | Auth/session/correlation metadata arrives on both sides and can be logged/validated. |
| Status/error details | Node can return typed gRPC status and details that Rust can inspect. |
| Gateway drain | Node can stop accepting new long-lived streams, notify existing streams, and close after a deadline. |
| Reconnect under load | Rust reconnects while other streams are active; stale stream cleanup is deterministic. |
| 1000+ stream open/close cycles | Repeated stream churn completes without FD, memory, timer, or task leaks. |
| Concurrent attach streams | Multiple attach/data streams run concurrently with independent completion and errors. |
| Slow receiver backpressure | A slow Rust or Node receiver applies backpressure without unbounded buffering or starving control traffic. |
| Proxy/file streaming fallback | Attach-like streams can carry bidirectional chunks representative of proxy/file fallback traffic. |

## Measurement Requirements

Capture enough evidence to make the runtime choice defensible:

- exact package/crate versions
- Node version and HTTP/2 server mode
- Rust version
- local OS
- command lines
- pass/fail summary per test
- cancellation/deadline/status observations
- memory/FD/task behavior during churn tests
- any adapter/proxy constraints discovered
- required runtime knobs such as max message size, keepalive, flow-control, and graceful drain settings

## Current Scaffold Validation Snapshot

Captured on 2026-04-25 after the initial spike scaffold and protobuf-es v2 fixes:

- OS: Darwin arm64 `24.6.0`
- Node: `v22.14.0`
- pnpm: `10.11.0`
- Rust: `rustc 1.92.0`
- protoc: `libprotoc 34.1`
- Installed spike packages: `@connectrpc/connect` `2.1.1`, `@connectrpc/connect-node` `2.1.1`, `@grpc/grpc-js` `1.14.3`, `@grpc/proto-loader` `0.7.15`, `@bufbuild/buf` `1.68.4`, `@bufbuild/protoc-gen-es` `2.12.0`, `@bufbuild/protobuf` `2.12.0`

Passing scaffold checks:

- `pnpm --dir /Users/adam/bud/spikes/grpc-interop generate`
- `pnpm --dir /Users/adam/bud/spikes/grpc-interop check`
- `cargo check --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml`
- `pnpm --dir /Users/adam/bud/spikes/grpc-interop connect:server`
- `cargo run --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml -- control`
- `cargo run --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml -- drain`

Notes:

- Connect is running as a Node `http2` server with Connect and gRPC-Web protocols disabled for this candidate, leaving native gRPC enabled.
- The initial sandbox blocked `tsx` IPC binding and Rust localhost connects; both smoke commands pass when run with local bind/connect permission.
- This scaffold smoke was superseded by the full Connect/grpc-js comparison recorded below and in [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md).

## Current Runtime Comparison Notes

The first matrix runs exposed implementation-sensitive failures in both candidates:

- Connect passed control, metadata, client cancellation, server cancellation, status metadata, and drain smoke, but the deadline probe returned `Cancelled` / tonic transport timeout instead of `DeadlineExceeded`.
- A bounded Connect confirmation pass showed generic status mapping is not the issue: immediate `ConnectError(Code.DeadlineExceeded)` reaches tonic as `DeadlineExceeded`. The client-deadline abort path still reaches the handler as `Code.Canceled`, and even catch-abort-then-throw-`DeadlineExceeded` still returns tonic cancellation / transport timeout.
- grpc-js initially hung on server cancellation because the spike used `call.destroy(error)` instead of grpc-js's stream `error` path. After patching to `call.emit("error", error)`, grpc-js passed server cancellation, status metadata, deadline, max-message, and drain smoke.
- grpc-js then failed concurrent attach with artificial slow echo by returning 15 of 16 expected frames on one stream, likely because the spike calls `end()` before delayed async writes finish.
- After adding pending-write and half-close coordination, grpc-js passed attach, proxy/file, and reconnect probes. A later 1000-stream churn failure was not fixed by grpc-js flags; the harness was dropping each response stream after `hello_ack`, which measured repeated cancellation churn. Draining each stream to EOF produced clean open/close churn, and grpc-js passed 1000 cycles with default server options.

The runtime decision should now prefer grpc-js for the daemon gateway. Connect remains reasonable for non-daemon APIs, but native gRPC bidi deadline behavior is not reliable enough for durable daemon operation classification.

## Decision Outcome

The Phase 1.5 decision is recorded in [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md).

Select **`@grpc/grpc-js`** for the daemon gateway because:

- Connect's tonic client-deadline path maps to cancellation / transport timeout for native gRPC bidi streams.
- grpc-js maps deadline, cancellation, status metadata, and message-size failures predictably.
- grpc-js exposes Node stream backpressure and lifecycle events directly, which is useful for Bud's daemon gateway.
- The spike's grpc-js failures were implementation bugs in the harness/server lifecycle and were corrected.

Do not choose **Connect Node** for the daemon gateway unless a future Connect release or deployment design proves tonic client-deadline bidi streams produce reliable `DeadlineExceeded` semantics without Bud-specific transport normalization.

Connect remains a good candidate for non-daemon APIs where its ergonomics and protocol flexibility matter more than daemon control-plane deadline classification.

## Original Decision Gate

Choose **Connect Node** for the daemon gateway only if:

- Rust `tonic` interoperates through native gRPC over HTTP/2
- every required bidi/cancellation/deadline/status/backpressure/drain test passes
- failures are understandable and can be represented as typed Bud errors
- deployment can serve end-to-end HTTP/2 for daemon traffic
- implementation stays simpler than or comparable to `@grpc/grpc-js`

Choose **`@grpc/grpc-js`** for the daemon gateway if:

- Connect requires fragile workarounds for long-lived bidi streams
- cancellation or deadline behavior is ambiguous
- status/details/metadata mapping is awkward
- backpressure is hard to reason about
- gateway drain cannot be implemented cleanly
- the deployment path makes Connect's native gRPC/H2 mode hard to guarantee

## Implementation Tasks

### Task 1: Add Buf spike scaffolding

Create minimal proto files and generation config for the spike. Keep generated artifacts either checked in under an explicit spike path or reproducibly generated by a documented command.

Current scaffold: [../../spikes/grpc-interop/](../../spikes/grpc-interop/) contains the Buf module, generation template, README, and spike specs. Generated TypeScript output is reproducible with `pnpm generate` from the spike root and is intentionally not checked in.

### Task 2: Implement Connect Node candidate

Run a Node HTTP/2 server using Connect Node or the Fastify adapter in the same shape Phase 2 would use. It must serve native gRPC, not only the Connect protocol.

Current scaffold: [../../spikes/grpc-interop/service/src/connect-server.ts](../../spikes/grpc-interop/service/src/connect-server.ts) starts a Node `http2` server with Connect Node, disables Connect/gRPC-Web handlers for this candidate, and serves only native gRPC for the interop services.

### Task 3: Implement Rust tonic client harness

Generate Rust client code from the same proto and implement the stream driver, cancellation, deadline, metadata, and churn tests.

Current scaffold: [../../spikes/grpc-interop/daemon/](../../spikes/grpc-interop/daemon/) is a separate Rust crate that generates tonic clients at build time and drives the control, cancellation, deadline, drain, churn, attach, and reconnect-under-load commands. The spike keeps the RPC name `Connect` to match the intended production shape, but disables tonic's generated transport constructor because that constructor is also named `connect`.

### Task 4: Run full interop matrix

Run the complete matrix locally. Record commands, results, logs, and any runtime limitations.

### Task 5: Add `@grpc/grpc-js` comparison if needed

If Connect behavior is ambiguous or fails important tests, run the same harness against an equivalent `@grpc/grpc-js` server before deciding.

Current scaffold: [../../spikes/grpc-interop/service/src/grpc-js-server.ts](../../spikes/grpc-interop/service/src/grpc-js-server.ts) exposes the same spike services and handler semantics on port `50052` for a direct comparison run.

### Task 6: Write decision record

Completed in [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md). The record includes:

- selected daemon-gateway runtime
- reasons
- rejected runtime and reasons
- version pins
- required runtime/deployment settings
- Phase 2 follow-up tasks

## Files Likely Affected

- `proto/`
- `spikes/grpc-interop/proto/`
- `spikes/grpc-interop/package.json`
- `spikes/grpc-interop/service/src/`
- `spikes/grpc-interop/daemon/Cargo.toml`
- `spikes/grpc-interop/daemon/build.rs`
- `spikes/grpc-interop/daemon/src/`
- `plan/network-upgrade/`

Prefer a clearly isolated spike location if production code is not ready to consume generated gRPC modules yet.

## Test Plan

- automated interop harness for the matrix above
- manual local run with verbose HTTP/2/gRPC logs
- leak/churn observation for 1000+ stream cycles
- slow-consumer test with bounded buffer assertions
- cancellation/deadline/status inspection from both sides

## Exit Criteria

- [x] the team has selected `@grpc/grpc-js` for the daemon gateway
- [x] Buf/protobuf generation path is validated for both TypeScript and Rust
- [x] Rust `tonic` interop evidence is recorded
- [ ] required staging/front-door HTTP/2 deployment constraints are known
- [x] Phase 2 can start without re-litigating the runtime choice
