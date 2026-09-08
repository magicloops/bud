# Debug: Durable invocation review release

## Environment and reproduction
Phase 5 invocation repository, local PostgreSQL. Expire a running lease after an
action intent is recorded; recovery marks it `needs_review` and retains its thread.

## Observed / expected
The reservation correctly prevents replay, but the owner has no explicit way to
acknowledge the uncertain effects and abandon the invocation after inspection.

## Proposed fix
Add an owner/thread-scoped, optimistic-state-checked abandonment operation for
`needs_review` only. Preserve action evidence, record a completed owner-review
audit action, fence the old executor and release the reservation atomically.
Do not mark uncertain actions successful or dispatch them again. Expose through
an ownership-authorized route with an explicit uncertainty acknowledgement.

## Validation
`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/agent/invocation-repository.test.ts`: 5 passed, including concurrent acknowledgement, owner/thread isolation, stale state, preserved action intent and old-fence rejection.
`pnpm --dir service exec node --import tsx --test src/routes/threads/agent-question-response.test.ts src/routes/threads/registration.test.ts` initially reported `Expected values to be strictly deep-equal`, with actual route set containing the new `POST /api/threads/:threadId/agent/invocations/:invocationId/abandon` route. Updated the explicit endpoint fixture for the added route.
