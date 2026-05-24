# Phase 4: Automatic Triggers And Budgeting

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented, trigger tests pending

---

## Objective

Invoke compaction automatically before Bud sends an over-budget provider request.

By the end of this phase:

- pre-turn compaction runs before the first provider call when needed
- mid-turn compaction runs before follow-up provider calls when needed
- model downshift is handled on the next agent run
- token estimates and thresholds are observable
- over-limit requests fail clearly if compaction cannot recover

## Scope

### In Scope

- token budget estimator
- threshold configuration and kill switch
- pre-turn compaction inside `runAgentFlow(...)`
- mid-turn compaction before follow-up model calls
- model downshift handling on message send
- in-memory conversation replacement after mid-turn compaction
- clear failure behavior

### Out Of Scope

- manual compaction UI
- remote provider-native compaction
- exact tokenizer integration
- exposing raw checkpoint data to clients

## Implementation Tasks

### Task 1: Add a token budget helper

Create a helper that estimates active context tokens for a candidate provider request.

Recommended first pass:

- use the latest completed normal `llm_call.usage.input_tokens` when it matches the active reconstruction prefix
- estimate unsampled appended messages with `ceil(chars / 4)` plus small per-message overhead
- estimate system prompt and tool schema overhead before the first provider call
- include replacement history and post-checkpoint delta in estimates
- expose diagnostics: `estimated_tokens`, `context_window_tokens`, `threshold_tokens`, and `threshold_ratio`

Keep the helper injectable or pure enough to test with synthetic windows.

### Task 2: Add configuration

Add service configuration for:

- `AGENT_AUTO_COMPACTION_ENABLED`
- `AGENT_AUTO_COMPACTION_RATIO`

Initial semantics:

- enabled by default
- `false`, `0`, or equivalent disables automatic triggers
- default ratio is `0.9`
- configured ratio is clamped to `<= 0.9`
- configured ratio below a safe lower bound, for example `0.5`, is rejected or clamped according to service config conventions

If the model catalog lacks `contextWindowTokens`, skip automatic compaction unless an explicit absolute threshold is later added.

### Task 3: Pre-turn compaction

At the start of `AgentService.runAgentFlow(...)`, after the user message has been persisted and the conversation has been loaded:

1. resolve effective provider/model/reasoning
2. estimate active context tokens
3. compare to threshold
4. if under threshold, continue normally
5. if over threshold, call `AgentContextCompactor`
6. replace local `conversation` with fresh system prompt plus returned replacement history plus post-checkpoint delta
7. continue to first provider call

If compaction fails, fail the agent turn with a clear runtime error instead of sending the over-budget request.

### Task 4: Mid-turn compaction

Before each follow-up provider call inside the tool loop:

1. estimate the current in-memory `conversation`
2. if over threshold, call `AgentContextCompactor` with `phase = "mid_turn"`
3. include fresh terminal/session context in the compaction input
4. replace the in-memory `conversation` with the compacted replacement form
5. continue the tool loop

The mid-turn checkpoint boundary should compact through the latest durable message and latest durable LLM call available at that moment. In-memory assistant/tool-result items that are not durable must be represented in the compaction summary before replacement.

### Task 5: Model downshift behavior

Handle smaller model windows without adding provider work to preference-only routes.

Rules:

- `PATCH /api/threads/:thread_id/model-preference` stores the preference only.
- On the next `POST /api/threads/:thread_id/messages`, resolve the selected model and estimate against that model's window.
- If the current context is too large for the selected model, compact before sampling.
- If a previous larger model is available and configured, prefer it for the compaction summary call.
- If no larger model is available, compact with the selected model and rely on trimming retry.

### Task 6: Avoid duplicate compactions

Prevent duplicate checkpoints for the same boundary when concurrent or repeated checks occur.

Implemented first-tranche approach:

- rely on the existing single active agent run per thread
- track replay-boundary keys in memory for the active turn
- skip repeated automatic compaction for a boundary already compacted during that turn
- surface the original provider context-window failure if the compacted context still cannot fit

The chosen approach must be documented in `service/src/agent/agent.spec.md`.

### Task 7: Add runtime diagnostics

Log structured fields for:

- `thread_id`
- `turn_id`
- `checkpoint_id`
- `phase`
- `reason`
- `tokens_before`
- `tokens_after`
- `threshold_tokens`
- `context_window_tokens`
- `compaction_duration_ms`
- `compaction_status`

Do not log raw summary or replacement-history text.

## Files Likely Affected

- `service/src/agent/agent-service.ts`
- `service/src/agent/context-compactor.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/model-runner.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/config.ts` or the current service config module
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`

## Tests

Add tests for:

- no compaction under threshold
- pre-turn compaction over threshold
- mid-turn compaction over threshold after large tool result
- disabled kill switch prevents compaction
- threshold ratio clamps to maximum
- unknown context window skips automatic compaction
- model downshift compacts on next message send
- `PATCH model-preference` performs no provider call
- compaction failure prevents over-budget provider invocation
- repeated checks do not create duplicate active checkpoints for the same boundary

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Token estimate undercounts and provider still rejects | Medium | Medium | Catch context-window errors and route through compaction retry where safe |
| Automatic compaction adds latency to normal turns | Medium | Medium | Trigger only near threshold and log duration |
| Mid-turn replacement drops in-memory state | Medium | High | Summary must include current in-turn assistant/tool-result state before replacing conversation |
| Duplicate compactions race | Low | Medium | Use run serialization or boundary recheck before final insert |
| Preference PATCH unexpectedly performs provider work | Low | High | Keep model downshift compaction in message-send path only |

## Exit Criteria

- Automatic pre-turn and mid-turn compaction are wired and tested.
- Compaction can be disabled with configuration.
- Over-budget requests fail clearly when compaction cannot recover.
- Model downshift is handled without provider side effects in preference-only routes.
