# Phase 2: Atomic Thread Creation and First Message

**Status:** Service/web implemented; PostgreSQL repository/migration checks pass; route fixtures and mobile adoption remain. **Request:** R4. **Dependency:** Phase 1 wake integration.
**Parent:** [Implementation spec](implementation-spec.md).

## Outcome and API

Extend `POST /api/threads` with optional `opening_message` and an owner-scoped
`creation_key`. Require the key whenever an opening message is supplied. Reuse the
existing message admission schema for text, client ID, selection and supported
viewport/cwd fields; do not duplicate validation or expose internal owner fields.

Return `thread`, canonical `message`, public `invocation`, and the normal queued
`agent` receipt on the combined path. First success is `201`; an equivalent retry
is `200` with the same durable identities. Creation without an opening message
retains its existing semantics. No transcript revision is introduced.

Use the thread's explicit model preference as the initial default; an explicit
opening-message selection follows normal message-admission preference semantics.
Resolve absent defaults once on first admission. A retry must not select a newer
service default or create a second invocation. Freeze exact wire fixtures before
client implementation.

## Transaction and retry design

1. Resolve viewer, authorize Bud and validate the body before side effects.
2. In one transaction, acquire/create the owner/key receipt, insert the owned thread,
   call existing `admitInTransaction`, and associate its message/invocation IDs.
3. Use a unique `(created_by_user_id, creation_key)` constraint. Concurrent duplicate
   requests must converge through the transaction/unique-conflict path, not a
   read-then-insert check alone. Any failure rolls back the complete operation.
4. Compare a canonical fingerprint of the caller's semantic input, including Bud,
   text, client ID, explicit preferences and geometry. Distinguish omitted options
   where that changes semantics. Conflicting reuse returns `409` without side effects.
5. Persist only the fingerprint and durable references needed for recovery, with
   receipt ID, tenant and owner fields. Reauthorize referenced resources on retry.
   Retain the key reservation through thread deletion; return `404` for an unavailable
   owned result rather than creating a replacement thread from an old retry.
6. Publish admission and wake the worker only after commit. A lost HTTP response
   cannot lose the admitted work or cause duplicate work on retry.

Store receipt references rather than a mutable serialized thread/agent snapshot.
Retries return the same identities with current canonical state, not a claim that
the invocation is still queued. Document this distinction in fixtures.

## Stream attachment dependency

This phase can remove the create-then-send waterfall before Phase 3. Until Phase 3
lands, clients use existing canonical bootstrap/recovery after the create receipt.
Do not return a cursor captured after a fast worker has already emitted output and
pretend it covers that output. After Phase 3, use its shared open/bootstrap contract
for direct attachment; generating a fresh bootstrap on retry does not readmit work.

## Validation, schema and rollout

Cover lost responses, concurrent equivalent/conflicting requests, owner/key isolation,
foreign Buds, transaction rollback at each insert, invalid selection/geometry,
deletion then retry, and worker execution before the HTTP response. Confirm exactly
one thread, input message and invocation, with all owner stamps.

Work in thread core/shared routes and an appropriately scoped creation repository;
reuse invocation admission rather than a second queue. Add the receipt in `schema.ts`,
run local `pnpm --dir service db:push`, generate/review a checked-in migration and
validate migration application. Update DB/migration/thread-route specs and auth
validation. Receipt cleanup/TTL is not part of this phase.

Deploy the additive schema/service first, then web/mobile combined-create consumers.
Migration `0048_lush_timeslip.sql` is generated, reviewed and applied locally.
The updated web requires durable service mode; legacy mode returns an explicit 503.
No deployment or mobile version has been validated. Web production build passes.
Record exact migration and client versions. Rollback must preserve admitted rows
and receipt uniqueness. Acceptance requires retry/race tests and a measured reduction
in dependent new-chat requests without changing admission correctness.
