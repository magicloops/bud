# Debug: Personal-data composite foreign key creation order

## Environment

Local PostgreSQL `localhost:5432/bud`, Drizzle Kit 0.31.x, main service schema. No LLM involved.

## Reproduction and observation

After adding owner-composite references from epoch/event/job, run `pnpm db:push` in `service/` and inspect the proposed SQL. The diff places `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (id, owner)` before `CREATE UNIQUE INDEX` for the referenced pair. Such a reference needs uniqueness when the FK is created.

The proposed SQL was declined before execution. The command exited successfully with `[x] All changes were aborted`; no failed migration was applied.

## Fix

Use table-level Drizzle `unique()` constraints for referenced `(id, created_by_user_id)` pairs, keeping other access/dedupe indexes as indexes. Drizzle emits those constraints with CREATE TABLE, before FK installation. Review the next generated push SQL and checked-in migration. Update the personal-data/DB specs with the resulting migration evidence.
