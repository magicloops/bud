# Debug: Invocation owner foreign-key migration order

## Environment and reproduction

Local PostgreSQL, Drizzle Kit 0.31.x. After adding invocation tables and referenced composite owner constraints to existing thread/message tables, run `pnpm db:generate` and inspect `0027_aspiring_triton.sql`.

## Observation

Drizzle emits new invocation foreign keys before adding the referenced composite unique constraints on existing tables. PostgreSQL requires those constraints first. Local `db:push` was canceled at its non-destructive unique-constraint prompt before applying changes.

## Proposed fix

Move the two generated unique-constraint statements ahead of dependent foreign keys in migration SQL, leaving generated metadata unchanged. Add the same two constraints locally before rerunning `db:push`; both include an existing primary key so they preserve all existing rows and cannot introduce duplicate data. No truncation is needed. Validate schema metadata and real PostgreSQL admission/concurrency tests. This is a migration-order adjustment, not a changed data model.

## Validation

The corrected SQL executes in the isolated-schema PostgreSQL test. `db:push` applied the reviewed new-table/FK/index statements after the two existing-table constraints were installed without truncation. Service compilation and invocation/schema tests pass. The canceled interactive command reported `Error: drizzle-kit push exited with code 1` (intentional Ctrl+C before changes); it was followed by the successful corrected push.
