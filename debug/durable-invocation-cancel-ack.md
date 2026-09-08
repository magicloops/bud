# Debug: Durable cancellation acknowledgement and queued expiry

## Observation

The lease validator rejected cancellation requests on all methods, including `finish`. A worker could observe cancellation but could not commit its acknowledgement. Also, latest-start expiry only ran while claiming work, so stale items behind a reserved thread remained pending indefinitely.

## Fix

Separate dispatch permission from completion permission. Owner-stamped cancellation immediately finishes unstarted work, but running work retains its reservation until fenced acknowledgement or conservative lease recovery. Unresolved action intents remain `needs_review`. Poll a bounded skip-locked expiry pass independently of thread claim availability. Add owner/cancel/expiry integration tests.

## Continuation regression found during validation

Command: `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-repository.test.ts src/agent/invocation-worker.test.ts` in `service/`.

The new continuation fixture failed at `assert.ok(continued)` after answering a question, deferring for model availability, and making the invocation due again. Investigating claim eligibility and fence adoption across this second preflight; no worker has been enabled.

## Resolution

Drizzle's single-table SELECT projection removed qualification from an interpolated outer `id` inside a correlated subquery, comparing against the action's ID. Explicit `agent_invocation.id` qualification fixes the continuation deadline exemption. Waiting action fences now advance on every claim, including after availability deferral. Migration 0028 adds independent thread reservations so deferral cannot let queued work overtake a continuation. The local push omitted the index predicate change; the reviewed backfill/index replacement was applied in a transaction. PostgreSQL validation now passes, including direct unique-index rejection of an overtaking reservation.
