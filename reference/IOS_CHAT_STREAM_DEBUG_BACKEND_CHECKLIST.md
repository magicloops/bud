# iOS Chat Stream Debug Checklist

**Date:** 2026-03-21  
**Audience:** Backend and web platform teams  
**Purpose:** Narrow the root cause of a post-send mobile chat update gap before the iOS team changes behavior

## Summary

We have a specific mobile failure mode:

1. iOS sends `POST /api/threads/:thread_id/messages`
2. backend accepts the message
3. web shows the resulting tool calls and Bud response
4. iOS does not show any of the new turn activity

The current iOS debug logs now narrow this substantially:

- send works
- immediate REST refresh works
- the mobile SSE request reaches `http://localhost:5173/api/threads/:thread_id/agent/stream`
- the stream response is `200` with `content-type: text/event-stream`
- auth is present on the stream request
- there are no redirects
- after that, iOS receives no parsed SSE frames at all during the captured window

So the highest-probability remaining issues are:

- `5173` opens the SSE response but does not flush frames correctly to native clients
- backend does not replay or prime the new stream connection the way the handoff describes
- iOS restarts the stream after send and misses the only connection that would have seen the turn live

This does **not** currently look like:

- a failed `POST /messages`
- a failed bearer-auth REST call
- or a simple transcript-history mapping bug

## Concrete Failing Example

Current captured thread:

- `thread_id = f92cb50b-a7ff-4658-9188-42aeeb0efc94`

Current captured mobile sequence:

- `POST /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94/messages` -> `201`
- `GET /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94` -> `200`
- `GET /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94/messages?limit=200` -> `200`
- `GET /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94/agent/stream` -> `200 text/event-stream`

## What We Need Backend To Check

### 1. Did the exact mobile SSE connection receive frames?

For the captured mobile stream request above, please confirm whether that exact connection emitted:

- priming `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`

The critical question is not just whether those events existed in the system, but whether they were actually written to the mobile client’s open SSE connection.

### 2. Is `localhost:5173` flushing SSE frames to native `URLSession` clients?

Please verify the local public origin path:

- `http://localhost:5173/api/threads/:thread_id/agent/stream`

We already know:

- the request reaches `5173`
- auth survives
- response is `200 text/event-stream`

What we do **not** know is whether `5173` is:

- truly streaming frames through immediately, or
- buffering/opening the response without flushing frames to the native client

This is currently one of the top suspects.

### 3. What are the replay semantics on a fresh attach after send?

The current iOS behavior is:

- thread already has an open stream
- after send, iOS does a REST refresh
- iOS restarts the stream and attaches again

Please confirm what backend guarantees for that new stream connection:

- should it always get an initial heartbeat immediately?
- should it replay buffered turn events for the active turn?
- can those buffered events already be gone by the time the second connection attaches?
- when exactly is the active turn buffer cleared?

This matters because mobile may be abandoning the pre-send connection and depending on replay from the replacement connection.

### 4. Are there any differences between the web stream path and the mobile stream path?

Please confirm whether the working web flow differs in any meaningful way from mobile on:

- request path
- auth mode
- proxy layer
- SSE headers
- replay behavior
- buffering behavior

We know the web UI shows the turn correctly, but web may be:

- staying on the original stream connection longer
- using a different auth path
- or relying on browser/proxy behavior that differs from native `URLSession.bytes(...)`

### 5. Can backend confirm the exact event shapes emitted for this failing turn?

iOS currently expects only these event names:

- `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`

If backend emitted anything else for this turn, please share it.

At the moment, the stronger suspicion is “no frames delivered” rather than “decode mismatch,” but event-shape confirmation is still useful.

## Suggested Backend Debug Steps

### A. Add request-scoped logging on the SSE route

For the failing thread, log:

- stream request start
- auth mode resolved
- whether the route accepted the request
- each event written to that connection
- whether the response stream was flushed after each event
- whether the connection closed before `final`

### B. Validate the `5173` proxy with a non-browser client

Please test the public-origin SSE route with a native-style client, not just the browser/web app.

Examples:

- `curl -N` against `http://localhost:5173/api/threads/:thread_id/agent/stream` with bearer auth
- a minimal Node or script client that reads raw SSE lines from `5173`

The goal is to confirm whether frames arrive progressively over `5173`, not just whether the route opens.

### C. Compare direct service vs public-origin behavior

If possible, compare:

- direct service route on `3000`
- public-origin route on `5173`

If direct service flushes events correctly but `5173` does not, that would point strongly to proxy behavior.

### D. Verify replay behavior on second attach

Please explicitly test:

1. attach stream before send
2. send message
3. detach and reattach stream shortly after send
4. confirm whether the second connection gets:
   - heartbeat
   - buffered tool/message events
   - final

That maps directly to the current mobile behavior.

## What We Need Back From Backend

The most useful response would be:

1. whether the mobile `5173` SSE request definitely received any frames
2. if yes, which frames, in order
3. whether those frames were flushed immediately
4. whether replay on reattach is guaranteed for this turn type
5. whether `5173` behaves differently from direct service access for SSE
6. whether any undocumented event names or shapes were emitted

## iOS Context

For context, the iOS side currently:

- uses bearer auth
- connects to the stream through `5173`
- restarts the stream immediately after send
- depends on SSE plus later canonical reload for post-send agent output

If backend confirms that the opened `200 text/event-stream` connection never received frames, the first fix is likely in backend/proxy streaming behavior.

If backend confirms that the replacement connection should never be expected to replay those frames, the first fix is likely on iOS: keep the original stream alive through the turn instead of restarting it immediately after send.

## Related Files

- `chat-debug-logs.txt`
- `debug/2026-03-21-chat-send-live-updates-missing.md`
