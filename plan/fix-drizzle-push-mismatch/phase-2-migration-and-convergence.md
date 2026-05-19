# Phase 2: Migration And Convergence

## Objective

Produce a deployable checked-in migration and prove that local `db:push` converges after the schema cleanup.

## Migration Generation

Run from the service package:

```bash
pnpm --dir /Users/adam/bud/service db:generate
```

Review the generated SQL and snapshot before applying anything.

Expected snapshot changes:

- `thread_web_view.thread_id.primaryKey` becomes `true`
- `thread_web_view.compositePrimaryKeys` no longer contains `thread_web_view_pkey`
- affected FK metadata names use explicit names shorter than 63 bytes

Expected SQL intent:

- rename existing FK constraints to the new stable names
- avoid physical `thread_web_view_pkey` churn
- avoid table truncation or data-changing statements

## SQL Review Rules

Prefer data-preserving constraint renames:

```sql
ALTER TABLE "terminal_session_input_log"
  RENAME CONSTRAINT "terminal_session_input_log_session_id_terminal_session_session_"
  TO "terminal_session_input_log_session_fk";
```

Use guarded `DO $$ ... $$` blocks where needed so the migration is replay-safe across:

- local DBs that already accepted one or more `db:push` prompts
- staging DBs that only applied checked-in migrations
- disposable DBs built from the full migration chain

Do not keep a physical `thread_web_view_pkey` drop/add if the live constraint is already:

```sql
PRIMARY KEY("thread_id")
```

If Drizzle generates PK rewrite SQL solely because metadata moved from `compositePrimaryKeys` to column-level `primaryKey`, remove that SQL and keep the normalized snapshot.

## Local Apply

Run:

```bash
pnpm --dir /Users/adam/bud/service db:push
```

Approve only if the prompt contains the expected constraint cleanup and no table truncation/data-loss warning. If Drizzle still reports a destructive PK rewrite, stop and capture the output in the debug doc.

Then run the same command again:

```bash
pnpm --dir /Users/adam/bud/service db:push
```

The second run should report no repeated FK/PK rewrites.

## Optional Disposable DB Validation

When feasible, validate a migration-built database:

1. create a temporary local database
2. run `pnpm --dir /Users/adam/bud/service db:migrate` against it
3. run `pnpm --dir /Users/adam/bud/service db:push` against it

Expected result: no pending FK/PK drift after migrations.

## Spec Files To Update

- [ ] [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md)
- [ ] [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md)

## Acceptance Criteria

- [ ] new migration SQL is checked in
- [ ] new migration snapshot is checked in
- [ ] migration does not include table truncation
- [ ] migration does not physically rewrite `thread_web_view_pkey` for metadata-only normalization
- [ ] local `db:push` applies or confirms the cleanup
- [ ] immediate second local `db:push` is quiet for the known FK/PK mismatches
