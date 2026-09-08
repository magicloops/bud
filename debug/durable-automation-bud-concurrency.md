# Debug: Cross-process automation capacity

## Observation

The dormant worker limits concurrency only within its process. Independent workers can claim different threads belonging to the same Bud, exceeding the intended shared-filesystem automation cap.

## Approach

Filter full Buds before choosing a candidate, then acquire a transaction-scoped advisory lock for that Bud and recheck capacity in a fresh statement before reserving a thread. The default is one automated reservation per Bud, configurable on the repository (1–32, same setting on all workers). Human invocations do not consume this cap. Existing continuation reservations retain their slot; unresolved actions in review retain capacity until explicitly reconciled. Preflight availability deferral releases it when no continuation exists. No daemon or database schema change is needed. The worker remains disabled pending the remaining phase 5 gates.

## Validation

Use independent repository instances against local PostgreSQL: simultaneous different-thread claims, capacity release on preflight defer, review retention, unaffected human admission and progress on a different Bud.

The first PostgreSQL run (`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/agent/invocation-repository.test.ts`) found `TypeError: (intermediate value) is not iterable` at the advisory-lock SELECT. A Drizzle select builder without `from` was not an executed row query. Changed this scalar lock query to `tx.execute` and read its typed `rows` result before continuing validation.

The concurrent `pnpm build` run reported the same issue as `TS2488: Type PgSelectBuilder must have a [Symbol.iterator]() method`. The scalar-query fix resolves both the runtime and compile-time problem. The full repository PostgreSQL fixture now passes, including its new capacity subtest.
