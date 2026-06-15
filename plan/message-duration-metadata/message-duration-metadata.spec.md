# message-duration-metadata

Implementation planning documents for standardizing per-message work-duration
metadata on agent-created transcript artifacts.

## Purpose

This folder turns the design work in:

- [../../design/agent-message-work-duration-contract.md](../../design/agent-message-work-duration-contract.md)
- [../../design/mobile-tool-call-timing-and-compaction.md](../../design/mobile-tool-call-timing-and-compaction.md)
- [../../plan/tool-timing/implementation-spec.md](../tool-timing/implementation-spec.md)

into an actionable phased implementation plan.

The plan assumes:

- clients own grouping and collapsed-summary presentation
- the backend owns per-message timing capture and durable metadata
- timing fields live in existing `message.metadata` JSONB, not a new table
- `message.created_at` remains ordering/persistence metadata only
- a durable `agent_turn` table is deferred until product needs turn-level status
  or exact turn wall-clock semantics

## Files

### `implementation-spec.md`

Parent implementation spec for the message-duration metadata rollout.

Documents:

- current timing gaps by message role
- fixed API/metadata decisions
- phase sequencing
- risks, non-goals, and definition of done

### `phase-1-contract-and-helper-foundation.md`

Foundation phase covering:

- canonical metadata field names and semantics
- shared helper shape for service wall-clock timing
- TypeScript metadata typing boundaries

### `phase-2-tool-and-reasoning-metadata.md`

Persistence phase covering:

- adding durable `turn_id` and `duration_source` to tool rows
- adding `duration_ms` and `duration_source` to reasoning rows
- keeping replay payloads unchanged

### `phase-3-assistant-timing-stream-and-persistence.md`

Assistant phase covering:

- assistant draft `started_at` tracking
- live `agent.message_start` / `agent.message_done` timing fields
- persisted intermediate and final assistant timing metadata

### `phase-4-client-types-docs-and-validation.md`

Finalization phase covering:

- first-party web type alignment
- protocol and spec updates
- mobile fixtures/handoff expectations
- automated and manual validation

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated verification checklist for the plan.

## Dependencies

- [../../design/agent-message-work-duration-contract.md](../../design/agent-message-work-duration-contract.md) - design source of truth for per-message timing
- [../../plan/tool-timing/implementation-spec.md](../tool-timing/implementation-spec.md) - existing tool timing rollout this plan extends
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent orchestration and transcript-writer contract
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) - active runtime state contract
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - HTTP/SSE route contract overview
- [../../service/src/routes/threads/threads.spec.md](../../service/src/routes/threads/threads.spec.md) - thread route and message-history contract
- [../../web/src/src.spec.md](../../web/src/src.spec.md) - web source and API type overview
- [../../docs/proto.md](../../docs/proto.md) - public protocol and SSE contract documentation
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- A durable `agent_turn` table remains intentionally deferred. Add a separate
  design and plan if product needs reload-stable turn status for failed/canceled
  turns without persisted message artifacts.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
