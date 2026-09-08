# Debug: app permission HTTP date fixture

## Environment and reproduction

Local PostgreSQL and Node/tsx on macOS. Run from `service/`:
`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-app-data.test.ts`.

## Observed

`AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal`
at `invocation-app-data.test.ts:110:10`. HTTP `created_at` was the string
`2026-09-05T02:05:07.893Z`; the expected repository value was a Date representing
the same instant. The other date fields differed in the same way.

## Expected and fix

Compare the HTTP response to JSON-normalized repository metadata. Convert the
repository setup expiry to an ISO string before passing it to the standalone
backend helper, whose public contract accepts the wire representation.
This is a fixture boundary mismatch, not a request decision failure.
