# Temporary Backend Note - Agent SSE Stream Contract

Date: 2026-05-14

Status: temporary clarification doc for backend/mobile alignment.

## Summary

Our intended mobile behavior is one long-lived agent SSE stream per active thread view. During a normal live assistant response, mobile should attach once and receive all `agent.message_delta` events over that same open response.

The stream should not disconnect between tokens, and mobile should not need to re-query `/agent/stream` to receive each token.

Resume cursor behavior, such as `after=...` or `Last-Event-ID`, should only be used after a real interruption:

- mobile connectivity loss
- app background/foreground interruption
- transport/proxy failure
- server restart or deploy
- client-side stream cancellation followed by deliberate resume

It should not be part of the normal token delivery path while the stream is already connected.

## Expected Normal Flow

1. Mobile opens the active thread.
2. Mobile fetches canonical thread state from REST.
3. Mobile attaches to:

```text
GET /api/threads/:thread_id/agent/stream
Accept: text/event-stream
Authorization: Bearer <token>
```

4. Backend keeps the SSE response open.
5. Backend emits heartbeats while idle.
6. When an assistant run starts, backend emits the live event sequence on the same open response:

```text
agent.message_start
agent.message_delta
agent.message_delta
...
agent.message_done
agent.message
final
```

7. Mobile renders visible deltas immediately from the open stream.
8. Mobile reconciles canonical state from REST after completion or explicit resync as needed.

## Expected Resume Flow

Resume is only for a stream that was actually interrupted.

1. Mobile had an open stream and recorded the latest SSE event ID it received.
2. The stream ends due to connectivity, app lifecycle, proxy/server interruption, or another transport failure.
3. Mobile reconnects with a resume cursor:

```text
GET /api/threads/:thread_id/agent/stream?after=<last_event_id>
```

or:

```text
Last-Event-ID: <last_event_id>
```

4. If the event is still in the backend replay buffer, backend replays only newer events and then keeps the stream open for future live events.
5. If the event is no longer in the backend replay buffer, backend should signal that the client must refetch canonical state, for example `agent.resync_required`.
6. After resync, mobile should attach cleanly without relying on the stale cursor.

## What Should Not Happen

During one active live assistant response, we should not see this pattern:

```text
GET /api/threads/:thread_id/agent/stream?after=...
Agent SSE attach requires resync
request completed
GET /api/threads/:thread_id/agent/stream?after=...
Agent SSE attach requires resync
request completed
...
```

That looks like a reconnect/resync loop, not a healthy live token stream.

We also should not need one stream request per token. Backend logs showing rapid `Agent SSE event emit` lines should correspond to writes on an already-open client response.

## Current Mobile Understanding

In the current iOS checkout, `NetworkChatBackend.streamConversation(id:)` is intended to:

- create one stream task per selected conversation;
- open `/api/threads/:thread_id/agent/stream`;
- read SSE frames from `URLSession.AsyncBytes`;
- keep `lastEventID` for actual reconnect/resume;
- parse `agent.message_delta` as true text deltas;
- use REST transcript fetches as canonical reconciliation, not as token transport.

One important detail: the checked-in iOS request builder currently sets `Last-Event-ID` when it has a resume cursor. It does not directly append `?after=...`. If backend logs show literal `?after=...`, that may be from another client/build, a proxy mapping, or server-side normalization. We should verify this with request IDs and mobile `agent-stream open-start` logs.

## Desired Backend Guarantees

For normal attach without a resume cursor:

- Return `200 text/event-stream`.
- Flush headers promptly.
- Keep the connection open while the client remains connected.
- Emit heartbeats during idle periods.
- Write all live agent events for the active thread to that response.
- Do not close after replaying current buffered events.
- Do not require the client to poll or reconnect to receive later tokens.

For resume attach with `after` or `Last-Event-ID`:

- Use the cursor only to replay missed events after interruption.
- If the cursor is valid, replay newer buffered events and then stay attached for live events.
- If the cursor is invalid, send `agent.resync_required` or equivalent, and make it clear whether the response will remain open or close.
- Avoid producing a fast close/reconnect loop when the client has a stale cursor.

## Open Questions For Backend

1. Is `/agent/stream` intended to stay open indefinitely while the client remains connected?
2. When the server logs `Agent SSE attach requires resync`, does it then close the response immediately?
3. If a client attaches with an invalid `after` cursor, should the client reconnect without a cursor after canonical resync?
4. Should mobile prefer `Last-Event-ID` header or `after` query for resume?
5. Are `agent.message_delta` events written to all currently attached stream responses immediately, or only stored for later replay?
6. Can we add request-scoped logs that distinguish:
   - live attach without cursor,
   - valid resume,
   - invalid cursor/resync,
   - client disconnect,
   - server/proxy close?

## Proposed Shared Contract

The simplest shared contract is:

- Live streaming is push-based over one open SSE connection.
- `after` / `Last-Event-ID` is a recovery mechanism only.
- `agent.resync_required` means the cursor cannot be used as a replay boundary.
- After resync, mobile should clear the stale cursor and make a fresh live attach.
- The backend should not close healthy live streams between tokens.
