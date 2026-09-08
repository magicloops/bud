# Debug: Contacts repair fixture races background publication

## Environment and reproduction

Local PostgreSQL with the development service running. From `service/`:

```sh
BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/personal-data/*.test.ts src/agent/invocation*.test.ts src/agent/app-permission-tool.test.ts src/agent/personal-data-tools.test.ts src/invocation-startup.test.ts
```

## Observed

`/tmp/bud-personal-data-consolidated-tests.log`: 74 passed, one failed.
`contact-repair.test.ts:64` expected `publishNext(false, owner)` to return true;
actual false (`ERR_ASSERTION`, `false !== true`). Focused runs previously passed.

## Hypothesis and fix

The fixture commits into public tables. Its owner filter constrains its own
processor, but does not exclude the running service's global worker. A worker
can publish the complete baseline before the fixture's explicit publication.
Isolate this deterministic interleaving test in a randomly named schema, with
real indexed table copies and a dedicated multi-connection pool. Keep concurrent
publication and exact-state assertions; do not weaken them to accept missing work.
Drop only the test-owned schema on completion. FK migration validation remains
covered separately; table copies do not claim to validate those constraints.

## Specs

Update the personal-data spec's repair-test description and current evidence.

## Validation

The isolated repair test passed, followed by the full 75-test suite with no
failures or skips. `pnpm build` passed from `service/`:
`/tmp/bud-repair-isolation-service-build.log`. The original failure is consistent
with competing publication; isolation removes that interference without changing
production behavior or relaxing publication assertions.
