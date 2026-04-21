# refactor-web

Implementation planning documents for refactoring the React web app into smaller, ownership-driven modules after the 2026-04-20 web architecture review.

## Purpose

This folder turns the architecture review in:

- [../../review/web-architecture-review-2026-04-20.md](../../review/web-architecture-review-2026-04-20.md)

into an actionable phased implementation plan.

The plan assumes:

- the repo is still in development, so backwards compatibility and rollout mechanics are not required for this refactor
- the main architectural problem is route/controller ownership sprawl rather than isolated component polish
- the thread workspace should remain the core browser runtime, but its responsibilities must be decomposed into explicit feature units
- duplicated auth gating, duplicated workspace logic, and the broad shared `api.ts` surface should be addressed before deeper runtime cleanup is considered complete
- test coverage needs to be established early so later structural changes do not proceed without guardrails
- final spec/docs updates are part of the refactor and not a separate later task

## Files

### `implementation-spec.md`

Parent implementation spec for the web refactor.

Documents:

- the current architectural pressure in `web/`
- fixed decisions for the refactor
- phase sequencing
- risks and definition of done

### `phase-1-foundation-test-harness-and-shared-client-boundaries.md`

Initial phase covering:

- the web test harness
- low-risk helper extraction
- shared model-loading/defaulting infrastructure
- the isolated theme-system bug fix

### `phase-2-route-auth-shell-and-api-surface-split.md`

Auth and shared-client phase covering:

- central protected-shell behavior
- removal of duplicated child-route auth gating
- ownership-based splitting of the current `api.ts` browser surface

### `phase-3-workspace-shell-deduplication-and-bud-layout-cleanup.md`

Workspace/Bud phase covering:

- shared shell extraction for new/existing thread routes
- shared model/composer wiring
- Bud-layout cleanup and Bud-route store clarification

### `phase-4-thread-runtime-decomposition.md`

Core runtime phase covering:

- transcript/message ownership extraction
- agent SSE ownership extraction
- terminal session/xterm ownership extraction
- reduction of `/$budId/$threadId` to a composition layer

Current state:

- transcript/message ownership has started and now exists in `web/src/features/threads/use-thread-messages.ts`
- agent-stream and terminal runtime extraction remain pending

### `phase-5-performance-ux-consistency-and-final-doc-alignment.md`

Finalization phase covering:

- timeline/render-path optimization
- mutation UX consistency
- placeholder UI cleanup/gating
- spec/documentation alignment

### `progress-checklist.md`

Running implementation checklist for the web refactor.

### `validation-checklist.md`

Manual verification checklist for the web refactor.

## Dependencies

- [../../review/web-architecture-review-2026-04-20.md](../../review/web-architecture-review-2026-04-20.md) - source review and findings
- [../../web/web.spec.md](../../web/web.spec.md) - web package overview
- [../../web/src/src.spec.md](../../web/src/src.spec.md) - current web source documentation
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
