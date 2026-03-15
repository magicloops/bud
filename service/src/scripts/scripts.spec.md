# scripts

Database utility scripts for development and operations.

## Purpose

Standalone scripts for database management tasks like seeding, migration verification, and table inspection.

## Files

### `db-push.ts`

Wrapper around `drizzle-kit push` for local schema initialization.

**Responsibilities**:
- Create the Postgres `auth` schema if it does not exist
- Bootstrap Better Auth core tables and indexes idempotently:
  - `auth.user`
  - `auth.session`
  - `auth.account`
  - `auth.verification`
- Delegate back to `drizzle-kit push` for public-schema diffs

**Usage**:
```bash
pnpm db:push
```

**Why It Exists**:
In this project, Drizzle Kit does not reliably bootstrap Better Auth's non-`public` schema objects during `push`, so the wrapper creates the auth foundation first.

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
| `pg` | Auth-schema bootstrap connection |
| `node:child_process` | Re-run Drizzle CLI after bootstrap |
| `crypto` | Token generation (seed) |
| `drizzle-orm` | Query helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
