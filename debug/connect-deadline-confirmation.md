# Debug: Connect deadline confirmation

## Environment
- Local Phase 1.5 spike under `spikes/grpc-interop/`
- Node Connect server: `pnpm --dir /Users/adam/bud/spikes/grpc-interop connect:server`
- Rust tonic harness: `cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- deadline`
- Endpoint: `http://127.0.0.1:50051`

## Repro Steps
1. Start the Connect spike server.
2. Run `cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- deadline`.

## Observed
- The tonic deadline probe reports cancellation / transport timeout rather than `DeadlineExceeded`, even after the handler rethrows `context.signal.reason`.

## Expected
- The daemon gateway runtime should let Rust distinguish deadline expiry from cancellation without transport-specific normalization.

## Hypotheses
- Connect may map an explicit `ConnectError(Code.DeadlineExceeded)` correctly, but fail when the deadline is triggered through the handler abort signal.
- The handler abort path may fire after tonic has already classified the stream as a transport timeout.
- The issue may be specific to native gRPC bidi streams rather than all Connect status mapping.

## Proposed Confirmation
- Add a diagnostic deadline mode to the Connect spike server.
- Compare current context-reason behavior with immediate explicit `DeadlineExceeded`.
- Compare current behavior with catch-abort-then-explicit `DeadlineExceeded`.

## Confirmation Results

### `CONNECT_INTEROP_DEADLINE_MODE=context-reason`

Command:

```bash
cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- deadline
```

Result:

```text
Error: expected DeadlineExceeded status for deadline, got code: 'The operation was cancelled', message: "Timeout expired", source: tonic::transport::Error(Transport, TimeoutExpired(()))
```

Server diagnostic:

```text
connect deadline abort {"mode":"context-reason","signal_aborted":true,"signal_reason":{"name":"ConnectError","message":"[canceled] http/2 stream closed with error code CANCEL (0x8)","code":1},"thrown_error":{"name":"AbortError","message":"The operation was aborted"}}
```

### `CONNECT_INTEROP_DEADLINE_MODE=explicit-status`

Command:

```bash
cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- deadline
```

Result:

```text
deadline: pass (code: 'Deadline expired before operation could complete', message: "explicit deadline probe")
```

### `CONNECT_INTEROP_DEADLINE_MODE=catch-explicit-status`

Command:

```bash
cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- deadline
```

Result:

```text
Error: expected DeadlineExceeded status for deadline, got code: 'The operation was cancelled', message: "Timeout expired", source: tonic::transport::Error(Transport, TimeoutExpired(()))
```

Server diagnostic:

```text
connect deadline abort {"mode":"catch-explicit-status","signal_aborted":true,"signal_reason":{"name":"ConnectError","message":"[canceled] http/2 stream closed with error code CANCEL (0x8)","code":1},"thrown_error":{"name":"AbortError","message":"The operation was aborted"}}
```

## Conclusion
- Connect maps an explicit `ConnectError(Code.DeadlineExceeded)` correctly when it is thrown before the client-side timeout.
- The handler abort signal for a tonic deadline arrives as `Code.Canceled`, not `Code.DeadlineExceeded`.
- Even forcing the catch block to throw `Code.DeadlineExceeded` after abort does not change what tonic receives.
- This confirms the blocker is Connect's native gRPC bidi deadline/abort behavior with tonic, not generic Connect status mapping.
