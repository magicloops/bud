# scripts

Database utility scripts for development and operations.

## Purpose

Standalone scripts for database management and auth/bootstrap tasks like seeding, migration verification, table inspection, and first-party iOS OAuth-client provisioning for local and staging environments.

## Files

### `db-push.ts`

Wrapper around `drizzle-kit push` for local schema initialization.

**Responsibilities**:
- Create the Postgres `auth` schema if it does not exist
- Run Better Auth's migration generator idempotently for the runtime auth config:
  - core auth tables (`auth.user`, `auth.session`, `auth.account`, `auth.verification`)
  - JWT/JWKS tables
  - OAuth Provider tables (`auth.oauthClient`, `auth.oauthRefreshToken`, `auth.oauthAccessToken`, `auth.oauthConsent`)
- Delegate back to `drizzle-kit push` for public-schema diffs

**Usage**:
```bash
pnpm db:push
```

**Why It Exists**:
In this project, Drizzle Kit does not reliably bootstrap Better Auth's non-`public` schema objects during `push`, so the wrapper creates the auth foundation first using Better Auth's own schema knowledge rather than maintaining hand-written bootstrap SQL.

### `backfill-message-client-ids.ts`

Stage-A rollout helper for `message.client_id`.

**Responsibilities**:
- Find message rows where `client_id` is still null
- Assign a generated UUIDv7 `client_id` in ordered batches
- Fail the script if any rows remain null after the pass completes

**Usage**:
```bash
pnpm db:backfill:message-client-ids
```

**Environment**:
- `MESSAGE_CLIENT_ID_BACKFILL_BATCH_SIZE` - Optional positive integer batch size override (default: `500`)

### `provision-ios-oauth-client-shared.ts`

Shared helper for first-party iOS OAuth-client provisioning scripts.

**Responsibilities**:
- Upsert deterministic first-party iOS client rows in `auth.oauthClient`
- Build the published auth bundle from the current `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Print environment-specific warnings when the running config does not match the expected public origin
- Share one bundle/output shape across local and staging provisioning entrypoints

### `provision-ios-local-oauth-client.ts`

Creates or updates the fixed first-party local iOS OAuth client and prints the exact local auth bundle to hand to the mobile team.

**Responsibilities**:
- Upsert `auth.oauthClient` row `bud-ios-dev-local`
- Supply the Better Auth table's required internal primary key when creating the row
- Enforce the expected local redirect URI (`chat.bud.app://oauth/callback`)
- Mark the client as a public native PKCE client with refresh-token support
- Print the current local auth bundle derived from `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Warn when the local env is not aligned with the expected public `http://localhost:5173` topology

**Usage**:
```bash
pnpm oauth:provision:ios-local
```

### `provision-ios-staging-oauth-client.ts`

Creates or updates the fixed first-party staging iOS OAuth client and prints the exact staging auth bundle to hand to the mobile team.

**Responsibilities**:
- Upsert `auth.oauthClient` row `bud-ios-staging`
- Enforce the staging redirect URI (`chat.bud.app://oauth/callback`)
- Mark the client as a public native PKCE client with refresh-token support
- Print the current staging auth bundle derived from `APP_BASE_URL`, `BETTER_AUTH_URL`, and `API_AUDIENCE`
- Warn when the staging env is not aligned with the expected public `https://staging.bud.dev` topology

**Usage**:
```bash
pnpm oauth:provision:ios-staging
```

**Execution Contract**:
- The package script loads `.env.staging` explicitly via Node's `--env-file` flag before importing `tsx`, so the staging bundle is always derived from the checked-in staging env file rather than whichever shell env happens to be active.

### `seed.ts`

Creates initial development data.

**Creates**:
- Sample enrollment token (valid for 24 hours)
- Outputs token for use with bud daemon

**Usage**:
```bash
npx tsx src/scripts/seed.ts
```

**Output**:
```
Seeded token: tok_<hash>
Use this token to enroll a new bud
```

### `check-tables.ts`

Verifies database schema by listing all tables and their row counts.

**Usage**:
```bash
npx tsx src/scripts/check-tables.ts
```

**Output**:
```
Table: bud, rows: 2
Table: thread, rows: 15
Table: message, rows: 142
...
```

### `apply-missing-migrations.ts`

Development helper for applying migrations that Drizzle Kit doesn't detect.

**Use Case**:
When schema changes are made but `drizzle-kit push` doesn't generate the expected migration, this script can manually apply SQL.

**Usage**:
```bash
npx tsx src/scripts/apply-missing-migrations.ts
```

**Note**: This is a development tool. Normal schema changes in this repo should go through `service/src/db/schema.ts` plus `pnpm db:push`.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../db/client.js` | Database connection |
| `../db/message-client-id.js` | UUIDv7 generation for message-client-id backfill |
| `../db/schema.js` | Table definitions |
| `../auth/auth.js` | Shared OAuth scope/base-path constants for bundle output |
| `../config.js` | Public-origin config used when printing the current iOS auth bundle |
| `pg` | Auth-schema bootstrap connection |
| `node:child_process` | Re-run Drizzle CLI after bootstrap |
| `crypto` | Token generation (seed) |
| `drizzle-orm` | Query helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
