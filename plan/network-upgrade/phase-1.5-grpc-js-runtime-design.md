# Phase 1.5: grpc-js Runtime Design Review

> **Superseded:** This HTTP/2-first implementation note is historical. The forward implementation plan is [../swappable-transport/implementation-spec.md](../swappable-transport/implementation-spec.md). Keep this file only for origin context; do not use it as an active checklist.


**Parent Plan**: [implementation-spec.md](./implementation-spec.md)  
**Interop Phase**: [phase-1.5-grpc-stack-interop-validation.md](./phase-1.5-grpc-stack-interop-validation.md)  
**Decision Record**: [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md)  
**Spike**: [../../spikes/grpc-interop/](../../spikes/grpc-interop/)  
**Status**: Accepted for Phase 2

---

## Purpose

Define what "using `@grpc/grpc-js` properly" means for Bud's daemon gateway.

The grpc-js candidate is selected for Phase 2. The spike failures were usage/lifecycle bugs, not runtime blockers.

## Target Shape

```text
Rust daemon tonic client
  -> native gRPC over HTTP/2
  -> @grpc/grpc-js Server
  -> loaded or generated service implementation
```

Required server posture:

- Use `@grpc/grpc-js` directly for the daemon listener.
- Keep generated or loaded service definitions isolated behind a gateway module.
- Set explicit `grpc.max_receive_message_length` and `grpc.max_send_message_length`.
- Keep `grpc-node.max_session_memory`, `grpc.max_concurrent_streams`, and `grpc.enable_channelz` configurable for diagnostics and production hardening.
- Handle backpressure with Node stream `write()` return values and `drain`.
- Treat `cancelled`, `error`, `end`, and pending write completion as first-class stream lifecycle events.

## Handler Model

grpc-js bidi handlers receive a `ServerDuplexStream<Request, Response>`:

```ts
function handleConnect(call: grpc.ServerDuplexStream<ClientControlEvent, ServerControlDirective>) {
  call.on("data", ...);
  call.on("end", ...);
  call.on("cancelled", ...);
  call.write(...);
}
```

Unlike Connect, grpc-js exposes Node stream primitives directly. That is useful for daemon gateway control, but it also means Bud owns the stream lifecycle details.

## Server Errors And Status

The initial spike used:

```ts
call.destroy(error);
```

That was not the right path for returning a typed gRPC status from a bidi handler. grpc-js's `ServerDuplexStreamImpl` has an `error` listener that converts a server error/status object into trailers and then ends the stream.

Correct spike pattern:

```ts
const error = Object.assign(new Error(message), {
  code,
  details: message,
  metadata,
});
call.emit("error", error);
```

After this patch, tonic received proper statuses for:

- `Cancelled`
- `FailedPrecondition` plus metadata
- `DeadlineExceeded`
- `ResourceExhausted`

## Async Write And End Ordering

The current attach failure:

```text
attach stream 0 expected 16 echoes, received 15
```

is likely a spike handler bug. The attach handler currently starts async work from a `data` event and calls `call.end()` immediately on `end`, without waiting for all delayed writes to flush. With `BUD_INTEROP_SLOW_ECHO_MS=5`, one pending write can still be in flight when `end` closes the response side.

Proper grpc-js attach/control handler rules:

- Track pending async handlers.
- Do not call `call.end()` until inbound half-close has happened and pending writes are flushed.
- After a typed failure, stop processing additional inbound frames.
- Do not call `resume()` after a terminal error.
- If `write()` returns `false`, wait for `drain` before processing more frames.
- Listen to `cancelled` and stop pending application work promptly.

Recommended helper shape:

```ts
let inboundEnded = false;
let pending = 0;
let failed = false;

function maybeEnd() {
  if (inboundEnded && pending === 0 && !failed && !call.destroyed) {
    call.end();
  }
}

call.on("data", (frame) => {
  call.pause();
  pending += 1;
  void handleFrame(frame)
    .catch((error) => failCall(call, grpc.status.UNKNOWN, error.message))
    .finally(() => {
      pending -= 1;
      if (!failed) call.resume();
      maybeEnd();
    });
});

call.on("end", () => {
  inboundEnded = true;
  maybeEnd();
});
```

This is still only a spike shape. Production should use a small per-stream state machine rather than ad hoc counters.

## Deadline Semantics

grpc-js passed the tonic deadline probe after cancellation semantics were fixed:

```text
DeadlineExceeded: "Deadline exceeded"
```

This is a meaningful point in grpc-js's favor for Bud because durable operation state needs to distinguish timeout from cancellation without transport-specific guesswork.

## Backpressure And Drain

grpc-js gives Bud direct visibility into Node stream backpressure:

- `call.write(frame)` returns `false` when the writable side is saturated.
- `drain` indicates writes may continue.
- `call.pause()` / `call.resume()` can throttle inbound reads.

This is powerful, but the attach failure shows why the implementation must be disciplined. The production gateway should centralize:

- pending write tracking
- inbound half-close handling
- cancellation cleanup
- stream credit updates
- drain deadlines
- traffic-class scheduling

## Current grpc-js Findings

Observed passing after lifecycle and harness fixes:

- control stream
- response metadata
- client cancellation
- server cancellation
- status metadata
- deadline exceeded
- max message size
- drain smoke
- concurrent attach streams with artificial slow echo
- proxy/file fallback frames
- reconnect while attach streams run
- 1000 clean stream open/close churn cycles

Interpretation:

- The attach failure was caused by ending the response side before delayed writes finished. Tracking pending work and waiting for inbound half-close fixed it.
- The initial churn failure was not fixed by grpc-js flags. Disabling channelz and explicitly setting `grpc-node.max_session_memory` plus `grpc.max_concurrent_streams` still failed around stream 540.
- The churn harness was dropping the response stream after `hello_ack`, causing repeated cancellation-style churn. Draining each stream to EOF changed the test to clean open/close churn, which passed 1000 cycles with default grpc-js server options.
- Keep a separate cancellation-churn stress test if Bud wants to measure repeated abrupt client cancellation. Do not treat cancellation churn as the same acceptance criterion as clean stream open/close churn.

## Phase 2 Requirements

Production code should not copy the spike handlers ad hoc. Phase 2 should centralize grpc-js stream handling in a daemon-gateway module with:

- typed status helpers that emit grpc-js server errors through the stream `error` path
- pending-write tracking before `call.end()`
- inbound half-close and cancellation state
- bounded outbound queues for service-originated directives
- explicit max send/receive message sizes
- configurable HTTP/2 / grpc-js diagnostics knobs
- drain behavior that refuses new long-lived streams before shutdown and lets existing streams close on a deadline

The initial service binding may follow the spike with isolated `@grpc/proto-loader`, but dynamic proto-loader shapes must not leak into runtime/domain modules. If this becomes awkward, switch the binding layer to a Buf-managed grpc-js TypeScript generator before broader Phase 2 code depends on it.

## Sources

- gRPC Node basics: <https://grpc.io/docs/tutorials/basic/node.html>
- grpc-js ServerDuplexStream reference: <https://grpc.github.io/grpc/node/grpc-ServerDuplexStream.html>
- grpc-js ClientDuplexStream reference: <https://grpc.github.io/grpc/node/grpc-ClientDuplexStream.html>
- Installed grpc-js source: `spikes/grpc-interop/node_modules/.../@grpc/grpc-js/src/server-call.ts`
- Current spike server: [../../spikes/grpc-interop/service/src/grpc-js-server.ts](../../spikes/grpc-interop/service/src/grpc-js-server.ts)
