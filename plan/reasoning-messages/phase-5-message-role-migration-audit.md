# Phase 5: Message Role Migration Audit

## Objective

Resolve the schema-review concern that reasoning support changed the message
role vocabulary without a checked-in Drizzle migration.

By the end of this phase, the branch should contain either:

1. a real checked-in Drizzle migration for the `reasoning` role, if the live or
   generated schema requires one, or
2. an explicit, reviewed no-migration rationale backed by Drizzle generation
   and database introspection evidence.

## Context

Reasoning messages added `reasoning` to `messageRoleValues` in
`service/src/db/schema.ts`.

Current local evidence:

- `messageRoleValues` is a TypeScript tuple used by
  `text("role", { enum: messageRoleValues })`.
- `message.role` is not declared with `pgEnum`.
- the latest checked-in Drizzle snapshot records `public.message.role` as
  physical `type: "text"` and does not track enum values for that column.
- the checked-in migration history does not define a `message_role`
  PostgreSQL enum.

That suggests this may be a TypeScript-only vocabulary change, but the branch
still needs an explicit audit because deployable schema changes require checked
migration coverage or a documented SQL-no-op decision.

## Audit Result

**Status**: Completed on 2026-06-08.

**Decision**: Outcome C, confirmed SQL no-op.

The `reasoning` role addition changes the TypeScript/Drizzle role vocabulary
only. The physical `message.role` column remains plain PostgreSQL `text`, with
no checked-in or live `message_role` enum and no role check constraint. Drizzle
does not generate SQL or metadata for this change, so there is no checked-in
migration to add.

Evidence:

- Repository search:

  ```bash
  rg -n "messageRoleValues|pgEnum|message_role|text\\(\"role\"" service/src/db/schema.ts service/drizzle/migrations
  ```

  Result: `messageRoleValues` is a TypeScript tuple in
  `service/src/db/schema.ts`, `message.role` is declared as
  `text("role", { enum: messageRoleValues })`, and no checked-in migration or
  schema file defines `pgEnum`/`message_role`.

- Latest checked-in Drizzle snapshot:

  ```bash
  sed -n '3740,3788p' service/drizzle/migrations/meta/0022_snapshot.json
  ```

  Result: `public.message.role` is recorded as physical `"type": "text"` with
  no enum values or check constraints in the snapshot.

- Drizzle generation from `service/`:

  ```bash
  pnpm db:generate
  ```

  Result:

  ```text
  No schema changes, nothing to migrate
  ```

- Local database introspection:

  ```sql
  select data_type, udt_name
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'message'
    and column_name = 'role';

  select typname
  from pg_type
  where typtype = 'e'
    and typname ilike '%message%role%';

  select conname, pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid = 'public.message'::regclass
    and pg_get_constraintdef(oid) ilike '%role%';
  ```

  Result:

  ```json
  {
    "column": [{ "data_type": "text", "udt_name": "text" }],
    "enums": [],
    "constraints": []
  }
  ```

Follow-up migration commands such as `pnpm db:push` and `pnpm db:migrate` were
not run because Drizzle generated no migration and the live schema already
matches the checked-in physical `text` contract.

## Scope

- Confirm the physical role column type from the latest checked-in Drizzle
  snapshot.
- Confirm whether a local live database has any `message_role` enum or check
  constraint that is not represented in the checked-in migrations.
- Run Drizzle generation from `service/` to determine whether the current
  `schema.ts` change produces SQL or metadata updates.
- If Drizzle generates a migration, review and commit the migration SQL plus
  metadata snapshot.
- If Drizzle generates no migration, document the no-op conclusion in the
  plan/checklists and keep the migration directory unchanged.
- Update DB/migration specs only if the audit changes the migration state or
  corrects prior documentation.

## Decision Tree

### Outcome A: Drizzle Generates A Migration

Use this path if `pnpm db:generate` produces a new migration or snapshot diff.

Required work:

- inspect the generated SQL and metadata
- verify it only captures the intended `reasoning` role change
- run `pnpm db:push` locally and confirm convergence
- run `pnpm db:migrate` against a scratch/staging-like database if available
- update `service/drizzle/migrations/migrations.spec.md`
- update `service/src/db/db.spec.md`
- update the reasoning-message progress and validation checklists

### Outcome B: Live DB Has A Physical Enum Or Constraint

Use this path if database introspection finds a real enum/check constraint even
though the checked-in migration snapshots currently show `text`.

Required work:

- identify where the physical enum or constraint came from
- decide whether the branch must normalize the schema back to the checked-in
  `text` contract or add a migration to support that physical constraint
- if a PostgreSQL enum exists and should remain, add a migration equivalent to
  `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'reasoning'`
- update migration specs with the schema-drift finding
- add a debug note if the drift source is not obvious

### Outcome C: Confirmed SQL No-Op

Use this path if Drizzle generation produces no migration and introspection
confirms `message.role` is plain `text`.

Required work:

- capture the commands and results in this phase doc or a linked debug note
- remove or correct any doc language implying a physical `message_role` enum
- leave `service/drizzle/migrations/` unchanged
- keep the reasoning-message checklist explicit that the migration status was
  audited, not assumed

## Suggested Commands

From the repository root:

```bash
rg -n "messageRoleValues|pgEnum|message_role|text\\(\"role\"" service/src/db/schema.ts service/drizzle/migrations
```

From `service/`:

```bash
pnpm db:generate
pnpm db:push
pnpm db:migrate
```

Database introspection queries:

```sql
select data_type, udt_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'message'
  and column_name = 'role';

select typname
from pg_type
where typtype = 'e'
  and typname ilike '%message%role%';

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.message'::regclass
  and pg_get_constraintdef(oid) ilike '%role%';
```

## Acceptance Criteria

- [x] Latest Drizzle snapshot role-column type is checked and documented.
- [x] Local live database role-column type is checked and documented.
- [x] `pnpm db:generate` result is checked and documented.
- [x] If SQL is generated, the migration SQL and metadata are checked in.
  Not applicable: no SQL or metadata was generated.
- [x] If SQL is not generated, the no-op rationale is documented.
- [x] `service/drizzle/migrations/migrations.spec.md` is updated if a new
  migration is added, or records the no-op rationale when no migration is
  generated.
- [x] `service/src/db/db.spec.md` is corrected if the audit changes the
  current no-op conclusion.
- [x] Reasoning-message progress and validation checklists reflect the final
  migration decision.

## Test Plan

- Run the generated migration path on a scratch database if Outcome A or B
  applies.
- Run a second `pnpm db:push` after applying any generated migration to confirm
  there is no lingering Drizzle diff.
- Run the existing reasoning-message service tests if code changes are needed.
- For Outcome C, no code tests are required beyond documenting the schema audit
  because no runtime code changes should be made.

## Risks

- Drizzle may not emit a migration for TypeScript-only enum metadata even when
  reviewers expect one; the phase must make that distinction explicit.
- A local database may have drifted from checked-in migrations through prior
  `db:push` experiments; do not treat local drift as proof that staging needs
  the same migration.
- Adding an empty or cosmetic migration could make future Drizzle diffs harder
  to reason about. Prefer a documented no-op over a migration with no SQL
  effect.
