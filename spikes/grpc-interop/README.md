# gRPC Interop Spike

This is the Phase 1.5 network-upgrade harness used to choose the Node daemon-gateway runtime.

It validates this topology:

```text
Rust tonic client
  <-> native gRPC over HTTP/2
  <-> Node daemon gateway candidate
```

Outcome: `@grpc/grpc-js` is selected for the daemon gateway. The Connect server remains in the spike as a diagnostic candidate and reference point, but it failed the tonic client-deadline bidi requirement.

The protobuf RPC is intentionally named `Connect` to match the intended production control-plane shape. The Rust build disables tonic's generated transport constructor and creates a `Channel` explicitly, because tonic's convenience constructor is also named `connect`.

## Commands

Run from this directory:

```bash
pnpm install
pnpm generate
pnpm check
```

Start the Connect candidate:

```bash
pnpm connect:server
```

In a second terminal:

```bash
cargo run --manifest-path daemon/Cargo.toml -- control
cargo run --manifest-path daemon/Cargo.toml -- metadata
cargo run --manifest-path daemon/Cargo.toml -- client-cancel
cargo run --manifest-path daemon/Cargo.toml -- server-cancel
cargo run --manifest-path daemon/Cargo.toml -- status-details
cargo run --manifest-path daemon/Cargo.toml -- deadline
cargo run --manifest-path daemon/Cargo.toml -- max-message
cargo run --manifest-path daemon/Cargo.toml -- drain
cargo run --manifest-path daemon/Cargo.toml -- churn
cargo run --manifest-path daemon/Cargo.toml -- attach
cargo run --manifest-path daemon/Cargo.toml -- proxy-file
cargo run --manifest-path daemon/Cargo.toml -- reconnect
```

Run the grpc-js comparison server on port `50052`:

```bash
pnpm grpc-js:server
BUD_INTEROP_ENDPOINT=http://127.0.0.1:50052 cargo run --manifest-path daemon/Cargo.toml -- control
```

The accepted daemon-gateway runtime decision is recorded in:

```text
../../plan/network-upgrade/phase-1.5-runtime-decision.md
```

## Useful Environment Variables

- `CONNECT_INTEROP_PORT` - Connect server port, default `50051`.
- `CONNECT_INTEROP_DEADLINE_MODE` - Connect deadline diagnostic mode: `context-reason`, `explicit-status`, or `catch-explicit-status`; default `context-reason`.
- `GRPC_JS_INTEROP_PORT` - grpc-js server port, default `50052`.
- `GRPC_JS_ENABLE_CHANNELZ` - optional grpc-js diagnostic override for `grpc.enable_channelz`.
- `GRPC_JS_MAX_SESSION_MEMORY` - optional grpc-js diagnostic override for `grpc-node.max_session_memory`.
- `GRPC_JS_MAX_CONCURRENT_STREAMS` - optional grpc-js diagnostic override for `grpc.max_concurrent_streams`.
- `BUD_INTEROP_ENDPOINT` - Rust client endpoint, default `http://127.0.0.1:50051`.
- `BUD_INTEROP_DURATION_MS` - long-lived control stream window, default `3000`.
- `BUD_INTEROP_HEARTBEAT_MS` - heartbeat interval, default `250`.
- `BUD_INTEROP_CHURN` - stream open/close cycles, default `1000`.
- `BUD_INTEROP_ATTACH_STREAMS` - concurrent attach streams, default `8`.
- `BUD_INTEROP_ATTACH_FRAMES` - frames per attach stream, default `16`.
- `BUD_INTEROP_SLOW_ECHO_MS` - server-side artificial delay per attach frame for slow-receiver/backpressure runs, default `0`.
- `BUD_INTEROP_MAX_PAYLOAD_BYTES` - semantic payload limit enforced by the spike handlers, default `4194304`.

## Matrix

The harness covers:

- long-lived bidirectional control stream
- server directive while the client streams heartbeats
- client cancellation
- server cancellation
- deadline exceeded
- metadata propagation
- status/error details
- gateway drain notice
- reconnect under load
- 1000+ stream-open/close cycles
- concurrent attach streams
- slow receiver/backpressure shape
- proxy/file streaming fallback shape through attach-style frames

Transport-level max-message-size limits still need explicit version-specific tuning after dependency install. The handlers enforce a semantic payload limit so the shape is testable before choosing exact runtime knobs.

## Decision Summary

Phase 1.5 selected `@grpc/grpc-js` for the daemon gateway:

- Connect-ES served native gRPC over HTTP/2 and mapped explicit statuses correctly.
- Connect-ES did not preserve tonic deadline semantics for native gRPC bidi client-deadline expiry.
- grpc-js passed the clean interop matrix after the spike fixed status emission and stream lifecycle handling.
- Abrupt cancellation churn remains a separate optional stress test, distinct from clean stream open/close churn.
