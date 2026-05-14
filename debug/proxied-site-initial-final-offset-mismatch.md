# Debug: Proxied Site Initial Final Offset Mismatch

## Status

- Confirmed root cause: service-side stream lifecycle frames could reach the
  data-plane runtime out of order.
- Fixed by dispatching WebSocket stream frames to the runtime before throttled
  activity writes and by serializing lifecycle handling per `stream_id` in the
  shared data-plane router.
- Temporary service and daemon send-path instrumentation has been removed after
  confirmation; regression tests now cover the ordering invariant.

## Environment

- Local service and web-proxy development flow.
- Browser opens a private proxied-site URL in a new tab.
- Bud daemon is connected with the WebSocket data-plane carrier.
- Observed browser response:

```json
{"statusCode":500,"error":"Internal Server Error","message":"expected final_offset 0, got 607"}
```

## Repro Steps

1. Open a proxied-site bootstrap or view URL in a new browser tab.
2. Let the gateway consume the viewer grant / validate the viewer cookie.
3. The redirected proxied request initially returns a 500 with
   `expected final_offset 0, got 607`.
4. Refresh the page.
5. The same proxied site loads successfully.

## Observed

- The error text comes from
  `service/src/transport/data-plane-router.ts` in `handleStreamClose(...)`.
- With `AGENT_DEBUG=0`, the browser reproduced the original 500:

```json
{"statusCode":500,"error":"Internal Server Error","message":"expected final_offset 0, got 607"}
```

- The daemon-side debug logs for that failed request show the daemon sent the
  frames in the correct order:

```text
sending localhost proxy stream_data stream_id=st_01KRHV7M5J854ANCQQ25F9A9D2 offset=0 byte_len=607 end_stream=false
sending localhost proxy stream_close stream_id=st_01KRHV7M5J854ANCQQ25F9A9D2 final_offset=607
```

- `handleStreamClose(...)` compares the incoming `stream_close.final_offset`
  against the service-side runtime stream `receiveOffset`.
- `receiveOffset` starts at `0` and only advances in `handleStreamData(...)`
  after a valid `stream_data` frame is accepted.
- The daemon sends `stream_close.final_offset` from
  `bud/src/proxy/mod.rs` after incrementing its local response offset for all
  chunks it attempted to send.
- A mismatch of `expected final_offset 0, got 607` means the service handled
  `stream_close` while it still believed no response bytes had been accepted.
- When `handleStreamClose(...)` detects the mismatch, it calls the stream
  `onReset` callback. For HTTP proxy streams that destroys the
  `ProxyRuntimeStream` body with the mismatch error, which Fastify surfaces as
  the observed 500 JSON response.

## Expected

- If the daemon sends a `stream_data` frame for 607 bytes followed by
  `stream_close.final_offset = 607`, the service should process the data first,
  advance `receiveOffset` to 607, then accept the close.
- The proxied response should stream normally on first navigation, without a
  refresh.

## Findings

### Primary finding: inbound WebSocket frames are not serialized by the service

`service/src/ws/bud-connection.ts` installs the message handler as:

```ts
socket.on("message", (raw) => {
  void this.handleIncoming(raw);
});
```

Each inbound WebSocket message starts an independent async handler. WebSocket
delivery order is preserved, but application processing order is not guaranteed
once handlers run concurrently.

For small local responses, the daemon can emit these frames back-to-back:

1. `proxy_open_result`
2. `stream_data` with `offset = 0`, body length `607`
3. `stream_close` with `final_offset = 607`

If the service begins processing `stream_close` before the prior `stream_data`
handler has advanced `receiveOffset`, `handleStreamClose(...)` sees
`receiveOffset = 0` and resets the stream as a protocol error.

This aligns with the symptom:

- first new-tab navigation hits the race because the response is tiny and
  frames arrive very close together
- refresh succeeds because timing shifts enough for `stream_data` to complete
  before `stream_close`

### Secondary finding: the data-plane runtime assumes ordered callback dispatch

`service/src/transport/data-plane-router.ts` has correct offset validation for
already-ordered frames, but it does not itself queue per-stream frame handling.
That makes it sensitive to caller dispatch behavior. The WebSocket gateway
currently calls it concurrently.

### Lower-probability alternative: cleanup before data is accepted

`service/src/proxy/proxy-edge.ts` cleanup deletes the data-plane runtime stream.
If cleanup occurred before data was accepted, later frames would normally be
unknown-stream resets, not `expected final_offset 0, got 607`. The exact error
therefore points more strongly at out-of-order processing while the stream
object still exists.

### Lower-probability alternative: daemon sent close without data

The daemon increments the offset as it sends body chunks. A non-zero
`final_offset` means daemon-side code believed body bytes were sent. This does
not rule out a lower transport send failure, but it would not explain why a
refresh reliably succeeds.

## Hypotheses

1. **Most likely: service WebSocket message handlers race.**
   Back-to-back `stream_data` and `stream_close` frames are delivered in order
   but processed out of order because `BudConnection.start()` does not await or
   queue `handleIncoming(...)`.

2. **Likely contributing factor: tiny first document response.**
   A small 607-byte page can fit in a single data frame immediately followed by
   close, creating a very tight race window.

3. **Less likely: data-plane runtime cleanup timing.**
   Cleanup paths can remove runtime streams, but the observed error requires
   the stream to still exist with `receiveOffset = 0`.

4. **Less likely: daemon transport send success without actual data delivery.**
   Possible in theory, but inconsistent with refresh success and with the
   service's exact mismatch state.

## Instrumentation Assessment

- Temporary opt-in service logs gated by `AGENT_DEBUG=1` were added to confirm:
  - inbound WebSocket sequence, frame type, stream ID, offset, decoded byte
    count, and final offset in `service/src/ws/bud-connection.ts`
  - before/after `noteDataPlaneActivity(...)`, including whether the heartbeat
    write path was taken and how long it took
  - data-plane router receive-offset checkpoints for `stream_data` and
    `stream_close` in `service/src/transport/data-plane-router.ts`
- Temporary daemon-side `debug!` logs were added around localhost proxy
  `stream_data` and
  `stream_close` sends in `bud/src/proxy/mod.rs`.
- These logs confirmed that the daemon sent `stream_data offset=0 byte_len=607`
  before `stream_close final_offset=607`, while the service could still fail
  with `expected final_offset 0, got 607`.
- The service-side logs also changed timing enough to mask the failure, so they
  should not remain in the fixed path.
- Final decision: remove the temporary logs and rely on targeted regression
  coverage plus the existing reset warnings. Future production diagnostics
  should be added as narrow, payload-safe error/metric events rather than
  per-frame stream traces.
- The confirming trace pattern was:

```text
stream_data inbound_sequence=N activity_will_write=true
stream_close inbound_sequence=N+1 activity_will_write=false
stream_close receive_offset_at_close=0 final_offset=607
stream_data inbound_sequence=N after activity note
```

If that ordering appears, the service is processing the close before the
preceding data frame reaches the router.

## Proposed Fix

Implemented first fix:

- Added ordered data-plane frame dispatch on the service side.
- `service/src/transport/data-plane-router.ts` now queues
  `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` per
  `stream_id` so a given stream processes lifecycle frames sequentially even
  when caller dispatch overlaps.
- `service/src/ws/bud-connection.ts` now invokes the shared data-plane runtime
  before awaiting throttled activity heartbeat writes. This ensures the
  WebSocket gateway reaches the per-stream queue in inbound frame order.
- Different streams remain independent, so one slow response body does not
  block unrelated terminal/file/proxy traffic.

Simpler but broader alternative:

- Serialize all inbound WebSocket message handling in
  `service/src/ws/bud-connection.ts` by chaining `handleIncoming(...)` calls.
- This preserves wire order but risks head-of-line blocking across unrelated
  frame families if a stream consumer stalls.

Avoid:

- Do not relax `final_offset` validation. That would hide real dropped or
  reordered bytes and weaken the data-plane integrity contract.

Implemented regression coverage:

- A data-plane runtime test invokes `handleDataPlaneStreamFrame(...)`
  concurrently for a `stream_data` frame and the following `stream_close` frame,
  with the data callback delayed, and verifies close waits until data advances
  `receiveOffset`.
- A WebSocket connection test verifies stream-frame dispatch is not blocked by
  delayed activity heartbeat writes.

## Spec Files Affected If Fixed

- `service/src/transport/transport.spec.md`
- `service/src/ws/ws.spec.md`
