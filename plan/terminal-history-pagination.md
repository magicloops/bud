# Plan: Unified Timeline Pagination (Chat + Terminal)

## Context
- Link to issue(s): Phase 4 UX polish follow-up (terminal history beyond last command).
- Related docs: `plan/terminal-shell-transcript.md`, `plan/ui-schema-alignment.md`, `plan/reasoning-effort-selector.md`.

## Objective
- Show the full shell transcript history (multiple tool calls/runs) inside the terminal pane, not just the latest run.
- Keep chat/thread messages and terminal entries aligned chronologically and paginate them together (loading older history should surface both message+shell context).
- Minimize redundant network calls while keeping SSE streaming for the active run.

## Existing design (today)
- **Messages**: `web/src/App.tsx` fetches `/api/threads/:id/messages?limit=200` once per thread; SSE refresh after each assistant message. No pagination/infinite scroll.
- **Terminal**: `terminalEntries` state is rebuilt per run from SSE (`agent.tool_call`, `exec.stdout`, etc.). When you switch threads or send a new message we `setTerminalEntries([])`; prior runs’ stdout/stderr are not persisted/queryable in the UI.
- **Backend**: `run_log` table stores raw stdout/stderr with `(run_id, seq)` PK. `run_step` table tracks tool calls. No REST endpoint exposes historical logs besides `/api/runs/:id/stream` (live SSE).
- **Consequence**: Terminal always shows “current run”; to review previous runs you must refresh thread or rely on messages summarizing results. Chat + terminal aren’t tied to a shared pagination model.

## Design / Approach
### Option A — Dedicated run history endpoint (recommended)
- Add `GET /api/threads/:threadId/runs?cursor=…&limit=…` returning ordered run summaries (latest first) plus lightweight stdout/stderr tails.
- Response shape includes: `run_id`, timestamps, `status`, `exit_code`, `cwd`, `bytes`, and e.g. `stdout_tail`, `stderr_tail`, `has_more_logs`.
- Backend query stitches `run_table`, `run_step`, and aggregated `run_log` (tail via subquery). Cursor based on `run_table.started_at` or ULID.
- Web terminal pane fetches this list when a thread loads and paginates independently (e.g., “Load older commands”). Chat timeline remains unchanged.
- Live SSE continues to hydrate the current run; when `final` arrives we optimistic‑append the new run to the history list so terminal stays in sync.
- Pros: small surface area change; no chat refactor; future‑proof (can later expose download links or more metadata).
- Cons: chat and terminal remain separate timelines (by design); still need UIs for multi-run navigation.

### Option B — Thread timeline API
- Introduce `/api/threads/:id/timeline?cursor=…` (combined messages + run steps) and rework UI to share one store.
- Pros: perfectly synchronized history; single pagination control.
- Cons: heavier backend/UI changes; potentially limits future UX iteration if timelines diverge.

### Option C — Persist SSE transcripts per run
- On run completion, backend materializes a transcript document (JSON) and stores it (e.g., `run_transcript` table).
- `/api/threads/:id/transcripts?cursor=…` returns serialized transcripts; UI renders them wholesale.
- Pros: very fast retrieval (single JSON blob per run); easier to export/share.
- Cons: extra storage cost; doesn’t unify chat pagination; requires migration/tooling to backfill transcripts.

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [x] REST API (thread timeline endpoints)
- [x] Web UI surfaces (chat + terminal state management)
- [ ] DB schema (maybe: new materialized view or transcript table depending on option)

## Test plan
- Manual: scroll up to load older history; confirm both chat and terminal panes fetch older entries together; ensure live SSE updates append without duplicates.
- Automated: add backend tests for timeline queries (ordering, pagination), unit tests for client timeline store reducer.

## Rollout
- Phase 1: implement `GET /api/threads/:threadId/runs` (Option A) returning paginated run summaries with stdout/stderr tails; hook terminal pane into the new route while keeping `/messages` untouched.
- Phase 2 (optional future): expand run history payloads (download links, full transcripts) or evolve toward a unified timeline once UX needs justify it.
- Update `PROGRESS.md` + UI docs once run history UI lands.

## Out of scope
- Log download/export UI (could be follow-up once timeline is in place).
- Persisting Bud PTY/ANSI rendering or file artifacts.
- Cross-thread/global history views.
