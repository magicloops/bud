# Phase 4: True Assistant Streaming

**Status**: Implemented, validation in progress

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)

---

## Objective

Add true incremental assistant-text streaming on top of the simpler transcript/history/stream foundation.

By the end of this phase:

- the backend can emit assistant text deltas instead of only one final body
- clients have draft/final semantics for assistant messages
- the service’s stream contract matches what `agent.message` currently sounds like it should mean

## Why This Is Separate

This was materially more complex than the earlier cleanup phases because it changed both agent orchestration and client reconciliation.

The shipped approach in this branch is:

- `AgentService` now consumes provider `invoke(...)` streams
- assistant draft text is emitted via `agent.message_start`, `agent.message_delta`, and `agent.message_done`
- the persisted assistant transcript row is still created once the turn resolves, then emitted as `agent.message`
- the reference web thread view renders one per-turn draft assistant row and replaces it with the canonical persisted row when available

Reasoning-specific live events remain intentionally deferred.

## Scope

### In Scope

- switching agent orchestration to provider streaming where appropriate
- assistant draft/delta/done semantics
- optional reasoning delta semantics if we decide to expose them
- final persisted-message creation rules

### Out Of Scope

- major mobile UI design for reasoning presentation
- non-essential cosmetic polish

## Contract Direction

Shipped event family:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`

Still optional later:

- `agent.reasoning_delta`
- `agent.reasoning_done`

Clients should be able to:

- build a plain-text draft incrementally
- replace that draft with the finalized persisted assistant message once the turn completes

## Implementation Tasks

### Task 1: Switch from `invokeSync(...)` to streaming invocation

Use the provider streaming abstraction already present in the LLM layer instead of continuing to collapse the entire response before emission.

Status: implemented.

### Task 2: Define draft/final persistence rules

Settle:

- when the persisted assistant message row is created
- whether a draft row exists server-side or only client-side
- how final `message_id` is communicated to clients

Status: implemented.

Current decision:

- draft assistant rows are client-side only
- `agent.message_done` is the final draft snapshot before persistence
- the persisted assistant row is still created once the turn resolves successfully
- `agent.message` carries the canonical persisted assistant row and `message_id`

### Task 3: Keep tool-call assembly coherent

Streaming the model output cannot break tool-call handling. We still need a clean way to:

- accumulate tool-call arguments
- dispatch tool execution
- continue the loop

Status: implemented.

Current note:

- streamed tool-use events are reassembled back into canonical tool calls before the agent loop decides whether to execute a tool or finalize an assistant response
- provider reasoning blocks are preserved in the in-memory conversation when a tool call occurs

### Task 4: Decide on reasoning exposure

Keep reasoning optional. If we expose it:

- define separate event names
- keep it explicitly optional for clients

Status: deferred.

Current decision:

- no dedicated reasoning SSE contract ships in this phase
- provider reasoning blocks are retained internally for provider continuity, but they are not exposed as browser-facing draft events yet

## Validation Checklist

- [x] assistant text arrives as true deltas, not only one final body
- [x] final assistant transcript state still converges to canonical persisted history
- [ ] tool-call orchestration has fresh end-to-end manual validation under the streaming model
- [x] cancellation and failure semantics remain explicit under the new stream model
- [x] clients can render draft assistant content without depending on markdown finalization mid-stream

Validation completed in this branch:

- `pnpm --dir /Users/adam/bud/service test`
- `pnpm --dir /Users/adam/bud/web build`
- `git diff --check`

Validation still desirable:

- one fresh end-to-end send/tool/final smoke run against the live service/web stack after the Phase 4 changes

## Exit Criteria

This phase is effectively implemented once “assistant streaming” means real incremental backend behavior, not a client illusion built on one final message event. The remaining follow-up is live validation depth, not contract design.
