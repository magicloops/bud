# Progress Checklist: Bud Offline Mode

## Phase 1: Environment State Contract

- [x] Define `AgentEnvironmentMode` and environment snapshot types.
- [x] Add owner-scoped environment resolver.
- [x] Add idle `/agent/state.environment`.
- [x] Add active `/agent/state.environment`.
- [x] Add create-message `agent` startup metadata.
- [ ] Add route/runtime tests.
- [x] Update protocol and backend specs.

## Phase 2: Offline Startup And Tool Catalog

- [x] Resolve environment before fresh message startup.
- [x] Skip context sync while Bud is offline.
- [x] Start offline-aware agent turns without terminal ensure.
- [x] Add tool-catalog resolver.
- [x] Exclude terminal and web-view tools while offline.
- [x] Keep `ask_user_questions` available while offline.
- [x] Add offline environment prompt context.
- [ ] Add offline startup tests.

## Phase 3: Transport Tool Results And Recovery

- [x] Normalize transport errors into tool-result metadata.
- [x] Convert terminal transport failures into tool results.
- [x] Convert web-view transport failures into tool results.
- [x] Refresh environment before provider steps.
- [x] Refresh environment before Bud-specific tool dispatch.
- [x] Restore Bud tools after reconnect before later provider steps.
- [ ] Add recovery tests.

## Phase 4: Reference Client Composer Status

- [x] Extend web client types.
- [x] Render composer-level Bud offline status.
- [x] Reconcile `agent.mode: "bud_offline"` send success.
- [x] Preserve normal request-failure UI.
- [ ] Add/update web tests.
- [ ] Prepare mobile handoff notes.

## Phase 5: Docs, Validation, And Rollout

- [x] Update `docs/proto.md`.
- [x] Update service/web specs.
- [ ] Run backend automated tests.
- [ ] Run web automated tests.
- [ ] Complete manual validation matrix.
- [x] Capture rollout notes for mobile.
