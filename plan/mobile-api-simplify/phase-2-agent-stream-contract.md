# Phase 2: Agent Stream Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Complete

---

## Objective

Make the agent SSE contract explicit, replay-safe, and reconcilable against transcript history.

By the end of this phase:

- agent events carry stable identifiers
- replay behavior is documented and testable
- `final` semantics are explicit for success/failure/cancel
- clients can reconcile live events against canonical transcript rows without synthetic guesswork

## Current Problem

Today:

- replay is process-local and in-memory only
- replay can duplicate already-seen events
- `agent.tool_call` and `agent.tool_result` do not expose stable reconciliation keys
- `agent.message` implies streaming semantics that do not exist
- clients rely on `final` plus a full transcript refetch to converge

## Scope

### In Scope

- event payload identifiers
- completion/error/cancel semantics
- replay/reconnect rules
- transcript revision / turn identity if needed
- fixtures and tests for event ordering and duplication behavior

### Out Of Scope

- true assistant text deltas
- paging/history route changes beyond their interaction with stream reconciliation

## Contract Direction

At minimum, live events should expose:

- `turn_id`
- `call_id` for tool lifecycle events
- `message_id` once a persisted message exists
- explicit `status`/completion semantics on `final`

Recommended direction:

- move toward transcript-centric names such as `message.created`, `message.updated`, or `tool_call.created` only if that materially simplifies the client model
- otherwise keep the current family but strengthen the payloads and semantics enough that clients do not need brittle workarounds

## Implementation Tasks

### Task 1: Add stable identifiers

Add backend-provided identifiers to events so clients can correlate:

- tool call to tool result
- live tool item to persisted tool row
- final assistant event to persisted assistant row

### Task 2: Settle replay rules

Document and implement one clear contract:

- whether replay is best-effort only
- whether duplicates are expected
- whether `Last-Event-ID` is honored or intentionally unsupported
- whether clients must reconcile against transcript history after reconnect

### Task 3: Make `final` semantics explicit

Document and test:

- success => `final` with `status: succeeded`
- failure => `final` with `status: failed`
- cancel => `final` with `status: canceled`

Also clarify which successful-turn events must occur before `final`.

### Task 4: Add stream fixtures

Publish example sequences for:

- ordinary success
- failure after tool activity
- cancellation
- reconnect replay with duplicates

### Task 5: Consider a transcript revision

If stable event IDs alone are not enough, add a monotonic thread transcript revision or turn revision so clients can cheaply detect drift and reconcile.

## Validation Checklist

- [x] every successful turn has a stable live-to-persisted correlation path
- [x] replay behavior is deterministic and documented
- [x] duplicate replay is either prevented or explicitly part of the contract
- [x] success/failure/cancel `final` semantics are documented with checked-in fixtures and consumed by the reference client
- [x] clients can recover cleanly by combining replay with canonical history

## Exit Criteria

This phase is done when the stream can be described without caveats like “the client has to guess what this event corresponds to.”

## Close-Out Notes

Phase 2 now closes with:

- stable `turn_id`, `call_id`, and `message_id` identifiers on the live stream
- canonical persisted transcript rows embedded in successful tool/assistant events
- resume-by-event-id replay support via `Last-Event-ID` or `last_event_id`
- a live-only fallback when the requested replay cursor is missing from the in-memory buffer
- checked-in stream fixtures and standalone replay tests

The remaining open work for the broader transcript program is no longer Phase 2 stream semantics. It is the later assistant-delta and polish work described in Phases 4 and 5.
