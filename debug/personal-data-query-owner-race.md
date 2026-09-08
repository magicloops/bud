# Debug: Recheck query thread ownership before delivery

## Environment and reproduction

Service personal-data tool execution, manual or durable turns. Authorize the
thread, hold the data query, then delete the thread or change thread/Bud ownership
before resolving the query. Use injected authorization/query functions so the
interleaving is deterministic and does not mutate an actual user's resources.

## Observed

`PersonalDataToolExecutor.execute` checks thread/Bud ownership before reading.
After the query it checks the automation binding and cancellation, but not
thread ownership. Manual queries have no automation binding to invalidate.

## Expected and fix

Withhold the query payload if current thread/Bud ownership no longer matches the
admitted owner. Repeat the existing ownership helper after the awaited query and
ceiling check, before returning evidence to transcript/provider paths. Preserve
the fixed `not_found` result and omit data/permission metadata on rejection.
Test revocation while a query is held and cancellation during the final check.
This closes the observed read interval; it does not claim transactional locking
through subsequent transcript persistence.

## Specs

Update `service/src/agent/agent.spec.md`; validation families Q1/Q2.

## Verification

Before the fix, `pnpm exec node --import tsx --test src/agent/personal-data-tools.test.ts`
failed both new regressions: ownership-loss returned `ok: true` (`true !== false`)
and final-check cancellation produced `Missing expected rejection (AbortError)`.
Evidence: `/tmp/bud-query-owner-race-before.log`.

After the fix, the consolidated PostgreSQL/service suite passed 77 tests with
zero failures/skips (`/tmp/bud-personal-data-consolidated-tests.log`). Service
`pnpm build` passed (`/tmp/bud-query-owner-race-build.log`). These deterministic
executor tests establish withholding behavior, not a live account-switch demo.
