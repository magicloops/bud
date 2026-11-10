# Device diagnostics (service side)

Status: built (2026-11-08) on `feat/device-diagnostics`, with bud-mobile Phase 3. The plan lives
in bud-mobile: `plan/diagnostics-logging/phase-3-diagnostics-upload.md` (Part A is this repo);
design: bud-mobile `design/diagnostics-upload.md`.

- Endpoint, validation and storage: `service/src/personal-data/diagnostics.ts`, `routes.ts`.
- Tables: migration `0066_device_diagnostics`.
- Reading: `pnpm db:diagnostics` (`service/src/scripts/diagnostics.ts`); see AGENTS.md §3.9.
- Contract: `service/src/personal-data/personal-data.spec.md`, "Device diagnostics".
- Retention: indefinite for now; TODO.md.

## Deployment

Deploy this before the bud-mobile build that uploads (an older service answers 404 and the phone
stops trying until its next launch). Render applies migration 0066 on deploy
(`preDeployCommand: pnpm db:migrate`). Locally it was applied with psql (2026-11-08); the local
database doesn't track migrations in drizzle's table.

**Deploy checklist (each environment: staging, then production).** The Cloudflare steps are
manual and not part of the Render deploy; without them uploads 404 at the front door and the phone
stops trying until its next launch.

1. Deploy the service (Render runs migration 0066).
2. Redeploy the front-door Worker from `deploy/cloudflare/bud-front-door-worker.js` (it now
   forwards `/v1/diagnostics` and `/v1/diagnostics/*`).
3. Add the Cloudflare route `<host>/v1/diagnostics*` to that Worker (runbook,
   `plan/deploy/cloudflare-front-door-runbook.md`, step 4).
4. Check: `curl -s -o /dev/null -w '%{http_code}' -X POST https://<host>/v1/diagnostics/batches`
   answers 401 (the service, unauthenticated), not 404.
5. Then ship the bud-mobile build that uploads.
