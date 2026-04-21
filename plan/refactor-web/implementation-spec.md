# Implementation Spec: Web Architecture Refactor

**Status**: Implemented, with follow-up automated hardening deferred
**Created**: 2026-04-20
**Review Doc**: [../../review/web-architecture-review-2026-04-20.md](../../review/web-architecture-review-2026-04-20.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-foundation-test-harness-and-shared-client-boundaries.md](./phase-1-foundation-test-harness-and-shared-client-boundaries.md)
**Phase 2**: [phase-2-route-auth-shell-and-api-surface-split.md](./phase-2-route-auth-shell-and-api-surface-split.md)
**Phase 3**: [phase-3-workspace-shell-deduplication-and-bud-layout-cleanup.md](./phase-3-workspace-shell-deduplication-and-bud-layout-cleanup.md)
**Phase 4**: [phase-4-thread-runtime-decomposition.md](./phase-4-thread-runtime-decomposition.md)
**Phase 5**: [phase-5-performance-ux-consistency-and-final-doc-alignment.md](./phase-5-performance-ux-consistency-and-final-doc-alignment.md)

---

## Context

The web app has reached the same point the daemon and service reached before their refactor passes:

- the largest route files own too many responsibilities
- route modules are acting as controllers, client stores, transport clients, and view trees at the same time
- shared browser/client concerns are concentrated in a broad `api.ts` helper
- the two primary workspaces (`/$budId/new` and `/$budId/$threadId`) intentionally duplicate behavior and structure
- the app has little to no automated protection around the most complex client-side behavior

The largest hotspot is:

- `web/src/routes/$budId/$threadId.tsx`

That file currently owns:

- transcript bootstrap and reconciliation
- optimistic message write flow
- paged history loading
- agent SSE attach/reconnect/resync behavior
- terminal session creation and recovery
- xterm lifecycle and browser terminal input translation
- terminal UI state and overlays
- workspace rendering

The app should be refactored now while:

- the repo is still development-stage
- breaking internal changes are acceptable
- there is no rollout or backwards-compatibility constraint
- the thread-scoped terminal architecture is already coherent enough to preserve
- the review findings are fresh and can be turned into an explicit target design rather than one-off cleanup

## Objective

Refactor the web app into smaller, explicit feature modules and shared client boundaries so that:

- route files primarily compose data and UI instead of owning entire runtimes
- auth gating becomes centralized and consistent
- browser transport helpers are split by ownership rather than living in a single broad utility file
- the shared workspace shell is reused rather than duplicated
- the thread view is decomposed into testable message, agent-stream, and terminal-session units
- performance-sensitive rendering paths are better isolated
- the app gains enough automated coverage to support future changes safely

## Fixed Decisions

These decisions are fixed for this plan:

- Breaking changes inside the current branch are acceptable.
- Do not spend time on compatibility shims for the old internal web structure.
- Preserve the current product model:
  - thread-scoped conversations
  - thread-scoped terminal sessions
  - agent SSE and terminal SSE as the primary live browser transport paths
- Fix architectural ownership first rather than polishing individual components in place.
- Add a real web test harness early rather than leaving tests until the end.
- Keep TanStack Router as the routing system.
- Prefer extracting hooks and feature modules over introducing a heavy global mutable store by default.
- If a client data layer is introduced, it must serve the refactor by reducing duplicated fetch/cache logic rather than adding a second architecture beside the current one.
- Placeholder UI that is not actually functional should be hidden or explicitly gated by the end of the refactor.
- Spec/docs updates are part of the refactor, not a follow-up chore.

## Success Criteria

- [ ] `web/src/routes/$budId/$threadId.tsx` is reduced from a mixed-runtime god file into a thin route and composed feature modules
- [x] `web/src/routes/$budId/new.tsx` and `web/src/routes/$budId/$threadId.tsx` share a real workspace shell and shared model-loading/composer infrastructure
- [x] `web/src/lib/api.ts` is split into smaller, ownership-oriented modules
- [x] duplicated auth gating is removed from child routes in favor of a protected-shell approach
- [x] destructive/mutating UI flows follow a consistent error and pending-state pattern
- [ ] the app has automated coverage for message reconciliation, stream/reconnect logic, and route auth behavior
- [x] the current known correctness issues are fixed
- [x] web specs describe the resulting module layout accurately

## Current Progress

The refactor is now past the foundation/auth/workspace phases and through the main runtime-ownership slices of Phase 4.

Completed so far:

- `web/src/lib/api.ts` has been split into narrower transport/auth/type/helper modules while preserving a compatibility re-export surface
- root-auth/session loading is centralized and child-route auth fetch duplication has been removed
- the shared workspace shell is used by both `/$budId/new` and `/$budId/$threadId`
- Bud-scoped thread summary ownership lives in the Bud route context rather than being treated as immutable loader output
- the `system` theme live-update bug and invisible thread-delete failures are fixed
- the web package now has a runnable `test` / `test:watch` command using Node's built-in test runner with TypeScript stripping
- initial pure-helper coverage now exists for auth redirect normalization, transcript/message reconciliation, and shared stream timing policy
- transcript/message ownership has been extracted from `/$budId/$threadId` into `web/src/features/threads/use-thread-messages.ts`
- agent SSE ownership has been extracted from `/$budId/$threadId` into `web/src/features/threads/use-agent-stream.ts`
- terminal session/xterm ownership has been extracted from `/$budId/$threadId` into `web/src/features/threads/use-terminal-session.ts`
- terminal presentation has been extracted into `web/src/components/workbench/thread-terminal-pane.tsx`, reducing `/$budId/$threadId` to route-level composition
- Phase 5 has started: the heavy tool-payload JSON viewer and fenced-code syntax highlighter now load on demand instead of living on the initial thread-route path
- `ChatTimeline` now consumes the hook-owned chronological transcript directly, and message-local overflow/expand/copy state no longer forces whole-list sorting/measurement passes during interaction

Closeout state:

- the manual validation pass is complete
- the web refactor validation checklist is now closed
- deeper automated browser/runtime hardening is intentionally deferred to the follow-up design in `../../design/web-refactor-test-hardening.md`

Deferred follow-up note:

- further async viewer/highlighter chunk reduction is intentionally deferred for now
- we want to preserve broad language support up front rather than trimming syntax coverage just to shrink the current async chunk
- the heavier viewer/code-block path should be revisited when the current JSON inspector is replaced with a streaming JSON library, because that change is expected to reshape both tool-payload rendering and code-block/highlighter boundaries

## Non-Goals

- redesigning the Bud product UX
- changing the backend REST/SSE contracts unless a small browser-side cleanup requires clarification
- replacing TanStack Router
- redesigning the auth product
- introducing multi-user collaboration semantics beyond the existing ownership constraints
- implementing the placeholder web-view feature
- implementing the Bud-rail add-button feature in this refactor
- adding new product capabilities unrelated to the refactor

## Planned Module Shape

The target direction for `web/src/` is roughly:

```text
web/src/
  app/
    protected-app-shell.tsx
  features/
    auth/
      routes/
      components/
      hooks/
    workspace/
      components/
      hooks/
      model-selection/
    buds/
      hooks/
      bud-route-store.ts
    threads/
      api/
      hooks/
      message-store.ts
      agent-stream.ts
      transcript-pagination.ts
    terminal/
      hooks/
      xterm/
      transport/
      readiness/
  lib/
    transport/
    auth/
    api-types/
    utils/
```

This exact directory layout is not mandatory, but the resulting ownership boundaries must be clear:

- auth/session shell ownership
- API/transport ownership
- Bud-route/thread-list ownership
- shared workspace-shell ownership
- thread message-state ownership
- agent stream ownership
- terminal session/runtime ownership
- presentation-only component ownership

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-foundation-test-harness-and-shared-client-boundaries.md](./phase-1-foundation-test-harness-and-shared-client-boundaries.md) | Urgent | Establish the test harness, extract low-risk shared browser helpers, and fix the cheap correctness issues first |
| 2 | [phase-2-route-auth-shell-and-api-surface-split.md](./phase-2-route-auth-shell-and-api-surface-split.md) | Urgent | Centralize auth gating and split the shared API/auth/EventSource surface into smaller modules |
| 3 | [phase-3-workspace-shell-deduplication-and-bud-layout-cleanup.md](./phase-3-workspace-shell-deduplication-and-bud-layout-cleanup.md) | High | Remove route duplication between new/existing thread workspaces and clean up Bud-layout ownership |
| 4 | [phase-4-thread-runtime-decomposition.md](./phase-4-thread-runtime-decomposition.md) | High | Split the thread view into message, agent-stream, and terminal-session hooks/components |
| 5 | [phase-5-performance-ux-consistency-and-final-doc-alignment.md](./phase-5-performance-ux-consistency-and-final-doc-alignment.md) | High | Improve performance-sensitive rendering paths, normalize UX debt, and finish spec/doc alignment |

## Expected Files And Areas

### Web code

- `web/src/routes/__root.tsx`
- `web/src/routes/index.tsx`
- `web/src/routes/login.tsx`
- `web/src/routes/settings.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/`
- `web/src/contexts/`
- `web/src/components/workbench/`
- `web/src/components/message-renderers/`
- any new feature folders introduced during the refactor

### Web documentation/specs

- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/components/components.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/contexts/contexts.spec.md`
- any new folder-level spec files created by the refactor

### Protocol/docs

- `docs/proto.md` only if browser-visible SSE or request-shape documentation needs clarification during implementation

## Known Issues To Fix During The Refactor

The following findings from the review are in scope as correctness or architectural fixes:

1. `system` theme mode does not react to OS theme changes while the app is open
2. thread deletion failures are console-only and not visible in the UI
3. child routes duplicate root-auth fetch/gating work
4. `/$budId/new` and `/$budId/$threadId` duplicate workspace/model-loading logic
5. `web/src/lib/api.ts` mixes transport, auth redirects, types, and terminal helpers in one module
6. the thread timeline render path eagerly loads heavy viewers and performs fully manual DOM measurement
7. placeholder UI remains exposed as if it were complete product UI

## Sequencing Notes

- Put the test harness first so later phases can move code without flying blind.
- Extract the lowest-risk shared boundaries before attacking the thread runtime.
- Centralize auth shell behavior before splitting more route modules, otherwise duplicated route logic will keep reappearing.
- Deduplicate the workspace shell before decomposing the thread runtime in depth; otherwise shared UI changes still need to be done twice.
- Treat the thread route decomposition as an ownership split, not a line-count exercise.
- Performance work belongs after the runtime split, once the feature boundaries are explicit enough to optimize deliberately.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The refactor devolves into file moves without reducing route ownership | Medium | High | Make each phase define explicit ownership extractions, not just target file counts |
| The thread runtime split changes subtle transcript or reconnect behavior | Medium | High | Add reducer/stream tests in Phase 1 and extend them through Phase 4 |
| Auth redirection behavior regresses while centralizing route gating | Medium | High | Add route auth tests before removing duplicated route guards |
| The new shared workspace shell still leaks route-specific assumptions | Medium | Medium | Keep shared workspace primitives narrow and pass route-specific behavior in explicitly |
| The app gains a new client data layer that overlaps awkwardly with route state | Medium | Medium | Only adopt one when it clearly replaces duplicated fetch/cache logic rather than coexisting with it |
| Performance tweaks happen before ownership is clear and create more hidden coupling | Medium | Medium | Delay major render-path optimization until after Phase 4 |

## Execution Strategy

This work does not need rollout planning.

The intended execution order is:

1. establish tests and extract low-risk shared client helpers
2. centralize auth shell behavior and split `api.ts`
3. deduplicate the workspace shell and Bud-layout concerns
4. decompose the thread runtime into explicit message/agent/terminal units
5. optimize the render path, normalize UX debt, and align specs/docs

## Definition Of Done

- [ ] route files are materially smaller and primarily compose feature modules
- [ ] auth/session gating is centralized and not redundantly fetched in child routes
- [ ] `api.ts` no longer acts as a single catch-all browser runtime helper
- [ ] new and existing thread workspaces share a real shell and shared model/composer logic
- [ ] the thread runtime is split into explicit message, agent-stream, and terminal-session ownership units
- [ ] test coverage exists for the most failure-prone browser logic
- [ ] the known correctness/UX issues in the review are addressed
- [ ] web specs and related docs are updated to match the new structure
