# Plan: UI Schema Alignment

## Context
- Link to issue(s): _TBD (tracking Phase 4 UI work)_
- Related docs/sections in `/plan/proof-of-concept.md`:
  - Phase 4 (web console + agent loop)
  - Phase 5 preview (cancel semantics, UX polish)

## Objective
- Provide the data the new Bud workbench needs: Bud metadata (labels, status, capabilities), thread summaries (title, last activity, unread counts), and richer run/message history so the UI can render the Bud rail, conversation drawer, and contextual settings without fabricating data in the browser.
- Acceptance: DB schema + APIs expose the new fields, default seeds cover demo Buds/threads, and the Vite app can render the rail/drawer purely from backend state.

## Design / Approach
- **Bud metadata table**: extend `buds` (or add `bud_profile`) with `display_name`, `accent_color`, `status`, `last_check_in_at`, `tags JSONB`, and `capabilities` (enum set). Backend REST should surface this via `/api/buds`.
- **Thread catalog**: add columns to `thread` for `title`, `last_message_preview`, `last_activity_at`, `message_count`, maybe `pinned`/`archived` flags. Populate on insert/update triggers or via view.
- **Thread membership**: store `bud_id` on `thread` (already there) but ensure API filters by Bud and sorts by `last_activity_at`.
- **Message audit**: keep existing `messages` table but add `display_role` + `metadata JSON` so UI can show agent/system badges and future attachments. Provide limit/order queries for chat timeline.
- **Run snapshots**: add `run_summary` table keyed by `run_id` capturing exit code, `stdout_bytes`, `stderr_bytes`, and `started_at/completed_at` so the UI can show badges + durations without crunching logs.
- **API updates**: 
  - `/api/buds` returns Bud metadata + last run (join to `run_summary`).
  - `/api/threads` accepts `bud_id`, returns summary fields + unread counts (counts derived from `message_seen_at` pivot table keyed by user?).
  - `/api/threads/:id/messages` stays but returns the new metadata fields.
- **Seeding**: CLI/SQL seeds for demo Buds and example threads to make the UI useful immediately.
- **Migration strategy**: additive migrations (nullable columns, default values). Backfill `display_name` using `bud_id`, `last_activity_at` using latest message timestamp.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [x] DB schema (migration)
- [ ] Agent adapter/tool registry
- [x] Web UI surfaces

## Test plan
- Unit tests for new repository methods (buds + threads summary queries).
- Integration tests for `/api/buds` and `/api/threads` verifying filters, ordering, and payload shape.
- Manual UI test recipe: seed DB, load the web app, ensure Bud rail/drawer populate correctly, switch Buds/threads, and verify SSE streaming still works.

## Rollout
- Apply DB migrations (up/down scripts).
- Update `service/README.md` with new environment expectations (seed command) and API docs.
- Refresh sample cURL / Postman scripts for `/api/buds` + `/api/threads`.

## Out of scope
- SSE payload redesign (Phase 4 later milestone).
- Browser preview streaming and cancel semantics (Phase 5).
- Multi-tenant RBAC beyond adding nullable `tenant_id` fields already required by PoC.
