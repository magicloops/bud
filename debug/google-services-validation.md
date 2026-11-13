# Debug: Google services validation

Environment: local macOS, Node/TypeScript, branch prashanth/googleservices.
Google API traffic in tests uses synthetic fixtures; PostgreSQL tests isolate schemas.

First command: `cd service && pnpm build`

Observed: `src/google/agent.test.ts(32,26): error TS2322`, fixture inventory
missing `gmail_access` and `drive_access` after expanding connection inventory.
Fix: update the typed fixture alongside the production inventory contract.
Expected: service build and Google tests pass with all three per-service flags.

Specs: service/src/google/google.spec.md, web/src/features/connected-apps/connected-apps.spec.md.

Second command: `cd service && BUD_DATA_DB_TEST=1 node --import tsx --test --test-reporter=spec src/google/*.test.ts`
Observed: connections.test.ts:82, `AssertionError [ERR_ASSERTION]: Missing expected rejection`, expected `/google_gmail_permissions_required/`.
Cause: the wrong-account fixture consent granted Bob Gmail permissions, then Bob
was reused for the Calendar-only refresh test. Use a third synthetic account for
wrong-subject rejection. The production owner/scope gates were unchanged.

After fixes: service build and 52 focused backend checks pass, including isolated
PostgreSQL incremental grants/preflight/disconnect. Web production build and 31
mounted chat/settings/projection checks pass. Build retains existing large-chunk
warnings; tests retain react-test-renderer/Fastify deprecation notices. No real
mail/file mutations or hosted configuration/deployment occurred.

Local smoke: `/readyz` returns 200 with database/auth_schema ok; anonymous
`/api/google/connection` returns 401. Vite is running at http://localhost:5173.
A signed-in Chrome visit to `/settings` displays Calendar, Gmail and Google Drive
cards, with Calendar still connected and Gmail/Drive available to connect. No
consent button or account-wide disconnect was clicked. Live Google workflows
remain user acceptance tests.
