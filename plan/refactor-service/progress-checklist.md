# Progress Checklist: Service Layer Refactor

**Overall Status**: Closed; Post-Closeout Regression Validated And Documented

## Phase 1: Contract Bugs And Legacy Runtime Removal

- [x] Remove the standalone `/api/runs` route and its bootstrap wiring
- [x] Remove the legacy `/api/runs/:runId/stream` SSE path
- [x] Remove the legacy `/api/terminals/:budId/stream` SSE path
- [x] Remove `RunManager`/`RunEventBus` runtime ownership that exists only for the deleted surface
- [x] Make provider-less service boot legal for auth/device-claim flows
- [x] Unify enrollment-token hashing behind one shared helper
- [x] Make thread-title generation choose an available provider or skip quietly
- [x] Fix the Node REPL context-sync heuristic
- [x] Align service/operator DB workflow docs with `db:push` local and `db:migrate` staging

## Phase 2: Terminal Runtime Ownership Split

- [x] Introduce a single `ensureSessionRecordForThread(...)` ownership boundary
- [x] Extract terminal request-dispatch ownership
- [x] Reject pending send/observe waits on cancel
- [x] Reject pending send/observe waits on Bud offline transition
- [x] Extract output persistence/replay ownership
- [x] Extract readiness/context/idle ownership
- [x] Add direct tests for session creation race handling
- [x] Add direct tests for cancel/offline fast-fail behavior

## Phase 3: Agent Runtime Ownership Split

- [x] Extract conversation-loading ownership
- [x] Extract model-runner ownership
- [x] Extract terminal tool execution ownership
- [x] Extract transcript writer/runtime emission ownership
- [x] Extract cancellation coordination ownership
- [x] Add agent seam tests for model/tool/cancel behavior

## Phase 4: Route And Gateway Decomposition

- [x] Split `routes/threads.ts` into smaller modules
- [x] Split websocket gateway ownership into smaller modules
- [x] Reduce `server.ts` to a thin composition root
- [x] Remove any lingering references to deleted legacy runtime surfaces
- [x] Add route/gateway regression coverage for the new seams

## Phase 5: Validation, Specs, And Final Cleanup

- [x] Run the manual validation matrix
- [x] Update `service/service.spec.md`
- [x] Update `service/src/src.spec.md`
- [x] Update affected `service/src/*/*.spec.md` files
- [x] Update `service/README.md`
- [x] Update Drizzle workflow docs/specs if touched
- [x] Update `AGENTS.md` if the DB workflow note is corrected there
- [x] Update `bud.spec.md`
- [x] Remove or explicitly document any remaining legacy runtime/schema remnants

## Phase 6: Service Lint Recovery

- [x] Normalize TypeScript ESLint rule ownership in `service/eslint.config.js`
- [x] Resolve contract-surface `no-unused-vars` errors without broad suppressions
- [x] Resolve Better Auth bridge lint/type-global errors in `service/src/auth/auth.ts`
- [x] Resolve real unused-value fallout in refactor-touched service modules
- [x] Pass `pnpm --dir /Users/adam/bud/service lint`

## Phase 7: Final Build, Lint, And Closeout

- [x] Resolve or explicitly document the remaining warning-only `service` lint debt
- [x] Pass final `pnpm --dir /Users/adam/bud/service build`
- [x] Pass final `pnpm --dir /Users/adam/bud/service lint`
- [x] Pass final `pnpm --dir /Users/adam/bud/web build`
- [x] Scope the remaining `web` lint fallout as an explicit Phase 8 follow-on

## Phase 8: Web Lint Recovery And Final Closeout

- [x] Resolve the React Fast Refresh context-module lint errors
- [x] Resolve the remaining route-level unused-vars findings
- [x] Resolve the remaining route hook-dependency warnings intentionally
- [x] Pass final `pnpm --dir /Users/adam/bud/web lint`
- [x] Reconfirm the full final `service` / `web` build-lint matrix after the web fixes
- [x] Mark the service refactor closed in the docs/checklists

## Phase 9: Web Regression Validation Before Structural Fixes

- [x] Log `threadId`, `initialThread.thread_id`, and `currentThread.thread_id` during thread navigation
- [x] Log terminal state/connection before and after the thread-change reset branch in `/$budId/$threadId`
- [x] Log `recoverTerminalSession(...)` calls and confirm they target the newly selected thread/session
- [x] Log parent-route `matches` and resolved `activeThreadId` in `/$budId`
- [x] Reproduce after a hard refresh / dev-server restart to distinguish route-state vs Fast Refresh exposure
- [x] Update the debug note with the validation outcome and recommended fix direction
