# drizzle

Database migration infrastructure using Drizzle Kit.

## Purpose

Contains Drizzle Kit config plus the checked-in migration history used for staging. Local development remains schema-first off `src/db/schema.ts` via `db:push`, while deployable schema changes are represented by checked-in SQL migrations and Drizzle snapshot metadata.

## Subfolders

### `migrations/` → [migrations.spec.md](./migrations/migrations.spec.md)

Sequential SQL migration files and Drizzle Kit metadata.

## Configuration

Drizzle Kit configuration is in `drizzle.config.ts` at the service root:

```typescript
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? defaultUrl
  },
  strict: true,
  verbose: true
});
```

## Workflow

### Local Development

1. Modify `src/db/schema.ts`
2. Run the metadata guardrail when changing schema or migrations:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/db/schema-metadata.test.ts
```

3. Run `pnpm db:push`
4. Review the proposed SQL before applying
5. Run `pnpm db:push` a second time when fixing or adding constraints; the second run should report no changes

### Staging

Use the checked-in migration chain with `pnpm db:migrate` (or `pnpm db:migrate:staging`) when a deployed environment must be aligned without `db:push`.

### Push-Convergence Guardrails

Drizzle Kit live introspection can produce non-converging `db:push` prompts when schema metadata cannot round-trip through PostgreSQL exactly. Keep new schema changes within these conventions:

- Use column-level `.primaryKey()` for single-column primary keys.
- Use table-level `primaryKey({ columns: [...] })` only for real multi-column primary keys.
- Give long or likely-long foreign keys explicit stable names with `foreignKey({ name: "short_stable_name" })`.
- Keep PostgreSQL-facing identifiers at or under 63 bytes.
- Treat FK drop/add churn for the same columns as suspicious; prefer data-preserving `ALTER TABLE ... RENAME CONSTRAINT ...` in checked-in migrations where possible.
- Treat a primary-key drop/add for the same columns as suspicious; verify whether it is only a Drizzle metadata representation change.

`service/src/db/schema-metadata.test.ts` enforces the first-line guardrails by scanning the latest checked-in Drizzle snapshot for overlong identifiers and one-column composite primary keys. Migration `0020` documents the first cleanup of this class and validates that repeated local `db:push` runs converge.

## Package Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `db:generate` | `drizzle-kit generate` | Generate a checked-in migration when staging history must catch up |
| `db:migrate` | `drizzle-kit migrate` | Apply checked-in migrations (staging/deployed environments) |
| `db:push` | `tsx src/scripts/db-push.ts` | Prepare Better Auth schema needs, then direct schema sync for local development |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio GUI |

---

*Referenced by: [../service.spec.md](../service.spec.md)*
