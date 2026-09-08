# Debug: App-key migration dependency order

## Environment and reproduction

Local PostgreSQL, service Drizzle schema. Ran `pnpm db:generate` from `service/`
after adding app permission requests and query-key state.

## Observed

Generated `0032_flat_wilson_fisk.sql` adds request foreign keys before adding the
new referenced invocation/context and proxied-site/owner unique constraints.
Review caught the ordering before execution; no failed migration was applied.

## Proposed fix

Move the two generated uniqueness statements before the dependent request
foreign keys. Keep generated snapshot/journal metadata unchanged. Review local
`db:push`, apply only the reviewed new schema transactionally, and exercise the
checked-in SQL in an isolated schema with ownership/state constraints.
