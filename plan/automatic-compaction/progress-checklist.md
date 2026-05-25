# Progress Checklist: Automatic Context Compaction

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented, validation pending

---

## Phase 0: Current State And Decisions

- [x] Reconfirm current reconstruction and provider-ledger behavior.
- [x] Lock first-tranche implementation decisions.
- [x] Define long-history and tool-heavy fixtures.
- [x] Confirm checkpoint boundary ordering rules.
- [x] Confirm no browser-facing checkpoint route is required for phases 1-4.

## Phase 1: Durable Checkpoint Foundation

- [x] Add `agent_context_checkpoint` to `service/src/db/schema.ts`.
- [x] Generate and review checked-in Drizzle migration.
- [x] Add checkpoint repository/helper module.
- [x] Add owner-stamped checkpoint write tests.
- [x] Add latest-completed checkpoint selection tests.
- [x] Update DB and migration specs.

## Phase 2: Conversation Loader Checkpoint Boundary

- [x] Inject checkpoint lookup into `AgentConversationLoader`.
- [x] Preserve no-checkpoint reconstruction behavior.
- [x] Add checkpoint replacement history after the system prompt.
- [x] Filter transcript rows after checkpoint message boundary.
- [x] Filter provider-ledger rows after checkpoint LLM-call boundary.
- [x] Add checkpoint reconstruction diagnostics.
- [ ] Add provider-switch fallback tests after checkpoint.

## Phase 3: Local Summary Compactor

- [x] Add `AgentContextCompactor`.
- [x] Add compaction prompt constant.
- [x] Invoke provider with no tools.
- [x] Build replacement history from summary note, recent user messages, and fresh terminal context.
- [x] Normalize provider context-window errors.
- [x] Add retry trimming with tool-use/tool-result pairing.
- [x] Persist completed and failed checkpoint attempts.
- [ ] Add compactor and trimming tests.

## Phase 4: Automatic Triggers And Budgeting

- [x] Add token budget estimator.
- [x] Add `AGENT_AUTO_COMPACTION_ENABLED` kill switch.
- [x] Add clamped threshold ratio configuration.
- [x] Wire pre-turn compaction.
- [x] Wire mid-turn compaction.
- [x] Handle model downshift on next message send.
- [x] Avoid duplicate checkpoints for the same boundary.
- [ ] Add trigger/failure tests.

## Phase 5: Stream Client Contract And Manual Compaction Decision

- [x] Decide whether additive compaction SSE events ship now.
- [x] If shipping events, implement `agent.compaction_start`.
- [x] If shipping events, implement `agent.compaction_done`.
- [x] If shipping events, implement `agent.compaction_failed`.
- [x] If shipping events, update web stream types.
- [x] Decide whether manual compaction remains deferred.
- [ ] If manual route ships, add owner authorization and route tests.
- [x] Update `docs/proto.md` for any new SSE event shapes.

## Phase 6: Validation Docs And Rollout

- [x] Run focused service tests.
- [x] Run service build.
- [ ] Run local `db:push` and checked-in migration generation.
- [ ] Review generated migration SQL and metadata.
- [ ] Complete manual validation checklist.
- [x] Update all affected specs.
- [ ] Document rollout and rollback controls.
- [ ] Record final validation status in this checklist.

## Deferred Follow-Ups

- [ ] Evaluate provider-native remote compaction.
- [ ] Design public manual compaction UI if product needs it.
- [ ] Add checkpoint browsing/admin tooling if operations needs it.
- [ ] Evaluate provider-specific token counters.
- [ ] Revisit summary quality after repeated compactions on real workloads.
