# Debug: ServerResponse MaxListenersExceededWarning

_Created: 2026-05-21_

## Environment

- Service: Node.js/Fastify backend in `/Users/adam/bud/service`
- Symptom: `MaxListenersExceededWarning` on `[ServerResponse]`
- Reported listener types: `finish`, `error`, `close`, `unpipe`, and `drain`
- Reported request result immediately before warning: `statusCode: 200`

## Observed

The service log shows a normal successful response followed by warnings like:

```text
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 finish listeners added to [ServerResponse].
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 error listeners added to [ServerResponse].
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added to [ServerResponse].
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 unpipe listeners added to [ServerResponse].
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 drain listeners added to [ServerResponse].
```

Those listener names are the signature of Node stream piping into an HTTP response. This is unlikely to be caused by many browser clients attached to the same Bud thread, because the warning is on one `ServerResponse` instance rather than on the service-level channel listener sets.

## Static Review Scope

Reviewed specs:
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/files/files.spec.md`
- `service/src/proxy/proxy.spec.md`

Reviewed implementation files in full:
- `service/src/server.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/terminal.ts`
- `service/src/routes/files.ts`
- `service/src/routes/proxy.ts`
- `service/src/routes/proxied-sites.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/files/file-edge.ts`
- `service/src/files/file-runtime.ts`
- `service/src/proxy/proxy-edge.ts`
- `service/src/proxy/proxy-runtime.ts`
- `service/node_modules/fastify-sse-v2/lib/plugin.js`
- `service/node_modules/fastify-sse-v2/lib/util.js`
- `service/node_modules/it-to-stream/src/duplex.js`

## Findings

### 1. The warning shape points to repeated stream pipes into one response

`fastify-sse-v2` implements `reply.sse(...)` by converting an async iterable into a Node stream and piping it to `reply.raw`:

- `service/node_modules/fastify-sse-v2/lib/plugin.js:35` pipes the plugin-owned pushable source on first use
- `service/node_modules/fastify-sse-v2/lib/plugin.js:38-39` pipes any user-provided async iterable source
- `service/node_modules/fastify-sse-v2/lib/plugin.js:49-50` is the actual `.pipe(reply.raw)` call

Each pipe adds response listeners such as `finish`, `error`, `close`, `unpipe`, and sometimes `drain`. If the same response gets piped repeatedly, Node reaches the default limit of 10 listeners and emits this warning.

### 2. A local probe reproduced the warning with repeated async-iterable SSE sends

I ran a one-shot local Fastify probe against the installed `fastify-sse-v2` package.

Result:
- `reply.sse({ event, data })` called 20 times on the same response did not grow listener counts.
- `reply.sse(asyncIterable)` called repeatedly on the same response reproduced the `finish/error/close/unpipe` warning pattern by the 9th to 10th call.

That confirms the dependency can emit this exact class of warning when it is used as "one async iterable per event" rather than "one long-lived response stream plus event objects".

### 3. The current thread SSE routes do not obviously use the dangerous shape

The current agent and terminal stream code passes plain event objects to `reply.sse(...)`:

- `service/src/runtime/agent-runtime-state.ts:253-259`
- `service/src/runtime/agent-runtime-state.ts:277-285`
- `service/src/runtime/event-bus.ts:84-91`
- `service/src/runtime/event-bus.ts:111-119`
- `service/src/routes/threads/agent.ts:155-162`
- `service/src/routes/threads/terminal.ts:115-122`

Those call sites should route through the plugin's pushable source, not create a new pipe for every frame. The current SSE implementation is therefore a suspect because it is the only direct `.pipe(reply.raw)` source in the SSE path, but the current Bud call pattern did not reproduce the warning by itself.

### 4. File/proxy edge responses are the other response-streaming hot path

The file and proxy edge code sends one `PassThrough` body per accepted request:

- `service/src/files/file-edge.ts:744-748`
- `service/src/proxy/proxy-edge.ts:825-829`

A single `reply.send(runtime.body)` should not exceed listener limits. These paths are still worth tracing because Fastify streams them through the same `ServerResponse`, and the reported request completed quickly with `200`, which could match a short proxy/file response as well as a short SSE response.

### 5. Raising max listeners would hide the symptom, not fix it

`reply.raw.setMaxListeners(...)` or global `events.defaultMaxListeners` would silence the warning, but the listener set is per HTTP response. A normal response should not need more than 10 stream pipe listeners. If the count is legitimate, we should be able to explain exactly which streams are attached; otherwise the right fix is to stop repeatedly piping into the same response.

## Current Hypotheses

### 1. Strongest: some route or helper is invoking `reply.sse` with async iterables repeatedly

This exactly matches the warning class in the installed SSE plugin. Static search of `service/src` did not find this in the current thread SSE routes, so if this is the production cause it may be:

- a route path not covered by the first search
- a dependency or wrapper layer
- stale running code from an older build
- a future/local experiment using `reply.sse(asyncGenerator())` for per-frame writes

### 2. Medium: a proxy/file streamed response is being sent or piped more than once

The file/proxy edge paths are the only current product paths that hand `PassThrough` streams to Fastify. The current code reads as one stream per response, but trace output is needed before ruling this out because the warning names `ServerResponse`, not the SSE bus.

### 3. Lower: a close/abort cleanup path leaves timers writing to a dead SSE response

The agent and terminal routes clear heartbeat intervals on `reply.raw.close`. If close does not fire in an edge case, later heartbeat calls would push into the existing plugin source. That is undesirable, but by itself it should not create new `pipe(...)` listeners for plain event-object writes.

## Recommended Remediation

1. Reproduce once with stack traces:

   ```bash
   pnpm dev:https -- --trace-service-warnings
   ```

   Or, when running the service directly:

   ```bash
   NODE_OPTIONS=--trace-warnings pnpm --dir /Users/adam/bud/service dev
   ```

   Capture the first `MaxListenersExceededWarning` stack. The stack should identify whether the listener growth comes from `fastify-sse-v2`, Fastify stream reply internals, or another dependency.

2. Add temporary request-scoped listener-count logging around streaming routes. Log `request.method`, `request.url`, `request.id`, and `reply.raw.listenerCount(...)` for `finish`, `error`, `close`, `unpipe`, and `drain` immediately before and after:
   - `agentRuntime.attach(...)`
   - `terminalEvents.attach(...)`
   - `reply.send(runtime.body)` in file/proxy edge paths

3. If `fastify-sse-v2` is confirmed, replace the hot path with a tiny service-owned SSE writer that:
   - sets SSE headers once
   - writes frames through `reply.raw.write(...)`
   - never calls `.pipe(reply.raw)` per event
   - exposes a single helper for `agent-runtime-state.ts` and `event-bus.ts`

4. Add a regression test that opens a real Fastify SSE route and emits at least 20 heartbeats/events, then asserts response listener counts remain bounded. The test should cover both agent and terminal stream helpers.

5. If file/proxy paths are confirmed instead, audit for double-send/double-pipe behavior and add a focused regression around one accepted proxy/file response with client close and daemon close races.

## Proposed Fix Direction

Do not increase `maxListeners` as the primary fix. The most robust service-side fix is to remove `fastify-sse-v2` from the per-event hot path and use direct `ServerResponse.write(...)` framing for thread SSE streams. Even though the current plain-object call pattern looks safe, a service-owned writer would make this class of repeated-pipe warning impossible for agent and terminal SSE.

## Spec Files Affected If Fixed

- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/service.spec.md`
- `bud.spec.md`
