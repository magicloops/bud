# Phase 3: Live-Only Attach And Handoff

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Flip the shipped agent-stream contract so fresh no-cursor attach is live-only, while preserving only a bounded cursor-based catch-up window and aligning the docs/fixtures/handoffs with that behavior.

By the end of this phase:

- no-cursor `GET /api/threads/:thread_id/agent/stream` is live-only
- cursor-based resume provides only a bounded catch-up window
- unknown or expired resume cursors produce explicit `resync_required`
- passive reopen of a completed thread is stable
- docs, fixtures, and specs all describe the same contract

## Current Problem

The current no-cursor attach behavior lives inside the shared SSE event bus:

- `service/src/runtime/event-bus.ts` replays the entire buffer when no cursor is provided
- `service/src/routes/threads.ts` passes agent-stream attaches directly into that generic behavior

That is now the exact behavior we need to remove for the agent stream, but not necessarily for every other SSE route.

## Scope

### In Scope

- agent-stream-specific attach policy
- replay tests and fixtures for passive open and reconnect
- backend handoff/protocol/spec updates
- manual validation of completed-thread reopen and active-turn open

### Out Of Scope

- redesigning terminal-stream replay semantics
- durable multi-instance runtime state or replay
- iOS client implementation work beyond backend-facing handoff docs

## Contract Direction

Target agent-stream behavior:

- no cursor: live-only attach, optional heartbeat, no buffered `agent.*` replay
- valid cursor present in the resume window: replay only effects strictly after that cursor
- stale or missing cursor: explicit `resync_required`

This change should apply to the agent stream only unless another stream gets its own reviewed design update.

The stream is not history. It is only transport plus a short server-owned catch-up window.

## Implementation Tasks

### Task 1: Add an explicit attach policy and bounded resume window

Implement an agent-stream-specific way to express:

- `live_only_if_no_cursor`
- `bounded_resume_if_cursor_present`

Candidate shapes:

- an attach option on `SseEventBus`
- an `AgentEventBus` wrapper helper
- route-level logic that requests no replay without changing other stream callers

Preferred direction:

- make the policy explicit in code rather than depending on ad hoc route behavior

The implementation should keep the resume window intentionally small:

- enough to cover `/agent/state` -> `/agent/stream` attach races
- enough to cover short reconnects
- not large enough to encourage treating the stream as history

### Task 2: Add explicit `resync_required`

Do not silently drop resume failures and do not force the client to infer gaps.

Choose and document one explicit recovery surface such as:

- HTTP `409` / `410`
- an initial SSE event like `agent.resync_required`

The important part is not the exact carrier. It is that the server owns the decision and makes it explicit.

The final mobile handoff for this phase should make that contract unambiguous.

### Task 3: Update agent-stream tests

Add or update coverage for:

- no-cursor attach does not replay buffered agent events
- valid cursor replays only newer effects within the bounded window
- stale cursor produces explicit `resync_required`
- terminal or other stream behavior does not regress unintentionally

### Task 4: Update fixtures

Add or revise examples for:

- passive open of a completed thread
- active-turn open using `/agent/state` plus `stream_cursor`
- reconnect with valid cursor
- reconnect with stale cursor and explicit `resync_required`

### Task 5: Update protocol/spec/handoff docs

Update:

- `docs/proto.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `reference/IOS_MOBILE_BACKEND_HANDOFF.md`
- `reference/IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md`
- `reference/IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md`
- `reference/AGENT_STREAM_EVENT_FIXTURES.md`
- `bud.spec.md`

The last-phase handoff doc should reflect the refined message plainly:

- state is truth
- stream is transport
- messages are history
- replay is only bounded reconnect convenience

If we decide to keep `Last-Event-ID` / `last_event_id` as the transport carrier for the cursor, the handoff should say so explicitly.
If we add a clearer `after=<cursor>` alias, the handoff should present that as the preferred mobile-facing form.

### Task 6: Run end-to-end validation

Manually validate:

- reopen completed thread
- open thread while turn is active
- reconnect during active turn
- resume failure and resync
- failure and cancel cleanup

Capture final results in [validation-checklist.md](./validation-checklist.md).

## Validation Checklist

- [ ] no-cursor agent-stream attach sends only heartbeat/live continuation
- [ ] completed-thread reopen no longer flashes stale tool/draft/stop-button state
- [ ] valid cursor replay still fills reconnect gaps
- [ ] stale cursor produces explicit `resync_required`
- [ ] active-turn open still works with `/agent/state` plus `stream_cursor`
- [ ] terminal-stream attach behavior is unchanged
- [ ] protocol/spec/handoff docs all describe the same semantics

## Exit Criteria

This phase is done when the backend contract can be described unambiguously as:

1. `/messages` is the durable transcript baseline
2. `/agent/state` is the explicit current-turn bootstrap surface and includes a resume token
3. `/agent/stream` is live-only by default and only provides bounded catch-up when the client explicitly resumes from a cursor
4. resume failure is explicit and the client recovers by refetching `/messages` plus `/agent/state`
