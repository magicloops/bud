# Debug: Personal-data PostgreSQL integration fixture failure

## Environment

2026-09-04, `/Users/adam/bud/service`, local PostgreSQL `localhost:5432/bud`. No LLM or external service involved. New personal-data schema applied via `pnpm db:push`; generated migration `0024_true_luminals.sql` reviewed. Initial proposed FK/index ordering was declined before execution and corrected as recorded in `personal-data-composite-fk-order.md`.

## Exact command

Run from `/Users/adam/bud/service`:

```sh
BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/personal-data/repository.test.ts
```

Exit code: 1.

## Exact output

```text
TAP version 13
# Subtest: Postgres ingestion: atomic jobs, retries, conflicts, owner boundaries and revocation
not ok 1 - Postgres ingestion: atomic jobs, retries, conflicts, owner boundaries and revocation
  ---
  duration_ms: 75.760708
  location: '/Users/adam/bud/service/src/personal-data/repository.test.ts:1:419'
  failureType: 'testCodeFailure'
  error: |-
    Failed query: insert into "auth"."user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") values ($1, $2, $3, default, default, default, default), ($4, $5, $6, default, default, default, default)
    params: data-test-be2847b8-1b05-4c42-a683-1896371ab1e4,Ingestion fixture,data-test-be2847b8-1b05-4c42-a683-1896371ab1e4@example.invalid,data-test-f3f014a1-2612-497f-90a8-05013982f9c9,Ingestion fixture,data-test-f3f014a1-2612-497f-90a8-05013982f9c9@example.invalid
  code: 'ERR_TEST_FAILURE'
  stack: |-
    NodePgPreparedQuery.queryWithCache (/Users/adam/bud/service/node_modules/.pnpm/drizzle-orm@0.44.7_@types+pg@8.15.6_kysely@0.28.12_pg@8.16.3/node_modules/src/pg-core/session.ts:73:11)
    process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    async TestContext.<anonymous> (/Users/adam/bud/service/src/personal-data/repository.test.ts:32:3)
    async Test.run (node:internal/test_runner/test:980:9)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 333.057292
```

## Expected and current evidence

Fixture owners should be inserted before testing concurrent dedupe, payload conflicts, owner separation, rollback at job persistence and epoch revocation. Failure happened during fixture creation, so none of those database assertions ran. The output wraps the query and does not expose the underlying PostgreSQL cause. No further diagnosis or alternative command was attempted, following AGENTS.md §3.5.

Previously passed:

- `pnpm exec node --import tsx --test src/personal-data/parser.test.ts src/personal-data/routes.test.ts`: 7/7 tests.
- `pnpm build`: passed before the composite-uniqueness schema adjustment and addition of `repository.test.ts`; final working tree still needs a build.
- `pnpm db:push`: reviewed corrected additive SQL and applied successfully locally.
- `pnpm db:generate`: generated `0024_true_luminals.sql` and metadata; SQL reviewed for five new tables, owner FKs and indexes.

## Next step for human guidance

Determine the underlying fixture INSERT failure before changing application behavior. Possible local auth-schema/default mismatch is unverified; do not infer an ingestion failure from this output. Once authorized to resume debugging, inspect the PostgreSQL cause and fixture schema requirements, fix only the confirmed cause, then rerun the failed integration test and final build. Continue remaining implementation phases afterward; no phase is complete.

## Resumed diagnosis

Read-only information_schema inspection confirmed that local `auth.user.emailVerified` is NOT NULL with no database default. The test omitted it, relying on the Drizzle declaration's default, while Better Auth owns the actual table. Fix the synthetic fixture to provide `emailVerified: false` explicitly. Do not modify live auth schema to accommodate a test.

## Fix verification

Explicit `emailVerified: false` resolved fixture creation. `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/personal-data/repository.test.ts` passed all assertions (concurrent dedupe, conflicts, separate owners, event/job rollback and epoch revocation). `pnpm build` from `service/` then passed for the current service tree.
