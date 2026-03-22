# Debug: ios-local-oauth-client-provisioning-id-null

## Environment
- macOS (arm64)
- Local PostgreSQL via `DATABASE_URL`
- Service local-auth provisioning flow from `service/`
- Command under investigation: `pnpm oauth:provision:ios-local`

## Repro Steps
1. Configure the local service/web auth env for the `http://localhost:5173` public-origin topology.
2. From `/Users/adam/bud/service`, run `pnpm oauth:provision:ios-local`.
3. Observe the script enter the create path for `auth.oauthClient.clientId = 'bud-ios-dev-local'`.

## Observed
- The command fails with `DrizzleQueryError: Failed query: insert into "auth"."oauthClient" ...`.
- Postgres reports `null value in column "id" of relation "oauthClient" violates not-null constraint` (`code: 23502`).
- The failing insert is emitted from `service/src/scripts/provision-ios-local-oauth-client.ts` when no existing row matches `clientId = 'bud-ios-dev-local'`.
- The create path currently inserts `clientId`, `createdAt`, and the shared client fields, but does not provide an `id`.
- Drizzle therefore generates `values (default, ...)` for `"id"`, but the database table does not define a default for `auth.oauthClient.id`.

## Expected
- `pnpm oauth:provision:ios-local` should create the local iOS OAuth client on the first run and update it on later runs.
- The provisioning path should be fully idempotent for fresh local databases and existing local databases.

## Findings
- `service/src/db/schema.ts` defines `authOAuthClientTable.id` as `text("id").primaryKey()` with no default generator.
- `service/drizzle/migrations/0007_auth_foundation.sql` creates `"auth"."oauthClient"."id" text PRIMARY KEY NOT NULL` with no `DEFAULT`.
- The script's update branch is keyed by `clientId`, so an already-created row would update successfully; the failure is specific to the first-create path.
- `clientId` and `id` are separate columns in the Better Auth table contract. `clientId` is unique, but it is not the primary key.

## Hypotheses
- The provisioning script incorrectly assumes Better Auth's `oauthClient` rows can be created without explicitly supplying the primary-key `id`.
- This is a script-level bug, not a mismatch with the iOS handoff doc or the local `5173` auth topology.
- Because the script writes directly to Better Auth tables instead of going through Better Auth runtime helpers, it must satisfy the table contract itself, including primary-key generation.
- After fixing `id`, the rest of the insert shape is likely valid, but that has not yet been proven because execution currently stops at the first constraint failure.

## Proposed Fix
- Update `service/src/scripts/provision-ios-local-oauth-client.ts` so the create path supplies a non-null `id` when inserting into `auth.oauthClient`.
- Choose an explicit provisioning policy for that `id`:
  - deterministic/stable row id tied to `bud-ios-dev-local`, or
  - generated unique id on first create while continuing to key updates by `clientId`
- Keep `clientId = 'bud-ios-dev-local'` as the published OAuth client identifier for iOS.
- Re-run `pnpm oauth:provision:ios-local` after the script change and confirm:
  - first run creates the row
  - second run updates cleanly
  - the printed auth bundle still matches the local handoff contract

## Spec Files Affected
- `bud.spec.md`
- `service/src/scripts/scripts.spec.md`
