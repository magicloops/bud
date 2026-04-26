# Debug: grpc-js churn GOAWAY

## Environment
- Local Phase 1.5 spike under `spikes/grpc-interop/`
- Node grpc-js server: `pnpm --dir /Users/adam/bud/spikes/grpc-interop grpc-js:server`
- Rust tonic harness: `cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- churn`
- Endpoint: `http://127.0.0.1:50052`

## Repro Steps
1. Start the grpc-js spike server with `BUD_INTEROP_SLOW_ECHO_MS=5`.
2. Run `BUD_INTEROP_ENDPOINT=http://127.0.0.1:50052 cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- churn`.

## Observed
- Churn failed while opening stream 536.
- tonic reported an HTTP/2 `GOAWAY` from the server with `INTERNAL_ERROR`.

```text
Error: open churn stream 536

Caused by:
    0: code: 'Internal error', message: "h2 protocol error: http2 error", source: tonic::transport::Error(Transport, hyper::Error(Http2, Error { kind: GoAway(b"", INTERNAL_ERROR, Remote) }))
    1: transport error
    2: http2 error
    3: connection error received: unexpected internal error encountered
```

## Expected
- The grpc-js candidate should survive 1000 sequential stream open/close cycles.

## Hypotheses
- Server/channelz tracking may be accumulating per-call/session state during churn.
- HTTP/2 session options such as max session memory or advertised max concurrent streams may need explicit spike coverage even if grpc-js defaults appear permissive.
- The churn harness may be dropping each response stream after the first message instead of draining trailers, causing repeated client-side cancellation rather than clean stream close.

## Proposed Fix
- Make grpc-js server HTTP/2/channel options configurable by environment.
- Test `grpc.enable_channelz=0`, explicit `grpc-node.max_session_memory`, and explicit `grpc.max_concurrent_streams` before changing harness semantics.
- If flags do not fix the failure, update the churn harness to distinguish clean close churn from cancellation churn.

## Follow-up Results
- `GRPC_JS_ENABLE_CHANNELZ=0` did not fix churn. The run failed while opening stream 543 with a closed connection.
- `GRPC_JS_ENABLE_CHANNELZ=0 GRPC_JS_MAX_SESSION_MEMORY=1073741824 GRPC_JS_MAX_CONCURRENT_STREAMS=100` did not fix churn. The run failed while opening stream 540 with HTTP/2 `GOAWAY` / `INTERNAL_ERROR`.
- Updating the churn harness to drain each response stream to EOF fixed clean open/close churn. With default grpc-js server options, `BUD_INTEROP_ENDPOINT=http://127.0.0.1:50052 cargo run --manifest-path spikes/grpc-interop/daemon/Cargo.toml -- churn` passed 1000 streams.

## Conclusion
- The original churn test was cancellation-style churn, not clean open/close churn, because the client dropped the response stream after the first `hello_ack`.
- grpc-js still needs a separate abrupt-cancellation churn stress test if Bud wants to validate that behavior.
- The clean open/close acceptance criterion now passes without special grpc-js flags.
