# context-meter

Implementation planning documents for the conversation context budget meter.

## Purpose

This folder turns the design work in [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md), [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md), and [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md) into an actionable phased implementation plan.

The plan assumes:

- the meter reports model-visible context budget, not visible transcript length
- the primary budget is Bud's effective compaction budget while automatic compaction is enabled
- the effective compaction threshold comes from the same service-side budget resolver used by automatic compaction
- checkpointed conversations count latest replacement history plus post-checkpoint deltas, not the full visible transcript
- first-pass clients use agent-state refresh rather than a new standalone
  `agent.context_budget` SSE event
- provider token-count APIs and local tokenizers are deferred
- the earlier Tier 1 provider usage work now feeds diagnostics unless the
  backend trigger intentionally adopts provider usage later
- follow-on usable-context work separates hard model windows from Bud usable context caps
- output reserve defaults to `maxOutputTokens`, with model-specific overrides
- the automatic-compaction ratio clamp should move to `0.95`
- invalid or missing local-model context policy should show `Context unknown`
- the primary meter should use the same estimate as the backend automatic
  compaction decision
- provider usage plus delta is diagnostic-only unless the backend trigger
  intentionally adopts it
- provider usage diagnostics are not rendered in the product context tooltip
- ordinary agent-turn budget estimates include the static normal-agent tool
  schemas; compaction-summary budgets remain tool-free
- active budget state should live in `AgentRuntimeStateManager`
- `agent.compaction_done` may carry an additive post-compaction
  `context_budget` snapshot

## Files

### `implementation-spec.md`

Parent implementation spec for the context meter rollout.

Documents:

- fixed product and architecture decisions
- phased implementation sequencing
- API and UI contracts
- expected code areas and spec updates
- open questions and known unknowns

### `phase-0-current-state-and-contract-lock.md`

Discovery and contract-lock phase covering:

- branch drift from the design doc
- final snapshot field names
- route/bootstrap ownership boundaries
- active-turn freshness expectations

### `phase-1-backend-budget-snapshot.md`

Backend baseline phase covering:

- service-owned context budget snapshot helper
- Tier 0 model-agnostic estimate
- effective-budget math shared with automatic compaction
- checkpoint-aware reconstruction inputs

### `phase-2-provider-usage-plus-delta.md`

Tier 1 estimator phase covering:

- latest `llm_call.usage` anchoring
- output-token handling for replayed assistant output
- delta estimation after the latest provider call
- invalidation rules for provider/model/reasoning/request-shape changes

### `phase-3-api-and-agent-state-contract.md`

Browser-facing contract phase covering:

- `context_budget` on `/agent/state`
- optional thread bootstrap inclusion
- ownership tests
- first-party TypeScript API types
- explicit non-goal of new SSE events for the first pass

### `phase-4-web-context-meter-ui.md`

Web UI phase covering:

- workbench/composer placement
- visual states and copy
- percentage and rounded-token formatting
- responsive tooltip/popover behavior

### `phase-5-validation-docs-and-rollout.md`

Finalization phase covering:

- automated and manual validation
- spec updates
- rollout and fallback notes
- deferred follow-ups

### `phase-6-usable-context-policy-resolver.md`

Follow-on context policy phase covering:

- model catalog usable-context and output-reserve fields
- shared resolver defaults and invalid policy handling
- `0.95` ratio clamp
- GPT-5.5 Codex-style 400k/128k budget policy

### `phase-7-agent-compaction-budget-semantics.md`

Follow-on agent semantics phase covering:

- normal-turn compaction using usable input threshold
- disabled-compaction effective budget using usable input window
- compaction summary trimming using the larger usable input window
- diagnostics that distinguish hard, usable, reserve, input, and threshold values

### `phase-8-api-models-and-web-policy-fields.md`

Follow-on API/UI phase covering:

- `/api/models` usable-context policy fields
- `context_budget` usable-context policy fields
- first-party API model/type updates
- context meter details and `Context unknown` fallback

### `phase-9-usable-context-validation-docs-and-rollout.md`

Follow-on validation phase covering:

- service and web validation for usable-context policy
- spec updates
- rollout notes and deferred follow-ups

### `phase-10-radial-send-button-context.md`

Follow-on web UI phase covering:

- replacing the dedicated composer context meter with a circular context-aware
  send button
- rendering context usage as a radial border from 0-100%
- moving the existing context tooltip to the send control
- preserving unknown, stale, near-threshold, over-threshold, and disabled states

### `phase-11-authoritative-budget-contract-and-tests.md`

Follow-on authoritative-budget contract phase covering:

- primary meter semantics matching backend compaction decisions
- provider usage diagnostics moved out of primary meter math
- provenance fields such as source, phase, reason, turn id, and checked time
- regression coverage for provider-usage-vs-trigger-estimate mismatch

### `phase-12-shared-budget-state-helper.md`

Follow-on backend refactor phase covering:

- a shared context budget state helper for agent decisions and snapshots
- `AgentService.compactConversationIfNeeded(...)` using the shared helper
- durable `/agent/state.context_budget` reconstruction using the same primary
  estimate builder
- provider usage plus delta retained as optional diagnostics

### `phase-13-runtime-active-budget-state.md`

Follow-on runtime state phase covering:

- storing the latest active budget decision in `AgentRuntimeStateManager`
- `/agent/state` preferring active runtime budget during active turns
- final/cancel paths leaving a budget suitable for the next user turn
- avoiding a separate budget runtime store

### `phase-14-web-refresh-and-compaction-payloads.md`

Follow-on web and stream contract phase covering:

- optional post-compaction `context_budget` on `agent.compaction_done`
- web applying post-compaction snapshots immediately when present
- `/agent/state` refresh fallback after send, model changes, resync, final, and
  cancel
- product-facing tooltip details without provider usage diagnostics

### `phase-15-calibration-and-trigger-estimator-follow-up.md`

Follow-on calibration phase covering:

- side-by-side trigger estimate vs provider usage diagnostics
- adding fixed normal-agent tool-schema overhead to trigger estimates
- measuring whether remaining request overhead explains observed deltas
- optional further estimator tuning
- explicit future design requirement before provider usage can drive compaction

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated validation checklist for the rollout.

## Dependencies

- [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md) - design source for budget semantics, tiers, and UI
- [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md) - design source for usable context caps, output reserves, and GPT-5.5 budget behavior
- [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md) - design source for backend-authoritative meter semantics and active runtime budget state
- [../../design/context-compaction.md](../../design/context-compaction.md) - compaction checkpoint and threshold design
- [../automatic-compaction/implementation-spec.md](../automatic-compaction/implementation-spec.md) - implemented automatic compaction plan this meter builds on
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - current agent loop, context budgeting, and checkpoint reconstruction
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - provider usage accounting and model catalog context
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - HTTP route ownership conventions
- [../../service/src/routes/threads/threads.spec.md](../../service/src/routes/threads/threads.spec.md) - thread route and agent-state contracts
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md) - thread hooks and stream handling
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) - workbench placement and composer controls
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

No tracked implementation debt exists yet. Open questions and deferred work are documented in [implementation-spec.md](./implementation-spec.md).

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
