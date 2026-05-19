# Fix Drizzle Push Mismatch Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Static Validation

- [ ] latest Drizzle snapshot has no identifier names longer than 63 bytes
- [ ] latest Drizzle snapshot has no one-column `compositePrimaryKeys`
- [ ] affected FK names in `schema.ts` match the implementation spec
- [ ] `thread_web_view.thread_id` is column-level primary key in snapshot metadata
- [ ] migration SQL contains no table truncation statements
- [ ] migration SQL does not physically drop/readd `thread_web_view_pkey` unless explicitly justified

## Command Validation

Record exact commands and results:

- [ ] `pnpm --dir /Users/adam/bud/service exec node --import tsx --test <metadata-test>`
- [ ] `pnpm --dir /Users/adam/bud/service build`
- [ ] `pnpm --dir /Users/adam/bud/service db:generate`
- [ ] `pnpm --dir /Users/adam/bud/service db:push`
- [ ] repeat `pnpm --dir /Users/adam/bud/service db:push`

Expected second `db:push` result:

- no repeated long-FK drop/add block
- no `thread_web_view_pkey` drop/add block
- no data-loss warning for `thread_web_view`

## Catalog Validation

Run read-only catalog checks after local apply:

- [ ] `agent_question_request` still exists
- [ ] `thread_web_view_pkey` exists
- [ ] `thread_web_view_pkey` definition is `PRIMARY KEY (thread_id)`
- [ ] affected FK constraints exist under their new stable names
- [ ] affected FK definitions preserve columns, target tables, and `ON DELETE` behavior
- [ ] no old truncated affected FK names remain

## Optional Disposable DB Validation

- [ ] create temporary local database
- [ ] run `pnpm --dir /Users/adam/bud/service db:migrate`
- [ ] run `pnpm --dir /Users/adam/bud/service db:push`
- [ ] confirm no FK/PK drift after migration chain
- [ ] drop temporary database

## Documentation Validation

- [ ] `service/src/db/db.spec.md` describes the naming convention
- [ ] `service/drizzle/migrations/migrations.spec.md` lists the new migration
- [ ] `debug/db-push-thread-web-view-primary-key.md` includes final command outcomes
- [ ] PR/deploy handoff mentions the migration filename and the `db:push` convergence result

## Notes

- If any build/run command fails, capture the exact command and error output in the debug doc and stop for human guidance.
- Do not treat a successful first `db:push` as sufficient; the second run is the convergence proof.
