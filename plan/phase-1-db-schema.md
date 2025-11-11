# Plan: Phase 1 — Database & Schema

## Context
- Link to issue(s): _TBD (Phase 1 tracking issue)_
- Related docs/sections in `/plan/proof-of-concept.md`: §6 Data Model, §11 Phase 1.

## Objective
- Stand up an initial Postgres schema matching the PoC tables (`bud`, `enrollment_token`, `thread`, `message`, `run`, `run_step`, `run_log`).
- Deliver a migration workflow (likely Drizzle + pnpm scripts) so future phases can evolve the schema safely.
- Seed one enrollment token + sample Bud row to unblock API and Bud presence work.
- Expose `GET /api/buds` returning rows from Postgres (even if mocked auth for now).

## Design / Approach
- **Migration tool**: Use Drizzle Kit with SQL migrations checked into `service/drizzle/migrations`. Add `drizzle.config.ts` and pnpm scripts (`db:generate`, `db:migrate`, `db:seed`).
- **Schema modeling**: Author TypeScript Drizzle schema definitions for each table with multi-tenant fields (`tenant_id`, `created_by_user_id`) and ULID/string columns where specified. Represent `run_log.data` as `bytea` (Drizzle `customType`).
- **Seed script**: Simple TS file executed via `tsx` that upserts one `bud` row (offline) and an `enrollment_token` (hashed with server secret env, e.g., `ENROLLMENT_SECRET`). Document how to swap values locally.
- **Service plumbing**: Add a `db` module exporting a Drizzle client (Node `pg` + connection string). Rework `/api/buds` route to query Postgres and serialize `bud` rows with `status` + timestamps.
- **Configuration**: Encourage `.env` usage with `DATABASE_URL`. Provide `docker-compose.local.yml` or instructions to run Postgres locally (optional stub). Validate that `pnpm db:migrate` fails clearly if env missing per AGENTS guidelines.
- **Doors open**: Keep schema versioned, add placeholders for `logs_blob_url`, `device_pubkey`, indexes noted in PoC doc.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [x] DB schema (migration)
- [ ] Agent adapter/tool registry
- [ ] Web UI surfaces

## Test plan
- `pnpm db:migrate` against a local Postgres succeeds from a clean database.
- `pnpm db:seed` inserts the enrollment token + Bud row (idempotent).
- `pnpm dev` (service) + manual `curl localhost:3000/api/buds` returns seeded Bud data.
- Add a lightweight integration test (e.g., Vitest or plain TS script) to exercise the DB client query for `bud`.

## Rollout
- Document DB setup steps in `service/README.md` (local Postgres + env vars).
- Mention migration commands in root README or docs.
- Ensure migrations are forward-only; provide guidance for Supabase deployment later.

## Out of scope
- Actual Supabase provisioning/automation.
- Web UI consumption of `/api/buds` (handled in later phases).
- Authentication/authorization around the API.
