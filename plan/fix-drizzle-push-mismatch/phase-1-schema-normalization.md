# Phase 1: Schema Normalization

## Objective

Update the Drizzle schema so PostgreSQL live introspection round-trips to the same metadata shape that `schema.ts` declares.

## Scope

### Primary Key Normalization

Change `threadWebViewTable.threadId` from:

```ts
threadId: uuid("thread_id")
  .notNull()
  .references(() => threadTable.threadId, { onDelete: "cascade" }),
```

plus:

```ts
pk: primaryKey({ columns: [table.threadId], name: "thread_web_view_pkey" })
```

to a column-level primary key:

```ts
threadId: uuid("thread_id")
  .primaryKey()
  .references(() => threadTable.threadId, { onDelete: "cascade" }),
```

If Drizzle typing requires a different method order, use the order that preserves:

- `PRIMARY KEY(thread_id)`
- `NOT NULL`
- FK to `thread(thread_id)`
- `ON DELETE cascade`

### Foreign-Key Name Normalization

Replace affected inline `.references(...)` calls with explicit `foreignKey({ name: "..." })` table-builder declarations where the generated name would exceed PostgreSQL's 63-byte limit.

Target names:

- `terminal_session_input_log_session_fk`
- `terminal_session_output_session_fk`
- `bud_operation_terminal_session_fk`
- `bud_operation_device_session_fk`
- `bud_operation_transport_session_fk`
- `bud_stream_device_session_fk`
- `bud_stream_transport_session_fk`
- `transport_session_device_session_fk`
- `proxied_site_viewer_grant_site_fk`
- `proxied_site_viewer_session_site_fk`

Preserve the existing referential actions exactly:

- terminal session output/input FKs: `ON DELETE cascade`
- operation/session stream optional references: `ON DELETE set null`
- proxied-site viewer FKs: `ON DELETE cascade`
- all unchanged `ON UPDATE no action`

## Guardrail Test

Add a focused service-side metadata test or script that fails if the latest Drizzle snapshot reintroduces this class of mismatch.

Minimum assertions:

- no FK, index, unique constraint, or primary key name exceeds 63 bytes
- no PostgreSQL `compositePrimaryKeys` entry has exactly one column

Preferred location:

- `service/src/db/schema-metadata.test.ts`

The test can read `service/drizzle/migrations/meta/_journal.json`, resolve the latest snapshot, and inspect the JSON metadata. It does not need a database connection.

## Spec Files To Update

- [ ] [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md)

## Acceptance Criteria

- [ ] TypeScript schema compiles
- [ ] `thread_web_view.thread_id` is represented as a column-level PK in generated snapshot metadata
- [ ] affected FK snapshot names are all shorter than 63 bytes
- [ ] guardrail test fails against the old snapshot shape and passes after regeneration

## Notes

- Do not rename unrelated constraints just for style consistency.
- Do not change table columns, nullability, or ownership fields.
- Keep the change limited to metadata representation and constraint names.
