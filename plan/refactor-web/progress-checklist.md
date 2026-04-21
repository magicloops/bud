# Progress Checklist: Web Architecture Refactor

**Overall Status**: Draft

## Phase 1: Foundation, Test Harness, And Shared Client Boundaries

- [ ] Add a runnable `web` test script and baseline test harness
- [ ] Add initial tests for auth redirect helpers and transcript/message identity helpers
- [ ] Extract low-risk shared helpers out of `web/src/lib/api.ts`
- [ ] Extract shared model-loading/default-selection logic
- [ ] Fix `ThemeProvider` system-theme live update behavior
- [ ] Establish a visible error-handling pattern for thread deletion failures

## Phase 2: Route Auth Shell And API Surface Split

- [ ] Replace duplicated child-route auth fetch/gating with a protected-shell pattern
- [ ] Split `web/src/lib/api.ts` into ownership-oriented transport/auth/domain modules
- [ ] Centralize route login-redirect helper behavior
- [ ] Preserve current auth/session redirect behavior through the new root/provider path

## Phase 3: Workspace Shell Deduplication And Bud Layout Cleanup

- [ ] Extract a shared workspace shell for `/$budId/new` and `/$budId/$threadId`
- [ ] Share model-loading/composer wiring across both workspace routes
- [ ] Reduce `/$budId.tsx` to Bud-scoped state/composition ownership
- [ ] Clarify Bud-route store ownership for thread summary mutations
- [ ] Keep Bud selection, thread selection, sessions modal, and settings navigation behavior intact

## Phase 4: Thread Runtime Decomposition

- [ ] Extract transcript/message ownership from `/$budId/$threadId`
- [ ] Extract agent SSE ownership from `/$budId/$threadId`
- [ ] Extract terminal session/xterm ownership from `/$budId/$threadId`
- [ ] Move terminal overlays/status/menu rendering to presentation components
- [ ] Reduce `/$budId/$threadId` to a thin route/composition layer
- [ ] Add automated coverage for transcript reconciliation, agent stream transitions, and terminal reconnect/recovery behavior

## Phase 5: Performance, UX Consistency, And Final Doc Alignment

- [ ] Lazy-load heavy timeline renderers where appropriate
- [ ] Reduce repeated timeline sorting/measurement pressure where practical
- [ ] Normalize mutation UX across thread delete, session close, and similar actions
- [ ] Gate or remove placeholder product UI that is not actually functional
- [ ] Update web specs and any new folder-level spec files introduced by the refactor
- [ ] Pass the final web refactor validation checklist
