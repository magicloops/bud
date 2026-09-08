# Debug: Bootstrap preview transaction configuration

## Environment and reproduction

Service TypeScript build: `pnpm --dir service build`.

## Observed

`src/personal-data/automation-bootstrap.ts(133,45): error TS2353: Object literal may only specify known properties, and 'readOnly' does not exist in type 'PgTransactionConfig'.`

## Cause and fix

The installed Drizzle transaction configuration uses `accessMode: "read only"`, not `readOnly: true`. Preserve repeatable-read isolation and enforce the read-only transaction with the supported option. Re-run service build and preview PostgreSQL tests.
