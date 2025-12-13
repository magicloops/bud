# scripts

Database utility scripts for development and operations.

## Purpose

Standalone scripts for database management tasks like seeding, migration verification, and table inspection.

## Files

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

**Note**: This is a development tool - production should use proper migrations via `drizzle-kit`.

## Dependencies

| Import | Purpose |
|--------|---------|
| `../db/client.js` | Database connection |
| `../db/schema.js` | Table definitions |
| `crypto` | Token generation (seed) |
| `drizzle-orm` | Query helpers |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
