# automatic-compaction

Implementation planning documents for automatic context compaction in the Bud service agent loop.

## Purpose

This folder turns the design work in [../../design/context-compaction.md](../../design/context-compaction.md) into an actionable phased implementation plan.

The plan assumes:

- the visible transcript remains append-only and unchanged by automatic compaction
- compacted model-visible context is service-owned runtime state, persisted outside the `message` table
- the latest completed checkpoint creates the replay boundary for future LLM calls
- the first implementation uses local summary compaction through Bud's existing provider interface
- automatic pre-turn and mid-turn compaction are required before exposing manual compaction as product UI

## Files

### `implementation-spec.md`

Parent implementation spec for the automatic compaction rollout.

Documents:

- fixed decisions carried over from the design doc
- the durable checkpoint architecture
- phase sequencing and dependencies
- expected files and spec updates
- open questions and known unknowns

### `phase-0-current-state-and-decisions.md`

Discovery and decision-lock phase covering:

- current unbounded reconstruction behavior
- concrete implementation decisions that must be fixed before schema/runtime edits
- fixture and test baselines for later phases

### `phase-1-durable-checkpoint-foundation.md`

Database and repository phase covering:

- the `agent_context_checkpoint` table
- owner-stamped append-only checkpoint writes
- latest-completed checkpoint lookup
- schema and migration documentation

### `phase-2-conversation-loader-checkpoint-boundary.md`

Conversation reconstruction phase covering:

- loading system prompt plus checkpoint replacement history plus post-checkpoint delta
- provider-ledger filtering after the checkpoint boundary
- diagnostics for checkpointed reconstruction

### `phase-3-local-summary-compactor.md`

Compactor implementation phase covering:

- local summary compaction through the existing provider interface
- replacement-history construction
- context-window retry trimming
- provider context-window error normalization

### `phase-4-automatic-triggers-and-budgeting.md`

Automatic trigger phase covering:

- token budget estimation
- pre-turn compaction
- mid-turn compaction
- model downshift behavior
- failure and kill-switch semantics

### `phase-5-stream-client-contract-and-manual-compaction-decision.md`

Client contract phase covering:

- optional additive `agent.compaction_*` SSE events
- first-party type updates
- manual compaction decision points and deferred API shape

### `phase-6-validation-docs-and-rollout.md`

Finalization phase covering:

- automated and manual validation
- spec and protocol updates
- migration rollout
- operational metrics and rollback controls

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated validation checklist for the compaction rollout.

## Dependencies

- [../../design/context-compaction.md](../../design/context-compaction.md) - durable checkpoint design and current implementation review
- [../../reference/CONTEXT_COMPACTION_SPEC.md](../../reference/CONTEXT_COMPACTION_SPEC.md) - external reference strategy adapted for Bud
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current agent orchestration, conversation loading, and tool-loop ownership
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - service schema and ownership conventions
- [../../service/drizzle/migrations/migrations.spec.md](../../service/drizzle/migrations/migrations.spec.md) - checked-in migration workflow
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - provider interface and usage accounting context
- [../../docs/proto.md](../../docs/proto.md) - SSE contract documentation if compaction stream events ship
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

No tracked implementation debt exists yet. Open decisions and known unknowns are documented in [implementation-spec.md](./implementation-spec.md) and should be resolved or carried forward during implementation.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
