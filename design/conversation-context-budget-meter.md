# Design: Conversation Context Budget Meter

Status: Draft

Audience: Backend, web/mobile clients, LLM-provider owners

Last updated: 2026-05-24

Related docs:

- [Context compaction](./context-compaction.md)
- [LLM model catalog and reasoning controls](./llm-model-catalog-and-reasoning-controls.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [web/src/features/threads/threads.spec.md](../web/src/features/threads/threads.spec.md)
- [web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)

## 1. Goal

Show users how much useful context remains in a conversation before Bud will
automatically compact the model-visible history.

"Context left" should be measured against Bud's automatic compaction threshold,
not the raw model context window. If the selected model has a 1,000,000 token
window and Bud is configured to compact at 90%, the user-facing primary budget is
900,000 estimated input tokens. The ratio is currently capped at 90%; clients
must still read the effective threshold from the service rather than hardcoding
90%.

Primary goals:

- give users an understandable sense of how close a thread is to automatic
  compaction
- keep the number consistent with the service-side compaction decision
- account for the latest compaction checkpoint so compacted transcript history
  does not make the meter look permanently full
- work across OpenAI, Anthropic, future cloud providers, and local models
- degrade to a conservative estimate when exact token counting is unavailable
- expose estimate quality clearly enough that clients do not overpromise
  precision

Non-goals for the first implementation:

- exact per-token accounting for every provider and modality
- provider token-count API calls on every render, keystroke, or SSE frame
- charging/cost estimation
- letting users manually edit compaction checkpoints from the meter
- hiding or changing visible transcript history after compaction

## 2. Product Semantics

The meter answers:

> How much model-visible input can this conversation probably add before Bud
> automatically compacts it?

It does not answer:

- how many tokens the visible transcript contains from the beginning of time
- how many tokens the provider will bill for a future call with perfect accuracy
- how much output the model can produce
- how much cached input a provider may reuse
- exact in-flight budget movement during every internal tool loop

The UI should use compaction language deliberately:

- primary label: `Context`
- primary detail: `312k left before auto-compact`
- secondary detail: `65% of compaction budget`
- tooltip detail: `Compacts at 90% of this model's 1,000,000 token window`

This keeps the meter tied to the user-visible event they may notice: Bud may
replace older model-visible history with a durable checkpoint, while preserving
the chat transcript.

## 3. Current Implementation Review

Bud already has most of the threshold machinery:

- `service/src/agent/context-budget.ts` resolves the selected model's
  `contextWindowTokens`, normalizes `AGENT_AUTO_COMPACTION_RATIO`, computes
  `thresholdTokens`, and decides when to compact.
- `estimateCanonicalMessagesTokens(...)` provides the current model-agnostic
  fallback estimate using character counts plus message/content overhead.
- `service/src/agent/conversation-loader.ts` reconstructs model-visible history
  from the fresh system prompt, latest completed checkpoint replacement history,
  and post-checkpoint message/provider-ledger deltas.
- `service/src/agent/context-compactor.ts` persists checkpoints that establish
  the replay boundary for future model calls.
- `service/src/llm/model-catalog.ts` exposes context window metadata through the
  model catalog and `/api/models`.
- Provider adapters normalize final usage into `TokenUsage`, and
  `recordLlmCall(...)` persists usage on `llm_call.usage`.

Main gaps:

1. Context budget data is internal to the agent loop; browser clients cannot
   inspect it.
2. The current estimate is sufficient as a guardrail but does not expose
   confidence, method, or freshness.
3. The meter needs a stable definition of "count since last compaction point"
   that matches conversation reconstruction.
4. Active turns may add transient in-memory messages and tool results that are
   not yet fully represented in durable rows.
5. Provider usage from the last LLM call is available but not yet combined with
   post-call deltas for a better user-facing estimate.

## 4. Budget Definition

Use the same budget resolver that automatic compaction uses:

```text
context_window_tokens = model_catalog[selected_model].contextWindowTokens
compaction_threshold_ratio = normalized AGENT_AUTO_COMPACTION_RATIO
compaction_threshold_tokens = floor(context_window_tokens * compaction_threshold_ratio)
effective_budget_tokens =
  compaction_enabled ? compaction_threshold_tokens : context_window_tokens
estimated_input_tokens = estimate of the next provider request input
remaining_context_tokens =
  max(0, effective_budget_tokens - estimated_input_tokens)
percent_of_context_budget =
  estimated_input_tokens / effective_budget_tokens
percent_of_model_window =
  estimated_input_tokens / context_window_tokens
```

The primary meter should use `percent_of_context_budget`, not
`percent_of_model_window`. While auto-compaction is enabled, this is the
compaction-budget percentage.

If auto-compaction is disabled, the service can still expose
`context_window_tokens` and `estimated_input_tokens`. For now Bud should rely on
auto-compaction being enabled; if it is disabled, the effective context limit for
meter math should be the model's full context window rather than the 90% limit.
The UI should avoid "before auto-compact" copy in that rare state.

If the model has no known context window, return `status: "unknown"` and omit
remaining/percent values.

## 5. What To Count

Count the service-owned request context that would be sent for the next model
call:

1. fresh Bud Agent system prompt
2. provider/tool request envelope where estimable
3. current model-facing tool schemas, or a measured allowance for them
4. latest completed context checkpoint replacement history, if one exists
5. durable user/assistant/tool/system messages after the checkpoint boundary
6. same-provider ledger items after the checkpoint boundary when the loader would
   replay them
7. active turn additions only through a narrow runtime estimate if one exists;
   otherwise user-facing snapshots may lag while internal compaction guardrails
   continue to count the in-memory loop state

Do not count:

- visible transcript rows before the latest completed checkpoint, except through
  the checkpoint replacement history
- hidden UI-only state
- terminal output that is not included in current model-visible messages
- old provider ledger items that the checkpoint boundary excludes

This definition means "since last compaction point" is not just "rows created
after checkpoint." It is the active reconstructed context after compaction:
replacement history plus post-checkpoint deltas.

## 6. Recommended Architecture

Add a service-owned context budget reporter that reuses the agent's existing
budget and conversation reconstruction logic.

Proposed module boundary:

- keep `resolveContextBudget(...)` in `service/src/agent/context-budget.ts`
- extract counting strategies into a small estimator layer, for example
  `service/src/agent/context-budget-estimator.ts`
- add an orchestration helper, for example
  `getThreadContextBudgetSnapshot(...)`, that:
  - resolves the authorized thread and selected/effective model
  - loads the model-visible conversation through the same loader path the agent
    uses
  - applies the best available counting tier
  - returns a normalized, client-safe snapshot

The reporter must remain backend-owned. Clients should not reconstruct message
history or apply tokenizer logic themselves, because they do not know provider
ledger replay rules, checkpoint boundaries, system prompt contents, tool schema
payloads, or auth-filtered rows.

### 6.1 Snapshot Shape

Expose a compact object on thread bootstrap and agent state:

```typescript
type ApiContextBudgetSnapshot =
  | {
      status: "available";
      model: string;
      provider: "openai" | "anthropic" | string;
      context_window_tokens: number;
      compaction_enabled: boolean;
      compaction_threshold_ratio: number;
      compaction_threshold_tokens: number;
      effective_budget_tokens: number;
      estimated_input_tokens: number;
      remaining_context_tokens: number;
      percent_of_context_budget: number;
      percent_of_model_window: number;
      basis:
        | "model_agnostic_estimate"
        | "provider_usage_plus_delta"
        | "tokenizer"
        | "provider_token_count";
      confidence: "low" | "medium" | "high";
      stale: boolean;
      updated_at: string;
      latest_checkpoint_id: string | null;
      compacted_through_message_id: string | null;
      compacted_through_llm_call_id: string | null;
    }
  | {
      status: "unknown";
      model: string;
      provider: string | null;
      reason:
        | "unknown_model_context_window"
        | "conversation_unavailable"
        | "count_failed";
      stale: boolean;
      updated_at: string;
    };
```

If auto-compaction is disabled but the model window is known, return an
`available` snapshot with `compaction_enabled: false` and
`effective_budget_tokens = context_window_tokens`.

### 6.2 API Surface

Recommended first pass:

- add `context_budget` to `GET /api/threads/:threadId/agent/state`
- include `context_budget` in the thread detail/bootstrap payload used by web and
  mobile, if there is a single owning loader for that view
- do not add a dedicated `context.budget` SSE event in the first pass; agent
  state refresh after sends, stream reconnects, provider completions, and
  compaction completion should be enough

Revisit a dedicated event only if agent-state refresh proves too stale in
practice.

All endpoints must use existing ownership-aware thread helpers before reading
messages, checkpoints, or provider ledger rows. A signed-in user requesting
another user's thread still receives `404`.

## 7. Counting Strategy Tiers

The estimator should choose the best supported strategy for the model/provider,
then fall back without throwing user-visible failures.

### Tier 0: Model-Agnostic Baseline

Use the existing character-based estimator:

- text tokens: roughly `ceil(characters / 4)`
- structured blocks: JSON-stringify unknown provider/tool payloads
- message/content overhead: fixed constants
- images/documents/binary-like blocks: approximate by payload size or a known
  conservative floor

Pros:

- works for OpenAI, Anthropic, future hosted providers, and local models
- no network calls
- no provider SDK dependency beyond what Bud already uses
- same failure mode as the compaction guardrail

Cons:

- can undercount non-English text, dense symbols, base64, and provider envelopes
- cannot exactly price tool schemas, images, PDFs, or hidden request framing
- does not know provider-specific tokenization

Recommendation:

- ship this as the baseline
- mark as `basis: "model_agnostic_estimate"` and `confidence: "low"` or
  `"medium"` depending on modality
- use a conservative multiplier or fixed overhead for known heavy request parts
  if validation shows systematic undercounting

### Tier 1: Provider Usage Plus Delta

Use the latest successful `llm_call.usage` as the strongest known anchor for the
last request, then estimate only the delta added since that call.

For OpenAI-style usage payloads, this includes:

- `input_tokens`: provider-counted tokens in the previous request input
- `output_tokens`: provider-counted tokens generated by the model response
- `total_tokens`: the sum, useful for diagnostics but not directly the next
  input estimate

The output-token count matters because assistant output from the last response
often becomes replayed context for the next provider request. It is not perfectly
equivalent to future input tokens, especially when providers count hidden
reasoning or non-replayable output differently, but it is a better anchor than
estimating generated assistant text from characters alone.

Example:

```text
estimated_input_tokens =
  latest_llm_call.usage.input_tokens
  + replayable_output_tokens_from_latest_llm_call
  + estimate(messages/tool results added after latest_llm_call)
  + estimate(system/tool schema changes since latest_llm_call)
```

Pros:

- cheap and already available after real provider calls
- captures provider-specific framing, tool schema cost, cached/reasoning item
  replay, generated assistant output size, and multimodal accounting for the
  anchored request
- usually better than counting the whole reconstructed request from scratch

Cons:

- only valid when the next request shape is close to the last request shape
- provider switch, reasoning setting changes, tool schema changes, or checkpoint
  installation can invalidate the anchor
- `output_tokens` can include provider-internal reasoning or other output tokens
  that may not be replayed exactly as future input
- active turns can make the durable ledger lag behind in-memory state

Recommendation:

- use this after a successful provider call when model/provider/reasoning/tool
  schema fingerprint still matches
- include provider-reported output tokens for replayable assistant output; when
  the adapter cannot distinguish replayable from non-replayable output, use the
  total output-token count conservatively and lower confidence if needed
- mark as `basis: "provider_usage_plus_delta"` and `confidence: "medium"` or
  `"high"` depending on fingerprint match quality
- fall back to Tier 0 when the anchor is stale

### Tier 2: Local Tokenizer Adapters

Use provider/model-specific tokenizers where available.

Examples:

- `openai/tiktoken` for supported OpenAI encodings and model mappings
- local model tokenizers from model manifests, such as `tokenizer.json`, for
  future self-hosted models
- provider-specific community tokenizers only if they are validated and pinned

Pros:

- no provider token-count network calls
- faster than remote counters for frequent refreshes
- useful for local models where no provider API exists

Cons:

- exact message/request accounting still requires provider envelope rules
- model mappings drift over time
- JavaScript runtime packaging may be heavier than the current service needs
- Anthropic token counts are exposed through provider APIs, but a first-party
  local tokenizer is not a stable public baseline for all current Claude models

Recommendation:

- do not block the first implementation on tokenizers
- add an adapter interface later:

```typescript
type TokenCountAdapter = {
  supports(args: CountRequest): boolean;
  count(args: CountRequest): Promise<TokenCountResult>;
};
```

- keep adapter failures non-fatal and observable

### Tier 3: Provider Token-Count APIs

Call provider token-count endpoints for the exact request shape before creating a
model response.

Current official options:

- OpenAI exposes a Responses input token counting endpoint for response-shaped
  requests: `POST /v1/responses/input_tokens`.
- Anthropic exposes Messages token counting at
  `POST /v1/messages/count_tokens`; its docs say the endpoint accepts the same
  structured inputs as message creation, including system prompts, tools, images,
  and PDFs, and returns total input tokens.

Pros:

- closest match to the provider's actual accounting
- covers tool schemas and multimodal inputs better than local heuristics
- useful for validation and high-confidence UI snapshots

Cons:

- adds latency and provider dependency to a UI surface
- may count as an API request for rate-limit purposes
- may have provider-specific request-size limits
- can fail due to provider outage or credentials even when the UI should still
  render
- should not run for every viewport render, keystroke, or polling interval

Recommendation:

- defer provider counter adapters for the first implementation
- rely first on real response usage from OpenAI and Anthropic model calls
- if this tier is added later, put it behind a feature flag or config, cache by
  `(provider, model, reasoning, tool_schema_fingerprint,
  reconstructed_context_fingerprint)`, and fall back to Tier 1 or Tier 0 on any
  error
- use as `basis: "provider_token_count"` and `confidence: "high"` only when the
  count was produced for the same reconstructed request fingerprint

### Tier 4: Model-Native Local Counters

For local models, support model descriptors that declare:

- context window
- tokenizer family or tokenizer file
- chat template / request envelope
- optional native count command or local HTTP count endpoint

Pros:

- makes Bud's meter viable beyond OpenAI and Anthropic
- lets local model hosts provide exact accounting when available

Cons:

- model hosts vary heavily
- chat templates and tool-call encodings are easy to mismatch
- unknown local models may only support Tier 0

Recommendation:

- treat this as a model catalog extension, not a special-case UI feature
- require unknown local models to declare at least a context window before the
  meter shows percentages

## 8. First Implementation Recommendation

Phase 1 should ship:

1. A backend snapshot helper based on `resolveContextBudget(...)` and the current
   reconstructed conversation.
2. Tier 0 counting everywhere.
3. Tier 1 provider usage plus delta when a valid latest-call anchor exists.
4. A client-safe `context_budget` object on agent state and thread bootstrap.
5. A small web meter in the thread workbench.
6. Tests that prove the meter resets after compaction because the loader counts
   checkpoint replacement history plus post-checkpoint deltas, not the full
   visible transcript.

Defer:

- provider token-count API calls
- local tokenizer dependencies
- provider-count caching tables
- alerting/analytics based on budget snapshots
- manual compaction actions such as `/compact` or a menu item

The first implementation should bias toward slightly conservative display. It is
better to show "about 80% used" and compact early than to show plenty of budget
left while the next provider call fails.

## 9. UI Design

### 9.1 Placement

Web:

- primary placement: composer/model-control row, near the model selector and
  reasoning control
- secondary placement: compact status chip in the workbench top bar only when
  the thread is above a warning threshold or compaction is running

Mobile:

- compact chip near the model/status area
- tap opens a sheet with details

The meter should not live inside the chat transcript, because it describes the
request budget rather than a message.

### 9.2 Visual States

Use a compact progress bar or ring plus short label:

| Budget used | State | Suggested copy |
| --- | --- | --- |
| unknown | unavailable | `Context unknown` |
| 0-70% | normal | `Context 42%` |
| 70-85% | elevated | `Context 78%` |
| 85-100% | near threshold | `Compact soon` |
| >=100% and active compaction pending | compacting | `Compacting` |
| count failed | degraded | `Context estimate unavailable` |

The visible percent is `percent_of_context_budget`, not model-window percent.
When auto-compaction is enabled, that is the compaction-budget percent.

Use the tooltip/popover for precision:

- selected model and provider
- estimated input tokens
- remaining tokens against the effective budget
- context window tokens
- compaction threshold ratio and tokens
- estimate basis and confidence
- latest checkpoint timestamp/id if present
- short explanation that compaction preserves the visible chat transcript

Avoid showing raw checkpoint IDs in the default compact view. They are diagnostic
details for the tooltip or debug mode.

### 9.3 Copy Rules

Preferred:

- `312k left before auto-compact`
- `Estimate based on last model call plus new messages`
- `Compaction keeps the chat visible and shortens model replay history`

If auto-compaction is disabled, use context-window copy such as
`312k context left` instead of `before auto-compact`.

Avoid:

- `312k tokens left in this conversation` because it implies visible transcript
  tokens rather than model-visible replay budget
- `exact` unless the basis is a provider token-count API for the same request
  fingerprint
- urgent warnings below the warning threshold

### 9.4 Interaction

The meter is informational. It should not block sending messages.

Potential actions in the popover:

- `Refresh estimate` if provider counting or a backend recount is available
- `Learn about compaction` linking to product help when product docs exist

Do not add `Compact now` in the first pass. Manual compaction has separate
prompt, authorization, and user-expectation implications.

## 10. Freshness And Active Turns

Idle threads:

- compute from durable rows and latest completed checkpoint
- cache briefly in memory if needed

After user message send:

- update estimate after the message is persisted
- include the new user message even before the agent starts

During active agent turns:

- the user-facing meter does not need to show every internal budget movement
  between user turns
- avoid exposing raw `AgentService.runAgentFlow(...)` conversation internals just
  to make the UI meter continuously live
- mark `stale: true` when durable state is behind active in-memory work, then
  update after durable writes or provider call completion
- keep automatic compaction checks inside the agent loop, including mid-turn
  checks before later provider calls in long-horizon tasks with many tool calls

After provider call completion:

- update from `usage.input_tokens` plus output-token usage and switch to Tier 1
  if the anchor is valid

After compaction completion:

- recompute from checkpoint replacement history plus post-checkpoint delta
- the meter should usually drop sharply

After provider switch or model change:

- recompute against the new model's context window and threshold
- invalidate Tier 1 anchors from a different provider/model/request shape

## 11. Persistence And Caching

First pass:

- compute on demand from existing durable data
- do not add a database table
- use short-lived in-memory caching only if needed for repeated agent-state
  polling

Later:

- persist `context_budget_snapshot` only if future provider token-count API use
  becomes common enough that caching across restarts matters
- store provider-count request fingerprints, not full reconstructed prompt text
- avoid exposing full prompt/checkpoint contents through budget APIs

## 12. Security And Privacy

Context budget endpoints are browser-facing and must follow existing ownership
contracts:

- resolve threads through ownership-aware helpers
- never count another user's thread even for aggregate metadata
- authorize before reading messages, checkpoints, terminal-derived system rows,
  or provider ledger rows
- return `404` for signed-in users requesting another user's resources
- avoid logging reconstructed prompt contents while counting
- keep provider token-count API payloads subject to the same provider privacy
  posture as normal model calls

## 13. Testing

Backend:

- `resolveContextBudget(...)` returns the same threshold used for compaction
- unknown model windows return `status: "unknown"`
- checkpointed threads count replacement history plus post-checkpoint messages
- visible transcript rows before the checkpoint do not inflate the meter
- Tier 1 estimates include provider output-token usage for replayed assistant
  output where available
- Tier 1 anchors invalidate on provider/model/reasoning/tool schema changes
- provider counter failures fall back to lower tiers
- ownership tests cover context budget reads for another user's thread

Frontend:

- normal/elevated/near-threshold/unknown/degraded states render in the composer
- tooltip values are formatted and do not overflow on mobile
- visual meter values use percentages, while hover/details can show rounded
  token values such as `312k`
- compaction completion updates the meter downward
- disabled auto-compaction falls back to the full model context window as the
  effective limit

Regression:

- construct a long thread that compacts, then add a small message; the meter
  should show post-compaction budget usage, not near-full usage from the full
  visible transcript

## 14. Decisions And Open Questions

Resolved first-pass decisions:

1. Primary UI shows compaction-budget usage only. Raw model-window usage can stay
   out of the first UI.
2. `AGENT_AUTO_COMPACTION_RATIO` remains capped at 0.9 for now.
3. Do not add `context.budget` SSE in the first pass; agent-state refresh is
   enough.
4. Do not expose detailed in-memory agent-loop context to the UI. The meter can
   lag during active turns, while the agent loop still performs mid-turn
   compaction checks before later provider calls.
5. Defer provider-specific token-count APIs. For OpenAI and Anthropic, use
   response usage from real model calls first.
6. Do not invest in provider-count cache TTL/fingerprints yet. If messages,
   tools, or system prompts change, invalidate anchored counts; current system
   prompts and tool schemas are static enough for a simple first pass.
7. If auto-compaction is disabled despite the expected default, use the full
   model context window as the effective meter limit.
8. Visual UI uses percent. Hover/details may show rounded token values such as
   `312k`.
9. Manual compaction through `/compact` or a menu item is deferred.
10. Local-model eligibility remains a TODO. The design should not preclude local
    models; at minimum they will need declared context-window metadata before a
    percentage meter is meaningful.

Remaining questions:

1. What exact metadata shape should future local model descriptors use for
   context windows, tokenizer files, and chat templates?
2. Should provider adapters attempt to distinguish replayable output tokens from
   non-replayable output tokens, or is conservative total output usage good
   enough for Tier 1?

## 15. Known Unknowns

- Exact provider request overhead for tool schemas, provider-specific system
  messages, and hidden request framing can drift.
- Anthropic token-count results are documented as estimates and may differ
  slightly from message creation usage.
- OpenAI and Anthropic SDK support for token-count endpoints may change faster
  than raw HTTP endpoint availability.
- Multimodal inputs, PDFs, and images may need provider-specific accounting
  sooner than plain text conversations do.
- Local model hosts may expose context windows that differ from the actual
  loaded runtime configuration.
- Reasoning items and encrypted provider ledger replay may affect exact counts
  differently by provider.

## 16. Source Notes

Official/provider references reviewed:

- OpenAI Responses input token counting endpoint:
  https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens
- OpenAI token-counting guide:
  https://developers.openai.com/api/docs/guides/token-counting
- OpenAI `tiktoken` tokenizer:
  https://github.com/openai/tiktoken
- Anthropic token counting guide:
  https://platform.claude.com/docs/en/build-with-claude/token-counting
- Anthropic Messages token-count API:
  https://platform.claude.com/docs/en/api/messages/count_tokens
