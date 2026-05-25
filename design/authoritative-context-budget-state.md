# Design: Authoritative Context Budget State

Status: Draft - Option A selected

Audience: Backend, web/mobile clients, LLM-provider owners

Last updated: 2026-05-25

Related docs:

- [Conversation context budget meter](./conversation-context-budget-meter.md)
- [Context compaction](./context-compaction.md)
- [Usable context window and output reserve](./usable-context-window-and-output-reserve.md)
- [Auto-compaction threshold mismatch debug note](../debug/auto-compaction-threshold-mismatch.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [service/src/runtime/runtime.spec.md](../service/src/runtime/runtime.spec.md)
- [web/src/features/threads/threads.spec.md](../web/src/features/threads/threads.spec.md)
- [web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)

## 1. Goal

Make the context meter show the same budget state that the backend agent uses
to decide whether to compact for a turn.

The user-facing ring should answer:

> How close is the current model-visible request to the backend's automatic
> compaction threshold?

The current implementation can answer a different question:

> How large does the latest provider usage anchor plus durable deltas appear to
> be?

Those are both useful diagnostics, but only the first should drive the primary
meter. If the meter says the conversation is over the auto-compact limit while
the backend compaction decision logs say `skipReason: "below_threshold"`, users
will reasonably treat the UI as broken.

Primary goals:

- one service-owned estimate drives automatic compaction decisions and the
  primary context meter
- active turns retain the latest backend budget decision so `/agent/state` can
  report it after refresh, finalization, or cancellation
- provider usage remains available for diagnostics and future calibration
  without silently becoming a different primary UI truth
- `/agent/state` remains the recovery/bootstrap source after refresh or missed
  stream events
- clients do not recompute token budgets or infer compaction thresholds

Non-goals for this design:

- exact provider token counting before every request
- changing compaction summary behavior
- adding manual compaction controls
- exposing reconstructed prompt contents, checkpoint summaries, or tool schemas
  to clients

## 2. Current Architecture Review

### 2.1 Budget Policy Is Shared

`service/src/agent/context-budget.ts` already centralizes the window policy:

- hard model window from the catalog
- Bud usable context window
- reserved output tokens
- usable input window
- `AGENT_AUTO_COMPACTION_RATIO`, clamped to `0.95`
- normal agent-turn threshold vs larger compaction-summary input budget

This part is structurally sound. The threshold in the UI and backend logs is
the same in the reported case: `27,200` tokens with a `0.1` ratio over a
`272,000` usable input window.

The drift is not the window policy. The drift is the usage estimate.

### 2.2 Backend Compaction Trigger

`AgentService.compactConversationIfNeeded(...)` resolves the budget and then
uses:

```typescript
estimateCanonicalMessagesTokens(args.conversation)
```

against `budget.thresholdTokens`.

That `args.conversation` is the active model-visible conversation for the next
provider request. During a turn it includes in-memory assistant/tool-result
blocks that may not yet be fully visible through durable `/agent/state`
reconstruction.

The diagnostic log added for this issue shows the backend decision state:

```text
phase: "mid_turn"
estimatedTokens: 15142
thresholdTokens: 27200
estimateBasis: "model_agnostic_estimate"
skipReason: "below_threshold"
```

From the backend's perspective, compaction correctly did not trigger.

### 2.3 Browser Context Snapshot

`service/src/agent/context-budget-snapshot.ts` builds
`/agent/state.context_budget` by:

1. resolving the thread's effective model and budget
2. loading durable reconstructed conversation state through
   `AgentConversationLoader`
3. finding a latest same-provider/model/reasoning `llm_call.usage` anchor after
   the latest checkpoint
4. adding estimated durable message deltas after that anchor
5. preferring that provider usage estimate over the canonical estimate

That means the web can show:

```text
Basis last provider usage plus new messages, high confidence.
```

even though the actual compaction trigger is still using
`model_agnostic_estimate`.

### 2.4 Runtime State And SSE

`AgentRuntimeStateManager` owns active turn state and bounded stream resume:

- phase
- turn id
- pending tool
- draft assistant
- stream cursor

The route enriches `/agent/state` with `context_budget`; runtime does not own
budget state today.

The agent stream carries:

- visible assistant/tool/message events
- `agent.compaction_start`
- `agent.compaction_done`
- `agent.compaction_failed`

Compaction events are activity markers. They include the token estimate used
when compaction starts, but there is no stream event for "budget checked and
skipped", and no budget event after each provider call or tool result.

### 2.5 Web State

The existing thread route stores `contextBudget` from `/agent/state` and passes
it to `CommandComposer` and `ContextSendButton`.

The route refreshes agent state after:

- loader/bootstrap
- user send
- model preference changes
- explicit stream resync
- final turn event
- successful compaction event

The route does not receive a live budget update for every backend budget check.
During active turns the snapshot may be stale, and the tooltip says so, but the
primary ring still renders the stale/different estimate as if it were the
current compaction trigger state.

## 3. Problem Statement

The current `context_budget` shape conflates two estimates:

1. **Compaction trigger estimate**: what the backend compares against the
   auto-compaction threshold before a provider call.
2. **Provider usage estimate**: latest provider `input_tokens + output_tokens`
   plus durable deltas.

Provider usage can be larger because it may include provider framing, tool
schema overhead, hidden reasoning/output tokens, cached prefix accounting, and
tokenizer behavior that the model-agnostic estimator does not include.

Provider usage can also be stale or inapplicable during an active tool loop
because the active in-memory conversation can move ahead of durable rows.

Therefore the primary web meter can show "full" while the actual backend state
is "55% of threshold". That is not a frontend rendering bug; it is a contract
semantics bug.

## 4. Design Principle

The primary budget snapshot must be authoritative for compaction decisions.

Concretely:

- `estimated_input_tokens` in the primary meter should be the exact value the
  backend would use, or did use, for the latest compaction decision at the same
  replay boundary.
- `percent_of_context_budget` should be derived from that same estimate.
- provider usage can appear in tooltip/debug fields, but it must not drive the
  primary ring unless the backend trigger also uses provider usage for that
  decision.
- when active state is not available, the UI should clearly show the last known
  authoritative budget as stale rather than substitute a different estimate.

## 5. Proposed Contract

Keep `context_budget` as the top-level field, but make its primary fields
trigger-aligned.

Add provenance fields so clients and logs can tell what they are showing:

```typescript
type ApiContextBudgetAvailable = {
  status: "available";
  model: string;
  provider: string;
  context_window_tokens: number;
  usable_context_window_tokens: number;
  reserved_output_tokens: number;
  usable_input_window_tokens: number;
  compaction_enabled: boolean;
  compaction_threshold_ratio: number;
  compaction_threshold_tokens: number;
  effective_budget_tokens: number;

  // Primary meter fields. These must match the backend trigger basis.
  message_estimated_tokens: number;
  tool_schema_tokens: number;
  estimated_input_tokens: number;
  remaining_context_tokens: number;
  percent_of_context_budget: number;
  percent_of_model_window: number;
  basis: "model_agnostic_estimate" | "provider_usage_trigger" | "provider_token_count";
  confidence: "low" | "medium" | "high";

  // New provenance.
  source:
    | "durable_reconstruction"
    | "active_agent_decision"
    | "compaction_event"
    | "unknown";
  phase: "pre_turn" | "mid_turn" | "idle" | "standalone_turn" | null;
  reason: "context_limit" | "context_error_retry" | "model_downshift" | "user_requested" | null;
  turn_id: string | null;
  checked_at: string | null;
  stale: boolean;

  // Optional diagnostics. Not primary meter math.
  provider_usage_estimate?: {
    estimated_input_tokens: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    delta_tokens: number;
    llm_call_id: string;
    confidence: "medium" | "high";
  } | null;

  latest_checkpoint_id: string | null;
  compacted_through_message_id: string | null;
  compacted_through_llm_call_id: string | null;
};
```

Naming note: `basis: "provider_usage_plus_delta"` should no longer be used for
the primary meter unless the backend trigger has explicitly switched to that
same strategy. If we keep it as a diagnostic label, it should live under
`provider_usage_estimate`.

## 6. Backend Architecture

### 6.1 Extract A Shared Decision Builder

Create a shared helper owned by the agent layer, tentatively:

```text
service/src/agent/context-budget-state.ts
```

Responsibilities:

- accept selected model/reasoning, provider, phase, reason, and a
  `CanonicalMessage[]`
- resolve the `ContextBudget`
- compute the compaction trigger estimate with the same estimator used by
  `shouldCompactContext(...)`
- return a client-safe `ContextBudgetSnapshot`
- optionally attach provider usage diagnostics when a valid anchor is available
  and the caller is building a durable/idle snapshot

`AgentService.compactConversationIfNeeded(...)` should call this helper and
then call `shouldCompactContext(...)` with the helper's primary estimate.

`getThreadContextBudgetSnapshot(...)` should call the same helper for its
primary fields after loading durable reconstructed conversation. It may add
provider usage diagnostics, but should not replace the primary estimate with
provider usage unless the agent trigger also does.

### 6.2 Store Latest Active Budget Decision

Active turns need a backend-owned place to store the latest budget decision that
the UI can retrieve or resume after missed events.

Decision: store this directly on `AgentRuntimeStateManager`.

This keeps the implementation simple and robust. `/agent/state` already reads
the runtime snapshot and already carries active-turn recovery state such as
phase, pending tool, draft assistant, and stream cursor. Adding the latest
context budget decision there avoids a separate store and avoids route-level
reconstruction guesses while a turn is active.

Whichever option we choose, `/agent/state` should prefer the active stored
decision when:

- runtime `active === true`
- stored decision `turn_id` matches runtime `turn_id`
- stored decision model/provider/reasoning matches the active turn

If no active decision exists yet, return the durable reconstruction snapshot
with `stale: true` and `source: "durable_reconstruction"`.

### 6.3 Update Timing And Stream Shape

Do not add a standalone budget event for every internal agent sub-turn in the
first pass. The context meter mainly matters before the next user turn, and
streaming every below-threshold tool-loop decision would add moving pieces
without improving normal product behavior.

Instead:

- update runtime `context_budget` whenever the agent performs a compaction
  decision, including pre-turn and mid-turn checks
- have `/agent/state` return that runtime value while the turn is active
- rely on existing `/agent/state` refreshes after send, resync, final, and
  cancel to update the composer
- include a post-compaction `context_budget` snapshot on `agent.compaction_done`
  so the UI can immediately drop the meter after a checkpoint is installed

Cancellation case:

- if the user cancels mid-turn, the final/cancel path should leave
  `/agent/state.context_budget` accurate for the next user turn
- if durable transcript state changed after the latest stored budget decision,
  the cancel/final refresh path should recompute from durable reconstruction
  before returning idle state

Future option:

- add `agent.context_budget` later if we find a real need for live budget
  movement during long-horizon runs, but do not start there.

`agent.compaction_*` events remain activity markers. `agent.compaction_done`
can carry the post-compaction budget snapshot as additive data, but clients
should still recover through `/agent/state` after missed events.

### 6.4 Keep Provider Usage As Diagnostics

Provider usage should remain valuable, but not silently primary.

Recommended diagnostic uses:

- server logs comparing provider usage estimate vs trigger estimate
- future calibration of the model-agnostic estimator
- future decision to adopt provider usage as the trigger basis

Web should not render provider usage diagnostics in the product context tooltip.
Normal users should see the authoritative backend trigger estimate only.

Do not subtract reasoning tokens from provider usage diagnostics in the first
pass. Some providers expose reasoning-token breakdowns, but using the raw
provider usage value keeps the diagnostic simple and avoids false precision.

If we later decide to make provider usage drive compaction, that should be a
deliberate backend change:

- the helper primary basis becomes `provider_usage_trigger`
- `AgentService` uses that same estimate for `shouldCompactContext(...)`
- the UI ring naturally follows because it consumes the same snapshot

## 7. Web Architecture

### 7.1 Treat Server Budget As Authoritative

`ContextSendButton` and `context-budget-meter-state.ts` should continue to be
presentation-only. They should not interpret provider usage or recompute
thresholds.

The route should update `contextBudget` from:

- loader `/agent/state`
- `/agent/state` after user sends, model changes, resync, final, and cancel
- explicit `/agent/state` refresh after resync
- `agent.compaction_done.context_budget` when present
- successful compaction completion fallback refresh if the stream event lacks a
  budget snapshot or was missed
- final turn refresh

The ring should use `percent_of_context_budget` from the server. Tooltip copy
should expose `source`, `phase`, `basis`, and `stale` more explicitly.

### 7.2 Active-Turn UI Behavior

Recommended active states:

- if `source: "active_agent_decision"` and `stale: false`, render normally
- if active but only durable reconstruction is available, render the last value
  but include `Refreshing while the agent works`
- if compaction starts, the separate `agent.compaction_start` marker can show
  `Compacting context...`
- after `agent.compaction_done`, apply the included post-compaction budget
  snapshot when present, then still allow the normal final/resync path to
  reconcile through `/agent/state`
- if no budget is known, show `Context unknown`

The UI should avoid saying "full" based on provider usage if the backend trigger
does not agree. Provider usage diagnostics remain available to backend logs and
API consumers, but the product tooltip should not display them in this pass.

### 7.3 Missed Event Recovery

The existing SSE cursor/resync contract is enough if `/agent/state` returns the
latest active budget decision.

On `agent.resync_required`, the route already refreshes bootstrap state. That
state should include the active decision snapshot if the turn is still running,
or the durable idle snapshot otherwise.

## 8. Potential Approaches

### Approach A: Make UI Use Backend Trigger Estimate

Description:

- primary `/agent/state.context_budget` uses the same estimate as
  `compactConversationIfNeeded(...)`
- provider usage remains diagnostic
- add active decision state to `AgentRuntimeStateManager`
- include post-compaction budget snapshots on `agent.compaction_done`

Pros:

- resolves the user-visible mismatch directly
- keeps compaction behavior unchanged
- makes logs, SSE, `/agent/state`, and UI comparable
- leaves room to calibrate or replace the estimator later
- avoids over-streaming budget events during internal tool loops

Cons:

- the primary number may look less "provider accurate" than the existing
  provider usage estimate
- users may see a lower percent even though provider usage was higher
- requires contract and test updates

Recommendation: choose this first.

### Approach B: Make Backend Trigger Use Provider Usage Plus Delta

Description:

- change compaction decisions to use the same provider-usage estimate currently
  used by the UI whenever a valid anchor exists

Pros:

- preserves current UI semantics
- provider usage may catch real overhead the model-agnostic estimator misses
- likely compacts earlier at low thresholds

Cons:

- provider output tokens can include non-replayable or hidden tokens
- active in-memory conversation still needs special handling
- no anchor before first provider call, after provider/model/reasoning changes,
  or with local models
- may cause unexpected compaction churn at low thresholds

Recommendation: defer. Consider after calibration shows the trigger estimator is
systematically unsafe.

### Approach C: Show Two Meters

Description:

- primary or tooltip exposes both "backend trigger" and "provider usage"
  estimates

Pros:

- honest diagnostic view
- useful for debugging estimator drift

Cons:

- too much cognitive load for a composer button
- users still need one answer for "will Bud compact?"

Recommendation: use one primary meter plus secondary tooltip diagnostics, not
two equal meters.

### Approach D: Poll `/agent/state` More Often

Description:

- refresh `/agent/state` after every tool result, message done, or short active
  interval instead of storing and returning the active backend decision

Pros:

- smaller API contract change
- no new SSE event type

Cons:

- still cannot report in-memory decisions unless runtime state stores them
- adds polling/network churn
- less deterministic than updating runtime state when the decision happens

Recommendation: insufficient alone. It can be a fallback, not the main design.

## 9. Implementation Phases

### Phase 1: Contract Clarification And Tests

- Update design/spec language so the primary meter means backend compaction
  trigger estimate.
- Add backend tests proving `buildContextBudgetSnapshot(...)` no longer uses
  provider usage as the primary estimate unless the trigger does.
- Add frontend tests for tooltip copy that distinguishes backend trigger basis
  from provider usage diagnostics.

### Phase 2: Shared Context Budget State Helper

- Extract a helper that returns a trigger-aligned `ContextBudgetSnapshot` from a
  `CanonicalMessage[]`.
- Use it from `AgentService.compactConversationIfNeeded(...)`.
- Use it from durable `/agent/state.context_budget` reconstruction.
- Preserve provider usage plus delta as an optional diagnostic field.
- Keep all logs and events on the same field names.

### Phase 3: Active Runtime Budget State

- Store the latest active budget decision by thread/turn.
- Make `/agent/state` prefer that active decision during active turns.
- Mark durable fallback snapshots `stale: true` when an agent turn is active and
  no active decision is available.
- Ensure cancel/final paths leave `/agent/state.context_budget` accurate for the
  next user turn, using the latest active decision or a durable recompute as
  appropriate.

### Phase 4: Web Refresh And Compaction Payloads

- Add `context_budget` as optional additive data on `agent.compaction_done`.
- Update web stream handling to apply `agent.compaction_done.context_budget`
  immediately when present.
- Keep existing `/agent/state` refreshes after send, model changes, resync, and
  final/cancel.
- Keep provider usage diagnostics out of the product tooltip.

### Phase 5: Calibration And Optional Trigger Upgrade

- Log or test side-by-side trigger estimate vs provider usage diagnostic.
- Include normal-agent tool-schema overhead in the trigger estimate because
  ordinary agent turns always send those tool definitions to providers.
- Measure whether additional request-envelope overhead explains the remaining
  provider-vs-trigger deltas seen at low thresholds.
- Only then consider using provider usage as a trigger basis for supported
  providers.

## 10. Testing Plan

Backend:

- `AgentService` budget decision log, runtime snapshot, and compaction decision
  all use the same `estimated_input_tokens`.
- `/agent/state.context_budget` returns durable trigger estimate when idle.
- `/agent/state.context_budget` returns latest active decision while a turn is
  running.
- provider usage diagnostics do not affect primary `percent_of_context_budget`.
- cancel/final paths return an up-to-date budget for the next user turn.
- `agent.compaction_done` can include a post-compaction budget snapshot.
- stream resume after compaction recovers through `/agent/state` even if the
  compaction event was missed.
- provider/model/reasoning changes invalidate provider usage diagnostics.
- checkpoint boundaries still reset durable estimates after compaction.

Web:

- route updates the composer meter from `/agent/state` and
  `agent.compaction_done.context_budget` when present.
- final/resync/bootstrap still refresh the meter from `/agent/state`.
- active stale snapshots show stale copy but do not render provider diagnostic
  percent as primary.
- compaction start/done/failure markers still render independently.
- tooltip omits provider usage diagnostics even when they are present in the
  API payload.

Regression:

- reproduce the reported case:
  - backend trigger estimate: `15,142`
  - threshold: `27,200`
  - provider usage diagnostic: about `35k`
  - UI primary ring should show about `56%`, not `128%`
  - tooltip may mention the provider diagnostic separately

## 11. Resolved Decisions

1. Use Approach A: the primary UI meter uses the same estimate the backend uses
   for compaction decisions.
2. Store active budget state in `AgentRuntimeStateManager`. Simple is robust,
   and this avoids a second runtime store.
3. Do not emit a budget event for every internal agent sub-turn in the first
   pass. The meter mainly matters before the next user turn.
4. Keep `/agent/state` accurate after finalization and cancellation. This is the
   recovery path for a user canceling an agent mid-turn.
5. Provider usage diagnostics are not rendered in the product context tooltip.
6. Do not subtract reasoning tokens from provider usage diagnostics in the first
   pass.
7. Add a post-compaction budget snapshot to `agent.compaction_done` rather than
   adding a separate `agent.context_budget` event now.
8. Keep the existing `estimated_input_tokens` field name and clarify that it is
   the backend's authoritative estimate of model-visible input against the
   effective compaction budget.

## 12. Deferred Questions

1. Should the trigger estimator add additional fixed request-envelope overhead
   beyond normal-agent tool schemas? Tool schemas are now counted for ordinary
   agent turns; provider framing remains uncalibrated.
2. How should local-model adapters report confidence when they only have a
   model-agnostic estimate but no provider usage diagnostics? Defer until local
   models are added.
3. Should Bud eventually add a dedicated `agent.context_budget` event for
   active long-horizon runs? Defer until `/agent/state` plus post-compaction
   snapshots prove insufficient.

## 13. Known Unknowns

- The model-agnostic estimator may still undercount provider request framing
  beyond the normal-agent tool schemas now included in trigger estimates.
- Provider `output_tokens` can overstate future replay input when it includes
  hidden reasoning or non-replayable output.
- Active in-memory conversation state can diverge from durable transcript rows
  inside long tool loops.
- The right amount of active budget streaming is unknown until we test real
  long-horizon agent runs.
- Future provider token-count APIs may make a better trigger basis possible, but
  they add latency and availability dependencies.
- Local models may expose context windows, chat templates, and tokenizer
  metadata inconsistently.

## 14. Recommendation

Proceed with Approach A.

The shortest reliable path is to make the backend compaction decision snapshot
the only primary context meter source. Provider usage should remain a diagnostic
until the backend trigger intentionally adopts it.

This keeps the product promise simple:

> If the ring reaches 100%, the backend is at or over the same threshold it uses
> to decide automatic compaction.

Once that invariant exists, we can improve the estimator without changing the
web contract again.
