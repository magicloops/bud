# Progress Checklist: Service Layer Refactor

## Phase 1: Contract Bugs And Legacy Runtime Removal

- [ ] Remove the standalone `/api/runs` route and its bootstrap wiring
- [ ] Remove the legacy `/api/runs/:runId/stream` SSE path
- [ ] Remove the legacy `/api/terminals/:budId/stream` SSE path
- [ ] Remove `RunManager`/`RunEventBus` runtime ownership that exists only for the deleted surface
- [ ] Make provider-less service boot legal for auth/device-claim flows
- [ ] Unify enrollment-token hashing behind one shared helper
- [ ] Make thread-title generation choose an available provider or skip quietly
- [ ] Fix the Node REPL context-sync heuristic
- [ ] Align service/operator DB workflow docs with `db:push` local and `db:migrate` staging

## Phase 2: Terminal Runtime Ownership Split

- [ ] Introduce a single `ensureSessionRecordForThread(...)` ownership boundary
- [ ] Extract terminal request-dispatch ownership
- [ ] Reject pending send/observe waits on cancel
- [ ] Reject pending send/observe waits on Bud offline transition
- [ ] Extract output persistence/replay ownership
- [ ] Extract readiness/context/idle ownership
- [ ] Add direct tests for session creation race handling
- [ ] Add direct tests for cancel/offline fast-fail behavior

## Phase 3: Agent Runtime Ownership Split

- [ ] Extract conversation-loading ownership
- [ ] Extract model-runner ownership
- [ ] Extract terminal tool execution ownership
- [ ] Extract transcript writer/runtime emission ownership
- [ ] Extract cancellation coordination ownership
- [ ] Add agent seam tests for model/tool/cancel behavior

## Phase 4: Route And Gateway Decomposition

- [ ] Split `routes/threads.ts` into smaller modules
- [ ] Split websocket gateway ownership into smaller modules
- [ ] Reduce `server.ts` to a thin composition root
- [ ] Remove any lingering references to deleted legacy runtime surfaces
- [ ] Add route/gateway regression coverage for the new seams

## Phase 5: Validation, Specs, And Final Cleanup

- [ ] Run the manual validation matrix
- [ ] Update `service/service.spec.md`
- [ ] Update `service/src/src.spec.md`
- [ ] Update affected `service/src/*/*.spec.md` files
- [ ] Update `service/README.md`
- [ ] Update Drizzle workflow docs/specs if touched
- [ ] Update `AGENTS.md` if the DB workflow note is corrected there
- [ ] Update `bud.spec.md`
- [ ] Remove or explicitly document any remaining legacy runtime/schema remnants
