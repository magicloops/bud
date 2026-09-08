# Debug: Automation pause versus start

## Environment
Local PostgreSQL, durable invocation worker, service TypeScript.

## Reproduction and observations
Preflight reads an enabled rule, then a human pauses it before the worker's
separate start transaction. Without another check the invocation becomes running.
Cancellation also previously closed pending questions only in waiting_for_user,
missing a continuation deferred for model availability.

## Proposed fix
Serialize the final start transition with the same owner lock used by pause and
grant changes; recheck supported delivery policy before stamping model context.
If pause wins, defer the still-leased invocation. Pause uses shared transactional
cancellation, retaining running reservations and review evidence. Close pending
questions for any non-running cancellation, including availability waits.

## Validation
PostgreSQL fixture exercises pause after claim and before start, then successful
start after resume. Cancellation tests distinguish queued and active choices.
Relevant specs: agent/agent.spec.md and personal-data/personal-data.spec.md.
