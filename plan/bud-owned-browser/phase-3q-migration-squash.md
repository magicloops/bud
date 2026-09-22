# Phase 3q: Squash the browser migration chain

Status: implemented locally; fresh-database migrate and isolated-schema repository tests pass. Updated 2026-09-21.

## Context

[Branch review](../../review/bud-owned-browser-branch-review.md) (merge blocker 4).
Related specs: [migrations](../../service/drizzle/migrations/migrations.spec.md),
[db](../../service/src/db/db.spec.md).
Related plans: [persistent browser](phase-3k-shared-persistent-browser.md).

The branch accumulated eight Drizzle migrations, `0039_tiny_loners` through
`0046_tired_johnny_blaze`, while the browser model moved from per-thread
ephemeral sessions (Phases 1–3e) to one persistent resource per Bud (Phase 3k).
Migrations 0039–0042 and 0045 added columns and constraints that 0046 then
dropped or replaced, and 0046 also carried a data fix for pre-3k rows plus a
hand-written trigger. Production was confirmed at `0038_automation_model_inheritance`
on 2026-09-21; nothing from this branch has deployed, so the intermediate
history has no consumer. AGENTS.md's development-stage policy prefers the
simplest complete migration over a replayed design history.

## Objective

Ship the browser schema as the minimum number of checked-in migrations that
produce exactly the schema `schema.ts` describes, keep the Drizzle-inexpressible
trigger explicit, and keep every test that exercises deploy SQL pointed at real
migration files. Do this before merge; once `main` auto-deploys the chain it can
no longer be rewritten.

## Options and recommendation

1. Keep all eight as history. Rejected: replays a superseded model on every
   fresh database, leaves create-then-drop churn in the journal, and preserves a
   data `UPDATE` that can never match a row in production.
2. **Recommended: regenerate one schema migration from the 0038 snapshot plus
   one custom migration for the trigger.** `drizzle-kit generate` emits the full
   diff deterministically; `generate --custom` gives the trigger its own numbered,
   journaled file so the generated SQL stays regenerable.
3. Fold the trigger into the generated file, as 0046 did. Workable but mixes
   hand-maintained SQL into a file that `db:generate` would otherwise own.

## What changed

- Removed `0039_tiny_loners` … `0046_tired_johnny_blaze` SQL and
  `meta/00xx_snapshot.json` files; restored `meta/_journal.json` to its `main`
  state at 0038 rather than hand-editing entries.
- `pnpm db:generate --name=bud_browser` → `0039_bud_browser.sql`: creates
  `browser_handoff`, `browser_resource`, and `browser_session` in their final
  shape, adds `agent_invocation.work_duration_ms` / `work_started_at`, then adds
  the composite owner FKs and all indexes. Drizzle orders `CREATE TABLE` before
  `ADD CONSTRAINT`, so the FK ordering fix that 0040 needed by hand is moot.
- `drizzle-kit generate --custom --name=browser_claim_retirement` →
  `0040_browser_claim_retirement.sql`: the `retire_bud_browser_claim()` function
  and `browser_claim_retirement` trigger on `bud`, copied verbatim from 0046 with
  a header explaining why it is hand-maintained.
- Dropped from the chain: `profile_mode`, per-session `control_state` /
  `revision` / `control_request_id` / `private_content`, the
  `browser_handoff_pending_session_idx`, the ephemeral-profile CHECK, and the
  0046 `UPDATE` that closed unlinked sessions. None can apply to production data.
- Tests that load migration SQL now target the two new files:
  `service/src/browser/repository.test.ts` applies both against stub base
  tables; `service/src/browser/resource-repository.test.ts` no longer stubs
  `browser_session` / `browser_handoff` or asserts legacy-row behaviour, and its
  fixtures satisfy the real NOT NULL, CHECK, and composite-FK rules;
  `service/src/agent/invocation-timing.test.ts` drops the copied browser tables
  from its isolated schema and applies `0039_bud_browser.sql` against
  pre-change storage.
- Spec updates: `migrations.spec.md`, `db.spec.md`, `phases.md`, and the branch
  review's blocker list.

## Validation

- Fresh database: `drizzle-kit migrate` from `0000` through `0040` on a scratch
  database applied cleanly (41 journal rows) and created the trigger.
- Schema parity: `pg_dump --schema-only` of the migrated scratch database versus
  the `db:push`-maintained local database differs only in column order for
  `browser_session.browser_id`, `browser_resource.control_operation`, and the
  pre-existing `bud` columns (expected: `ADD COLUMN` versus inline `CREATE`).
- Isolated-schema tests under `BUD_DATA_DB_TEST=1`: `repository.test.ts`,
  `resource-repository.test.ts`, `invocation-timing.test.ts`, plus the full
  service suite.

## Rollout

- Deploy order is unchanged: run `pnpm db:migrate` before starting the updated
  service. Production moves 0038 → 0040 in one step.
- Local databases maintained with `db:push` need nothing. Any local database
  that ran `db:migrate` with the old 0039–0046 files must be reset, because the
  old hashes no longer exist in the journal.
- `db:push` will not create or drop the trigger; `0040_browser_claim_retirement.sql`
  is the only source of that SQL.
- No daemon or web change; this is service-only.
