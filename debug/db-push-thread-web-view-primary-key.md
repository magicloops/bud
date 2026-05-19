# Debug: db:push Non-Converging Constraint Diff

## Environment

- OS: macOS
- Package: `service`
- Drizzle Kit: `0.31.6`
- Drizzle ORM: `0.44.7`
- Database: local PostgreSQL from `DATABASE_URL` or the service default `postgres://postgres:postgres@localhost:5432/bud`
- Command under investigation: `pnpm --dir /Users/adam/bud/service db:push`

## Repro Steps

1. Add the `agent_question_request` schema to `service/src/db/schema.ts`.
2. Generate the checked-in migration with `pnpm --dir /Users/adam/bud/service db:generate`.
3. Run `pnpm --dir /Users/adam/bud/service db:push`.
4. Accept the interactive prompt.
5. Run `pnpm --dir /Users/adam/bud/service db:push` again.

## Observed

The first `db:push` correctly detected the new `agent_question_request` table, but also proposed unrelated schema rewrites:

```sql
CREATE TABLE "agent_question_request" (...);

ALTER TABLE "thread_web_view" DROP CONSTRAINT "thread_web_view_pkey"
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_pkey" PRIMARY KEY("thread_id");
```

Drizzle marked the primary-key rewrite as a data-loss risk:

```text
Found data-loss statements:
· You're about to change thread_web_view primary key. This statements may fail and you table may left without primary key

THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED

Do you still want to push changes?
❯ No, abort
  Yes, I want to truncate 1 table
```

After the prompt was accepted and `db:push` succeeded, the next `db:push` still proposed the same unrelated constraint rewrites:

```sql
ALTER TABLE "terminal_session_input_log" DROP CONSTRAINT "terminal_session_input_log_session_id_terminal_session_session_";
ALTER TABLE "terminal_session_input_log" ADD CONSTRAINT "terminal_session_input_log_session_id_terminal_session_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."terminal_session"("session_id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "thread_web_view" DROP CONSTRAINT "thread_web_view_pkey"
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_pkey" PRIMARY KEY("thread_id");
```

This means the warning is not a one-time apply failure. The live diff is non-converging: applying the statements produces a database shape that Drizzle Kit still interprets as different on the next run.

## Expected

After a successful push, `db:push` should report no pending schema changes.

## Read-Only Catalog Evidence

After the successful push, the local database has the new table:

```json
{
  "agent_question_request": "agent_question_request",
  "thread_web_view_rows": "6"
}
```

The live local database also still has the expected primary key:

```json
{
  "conname": "thread_web_view_pkey",
  "contype": "p",
  "def": "PRIMARY KEY (thread_id)"
}
```

The live indexes also match the expected primary-key index:

```json
{
  "indexname": "thread_web_view_pkey",
  "indexdef": "CREATE UNIQUE INDEX thread_web_view_pkey ON public.thread_web_view USING btree (thread_id)"
}
```

The local Drizzle migration tracking table exists but is still empty:

```json
{
  "migration_tables": [
    { "table_schema": "drizzle", "table_name": "__drizzle_migrations" }
  ],
  "recent_migrations": []
}
```

That is expected for `push`: it applies a live diff and does not mark checked-in migrations as run.

The live foreign-key constraints that Drizzle keeps dropping/readding are all stored at PostgreSQL's 63-byte identifier limit:

```json
[
  {
    "table_name": "terminal_session_input_log",
    "conname": "terminal_session_input_log_session_id_terminal_session_session_",
    "name_len": 63
  },
  {
    "table_name": "bud_operation",
    "conname": "bud_operation_transport_session_id_transport_session_transport_",
    "name_len": 63
  },
  {
    "table_name": "proxied_site_viewer_session",
    "conname": "proxied_site_viewer_session_proxied_site_id_proxied_site_proxie",
    "name_len": 63
  }
]
```

The corresponding Drizzle snapshot names are longer than PostgreSQL can store:

```json
[
  {
    "table": "terminal_session_input_log",
    "expected_name": "terminal_session_input_log_session_id_terminal_session_session_id_fk",
    "expected_len": 68
  },
  {
    "table": "bud_operation",
    "expected_name": "bud_operation_transport_session_id_transport_session_transport_session_id_fk",
    "expected_len": 76
  },
  {
    "table": "proxied_site_viewer_session",
    "expected_name": "proxied_site_viewer_session_proxied_site_id_proxied_site_proxied_site_id_fk",
    "expected_len": 75
  }
]
```

## Code And Migration Evidence

`service/src/db/schema.ts` defines `thread_web_view` as:

```ts
pk: primaryKey({ columns: [table.threadId], name: "thread_web_view_pkey" })
```

The migration that introduced `thread_web_view` also created:

```sql
CONSTRAINT "thread_web_view_pkey" PRIMARY KEY("thread_id")
```

The generated `0019` migration for this branch contains only the new `agent_question_request` table, its foreign keys, and its indexes. It does not touch `thread_web_view`.

The generated `0018` and `0019` Drizzle snapshot metadata both record:

```json
"compositePrimaryKeys": {
  "thread_web_view_pkey": {
    "name": "thread_web_view_pkey",
    "columns": ["thread_id"]
  }
}
```

## Root Cause

There are two separate non-converging diffs.

### 1. Long Foreign-Key Names

Drizzle's generated FK names exceed PostgreSQL's 63-byte identifier limit. PostgreSQL truncates those names when the constraints are created. On the next `db:push`, Drizzle compares its full expected name against the truncated live name and decides the FK was renamed or changed.

Approving the prompt cannot fix this class of diff, because PostgreSQL will truncate the newly added long name again.

### 2. Single-Column Table-Level Primary Key

`service/src/db/schema.ts` defines `thread_web_view` with a one-column table-level primary key:

```ts
pk: primaryKey({ columns: [table.threadId], name: "thread_web_view_pkey" })
```

The Drizzle snapshots therefore store this under `compositePrimaryKeys`:

```json
"compositePrimaryKeys": {
  "thread_web_view_pkey": {
    "name": "thread_web_view_pkey",
    "columns": ["thread_id"]
  }
}
```

However, Drizzle Kit's PostgreSQL introspection path represents a live one-column primary key as a column-level primary key, not as a composite primary key. A targeted introspection of the live table emitted:

```ts
threadId: uuid("thread_id").primaryKey().notNull()
```

and no table-level `primaryKey({ columns: [table.threadId] })`.

Drizzle Kit 0.31.6's introspection code has this behavior explicitly:

- it only records a `compositePrimaryKeys` entry when the primary key spans more than one column;
- it sets `column.primaryKey = true` when exactly one column participates in the primary key.

So `db:push` sees:

- source schema: `thread_id.primaryKey === false`, `compositePrimaryKeys.thread_web_view_pkey` exists;
- live database after introspection: `thread_id.primaryKey === true`, `compositePrimaryKeys` is empty.

It then tries to convert the live representation into the source representation by dropping and re-adding the same physical primary key. PostgreSQL stores that as the same one-column PK, and the next introspection collapses it back to column-level again.

## Conclusion

This is not caused by the new `agent_question_request` schema. That table now exists locally.

The repeated prompt is caused by schema constructs that Drizzle Kit 0.31.6 cannot round-trip through PostgreSQL live introspection:

- auto-generated FK names longer than 63 bytes;
- a one-column primary key expressed with table-level `primaryKey(...)` instead of column-level `.primaryKey()`.

The live database is not missing the primary key. The warning repeats because Drizzle's source snapshot and live-introspection snapshot encode the same physical PK differently.

## Proposed Fix / Next Steps

Recommended fix:

- Change `threadWebViewTable.threadId` to use column-level `.primaryKey()` and remove the table-level `pk: primaryKey({ columns: [table.threadId], name: "thread_web_view_pkey" })`.
- Replace the affected inline `.references(...)` definitions with explicit `foreignKey({ name: "..." })` builders using stable names shorter than 63 bytes.
- Generate and review a checked-in migration for the FK renames. The primary-key representation change should be validated carefully because it is intended to align Drizzle metadata with the existing live PK, not change the physical constraint.
- Re-run `pnpm --dir /Users/adam/bud/service db:push` after the schema cleanup. The prompt should stop showing these FK and PK rewrites.

Operational guardrail:

- Consider making `service/src/scripts/db-push.ts` fail closed or print a clearer handoff when Drizzle proposes destructive statements. The current interactive text suggests truncating a table even when the underlying issue is a non-converging metadata diff.

## Status

Root cause identified. No repository schema cleanup has been applied yet.
