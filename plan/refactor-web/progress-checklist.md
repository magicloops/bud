# Progress Checklist: Web Architecture Refactor

**Overall Status**: In Progress

## Phase 1: Foundation, Test Harness, And Shared Client Boundaries

- [x] Add a runnable `web` test script and baseline test harness
- [x] Add initial tests for auth redirect helpers and transcript/message identity helpers
- [x] Extract low-risk shared helpers out of `web/src/lib/api.ts`
- [x] Extract shared model-loading/default-selection logic
- [x] Fix `ThemeProvider` system-theme live update behavior
- [x] Establish a visible error-handling pattern for thread deletion failures

## Phase 2: Route Auth Shell And API Surface Split

- [x] Replace duplicated child-route auth fetch/gating with a protected-shell pattern
- [x] Split `web/src/lib/api.ts` into ownership-oriented transport/auth/domain modules
- [x] Centralize route login-redirect helper behavior
- [x] Preserve current auth/session redirect behavior through the new root/provider path

## Phase 3: Workspace Shell Deduplication And Bud Layout Cleanup

- [x] Extract a shared workspace shell for `/$budId/new` and `/$budId/$threadId`
- [x] Share model-loading/composer wiring across both workspace routes
- [x] Reduce `/$budId.tsx` to Bud-scoped state/composition ownership
- [x] Clarify Bud-route store ownership for thread summary mutations
- [x] Keep Bud selection, thread selection, sessions modal, and settings navigation behavior intact

## Phase 4: Thread Runtime Decomposition

- [x] Extract transcript/message ownership from `/$budId/$threadId`
- [x] Extract agent SSE ownership from `/$budId/$threadId`
- [x] Extract terminal session/xterm ownership from `/$budId/$threadId`
- [x] Move terminal overlays/status/menu rendering to presentation components
- [x] Reduce `/$budId/$threadId` to a thin route/composition layer
- [ ] Add deeper automated coverage for transcript reconciliation, agent stream transitions, and terminal reconnect/recovery behavior

## Phase 5: Performance, UX Consistency, And Final Doc Alignment

- [x] Lazy-load heavy timeline renderers where appropriate
- [ ] Reduce repeated timeline sorting/measurement pressure where practical
- [ ] Normalize mutation UX across thread delete, session close, and similar actions
- [ ] Gate or remove placeholder product UI that is not actually functional
- [ ] Update web specs and any new folder-level spec files introduced by the refactor
- [ ] Pass the final web refactor validation checklist
