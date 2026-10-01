# Phase 1: Worker Wakeups and Invocation Status

**Status:** Not started. **Request:** R1. **Dependency:** Phase 0 baseline.
**Parent:** [Implementation spec](implementation-spec.md).

## Outcome

Eligible committed work starts when execution capacity is available. Clients can
distinguish queued, preflight, running and waiting work without speculative refreshes.

## Scheduling design

- Extract claim scheduling from execution in `invocation-worker.ts`. Today's
  `runOnce()` awaits the complete execution and includes maintenance scans.
- Provide a coalescing local `wake()` and one serialized claim pump. Reserve slots
  while claiming so overlapping hints cannot exceed concurrency. Launch claimed
  executions without awaiting their completion in the pump; refill on completion.
- Stop draining on no eligible claim or full capacity. Avoid tight retries when
  `SKIP LOCKED`/automation locks mean a null claim is temporary contention.
- Keep the existing claim SQL, fairness, thread reservation, lease heartbeat and
  fencing rules. Preserve stop/generation guards around an in-flight DB claim.
- Initially retain the one-second fallback scheduling bound. Run recovery/expiry
  once per maintenance cycle, not once per free execution slot. A longer idle
  interval is a later measured adjustment with retry/deadline tests.

## Post-commit coverage

Use one service-owned post-commit hook boundary, following the existing
`invocation-timing.ts` pattern. Cover ordinary admission, creation with a first
message, automation/bootstrap admission, answer/approval/browser continuation,
cancellation or completion freeing a reservation, and recovery making work eligible.
Nested transaction callers must publish/wake after their outer transaction commits.
Rollback publishes nothing. Hints may be lost; periodic eligibility checks remain.

Do not add a PostgreSQL listener for worker hints under the confirmed one-process
topology. If Phase 0 finds another actual worker topology, revise this section before
implementation and account for pool connections rather than silently adding one.

## Event contract

Add one named SSE event, `agent.invocation_changed`, carrying the canonical public
invocation identity/status projection (invocation, turn and input-message IDs,
status and safe reason; client identity when available). Reuse the existing public
invocation serializer and strip private execution/lease details. The SSE `id:` uses
the existing thread stream cursor. `/agent/state.invocations` remains recovery truth.

Publish actual committed transitions, including waiting, resumption, cancellation,
expiry, recovery and completion. Claim corresponds to `leased`; `running` follows
successful preflight. Lease renewal alone emits no status event. Do not infer the
committed result from the requested `finish` argument: repository policy may choose
`needs_review` or cancellation instead.

Before shipping, prove ordered publication per invocation under delayed commit
callbacks. Reuse a serialized publication boundary or reload current committed
state before ordered publication; do not treat heartbeat-updated timestamps as a
reliable lifecycle revision. State bootstrap and replay must not regress status.
Record the selected mechanism and exact payload fixture here and in `docs/proto.md`.

## Client adoption

Render queued admission immediately from the send receipt. Map lifecycle events
to progress without inventing output activity. Update web named-event handlers and
mobile fixtures; unknown-event tolerance alone does not provide this behavior.
Remove the short silence-triggered full refresh only after status/recovery tests
pass. Preserve targeted state recovery after disconnect, resync or prolonged silence.

## Validation and files

Test rollback/no wake, nested commits, many coalesced wakes, four independent queued
threads with free slots, same-thread exclusion, refill, contention, future retry,
expiry/recovery, stop during claim, and failed publication followed by recovery.
Use controlled scheduling assertions rather than wall-clock sleep thresholds.
Verify owner isolation, all status transitions and reordered callback scenarios.

Primary files: invocation worker/repository/timing/view/executor, service composition,
automation/bootstrap admission and continuation writers, agent routes/runtime and
web stream reducers. Update agent/runtime/personal-data/routes specs and protocol.
Create a debug note before fixing the confirmed scheduling issue.

Acceptance: no mandatory one-second staircase with idle slots; no duplicate execution
or weakened fences; measured queue improvement with first-output results reported
separately. Additive event rollout needs no daemon update or schema by default.
