# Debug: App-key test retry key inference

## Reproduction and observed output

`pnpm build` from `service/` after adding the PostgreSQL app-key fixture:

```text
src/personal-data/app-keys.test.ts(80,70): error TS2345: Argument of type '"approval-retry"' is not assignable to parameter of type '`${string}-${string}-${string}-${string}-${string}`'.
src/personal-data/app-keys.test.ts(80,112): error TS2345: Argument of type '"approval-retry"' is not assignable to parameter of type '`${string}-${string}-${string}-${string}-${string}`'.
```

## Cause and fix

The helper's `randomUUID()` default inferred a UUID template-literal parameter,
but valid retry keys are general bounded strings. Explicitly type the test
parameter as `string`; retain the production contract. The database fixture
passed at runtime before this compile check.
