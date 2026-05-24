# Implementation Spec: Automatic Context Compaction

**Status**: Implemented, validation pending
**Created**: 2026-05-23
**Design Doc**: [../../design/context-compaction.md](../../design/context-compaction.md)
**Reference Spec**: [../../reference/CONTEXT_COMPACTION_SPEC.md](../../reference/CONTEXT_COMPACTION_SPEC.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-current-state-and-decisions.md](./phase-0-current-state-and-decisions.md)
**Phase 1**: [phase-1-durable-checkpoint-foundation.md](./phase-1-durable-checkpoint-foundation.md)
**Phase 2**: [phase-2-conversation-loader-checkpoint-boundary.md](./phase-2-conversation-loader-checkpoint-boundary.md)
**Phase 3**: [phase-3-local-summary-compactor.md](./phase-3-local-summary-compactor.md)
**Phase 4**: [phase-4-automatic-triggers-and-budgeting.md](./phase-4-automatic-triggers-and-budgeting.md)
**Phase 5**: [phase-5-stream-client-contract-and-manual-compaction-decision.md](./phase-5-stream-client-contract-and-manual-compaction-decision.md)
**Phase 6**: [phase-6-validation-docs-and-rollout.md](./phase-6-validation-docs-and-rollout.md)

---

## Context

Bud reconstructs agent context from durable thread history before every provider call. That reconstruction is currently unbounded:

- `AgentConversationLoader.loadWithDiagnostics(...)` starts with the Bud Agent system prompt, then loads all persisted thread messages.
- Same-provider replay can include the full `llm_call` / `llm_call_item` provider ledger.
- `AgentService.runAgentFlow(...)` keeps appending assistant/tool output to an in-memory `conversation` array inside a tool loop.
- Provider usage is recorded, and the model catalog exposes `contextWindowTokens`, but there is no guardrail that uses either value to compact before an over-limit provider request.

The result is predictable: long-running threads and tool-heavy loops can exceed the selected model's context window and fail at the provider boundary.

## Objective

Add automatic context compaction so long-running threads remain usable without changing the visible transcript.

Specifically:

- persist service-owned model context checkpoints outside the `message` transcript
- reconstruct future LLM requests from fresh system prompt, latest checkpoint replacement history, and post-checkpoint delta
- compact before a new turn exceeds the selected model's budget
- compact mid-turn before the next provider call when tool results grow too large
- fail clearly if compaction cannot make the request fit
- keep ownership, provider-switching, and same-provider replay semantics explicit

## Fixed Decisions

These decisions are fixed for the initial implementation:

- Automatic compaction does not create user-visible `message` rows.
- Compaction state lives in a new append-only `agent_context_checkpoint` table.
- Only the latest completed checkpoint for a thread is active for reconstruction.
- Failed or canceled checkpoints are retained for diagnostics and ignored by the loader.
- Checkpoint `replacement_history` stores canonical Bud model messages and excludes the base Bud Agent system prompt.
- The system prompt, tool schemas, model settings, and auth/session context are always injected from current code.
- Provider ledger rows before the checkpoint boundary are not replayed on top of the checkpoint summary.
- The first compactor implementation uses Bud's existing provider interface with no tools.
- Compaction provider calls are recorded only on the checkpoint row in the first tranche, not in `llm_call`, to avoid replay pollution.
- Public manual compaction is deferred until automatic compaction is reliable.
- `PATCH /api/threads/:thread_id/model-preference` does not proactively call a provider. Model downshift compaction happens on the next agent run.
- `POST /api/threads/:thread_id/messages` with an explicit smaller model can compact before sampling if the reconstructed context exceeds the selected model budget.
- Automatic compaction is enabled by default when a model has a known `contextWindowTokens`, with an environment kill switch.

## Success Criteria

- [ ] A long thread compacts before the next provider request when it crosses the selected model threshold.
- [ ] A long tool loop can compact mid-turn and continue using the installed replacement history.
- [ ] Visible `/api/threads/:thread_id/messages` history is unchanged by automatic compaction.
- [ ] Service restart reconstructs from the latest completed checkpoint.
- [ ] Provider ledger rows before the checkpoint are not replayed on top of the summary.
- [ ] Checkpoint rows are stamped with inherited thread ownership.
- [ ] Non-owners cannot read or trigger checkpoint data through any browser-facing path.
- [ ] Context-window provider errors can trigger compaction retry trimming when safe.
- [ ] Compaction failures produce clear agent errors and do not silently drop transcript history.

## Non-Goals

- retrieval-augmented search over old transcript rows
- lossless compression of every prior message, tool call, and tool result
- user-editable compaction prompts
- provider-native remote compaction as the required baseline
- a public manual compaction route in the first backend tranche
- exposing raw checkpoint `replacement_history` through normal browser transcript routes
- changing Bud daemon or terminal WebSocket protocols

## Proposed Architecture

### Durable Checkpoint

Add an `agent_context_checkpoint` table with append-only rows. A completed row defines the active replay boundary for one thread.

Candidate columns:

| Column | Purpose |
|--------|---------|
| `checkpoint_id` | ULID primary key |
| `thread_id` | owning thread |
| `trigger` | `auto`, `manual`, or `model_downshift` |
| `reason` | `context_limit`, `context_error_retry`, `model_downshift`, or `user_requested` |
| `phase` | `pre_turn`, `mid_turn`, or `standalone_turn` |
| `implementation` | `local_summary` initially |
| `status` | `completed`, `failed`, or `canceled` |
| `source_provider` / `source_model` | provider and model used to summarize |
| `source_reasoning_effort` | selected reasoning effort for the summary call, if any |
| `summary` | raw handoff summary text |
| `replacement_history` | JSONB canonical messages installed after compaction, excluding base system prompt |
| `compacted_through_message_created_at` / `compacted_through_message_id` | transcript boundary |
| `compacted_through_llm_call_created_at` / `compacted_through_llm_call_id` | provider-ledger boundary |
| `input_tokens_before` | best known active-context token count before compaction |
| `estimated_tokens_after` | estimated replacement-history token count after compaction |
| `error` | bounded diagnostic object for failed attempts |
| `tenant_id` / `created_by_user_id` | standard ownership fields |
| `created_at` / `completed_at` | lifecycle timestamps |

### Conversation Reconstruction

`AgentConversationLoader` should reconstruct provider input in this order:

1. fresh Bud Agent system prompt
2. latest completed checkpoint `replacement_history`, if present
3. durable `message` rows after the checkpoint message boundary
4. same-provider `llm_call_item` rows after the checkpoint LLM-call boundary, when provider-native replay is valid

Provider switching continues to use canonical transcript fallback for the post-checkpoint delta.

### Local Summary Compactor

Add an `AgentContextCompactor` service collaborator that:

1. receives the current canonical conversation and boundary metadata
2. sends a no-tools compaction request to the selected provider/model
3. extracts assistant text as a handoff summary
4. builds compact provider-neutral `replacement_history`
5. persists a completed checkpoint
6. returns the replacement history to the caller for immediate in-memory use

The compactor must retry context-window failures by trimming the temporary compaction request from the oldest side while preserving required tool-use/tool-result pairing.

### Automatic Triggering

Add a token-budget helper that compares estimated active context tokens to a threshold derived from `contextWindowTokens`.

Initial policy:

- default threshold ratio: `0.9`
- allow `AGENT_AUTO_COMPACTION_ENABLED=false` as a kill switch
- allow `AGENT_AUTO_COMPACTION_RATIO` as a lower threshold override
- clamp any configured ratio to `<= 0.9`
- skip auto compaction if the selected model has no known window and no explicit threshold is configured

Pre-turn compaction runs at the start of `runAgentFlow(...)`, after the user message has been persisted and the conversation has been loaded. Mid-turn compaction runs before each follow-up provider call after assistant/tool output has been appended.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 0 | [phase-0-current-state-and-decisions.md](./phase-0-current-state-and-decisions.md) | Urgent | Lock current-state assumptions, decisions, and fixtures before runtime/schema edits |
| 1 | [phase-1-durable-checkpoint-foundation.md](./phase-1-durable-checkpoint-foundation.md) | Urgent | Add durable owner-stamped checkpoint storage and repository helpers |
| 2 | [phase-2-conversation-loader-checkpoint-boundary.md](./phase-2-conversation-loader-checkpoint-boundary.md) | Urgent | Reconstruct model input from checkpoint plus post-checkpoint transcript/provider delta |
| 3 | [phase-3-local-summary-compactor.md](./phase-3-local-summary-compactor.md) | Urgent | Implement local summary compaction, replacement-history building, and retry trimming |
| 4 | [phase-4-automatic-triggers-and-budgeting.md](./phase-4-automatic-triggers-and-budgeting.md) | Urgent | Compact automatically before over-budget pre-turn and mid-turn provider calls |
| 5 | [phase-5-stream-client-contract-and-manual-compaction-decision.md](./phase-5-stream-client-contract-and-manual-compaction-decision.md) | High | Add optional stream observability and decide whether manual compaction ships |
| 6 | [phase-6-validation-docs-and-rollout.md](./phase-6-validation-docs-and-rollout.md) | High | Complete tests, docs, migration rollout, metrics, and release gates |

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/model-runner.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/context-compactor.ts`
- `service/src/agent/context-checkpoint-repository.ts`
- `service/src/llm/types.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/llm/model-catalog.ts`

### Routes And Clients

- `service/src/routes/threads/`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/lib/api-types.ts`

Client files are only expected if Phase 5 ships additive compaction events or manual compaction UI.

### Docs / Specs

- `docs/proto.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/features/threads/threads.spec.md`
- `bud.spec.md`

## Open Questions

- What are the exact OpenAI and Anthropic SDK error shapes for context-window failures across streamed and non-streamed calls?
- Should provider usage from compaction calls eventually be recorded in `llm_call` under a filtered request mode for telemetry?
- How much recent user-message history should be preserved after repeated compactions before summary quality starts to degrade?
- Should checkpoint summaries include verbatim terminal output snippets for debugging tasks, or only high-level terminal outcomes?
- Should a future manual compaction affordance be an admin route, a user route, or a slash command intercepted before transcript persistence?
- Do same-timestamp message and LLM-call boundaries occur often enough to require stronger ordering columns than `created_at` plus ULID tie-breakers?

## Known Unknowns

- Provider-reported usage may or may not consistently include system prompt and tool schema overhead.
- Existing provider-ledger reconstruction may expose edge cases once historical ledger rows are filtered by checkpoint boundaries.
- Large single user messages may still require truncation even after old history is summarized.
- Repeated summary-of-summary compaction may reduce task quality in ways that only show up in realistic long-running sessions.
- Current context-sync rows may not contain the exact fresh terminal state needed for high-quality mid-turn compaction, so Phase 3 should verify whether a service-built terminal context note is enough.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Compaction summary drops critical task state | Medium | High | Preserve recent user messages, include current terminal context for mid-turn, and validate with long-running fixtures |
| Loader replays compacted provider-ledger rows and duplicates old context | Medium | High | Make checkpoint boundary filtering a Phase 2 gate with direct tests |
| Compaction request itself exceeds provider context | High | High | Add context-window error normalization and trimming retry in Phase 3 |
| Automatic compaction calls provider APIs from an unsafe route path | Medium | High | Keep provider work inside `runAgentFlow(...)`; model preference PATCH only marks preference |
| Checkpoint summaries leak through browser transcript APIs | Low | High | Store checkpoints outside `message`; add route tests that `/messages` is unchanged |
| Token estimates are too optimistic | Medium | Medium | Use latest provider usage when available, conservative char estimates otherwise, and fail before over-limit calls when compaction fails |
| Rollout needs emergency disablement | Medium | Medium | Ship `AGENT_AUTO_COMPACTION_ENABLED=false` kill switch and clear logs |

## Rollout Strategy

1. Land checkpoint schema and repository helpers behind no runtime behavior.
2. Teach the loader to honor checkpoints while preserving current no-checkpoint behavior.
3. Add the compactor and focused tests without automatic triggers.
4. Enable pre-turn and mid-turn auto compaction behind the kill switch.
5. Defer stream observability and manual compaction API until automatic compaction has runtime validation.
6. Run migration, automated tests, and long-thread manual validation before staging.

## Definition Of Done

- [ ] Schema and checked-in migrations add owner-stamped checkpoints.
- [ ] Loader reconstruction works correctly with no checkpoint, with one checkpoint, and after provider switching.
- [ ] Local summary compaction installs durable replacement history.
- [ ] Pre-turn and mid-turn triggers prevent known over-limit requests.
- [ ] Provider context-window failures are distinguishable from non-retryable provider failures.
- [ ] Stream/client/docs changes are additive and optional.
- [ ] Specs and protocol docs match the shipped behavior.
- [ ] Validation checklist passes with the automatic compaction kill switch both enabled and disabled.

## Deferred Follow-Ups

- provider-native remote compaction primitives
- public manual compaction UI
- checkpoint browsing/admin tooling
- retrieval over old transcript rows
- provider-specific token counters
- prompt-management integration for the compaction prompt
