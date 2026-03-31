# Debug: Staging Message Client ID Rollout Diagnostics

## Environment

- Staging service database targeted via `service/.env.staging`
- Service schema rollout currently depends on deploy-time `pnpm db:migrate`
- Client-id rollout originally shipped through `schema.ts` plus `pnpm db:push`

## Repro Steps

1. Deploy the branch with `message.client_id` rollout code to staging.
2. Observe the deploy logs run `pnpm db:migrate`.
3. Run `DOTENV_CONFIG_PATH=.env.staging pnpm db:backfill:message-client-ids`.
4. Observe either:
   - the earlier failure where `message.client_id` did not exist, or
   - a later run where the backfill reports `0` updated rows even though staging state still needs verification.

## Observed

- Staging deploy logs showed predeploy `pnpm db:migrate`, not `pnpm db:push`.
- The first backfill attempt failed because `public.message.client_id` did not exist on staging.
- After manually applying schema changes, a subsequent update/backfill path reported `0` updated rows, which is ambiguous without a direct inspection of the targeted database.

## Expected

- The targeted staging database should show one of two valid states:
  - Stage A: `message.client_id` exists, is nullable, historical null rows may remain until backfill completes.
  - Stage B: `message.client_id` exists, is `NOT NULL`, and no duplicate `client_id` values exist.

## Hypotheses

- The env file may point at a different database than expected.
- The manual schema apply may have succeeded, but the inspected database may already have no null `client_id` rows.
- The staging database may be in a mixed rollout state where the column exists but indexes/nullability do not match either Stage A or Stage B cleanly.

## Proposed Fix

- Add a dedicated inspection script that runs against any env file and prints:
  - resolved database target
  - presence/nullability of `message.client_id`
  - current `client_id` indexes
  - null and duplicate counts
  - a small sample of null/recent message rows
- Use that script before and after backfill to distinguish:
  - wrong database target
  - missing schema
  - healthy zero-null state
  - remaining duplicate/null anomalies

## Spec Files Affected

- [service/service.spec.md](../service/service.spec.md)
- [service/src/scripts/scripts.spec.md](../service/src/scripts/scripts.spec.md)
- [bud.spec.md](../bud.spec.md)
