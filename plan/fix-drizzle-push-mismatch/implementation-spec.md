# Implementation Spec: Fix Drizzle Push Mismatch

**Status**: Implemented
**Created**: 2026-05-19
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-schema-normalization.md](./phase-1-schema-normalization.md)
**Phase 2**: [phase-2-migration-and-convergence.md](./phase-2-migration-and-convergence.md)
**Phase 3**: [phase-3-guardrails-docs-and-handoff.md](./phase-3-guardrails-docs-and-handoff.md)
**Related Docs**:
- [../../debug/db-push-thread-web-view-primary-key.md](../../debug/db-push-thread-web-view-primary-key.md)
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md)
- [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md)

---

## Context

After `pnpm --dir /Users/adam/bud/service db:push` successfully applied the `agent_question_request` table, running the command again still proposed constraint rewrites and a data-loss warning:

- several FK constraints are dropped and re-added under long names
- `thread_web_view_pkey` is dropped and re-added as the same physical primary key

The live database already has `agent_question_request`, and `thread_web_view_pkey` is present and valid. The repeated prompt is a non-converging Drizzle Kit live-diff problem.

## Objective

Make the service schema and migration chain converge cleanly with PostgreSQL introspection:

- `db:push` should not repeatedly propose the same FK/PK rewrites after a successful apply
- the fix must preserve existing table data
- the physical `thread_web_view` primary key should remain `PRIMARY KEY(thread_id)`
- affected FKs should keep the same columns, targets, and delete/update behavior
- staging should receive a checked-in Drizzle migration
- future schema changes should have a guardrail against reintroducing this mismatch class

## Root Causes

### Long FK Names

Drizzle auto-generated several FK names longer than PostgreSQL's 63-byte identifier limit. PostgreSQL truncates the names when creating the constraints. Drizzle then compares its full expected names with the truncated live names and keeps trying to rewrite them.

### Single-Column Table-Level PK

`thread_web_view.thread_id` is a one-column primary key but is expressed in `schema.ts` as a table-level `primaryKey({ columns: [table.threadId] })`. Drizzle Kit introspects live one-column PostgreSQL PKs as column-level `.primaryKey()`, so the same physical PK round-trips as different metadata.

## Fixed Decisions

- Keep Drizzle ORM and Drizzle Kit versions unchanged for this fix.
- Do not rewrite old migration history.
- Do not use `db:push --force`.
- Do not rely on accepting the same prompt repeatedly.
- Express `thread_web_view.thread_id` with column-level `.primaryKey()`.
- Give affected FKs explicit names shorter than 63 bytes.
- Prefer migration SQL that renames existing FK constraints instead of dropping/recreating semantically identical FKs.
- Treat PK metadata normalization as a source/snapshot fix; do not physically drop/recreate `thread_web_view_pkey` unless validation proves it is unavoidable.

## Affected Constraints

| Table | Current Live Name Pattern | Proposed Stable Name |
|-------|---------------------------|----------------------|
| `terminal_session_input_log` | `terminal_session_input_log_session_id_terminal_session_session_` | `terminal_session_input_log_session_fk` |
| `terminal_session_output` | `terminal_session_output_session_id_terminal_session_session_id_` | `terminal_session_output_session_fk` |
| `bud_operation` | `bud_operation_terminal_session_id_terminal_session_session_id_f` | `bud_operation_terminal_session_fk` |
| `bud_operation` | `bud_operation_device_session_id_device_session_device_session_i` | `bud_operation_device_session_fk` |
| `bud_operation` | `bud_operation_transport_session_id_transport_session_transport_` | `bud_operation_transport_session_fk` |
| `bud_stream` | `bud_stream_device_session_id_device_session_device_session_id_f` | `bud_stream_device_session_fk` |
| `bud_stream` | `bud_stream_transport_session_id_transport_session_transport_ses` | `bud_stream_transport_session_fk` |
| `transport_session` | `transport_session_device_session_id_device_session_device_sessi` | `transport_session_device_session_fk` |
| `proxied_site_viewer_grant` | `proxied_site_viewer_grant_proxied_site_id_proxied_site_proxied_` | `proxied_site_viewer_grant_site_fk` |
| `proxied_site_viewer_session` | `proxied_site_viewer_session_proxied_site_id_proxied_site_proxie` | `proxied_site_viewer_session_site_fk` |

`thread_web_view_pkey` keeps the same name and physical columns, but its Drizzle schema representation changes from table-level one-column composite PK metadata to column-level PK metadata.

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-schema-normalization.md](./phase-1-schema-normalization.md) | `schema.ts` expresses the PK and affected FKs in a Postgres-introspection-stable way |
| 2 | [phase-2-migration-and-convergence.md](./phase-2-migration-and-convergence.md) | checked-in migration and local DB validation prove `db:push` converges |
| 3 | [phase-3-guardrails-docs-and-handoff.md](./phase-3-guardrails-docs-and-handoff.md) | specs, debug doc, guardrails, and deploy notes reflect the fix |

## Current Code Map

- `service/src/db/schema.ts` owns all Drizzle table definitions and affected FK/PK declarations.
- `service/drizzle/migrations/` owns checked-in SQL and metadata snapshots.
- `service/drizzle/migrations/meta/_journal.json` must be updated by Drizzle, not manually.
- `service/src/scripts/db-push.ts` wraps Better Auth migration prep and then delegates to `drizzle-kit push`.
- `service/src/db/db.spec.md` and `service/drizzle/migrations/migrations.spec.md` must describe any schema/migration behavior that changes.

## Migration Strategy

Generate the next Drizzle migration after updating `schema.ts`, then review it carefully:

- Keep the generated metadata snapshot so future `db:generate` diffs use the normalized schema as baseline.
- Replace any semantically identical FK drop/add statements with guarded `ALTER TABLE ... RENAME CONSTRAINT ... TO ...` statements where practical.
- Remove any physical `thread_web_view_pkey` drop/add if the only change is metadata representation. The existing live PK is already correct.
- Keep the migration replay-safe for environments that have either the old truncated names or the new stable names.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Migration drops and recreates FKs unnecessarily | Medium | Medium | Prefer guarded constraint renames and review generated SQL |
| PK normalization generates destructive-looking SQL | High | Medium | Treat it as metadata-only and remove no-op PK rewrite from migration SQL after review |
| Future schema changes reintroduce long names | Medium | Medium | Add a snapshot/schema guardrail test for 63-byte identifier limits |
| Existing local DB differs from staging | Medium | Medium | Validate current local DB and a disposable migration-built DB when feasible |
| `db:push` still reports drift after first apply | Medium | High | Make rerunning `db:push` part of required validation |

## Definition Of Done

- [x] `schema.ts` uses column-level `.primaryKey()` for `thread_web_view.thread_id`
- [x] affected FKs have explicit stable names shorter than 63 bytes
- [x] checked-in migration updates FK names without data loss
- [x] latest Drizzle snapshot has no affected FK names over 63 bytes
- [x] latest Drizzle snapshot has no one-column `compositePrimaryKeys`
- [x] `pnpm --dir /Users/adam/bud/service db:push` applies the cleanup locally
- [x] rerunning `pnpm --dir /Users/adam/bud/service db:push` reports no repeated FK/PK rewrite warning
- [x] service DB and migration specs are updated
- [x] debug note is updated with the implemented resolution
