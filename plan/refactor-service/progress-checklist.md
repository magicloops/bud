# Progress Checklist: Service Layer Refactor

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

- [ ] Run the manual validation matrix
- [x] Update `service/service.spec.md`
- [x] Update `service/src/src.spec.md`
- [x] Update affected `service/src/*/*.spec.md` files
- [x] Update `service/README.md`
- [x] Update Drizzle workflow docs/specs if touched
- [x] Update `AGENTS.md` if the DB workflow note is corrected there
- [x] Update `bud.spec.md`
- [x] Remove or explicitly document any remaining legacy runtime/schema remnants
