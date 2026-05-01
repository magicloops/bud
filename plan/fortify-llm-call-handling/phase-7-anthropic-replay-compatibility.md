# Phase 7: Anthropic Replay Compatibility

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Source Review**: [../../review/fortify-llm-call-handling-branch-review.md](../../review/fortify-llm-call-handling-branch-review.md)

---

## Objective

Make same-provider Anthropic replay conditional on compatible request settings, not only provider equality.

The current branch can replay signed `thinking` and `redacted_thinking` blocks into any later Anthropic request. That is provider-correct only when the next Anthropic request enables a compatible thinking mode and model/request shape. This phase makes that compatibility explicit and observable.

## Scope

### In Scope

- compatibility checks for Anthropic provider-native replay
- current model/reasoning config passed into reconstruction
- canonical fallback for incompatible Anthropic reasoning-bearing ranges
- structured degradation metadata for same-provider but incompatible replay
- fixture coverage for thinking-enabled to no-thinking or incompatible Anthropic transitions

### Out Of Scope

- cross-provider reasoning translation
- showing reasoning in the UI
- forcing Anthropic thinking on when the user/model selection disabled it
- broad prompt-cache tuning beyond replay compatibility diagnostics

## Implementation Tasks

1. Extend conversation reconstruction input so the loader can see the current target model and reasoning config, not just the target provider.
2. Define an Anthropic replay compatibility helper that answers:
   - whether a stored provider-ledger assistant item contains `thinking` or `redacted_thinking`
   - whether the current Anthropic request enables a compatible thinking mode for those blocks
   - whether request-mode/model family changes require canonical fallback
3. Only include Anthropic provider-ledger messages in provider-native replay when the full message is compatible with the current request.
4. When a ledger message is incompatible, fall back to product transcript rows for that range and record a degradation reason such as `same_provider_incompatible_reasoning`.
5. Keep provider-only thinking and redacted-thinking blocks out of canonical fallback prompts.
6. Include compatibility details in `llm_call.cache_metadata` or equivalent reconstruction metadata without logging provider payload content.
7. Add tests for:
   - thinking-enabled Anthropic replay into thinking-enabled Anthropic request
   - thinking-enabled Anthropic replay into no-thinking Anthropic request
   - redacted-thinking replay into incompatible Anthropic request
   - mixed visible text/tool transcript preservation when provider-native reasoning is omitted

## Acceptance Criteria

- [x] Same-provider Anthropic replay remains provider-native when stored reasoning blocks and current request settings are compatible.
- [x] Same-provider Anthropic replay falls back canonically when stored reasoning blocks are incompatible with the current model/reasoning config.
- [x] Incompatible same-provider fallback is distinguishable from cross-provider fallback in logs and call metadata.
- [x] Canonical fallback keeps visible assistant text and tool transcript semantics while omitting provider-only thinking payloads.
- [x] Fixture tests cover signed thinking and redacted thinking across compatible and incompatible Anthropic continuations.

## Risks

| Risk | Mitigation |
|------|------------|
| Compatibility logic becomes too conservative and reduces cache hits | Start by gating only reasoning-bearing Anthropic ranges and log exact degradation reasons |
| Canonical fallback duplicates visible text already represented by a compatible ledger range | Keep compatible ledger call IDs separate from incompatible fallback ranges during timeline merge |
| Request metadata is stored in the wrong place | Prefer reconstruction metadata over browser transcript rows; add schema only if existing metadata fields are insufficient |
| Future Anthropic thinking modes change semantics | Keep compatibility helper provider-specific and fixture-backed rather than baking assumptions into generic loader code |
