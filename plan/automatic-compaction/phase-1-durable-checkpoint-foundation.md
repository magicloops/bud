# Phase 1: Durable Checkpoint Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Add durable, owner-stamped checkpoint storage without changing conversation reconstruction yet.

By the end of this phase:

- the database has an append-only `agent_context_checkpoint` table
- repository helpers can write attempts and load the latest completed checkpoint
- ownership inheritance is explicit
- migration and schema specs describe the new runtime table

## Scope

### In Scope

- Drizzle schema addition
- checked-in migration generation
- repository/service helper for checkpoint reads and writes
- type definitions for checkpoint status, trigger, reason, and phase
- tests for ownership stamps and latest-completed selection

### Out Of Scope

- using checkpoints in `AgentConversationLoader`
- calling a provider to create summaries
- automatic trigger logic
- browser-facing checkpoint APIs

## Implementation Tasks

### Task 1: Add the schema table

Add `agent_context_checkpoint` in `service/src/db/schema.ts`.

Required columns:

- `checkpoint_id` ULID primary key
- `thread_id` foreign key to `thread`
- `trigger`
- `reason`
- `phase`
- `implementation`
- `status`
- `source_provider`
- `source_model`
- `source_reasoning_effort`
- `summary`
- `replacement_history` JSONB
- `compacted_through_message_created_at`
- `compacted_through_message_id`
- `compacted_through_llm_call_created_at`
- `compacted_through_llm_call_id`
- `input_tokens_before`
- `estimated_tokens_after`
- `error` JSONB
- `tenant_id`
- `created_by_user_id`
- `created_at`
- `completed_at`

Recommended indexes:

- `(thread_id, status, created_at desc)`
- `(thread_id, compacted_through_message_created_at, compacted_through_message_id)`
- `(thread_id, compacted_through_llm_call_created_at, compacted_through_llm_call_id)`

Keep enum-like fields as string columns unless the codebase already has a local enum pattern for similar agent runtime state.

### Task 2: Generate and verify migrations

Follow the project Drizzle workflow:

1. edit `service/src/db/schema.ts`
2. run `pnpm db:push` from `service/` for local development
3. run `pnpm db:generate` from `service/`
4. review generated SQL and metadata
5. update migration specs

The migration must be deployable through `pnpm db:migrate`; `db:push` alone is not enough for this schema change.

### Task 3: Add typed checkpoint helpers

Create a small helper module, tentatively `service/src/agent/context-checkpoint-repository.ts`.

Required operations:

- `getLatestCompletedCheckpoint({ threadId })`
- `createPendingCheckpointAttempt(...)` or `recordCheckpointAttempt(...)`
- `markCheckpointCompleted(...)`
- `markCheckpointFailed(...)`

Implementation can collapse create/complete into one insert if compaction is synchronous, but the type model should still distinguish `completed` from `failed` attempts so diagnostics are durable.

### Task 4: Stamp ownership from thread owner

Automatic compaction must inherit `created_by_user_id` from the owning thread, not from untrusted input.

Repository writes should receive the already authorized or runtime-owned thread owner and store:

- `created_by_user_id = thread.created_by_user_id`
- `tenant_id = thread.tenant_id` when available

No browser route should accept raw owner fields.

### Task 5: Bound error details

Failed checkpoints should store a bounded diagnostic object, for example:

```json
{
  "code": "CONTEXT_WINDOW",
  "message": "Provider request exceeded context window after trimming",
  "retryable": false
}
```

Do not store full provider request bodies or API credentials in `error`.

## Files Likely Affected

- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- `service/src/agent/context-checkpoint-repository.ts`
- `service/src/agent/agent.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `bud.spec.md`

## Tests

Add focused tests for:

- latest completed checkpoint ignores failed and canceled rows
- latest completed checkpoint chooses the newest completed row for a thread
- checkpoint writes include `created_by_user_id`
- checkpoint writes do not require or expose browser authorization helpers
- replacement history round trips as JSONB canonical messages

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Schema stores too little boundary metadata | Medium | High | Include both message and LLM-call boundaries in Phase 1 |
| Failed attempts accidentally become active | Low | High | Loader later filters strictly on `status = completed`; repository tests cover selection |
| Raw replacement history becomes browser-visible | Low | High | Keep repository service-only and add no route in this phase |
| Migration drifts from schema | Medium | High | Run both `db:push` and `db:generate`, then update migration specs |

## Exit Criteria

- `agent_context_checkpoint` exists in schema and checked-in migrations.
- Repository helpers can write and read checkpoint rows.
- Ownership stamping is tested.
- No runtime reconstruction behavior changes yet.
