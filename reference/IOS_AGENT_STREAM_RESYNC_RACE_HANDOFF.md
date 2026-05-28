# iOS Agent Stream Resync Race Handoff

**Status:** Investigation handoff  
**Audience:** iOS, backend, web platform  
**Last Updated:** 2026-05-25

## Summary

The local service logs show repeated `Agent SSE attach requires resync` responses when a client attaches to:

```http
GET /api/threads/:thread_id/agent/stream?after=<stale_cursor>
```

The server behavior is expected. Agent stream replay is intentionally bounded and process-local. After a service restart, frontend HMR, or replay-buffer expiry, a previously stored cursor can no longer be used as a replay boundary. In that case, the service sends `agent.resync_required`, closes that SSE response, and expects the client to refetch `/messages` plus `/agent/state`.

The observed mobile issue is that the client begins refresh work, but also opens a new stream with the same known-invalid cursor before `/agent/state` returns a fresh `stream_cursor`.

## Observed Mobile Pattern

From the local service log sample:

```text
16:48:24.655  GET /api/threads/:id/agent/stream?after=01KSGRK8ZF986CE4VTJSM1H0HR
16:48:24.655  Agent SSE attach requires resync

16:48:25.730  GET /api/threads/:id/messages?limit=100
16:48:25.732  GET /api/threads/:id

16:48:25.907  GET /api/threads/:id/agent/stream?after=01KSGRK8ZF986CE4VTJSM1H0HR
16:48:25.908  GET /api/threads/:id/agent/state
16:48:25.917  Agent SSE attach requires resync
```

The important ordering is:

1. the first stream attach proves `01KSGRK8ZF986CE4VTJSM1H0HR` is not resumable
2. mobile starts some canonical refresh requests
3. mobile opens another stream with `after=01KSGRK8ZF986CE4VTJSM1H0HR`
4. only after that does mobile start `/agent/state`

That second stream cannot succeed because it reuses the same cursor the server already rejected.

## Backend Contract

The shipped contract remains:

- `/api/threads/:thread_id/messages` is durable transcript history
- `/api/threads/:thread_id/agent/state` is the authoritative current runtime snapshot
- `/api/threads/:thread_id/agent/stream` is live transport plus bounded same-process resume
- `agent.resync_required` means the supplied cursor is too old, unknown, or otherwise outside the replay window

When the stream returns:

```text
event: agent.resync_required
data: {"error":"resync_required","provided_cursor":"01CUR..."}
```

the `provided_cursor` is known invalid for the current backend process. The client should not use it for another `after=` attach.

## Likely Root Cause

The mobile client appears to have more than one path capable of starting the agent stream:

- normal thread-open attach
- stream disconnect reconnect
- resync recovery
- route/view refresh after transcript or thread state reload

On `agent.resync_required`, recovery work starts, but an existing reconnect path still uses the old resume cursor. Because `/agent/state` has not completed yet, that path has no fresh cursor and reattaches with the stale one.

This is a client-side sequencing problem, not evidence of a backend listener leak.

## Proposed Mobile Solution

Treat `agent.resync_required` as an exclusive stream-recovery state transition.

Required behavior:

1. close the current SSE stream
2. cancel or suppress any pending stream reconnect timer/task
3. immediately mark the `provided_cursor` as invalid
4. enter a `recovering` state so no other code path can attach a stream with the old cursor
5. fetch `/messages` and `/agent/state`
6. apply canonical transcript and runtime overlay state
7. store `/agent/state.stream_cursor` as the next resume cursor
8. open exactly one new stream with `after=<state.stream_cursor>`

If `/agent/state` fails but `/messages` succeeds:

- render the canonical transcript
- do not show pending runtime overlay or stop/cancel state from old data
- retry `/agent/state`
- if product requirements demand a stream before `/agent/state` recovers, attach with no cursor and treat that stream as live-only

## State Machine Sketch

```text
idle
  -> attaching
  -> streaming
  -> recovering
  -> attaching
  -> streaming

streaming
  -> stopped_auth_expired
  -> stopped_thread_changed
  -> recovering
```

Rules:

- only `attaching` may create a new stream
- `recovering` owns bootstrap fetches and blocks reconnect timers
- `recovering` clears or quarantines the invalid cursor before any async work
- stream callbacks should be ignored unless they belong to the current stream generation
- a later thread selection, logout, or explicit close should invalidate the current generation

## Pseudocode

```swift
func handleResyncRequired(providedCursor: String?) {
    streamGeneration += 1
    let generation = streamGeneration

    closeCurrentStream()
    cancelReconnectTimer()

    if resumeCursor == providedCursor {
        resumeCursor = nil
    }
    invalidResumeCursors.insert(providedCursor)
    streamPhase = .recovering

    recoveryTask?.cancel()
    recoveryTask = Task {
        async let messages = fetchMessages(threadID)
        async let state = fetchAgentState(threadID)

        do {
            let (nextMessages, nextState) = try await (messages, state)
            guard generation == streamGeneration else { return }

            applyMessages(nextMessages)
            applyAgentStateOverlay(nextState)

            resumeCursor = nextState.streamCursor
            streamPhase = .attaching
            openAgentStream(after: nextState.streamCursor, generation: generation)
        } catch {
            guard generation == streamGeneration else { return }

            streamPhase = .recovering
            scheduleStateRefreshRetry()
        }
    }
}
```

The exact Swift structure can differ. The invariant matters more than the shape: once a cursor produces `agent.resync_required`, no reconnect path may reuse it.

## Validation Checklist

Use local service logs to validate the fix:

1. Restart the service while a mobile thread view is open.
2. Confirm one stale attach may occur:
   ```http
   GET /api/threads/:id/agent/stream?after=<old_cursor>
   ```
3. Confirm the next requests are:
   ```http
   GET /api/threads/:id/messages?limit=100
   GET /api/threads/:id/agent/state
   ```
4. Confirm the next stream attach uses the fresh state cursor:
   ```http
   GET /api/threads/:id/agent/stream?after=<new_state_cursor>
   ```
5. Confirm there is no second attach with the old cursor.
6. Repeat with quick view disappear/reappear and thread switching.
7. Repeat with `/agent/state` temporarily failing; the client should not reconnect with the known-invalid cursor.

## Useful Diagnostics

Add short-lived mobile logs around:

- stream generation id
- stream open URL, with cursor redacted or shortened
- `agent.resync_required` receipt and `provided_cursor`
- cursor invalidation
- recovery start/success/failure
- `/agent/state.stream_cursor` received
- reconnect timer cancellation and scheduling
- ignored stale callback due to generation mismatch

The service-side symptom to eliminate is repeated:

```text
Agent SSE attach requires resync
afterCursor: "<same_cursor>"
```

with no successful `/agent/state`-derived cursor attach in between.

## Non-Goals

- Do not make SSE a durable event log.
- Do not persist the bounded replay buffer as part of this mobile fix.
- Do not infer runtime state from old transcript rows when `/agent/state` is unavailable.
- Do not retry `provided_cursor` after `agent.resync_required`.
- Do not require backend changes for this specific race.

## Related Docs

- [`IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`](./IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)
- [`IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md`](./IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md)
- [`../debug/agent-sse-resync-required-loop.md`](../debug/agent-sse-resync-required-loop.md)
- [`../design/agent-sse-stale-cursor-recovery.md`](../design/agent-sse-stale-cursor-recovery.md)
