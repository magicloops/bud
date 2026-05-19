# Phase 3: Guardrails, Docs, And Handoff

## Objective

Close the loop so the fix is documented, future schema work avoids this class of mismatch, and deploy handoff is explicit.

## Guardrails

Add or document a guardrail that catches future PostgreSQL identifier round-trip risks before `db:push` surprises the developer.

Minimum durable guardrail:

- a service test that scans the latest Drizzle snapshot for identifiers longer than 63 bytes
- a service test that rejects one-column `compositePrimaryKeys`

Optional follow-up:

- add a preflight call in `service/src/scripts/db-push.ts` that runs the same metadata check before delegating to `drizzle-kit push`
- print a targeted message pointing developers at this plan/debug doc when the preflight fails

## Docs

Update:

- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) with the constraint naming convention and `thread_web_view` PK representation note
- [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md) with the new migration summary
- [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md) with the implemented resolution and final validation result

## Deployment Handoff

The PR/deploy note should call out:

- the migration is metadata/constraint-name cleanup, not a data model change
- affected FKs keep the same columns and referential actions
- `thread_web_view_pkey` remains physically unchanged
- staging should use `pnpm db:migrate`, not `db:push`
- local validation included a clean rerun of `pnpm db:push`

## Validation Record

Record command results in [validation-checklist.md](./validation-checklist.md):

- schema metadata test
- service build or focused test command
- `db:generate`
- first `db:push`
- second `db:push`
- optional disposable DB migration-chain check

If any command fails, copy the exact command and output into [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md) and stop for human guidance.

## Acceptance Criteria

- [ ] docs/specs describe the fixed constraint naming and PK representation
- [ ] debug note status is closed or updated with remaining risk
- [ ] validation checklist includes exact commands run
- [ ] deployment handoff explains that migrations, not `db:push`, are the staging path
- [ ] optional `db-push` preflight is either implemented or explicitly deferred
