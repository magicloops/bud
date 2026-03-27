# iOS Agent Stream Attach Semantics Handoff

**Status:** Ready for backend review  
**Audience:** Backend, web platform, iOS  
**Last Updated:** 2026-03-26

## Purpose

This handoff narrows a specific transcript-open/runtime-state issue in the iOS chat client and proposes the desired semantics for `GET /api/threads/:thread_id/agent/stream`.

The immediate goal is to align backend and iOS on what should happen when mobile:

- opens a thread for passive reading
- reconnects after a short disconnect
- opens a thread while a real agent turn is still in progress

The current iOS rewrite exposed a contract mismatch around attach-time replay. That mismatch is now a concrete product problem, not just an implementation detail.

## What We Observed

When iOS opened an existing thread, we saw:

- the `Stop` button flash even though no run was active
- the most recent tool row briefly render as if it were running again
- the transcript flash through prior tool rows before settling
- extra thread-open jitter that became much worse in markdown-heavy transcripts

We then restarted the local dev server, which cleared the process-local in-memory stream buffer. After that:

- the `Stop` flash disappeared
- the fake running-tool flash disappeared
- thread-open flicker was materially reduced

That strongly suggests the issue is not just local UI logic. Attach-time buffered stream events are affecting the mobile client in situations where the user is only opening a read-only thread view.

## Current Documentation Conflict

The older mobile handoff package, which has since been removed from `reference/`, described conflicting semantics.

One older description said:

- replay is process-local, in-memory, and at-least-once
- if `Last-Event-ID` or `last_event_id` hits an event still in the buffer, only newer events replay
- if the cursor is missing, the server falls back to live-only delivery

Another older description said:

- events are buffered in memory and replayed on attach

Those are not equivalent.

The first description implies:

- fresh attach without a cursor is live-only

The second description can be read as:

- fresh attach may replay buffered events even without a cursor

The behavior we observed in local development is consistent with the second interpretation, not the first.

## Why This Matters To Mobile

For thread open, iOS already fetches canonical history first via:

- `GET /api/threads/:thread_id/messages`

That payload is the durable transcript baseline for the selected window.

For the same thread open, iOS then attaches:

- `GET /api/threads/:thread_id/agent/stream`

From the mobile product perspective, the stream should now be additive. It should provide only net-new live events after attach, or a well-defined reconnect replay when the client presents a valid cursor.

If the stream instead replays older buffered events on a passive open, the client can momentarily regress a completed thread into an active-looking state:

- old `agent.tool_call` looks like a running tool again
- old `agent.message_start` looks like a live assistant turn again
- `Stop` becomes visible even though there is nothing to cancel

This makes a read-only transcript open look broken.

## Current iOS Request Sequence

On thread open, iOS currently does:

1. `GET /messages`
2. build the transcript from that canonical page
3. attach SSE

Important current client facts:

- on a fresh thread open, iOS does not send `Last-Event-ID`
- `Last-Event-ID` is only sent on reconnect within the same active stream task
- iOS expects `/messages` to provide the initial truth for the visible transcript window
- iOS expects SSE to represent live continuation from that point forward

So if a fresh attach without `Last-Event-ID` is replaying stale events, mobile will treat them as new unless the protocol makes replay explicit.

## Desired Semantics

## 1. Passive thread open without `Last-Event-ID` should be live-only

When the client opens a thread for reading and attaches the agent stream without `Last-Event-ID`:

- do not replay prior buffered tool or assistant events from an already completed turn
- do not resend old `agent.tool_call`, `agent.message_start`, `agent.message_delta`, or `final`
- it is fine to send an initial `heartbeat`

Desired result:

- `/messages` defines the visible baseline
- SSE only carries net-new events after attach

## 2. Reconnect replay should require a valid cursor

Replay is useful, but only for short reconnect recovery.

When the client reconnects with `Last-Event-ID` or equivalent cursor:

- if that cursor is still in the in-memory buffer, replay only newer buffered events after that cursor
- do not replay the whole buffered turn from the beginning
- preserve the documented at-least-once property

Desired result:

- reconnect fills a gap
- reconnect does not restage the whole prior turn

## 3. Missing or stale cursor should fall back to live-only

If the client reconnects with no cursor, or a cursor that is no longer in the buffer:

- fall back to live-only delivery
- do not replay buffered frames from the start of the turn

This matched the stricter reading of the older mobile handoff package.

## 4. Completed turns should not reactivate on passive reopen

If a turn already finished and the user later reopens the thread:

- the agent stream should not make that completed turn appear active again
- completed tool rows should remain completed
- no active assistant runtime should be implied unless a genuinely new turn begins after attach

Desired result:

- reopening a completed thread is visually stable

## 5. If the backend wants attach-time replay on fresh open, it must be explicit

If backend intentionally wants fresh attach without a cursor to replay buffered events, mobile needs that to be explicit in the contract.

Acceptable options would be:

- a documented flag on replayed events such as `replayed: true`
- a dedicated replay envelope before live delivery starts
- an explicit opt-in query parameter for replay behavior

What is not workable for mobile is:

- old buffered frames arriving on a passive open and being indistinguishable from new live activity

## Desired Examples

### A. Passive open of a completed thread

1. iOS fetches `/messages`
2. iOS attaches `/agent/stream` with no `Last-Event-ID`
3. server sends optional `heartbeat`
4. server sends nothing else until a genuinely new turn starts

### B. Short reconnect during an active turn

1. iOS was already connected and saw event `E42`
2. connection drops
3. iOS reconnects with `Last-Event-ID: E42`
4. if buffered events `E43`, `E44`, and `E45` still exist, only those replay
5. stream then continues live

### C. Reopen after a completed turn with leftover buffer still in memory

1. prior turn finished
2. process-local buffer still happens to contain its frames
3. user later opens the thread from the list
4. `/messages` returns the completed transcript window
5. fresh SSE attach with no cursor does not replay the old turn frames

## One Open Product/Protocol Question

There is one legitimate ambiguous case:

- the user opens a thread while a real agent turn is already in progress on another device or session

For that case, backend and iOS should explicitly choose one of these models:

### Option A: strict live-only attach

- `/messages` provides only persisted history
- SSE with no cursor starts from "now"
- iOS may miss the already-started portion of the active draft turn unless another route exposes current draft state

### Option B: explicit current-turn bootstrap

- fresh attach may bootstrap the currently active turn
- but that bootstrap must be documented and distinguishable from stale replay of an already completed turn

Either model can work. The important requirement is that a passive open of a completed thread must not be able to masquerade as live activity.

## Backend Response Requested

Please confirm:

1. what the actual current server behavior is on fresh attach without `Last-Event-ID`
2. whether the observed stale-event replay on passive open is expected or a bug
3. whether backend is willing to adopt the desired semantics above
4. if not, what explicit replay marker or attach mode backend proposes instead
5. which of the two docs should be treated as the source of truth until they are aligned

## Recommended Contract Update

After alignment, please update the backend handoff docs so they unambiguously state:

- fresh attach semantics without cursor
- reconnect semantics with cursor
- whether replay can occur for completed turns on passive open
- whether any replayed events are explicitly marked
- how active-turn bootstrap should work, if supported

Without that contract, mobile transcript correctness remains fragile even if the UI implementation improves.
