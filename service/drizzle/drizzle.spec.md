# drizzle

Database migration infrastructure using Drizzle Kit.

## Purpose

Contains SQL migrations and metadata for evolving the PostgreSQL schema. Drizzle Kit generates migrations from TypeScript schema definitions in `src/db/schema.ts`.

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

### Development

1. Modify `src/db/schema.ts`
2. Run `pnpm db:generate` to create migration
3. Review generated SQL in `drizzle/migrations/`
4. Run `pnpm db:migrate` to apply

### Quick Iteration

For rapid prototyping, use `pnpm db:push` to sync schema directly (skips migration files).

**Warning**: `db:push` can cause data loss - only use in development.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `db:generate` | `drizzle-kit generate:pg` | Create migration from schema |
| `db:migrate` | `drizzle-kit migrate` | Apply pending migrations |
| `db:push` | `drizzle-kit push:pg` | Direct schema sync (dev) |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio GUI |

---

*Referenced by: [../service.spec.md](../service.spec.md)*
