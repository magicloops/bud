# Debug: Context-filter response fixture

## Environment and reproduction
Run `pnpm --dir service build` after adding owner-authorized automation filters.

## Observed
`src/personal-data/routes.test.ts(104,7): error TS2322`: the injected list fixture
returns `{ items: [] }` and lacks the new `context_filter` response capability.

## Proposed fix
Update the fixture to the additive response contract and cover query forwarding.
Preserve legacy-client response fields and owner-first filtering.

Database fixture follow-up: `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/personal-data/automations.test.ts` failed inserting thread IDs. The fixture used a prefixed UUID for a PostgreSQL UUID column. Use plain random UUIDs; no application schema change. Full output: /tmp/bud-phase15-automations-tests.log.

Final type/lint checks exposed two fixture/export issues:
- `pnpm --dir service build`: `automations.test.ts(80,16)` and `(81,16)`, TS2571 Object is of type unknown. Database JSON columns are intentionally typed unknown; assertions must narrow the stored definition.
- Package-local `pnpm exec eslint ...`: `app-data-permissions.tsx:121:17 react-refresh/only-export-components`. Keep the status formatter private to its component module.
