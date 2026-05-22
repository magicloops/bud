# fix-drizzle-push-mismatch

Implementation planning documents for making `pnpm db:push` converge cleanly after the Drizzle/PostgreSQL constraint metadata mismatch investigation.

## Purpose

This folder turns [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md) into an actionable service database cleanup plan.

The plan assumes:

- `agent_question_request` has already been pushed successfully to the local database
- the repeated warning is caused by Drizzle/PostgreSQL metadata round-trip mismatches, not by a missing table
- PostgreSQL truncates identifiers longer than 63 bytes
- Drizzle Kit 0.31.6 introspects one-column PostgreSQL primary keys as column-level `.primaryKey()`
- the physical database schema should remain semantically unchanged
- checked-in migrations must remain the deployable path for staging

## Files

### `implementation-spec.md`

Parent implementation spec covering:

- root causes
- fixed decisions
- affected constraint families
- phase sequencing
- migration strategy
- risks and definition of done

### `phase-1-schema-normalization.md`

Schema cleanup phase covering:

- converting `thread_web_view.thread_id` to column-level `.primaryKey()`
- replacing long auto-generated FK names with explicit shorter names
- adding a snapshot/schema guardrail test for future migrations

### `phase-2-migration-and-convergence.md`

Migration and local validation phase covering:

- generating a new Drizzle migration and snapshot
- using data-preserving constraint renames where possible
- applying local schema changes
- running `db:push` twice to prove convergence

### `phase-3-guardrails-docs-and-handoff.md`

Finalization phase covering:

- service DB docs
- migration docs
- debug note closeout
- optional `db-push` preflight hardening
- staging/deploy handoff notes

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for local and migration-chain convergence.

## Dependencies

- [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md) - investigation and root-cause evidence
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - schema ownership and database conventions
- [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md) - checked-in migration chain
- [../../service/src/db/schema.ts](../../service/src/db/schema.ts) - Drizzle schema source of truth
- [../../service/src/scripts/db-push.ts](../../service/src/scripts/db-push.ts) - local push wrapper

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The current plan fixes the known non-converging constraints. A broader Drizzle metadata lint can later be expanded to indexes, unique constraints, check constraints, and future schemas.

---

*Referenced by: [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md)*
