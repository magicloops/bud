# Bud Web UI (Vite + React)

This app will host the chat thread, live run logs, and cancel controls described in [`/plan/proof-of-concept.md`](../plan/proof-of-concept.md). The scaffold is intentionally minimal so we can layer in SSE wiring, log panes, and Bud presence views as backend features land.

## Scripts (pnpm)

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run the Vite dev server with HMR. |
| `pnpm build` | Type-check (`tsc -b`) and emit the production bundle. |
| `pnpm preview` | Preview the production build locally. |
| `pnpm lint` | Run ESLint using the shared config. |

## Next steps

1. Implement Bud list + enrollment token UI (Phase 2+ of the PoC plan).
2. Add thread views with agent/bud event timelines driven by `GET /api/runs/:run_id/stream`.
3. Surface cancel + retry affordances, plus Unsafe PoC warnings, per `AGENTS.md`.

Keep this document updated as new flows/components are added.***
