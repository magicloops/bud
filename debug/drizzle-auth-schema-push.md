# Debug: drizzle-auth-schema-push

## Environment
- macOS (arm64)
- Local PostgreSQL via `DATABASE_URL`
- Service auth-foundation work using Better Auth + Drizzle Kit push

## Repro Steps
1. Add Better Auth tables under `pgSchema("auth")` in `service/src/db/schema.ts`.
2. Run `pnpm db:push` from `service/`.
3. Observe Drizzle fail before a fresh database can be initialized cleanly.

## Observed
- Initial failure: `schema "auth" does not exist`
- After creating only the schema namespace: Drizzle still failed because `auth.user` did not exist when applying `user_profile` foreign keys
- After forcing Drizzle to include `auth` in `schemaFilter`: the CLI proposed `DROP SCHEMA "auth"` even though the compiled schema exports included the auth tables

## Expected
- `pnpm db:push` should work against a blank local database without requiring manual SQL for the Better Auth foundation

## Hypotheses
- In this project setup, `drizzle-kit push` does not reliably bootstrap/manage the Better Auth tables in a non-`public` Postgres schema
- Drizzle can still manage `public` objects that reference `auth.user`, as long as the auth tables already exist

## Proposed Fix
- Add `service/src/scripts/db-push.ts` as the `pnpm db:push` entrypoint
- Bootstrap `auth` schema plus Better Auth core tables/indexes idempotently before invoking `drizzle-kit push`
- Keep Drizzle scoped to the `public` schema so it only applies app-owned diffs such as `user_profile` constraints/indexes and existing terminal FK cleanup
- Document the split clearly in the service/db/scripts specs

## Spec Files Affected
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/db/db.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/scripts/scripts.spec.md`
- `bud.spec.md`
