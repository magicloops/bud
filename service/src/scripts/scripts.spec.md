# scripts

Database utility scripts for development and operations.

## Purpose

Standalone scripts for database management and auth/bootstrap tasks like seeding, migration verification, table inspection, and first-party local OAuth-client provisioning.

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
| `../db/schema.js` | Table definitions |
| `../auth/auth.js` | Shared OAuth scope/base-path constants for bundle output |
| `../config.js` | Public-origin config used when printing the local auth bundle |
| `pg` | Auth-schema bootstrap connection |
| `node:child_process` | Re-run Drizzle CLI after bootstrap |
| `crypto` | Token generation (seed) |
| `drizzle-orm` | Query helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
