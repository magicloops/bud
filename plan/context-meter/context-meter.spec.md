# context-meter

Implementation planning documents for the conversation context budget meter.

## Purpose

This folder turns the design work in [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md) into an actionable phased implementation plan.

The plan assumes:

- the meter reports model-visible context budget, not visible transcript length
- the primary budget is Bud's effective compaction budget while automatic compaction is enabled
- the effective compaction threshold comes from the same service-side budget resolver used by automatic compaction
- checkpointed conversations count latest replacement history plus post-checkpoint deltas, not the full visible transcript
- first-pass clients use agent-state refresh rather than a new `context.budget` SSE event
- provider token-count APIs and local tokenizers are deferred
- Tier 1 should use provider response usage, including output tokens that may become replayed assistant context

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

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated validation checklist for the rollout.

## Dependencies

- [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md) - design source for budget semantics, tiers, and UI
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
