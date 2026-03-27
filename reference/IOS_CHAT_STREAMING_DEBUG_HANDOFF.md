# iOS Chat Streaming Debug Handoff

**Date:** March 22, 2026  
**Audience:** iOS team, backend team  
**Scope:** Live agent SSE updates for `GET /api/threads/:thread_id/agent/stream`

## Summary

We have now confirmed that the backend and local web proxy are producing and forwarding valid SSE frames for the real authenticated mobile chat stream.

That means the problem is no longer well-described as:

- message send failing
- auth failing
- redirects stripping auth
- or Vite broadly failing to stream SSE through `http://localhost:5173`

The strongest remaining hypothesis is now on the native client side:

- raw bytes may not be reaching the iOS SSE parser as expected, or
- the parser is receiving bytes but not turning them into events

There is still a narrower proxy-to-client possibility on the last hop from Vite to the iOS app, but the service-to-proxy path is now confirmed healthy.

## What We Confirmed

### 1. The real mobile agent stream request reaches the backend correctly

Captured request:

- `GET /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94/agent/stream`
- `Authorization: Bearer <access_token>`
- `Accept: text/event-stream`
- `User-Agent: Bud (unknown version) CFNetwork/3860.300.31 Darwin/24.6.0`

Vite proxy logs confirmed:

- request reached `localhost:5173`
- proxy forwarded to `http://localhost:3000`
- forwarded host/proto were preserved:
  - `x-forwarded-host: localhost:5173`
  - `x-forwarded-proto: http`
- service responded `200`
- response `content-type` was `text/event-stream`

### 2. The real authenticated stream produced actual SSE frames

For that same failing mobile request, Vite logged these chunks:

1. `retry: 3000`
2. initial `heartbeat`
3. periodic `heartbeat`
4. periodic `heartbeat`
5. `agent.message`
6. `final`
7. another `heartbeat`

This is the key result. The real `/agent/stream` route is not just opening the connection. It is actually producing event frames.

### 3. The generic local SSE transport path worked through both `3000` and `5173` during the March 22 verification pass

During the March 22 verification pass, we temporarily added a dev-only probe route:

- `GET /api/debug/sse-probe`

That probe streamed progressive SSE frames successfully through:

- direct service access on `http://127.0.0.1:3000`
- proxied access on `http://localhost:5173`

So the broad theory “Vite on `5173` cannot stream SSE” is now much weaker.

### 4. The current turn did not emit tool events, and that is valid

For the captured turn, the stream emitted:

- `agent.message`
- `final`

but not:

- `agent.tool_call`
- `agent.tool_result`

That is not itself a bug. It means the agent returned a direct final response for that turn instead of taking a tool path.

### 5. The stream does not automatically close on `final`

One subtle but important finding:

- heartbeats continued after the `final` event

Implication:

- clients must treat the `final` event itself as “turn complete”
- clients should not wait for EOF / socket close to decide that the turn ended

If the iOS implementation expects the server to close the connection after `final`, that expectation is incorrect for the current backend behavior.

## What This Rules Out

These explanations are now weak or ruled out for the captured failure:

- `POST /messages` is failing
- bearer auth is missing on the stream request
- the stream request is being redirected
- the backend never emits any frames
- `5173` cannot stream SSE at all
- the event names are completely different from the documented contract

## Current Best Hypotheses

## 1. iOS raw-byte handling / SSE parsing is the primary suspect

Why:

- proxy logs show the real stream frames arriving
- the wire format looks like standard SSE
- iOS still reports no parsed events

Things that could go wrong here:

- parser never sees the downstream bytes
- parser mishandles the leading `retry:` frame
- parser ignores named events like `heartbeat` or `final`
- parser expects EOF instead of honoring `final`
- parser mishandles framing with blank-line delimiters
- parser mishandles JSON in `data:` lines when the JSON string contains escaped newlines

## 2. The Vite upstream side is healthy, but the last hop to the iOS client may still differ

This is narrower than the old proxy hypothesis.

What we know:

- Vite receives the upstream SSE chunks

What we do not yet know:

- whether the iOS client receives those same bytes on the downstream side

If iOS raw-byte logs show nothing arriving, this last-hop possibility becomes stronger.

## 3. Replay / reattach timing could still be a secondary issue

This is no longer the leading theory, but it remains worth tracking.

The backend contract today is:

- per-thread in-memory event buffer
- initial heartbeat on empty attach
- current-turn replay is best-effort
- buffer is cleared at the start of each new send

That means stream replacement timing can matter, but it does **not** explain the stronger new fact that valid frames were seen on the captured failing request.

## Exact Wire Characteristics Observed

From the proxied real request:

- SSE prelude included `retry: 3000`
- events used explicit `event:` names
- payloads used JSON in `data:`
- frames were separated by blank lines
- assistant text in `agent.message` included escaped newline sequences inside JSON
- `final` arrived as a normal named event, not as connection termination

Representative event sequence:

```text
retry: 3000

event: heartbeat
data: {"ts":...,"initial":true}

event: heartbeat
data: {"ts":...}

event: agent.message
data: {"text":"..."}

event: final
data: {"status":"succeeded","text":"..."}
```

## What We Need From iOS Next

The most useful next evidence is **raw stream logging before SSE parsing**.

Please log:

1. raw byte chunks received from the `/agent/stream` request
2. the exact text reconstructed from those bytes before event parsing
3. when the parser decides an event is complete
4. whether the parser ignores:
   - `retry: 3000`
   - `heartbeat`
   - `final`
   - frames where JSON strings contain escaped `\n`
5. whether the client waits for EOF before emitting events or completing the turn

## iOS Parser Checklist

For the current backend contract, the client should handle all of these correctly:

- leading `retry:` lines
- named events via `event: <name>`
- `data:` payload lines
- blank line as event boundary
- long-lived connections that stay open after `final`
- `final` as semantic completion of the turn

The client should **not** require:

- socket close after `final`
- only `message` events with no custom event names
- a browser `EventSource` environment

## Recommended Next Step

Run one more local mobile send with new iOS raw-byte stream logging enabled.

If we need another backend/proxy correlation pass, we should temporarily re-add targeted service/proxy logging rather than assuming the March 22 debug hooks still exist.

Then compare three timelines for the same request:

1. whatever backend/proxy logs we explicitly enable for that retry
2. any proxy/client capture available for the same request
3. iOS raw-byte and parser logs

That should tell us exactly which boundary is failing:

- service -> Vite
- Vite -> iOS socket
- or iOS socket -> SSE parser

## Current Backend/Web Conclusion

As of March 22, 2026:

- the backend is emitting valid SSE frames for the real mobile chat stream
- the Vite proxy is receiving those frames for the same authenticated request
- the stream remains open after `final`

So the current highest-signal debugging target is the iOS streaming/parser implementation, not the backend route contract.

## Related Docs

- [ios-chat-agent-stream-no-frames.md](../debug/ios-chat-agent-stream-no-frames.md)
- [IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md](./IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)
