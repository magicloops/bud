# drizzle

Database migration infrastructure using Drizzle Kit.

## Purpose

Contains Drizzle Kit config plus the checked-in migration history used for staging. Local development remains schema-first off `src/db/schema.ts` via `db:push`.

## Subfolders

### `migrations/` → [migrations.spec.md](./migrations/migrations.spec.md)

Sequential SQL migration files and Drizzle Kit metadata.

## Configuration

Drizzle Kit configuration is in `drizzle.config.ts` at the service root:

```typescript
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL
  }
};
```

## Workflow

### Local Development

1. Modify `src/db/schema.ts`
2. Run `pnpm db:push`
3. Review the proposed SQL before applying

### Staging

Use the checked-in migration chain with `pnpm db:migrate` (or `pnpm db:migrate:staging`) when a deployed environment must be aligned without `db:push`.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `db:generate` | `drizzle-kit generate:pg` | Generate a checked-in migration when staging history must catch up |
| `db:migrate` | `drizzle-kit migrate` | Apply checked-in migrations (staging/deployed environments) |
| `db:push` | `drizzle-kit push:pg` | Direct schema sync for local development |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio GUI |

---

*Referenced by: [../service.spec.md](../service.spec.md)*
