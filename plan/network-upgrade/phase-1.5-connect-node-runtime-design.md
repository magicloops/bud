# Phase 1.5: Connect Node Runtime Design Review

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)  
**Interop Phase**: [phase-1.5-grpc-stack-interop-validation.md](./phase-1.5-grpc-stack-interop-validation.md)  
**Decision Record**: [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md)  
**Spike**: [../../spikes/grpc-interop/](../../spikes/grpc-interop/)  
**Status**: Rejected for daemon gateway

---

## Purpose

Define what "using Connect Node properly" means for Bud's daemon gateway spike before treating the current interop results as a runtime decision.

The Connect candidate is now blocked for the daemon gateway unless Bud deliberately accepts transport-specific deadline normalization. A bounded confirmation pass showed that explicit `ConnectError(Code.DeadlineExceeded)` maps correctly, but a tonic client deadline on the native gRPC bidi stream reaches the handler as cancellation and still surfaces to tonic as cancellation / transport timeout.

## Target Shape

```text
Rust daemon tonic client
  -> native gRPC over HTTP/2
  -> Node http2 server
  -> connectNodeAdapter
  -> ConnectRouter service implementation
```

Required server posture:

- Use Node `http2.createServer(...)` or the production deployment equivalent with end-to-end HTTP/2.
- Register services through `connectNodeAdapter({ routes })`.
- Enable native gRPC and explicitly disable Connect/gRPC-Web for this daemon-only candidate during validation.
- Keep browser/mobile APIs out of this listener unless a later deployment design proves co-hosting is safe.

## Handler Model

Connect bidi handlers are plain functions:

```ts
async function* connect(
  requests: AsyncIterable<ClientControlEvent>,
  context: HandlerContext,
): AsyncIterable<ServerControlDirective> {
  // ...
}
```

Design rules for Bud:

- Treat `requests` as the only inbound stream.
- Return an `AsyncIterable` for outbound directives.
- Do not write directly to Node HTTP/2 streams.
- Use `context.requestHeader`, `context.responseHeader`, and `context.responseTrailer` for metadata.
- Use `ConnectError` for intentional typed failures.
- Use protobuf-es `create(MessageSchema, init)` when the response type is a generated `Message` rather than relying on plain object assignability.

## Long-Lived Bidi Implementation

The gateway needs concurrent read and write. A single `for await` loop that only yields after inbound reads is not enough for Bud, because the service must send directives while the daemon continues heartbeats.

Recommended pattern:

- Own a per-RPC bounded outbound queue.
- Start one reader task over `requests`.
- Yield outbound messages from the queue.
- Close the queue only after the reader exits or the RPC is canceled.
- Fail the queue only with a typed error that should become the RPC status.
- Bound the queue by traffic class; do not let daemon heartbeats, proxy bytes, or file chunks grow unbounded.

The current spike's `AsyncQueue` is adequate as a shape probe but not enough for production because it is unbounded and does not record drain/backpressure metrics.

## Timeout And Cancellation Semantics

Connect's Node timeout docs state that handler code can use `context.signal`, and that `context.signal.reason` carries a timeout error when the deadline expires. The initial spike might have violated that intent:

```ts
await delay(2_000, undefined, { signal: context.signal });
```

Node's timer rejects with an `AbortError`, and Connect's generic error conversion can map an `AbortError` to cancellation. That matches the observed tonic result:

```text
code: Cancelled
message: "Timeout expired"
source: tonic::transport::Error(Transport, TimeoutExpired)
```

Proper Connect spike behavior should explicitly preserve the context reason:

```ts
try {
  await delay(2_000, undefined, { signal: context.signal });
} catch (error) {
  if (context.signal.aborted && context.signal.reason) {
    throw context.signal.reason;
  }
  throw error;
}
```

or check before long waits:

```ts
context.signal.throwIfAborted();
```

Confirmation results:

- Rethrowing `context.signal.reason` still returned tonic `Cancelled` / transport timeout.
- Server diagnostics showed `context.signal.reason` was `ConnectError` code `Canceled` with message `http/2 stream closed with error code CANCEL (0x8)`, not `DeadlineExceeded`.
- Throwing `ConnectError(Code.DeadlineExceeded)` immediately mapped correctly to tonic `DeadlineExceeded`, proving generic status mapping works.
- Catching the abort and explicitly throwing `ConnectError(Code.DeadlineExceeded)` still returned tonic cancellation / transport timeout.

Acceptance criterion update:

- Treat Connect as failing Bud's daemon-gateway deadline requirement for native gRPC bidi streams.
- Do not choose Connect for the daemon gateway unless the production design explicitly normalizes tonic's cancellation / transport timeout into deadline semantics and accepts that complexity.

## Server Cancellation

Intentional server cancellation should throw:

```ts
throw new ConnectError("server cancellation requested", Code.Canceled);
```

This currently passes in the spike and should remain the reference behavior.

## Status Metadata And Error Details

Use `ConnectError` with metadata for typed Bud status probes:

```ts
throw new ConnectError(
  "typed status detail probe",
  Code.FailedPrecondition,
  {
    "x-bud-error-kind": "interop_precondition",
    "x-bud-error-retryable": "false",
  },
);
```

Future production status details should use typed protobuf details where useful, but the Phase 1.5 matrix can continue validating metadata first because Bud's immediate need is deterministic operation classification.

## Backpressure And Drain

Connect hides direct HTTP/2 stream writes behind the async iterable. Bud still needs explicit application-level backpressure:

- bounded outbound queues
- stream credit frames for attach/data streams
- separate traffic classes for control, terminal, proxy, and file traffic
- drain state that refuses new long-lived streams before shutdown
- drain notice followed by a close deadline

Connect should only pass Phase 1.5 if this bounded-queue design remains straightforward in the spike.

## Current Connect Findings

Observed passing:

- native gRPC/HTTP2 tonic interop smoke
- control stream
- response metadata
- client cancellation
- server cancellation
- status metadata
- drain smoke

Observed failing:

- deadline probe maps to `Cancelled` / tonic transport timeout instead of `DeadlineExceeded`

Interpretation:

- The failure is now conclusive for this spike's daemon-gateway decision. Connect can map explicit statuses, but its handler abort path for tonic client deadlines does not preserve deadline semantics on native gRPC bidi streams.
- Keep Connect available for non-daemon APIs or future reconsideration, but do not put it on the critical daemon control stream unless this runtime behavior changes upstream.

## Sources

- Connect Node implementing services: <https://connectrpc.com/docs/node/implementing-services/>
- Connect Node timeouts: <https://connectrpc.com/docs/node/timeouts/>
- Installed Connect types: `spikes/grpc-interop/node_modules/.../@connectrpc/connect/dist/esm/implementation.d.ts`
- Current spike server: [../../spikes/grpc-interop/service/src/connect-server.ts](../../spikes/grpc-interop/service/src/connect-server.ts)
