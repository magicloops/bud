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
