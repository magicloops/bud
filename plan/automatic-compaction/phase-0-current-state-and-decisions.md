# Phase 0: Current State And Decisions

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Lock the implementation baseline before schema and runtime changes begin.

By the end of this phase:

- the current unbounded context behavior is captured in tests or fixtures
- implementation choices from the design doc are confirmed in this plan
- risky unknowns have explicit owners or follow-up tasks
- later phases can change schema/runtime code without rediscovering the same context

## Context

The design review found three current pressure points:

- turn-start reconstruction loads full transcript history and same-provider ledger history
- in-turn tool loops append model output and tool results without a budget guard
- provider usage and model context windows exist but are not used to decide when to compact

Phase 0 should verify that those findings still match the branch before implementation starts.

## Scope

### In Scope

- reread current agent, loader, provider ledger, model catalog, and schema code
- identify exact tests to add or update in later phases
- lock first-tranche choices that affect data model and route semantics
- decide fixture shape for long-history and tool-heavy transcripts

### Out Of Scope

- adding the checkpoint table
- changing conversation reconstruction behavior
- calling providers for compaction
- exposing stream events or manual compaction routes

## Implementation Tasks

### Task 1: Reconfirm current reconstruction paths

Read and summarize the current behavior of:

- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/db/schema.ts`

Record any branch drift directly in this phase file or the parent implementation spec before editing code.

### Task 2: Lock first-tranche decisions

Confirm these decisions still hold:

- checkpoint rows stay outside the visible transcript
- pre-turn compaction runs inside `runAgentFlow(...)` after the new user message is persisted
- `PATCH /api/threads/:thread_id/model-preference` does not call a provider
- manual compaction remains deferred until Phase 5
- compaction provider calls are not recorded in `llm_call` during the first tranche
- automatic compaction ships with a kill switch and a clamped threshold ratio
- current terminal context for mid-turn compaction is a fresh service-built model note, not old context-sync row replay

If implementation pressure changes any item, update [implementation-spec.md](./implementation-spec.md) before code changes.

### Task 3: Define test fixtures

Create or identify fixtures for:

- long visible transcript that exceeds a small synthetic context window
- thread with a completed checkpoint and post-checkpoint messages
- same-provider provider-ledger rows before and after a checkpoint
- provider-switch reconstruction after a checkpoint
- tool loop where a large tool result forces mid-turn compaction
- provider context-window error during a compaction request

Use small synthetic token windows in tests so fixtures stay readable.

### Task 4: Decide boundary ordering assumptions

Document the deterministic boundary rule used by later phases:

- transcript rows after a checkpoint are rows where `(created_at, message_id)` sorts after `(compacted_through_message_created_at, compacted_through_message_id)`
- LLM call rows after a checkpoint are rows where `(created_at, llm_call_id)` sorts after `(compacted_through_llm_call_created_at, compacted_through_llm_call_id)`

If current schema cannot support deterministic sorting reliably, Phase 1 must add supporting indexes or Phase 2 must use an alternate boundary.

### Task 5: Identify route ownership boundaries

Confirm no browser-facing checkpoint read route is needed for phases 1-4.

If Phase 5 adds manual compaction:

- resolve thread ownership through `getAuthorizedThread(...)`
- return `404` for authenticated non-owner access
- never return raw `replacement_history` by default

## Files Likely Read

- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/db/schema.ts`
- `service/src/routes/threads/`

## Tests To Prepare

- fixture-builder helpers for synthetic thread messages and provider ledger rows
- no-checkpoint reconstruction baseline
- budget estimator synthetic-window cases
- context-window error normalization fixtures for OpenAI and Anthropic

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Branch behavior has drifted since the design review | Medium | Medium | Reconfirm files before Phase 1 edits |
| Tests are too tied to production model windows | Medium | Medium | Use synthetic catalog entries or injectable context windows |
| Boundary ordering assumptions are ambiguous | Medium | High | Decide and test `(created_at, id)` ordering before loader changes |

## Exit Criteria

- Current-state assumptions are confirmed or updated.
- First-tranche decisions are documented and accepted.
- Fixture needs are clear enough for phases 1-4.
- No schema/runtime changes are blocked by unresolved product choices.
