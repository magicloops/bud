# Design: Agent SSE Stale Cursor Recovery

Status: Draft

Last updated: 2026-05-25

## Context

Bud's current agent-stream contract is already the right shape:

- `GET /api/threads/:thread_id/messages` is durable transcript history.
- `GET /api/threads/:thread_id/agent/state` is the in-flight runtime snapshot and exposes `stream_cursor`.
- `GET /api/threads/:thread_id/agent/stream?after=<cursor>` is live transport plus bounded same-process catch-up.
- Missing or expired resume cursors produce explicit `agent.resync_required`.

The gap is in the browser recovery path after service restart, replay-buffer expiry, and sometimes frontend HMR.

The investigation in [`debug/agent-sse-resync-required-loop.md`](../debug/agent-sse-resync-required-loop.md) found this pattern:

```text
[agent-sse] connected { threadId, after: "old-cursor" }
[agent-sse] error { readyState: 0, evt: Event }
```

The service logs repeatedly show:

```text
GET /api/threads/:id/agent/stream?after=<same-old-cursor>
Agent SSE attach requires resync
```

`readyState: 0` means `EventSource.CONNECTING`. The current web handler logs that error, then returns because the source is not `CLOSED`, intentionally letting the browser's native EventSource retry continue. Native retry reuses the original URL, so the stale `after` cursor is retried every few seconds and the tab never reaches the `/messages` + `/agent/state` bootstrap repair path.

## Problem

After a service restart or stale replay-buffer miss, an already-open browser tab can keep retrying an invalid stream cursor forever.

The server is behaving correctly:

- the old cursor is not in the new process-local replay buffer
- the stream attach requires resync
- the route attempts to emit `agent.resync_required` and closes the response

The browser is not converging:

- the custom `agent.resync_required` event is not observed in the console
- native EventSource retry owns the next attach
- native retry keeps the original `?after=<old-cursor>` URL
- the React hook never replaces `cursorRef.current` with a fresh `/agent/state.stream_cursor`

## Goals

- Stop repeated same-cursor `agent/stream` retries after service restart or HMR.
- Preserve the existing bounded-resume contract.
- Keep recovery server-authoritative by refreshing `/messages` and `/agent/state`.
- Avoid turning `/agent/stream` into durable history.
- Preserve active-turn recovery when a restart happens during a running agent turn.
- Abort cleanly on auth expiry.
- Add focused automated coverage around the new stream recovery behavior.

## Non-Goals

- No change to daemon or terminal protocol.
- No durable cross-process stream replay in this fix.
- No Redis/shared resume buffer in this fix.
- No full replacement of EventSource in the first pass.
- No attempt to guarantee delivery of every intermediate stream delta across service restarts.

## Recommendation

Add client-owned stale-cursor recovery to `useAgentStream(...)`.

The stream's explicit `agent.resync_required` event remains the preferred path. The new logic is a fallback for the observed case where native EventSource opens and then errors in `CONNECTING` state without delivering that custom event to React.

### Recovery Trigger

In the `error` listener:

1. Run the existing auth check first.
2. If auth redirect is pending, close and stop.
3. If `suppressErrorReconnect` is set because the explicit resync handler already ran, do nothing.
4. If the source is `EventSource.CONNECTING` and `cursorRef.current` is non-null, treat it as a possible stale-cursor/native-retry loop.
5. Close the source so native EventSource stops retrying the stale URL.
6. Start a deduped bootstrap recovery job.

This should be intentionally conservative:

- only one recovery job per thread at a time
- ignore stale jobs after thread switch/unmount
- never reuse a cursor already known to be invalid for another immediate stream attach

### Bootstrap Recovery

The recovery job should:

1. mark the current source as owned by recovery and close it
2. call the same route-provided `refreshBootstrap(threadId)` used by the explicit `agent.resync_required` handler
3. merge latest transcript and runtime state
4. set `cursorRef.current = nextAgentState.stream_cursor`
5. create a new EventSource with the refreshed cursor

If bootstrap refresh fails:

- do not reopen the stream with the stale cursor
- schedule another bootstrap recovery attempt using the existing reconnect delay policy
- keep auth redirects as terminal
- surface a user-visible error only after the first failure or after repeated failures, depending on current product preference

The important invariant:

```text
once a cursor has produced a resume miss, the client must not keep reconnecting
with that same cursor without first refreshing /agent/state
```

### Explicit Resync Handler

The existing `agent.resync_required` handler should be aligned with the same recovery helper:

- set `suppressErrorReconnect = true`
- close the source
- clear or quarantine the invalid cursor before retry
- run bootstrap recovery
- reconnect only after a fresh `stream_cursor` is available

That keeps explicit resync and quick-close fallback on one path.

## State Model

Add a small recovery state inside `useAgentStream(...)`:

```text
idle
connected
native_reconnecting
bootstrap_recovering
manual_reconnect_scheduled
stopped
```

This does not need to be React state unless the UI will render it. Refs are enough for the first pass:

- `recoveryInFlightRef`
- `recoveryTimerRef` or reuse `reconnectTimerRef`
- `lastOpenedCursorRef`
- `sourceGenerationRef`
- `receivedResyncEventRef`

Generation checks matter because native EventSource may still fire callbacks after the hook has moved on to a newer source.

## Event Handling Rules

| Event / state | Behavior |
|---------------|----------|
| `open` | reset heartbeat, reset manual reconnect attempts, record opened cursor |
| `heartbeat` or agent event | update `lastEventTimeRef`, update cursor from `lastEventId` when present |
| `agent.resync_required` | close source, run bootstrap recovery, reconnect from fresh cursor |
| `error` + `CLOSED` | existing manual reconnect path is still valid |
| `error` + `CONNECTING` + cursor present | close source, run bootstrap recovery fallback |
| `error` + auth expired | stop all reconnect/recovery work |
| thread unmount/switch | close source, cancel timers, invalidate generation |

## Why This First

This is the smallest fix that directly targets the observed logs.

It keeps:

- current server contract
- current `/agent/state` bootstrap design
- current bounded replay window
- native EventSource for the ordinary healthy case

It changes only the edge where native EventSource retry has become harmful because it is retrying a known-stale URL.

## Alternatives

### A. Server flush or delayed close for `agent.resync_required`

Potentially useful, but should not be the primary fix.

Pros:
- may make the custom resync event more reliably visible to browsers
- small backend change

Cons:
- still leaves native EventSource retry in control when any proxy/browser path drops the event
- does not address ordinary restart/network errors that skip custom event delivery
- requires browser-network validation to tune correctly

Recommendation: validate in Network/EventStream, but do not rely on this alone.

### B. Fetch-based SSE client

Replace native `EventSource` with a fetch/ReadableStream SSE reader for the agent stream.

Pros:
- app owns retry timing
- app can inspect HTTP status and response body
- no native retry blind spot
- easier to make stale cursor recovery explicit

Cons:
- larger change
- custom SSE parsing, abort handling, and credential behavior
- more browser compatibility and test surface

Recommendation: keep as a follow-up if the targeted EventSource recovery remains brittle.

### C. Attach live-only with no cursor after failure

Clear the cursor and reconnect to `/agent/stream` without `after`.

Pros:
- stops the stale-cursor loop quickly
- simple

Cons:
- can miss active-turn events between restart and live attach
- bypasses the `/messages` + `/agent/state` repair contract
- leaves UI overlays potentially stale

Recommendation: only use as a degraded fallback if `/agent/state` is unavailable and the UI makes that degraded state explicit.

### D. Persist replay buffer across service restarts

Move the replay window into Redis or another shared ephemeral store.

Pros:
- reduces resume misses
- helps non-sticky production routing later

Cons:
- not necessary for correctness if clients resync properly
- adds infrastructure and ordering complexity
- does not solve HMR/native retry by itself

Recommendation: defer until deployment topology requires cross-instance resume.

## Implementation Scope

Expected primary files:

- [`web/src/features/threads/use-agent-stream.ts`](../web/src/features/threads/use-agent-stream.ts)
- [`web/src/features/threads/thread-stream-timing.ts`](../web/src/features/threads/thread-stream-timing.ts), only if a separate bootstrap-retry delay helper is useful
- [`web/src/features/threads/threads.spec.md`](../web/src/features/threads/threads.spec.md)

Likely tests:

- add or extend a test harness for `useAgentStream(...)`
- fake EventSource with controllable `readyState`
- fake `refreshBootstrap(...)` returning a fresh cursor

Optional backend validation files if server flush behavior is investigated:

- [`service/src/routes/threads/agent.ts`](../service/src/routes/threads/agent.ts)
- [`service/src/routes/threads/threads.spec.md`](../service/src/routes/threads/threads.spec.md)

## Test Plan

### Unit / hook coverage

Add focused hook tests for:

1. `agent.resync_required` refreshes bootstrap and reconnects with the new cursor.
2. `error` with `readyState: CONNECTING` and an existing cursor closes native EventSource and refreshes bootstrap.
3. bootstrap recovery failure does not reconnect with the same stale cursor.
4. auth expiry aborts recovery and reconnect timers.
5. stale source callbacks after thread switch do not reconnect the old thread.
6. healthy transient open/heartbeat behavior remains unchanged.

### Manual validation

1. Open a thread tab.
2. Restart the service.
3. Confirm at most one or two stale `agent/stream?after=<old>` requests appear.
4. Confirm the tab fetches `/agent/state` and `/messages`.
5. Confirm the next stream URL uses a new cursor.
6. Confirm the same stale cursor no longer repeats every ~3 seconds.
7. Repeat after frontend HMR.
8. Repeat during an active agent turn and verify transcript/runtime state converges.

### Logging validation

Add temporary or permanent low-noise logs:

- `agent-sse bootstrap recovery started`
- `agent-sse bootstrap recovery succeeded`
- `agent-sse bootstrap recovery failed`
- stale cursor value or hash
- refreshed cursor value or hash
- source generation
- recovery reason: `explicit_resync` or `native_connecting_error`

Logs should avoid message contents and tool payloads.

## Acceptance Criteria

- A stale tab after service restart stops retrying the same `after` cursor indefinitely.
- The client performs `/messages` + `/agent/state` bootstrap recovery before reconnecting after a resume miss.
- Existing explicit `agent.resync_required` recovery still works.
- Auth expiry still stops reconnect/recovery loops.
- A running turn still renders from refreshed runtime state after recovery.
- No duplicate transcript rows are introduced during recovery.
- Tests cover both explicit resync and native `CONNECTING` error fallback.

## Rollout

Recommended phases:

1. Add hook-level recovery helper and tests.
2. Validate service restart locally with an idle thread.
3. Validate service restart during an active thread.
4. Validate frontend HMR with an idle thread.
5. Decide whether server-side resync flush hardening is still needed.
6. Update related specs and validation checklist with the final behavior.

## Open Questions

- Should failed bootstrap recovery show a user-facing banner immediately, or only after repeated attempts?
- Should the fallback trigger on every `CONNECTING` error with a cursor, or only after the source has opened at least once?
- Should the hook clear the cursor to `null` during recovery, or keep it quarantined for diagnostics while preventing stream reuse?
- Do we want a permanent metric for stale-cursor recovery count per tab/thread?
- If the EventStream panel shows `agent.resync_required` reliably, why is the event not reaching the JS handler before native retry resumes?

## Related Docs

- [`debug/agent-sse-resync-required-loop.md`](../debug/agent-sse-resync-required-loop.md)
- [`debug/agent-sse-stale-tab-reconnect-loop.md`](../debug/agent-sse-stale-tab-reconnect-loop.md)
- [`design/mobile-agent-stream-attach-semantics.md`](./mobile-agent-stream-attach-semantics.md)
- [`design/web-refactor-test-hardening.md`](./web-refactor-test-hardening.md)
