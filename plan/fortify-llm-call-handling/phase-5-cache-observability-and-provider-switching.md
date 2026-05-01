# Phase 5: Cache Observability And Provider Switching

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Make cache behavior measurable and make provider switching explicit.

The provider ledger should make same-provider reconstruction stable enough for cache hits. This phase adds the observability and policy checks needed to know whether the request was actually cache-friendly.

## Scope

### In Scope

- OpenAI cached-token telemetry
- OpenAI prompt cache key/retention policy review
- Anthropic cache-control strategy review
- provider-switch fallback diagnostics
- cache-safe replay compatibility checks
- tests for provider-native vs canonical fallback reconstruction

### Out Of Scope

- guaranteeing a cache hit for every request
- cross-provider cache reuse
- aggressive prompt compaction
- changing product UI for cache metrics

## OpenAI Tasks

1. Persist response usage fields that report cached input tokens.
2. Log `prompt_cache_key`, retention setting, model, provider, and reconstruction mode.
3. Add a stable `prompt_cache_key` strategy if missing:
   - scoped to user/thread/provider where appropriate
   - stable across same-thread same-provider continuations
   - not so broad that unrelated users/threads compete for routing
4. Review whether `prompt_cache_retention` should remain default or opt into longer retention for long agent turns.
5. Ensure reasoning encrypted content is requested and stored when manual Responses context requires it.
6. Add diagnostics for degraded same-provider replay that would prevent exact prefix reuse.

## Anthropic Tasks

1. Inventory current `cache_control` behavior.
2. Decide whether to use top-level automatic caching, explicit breakpoints, or both.
3. Keep cache breakpoints away from unstable request suffixes unless intentionally caching a growing conversation.
4. Preserve `thinking` and `redacted_thinking` blocks during tool-use continuation even when previous thinking blocks are omitted from non-tool contexts.
5. Persist Anthropic cache usage fields if returned by the SDK/API.
6. Add diagnostics for cache-control incompatibilities when thinking settings or tool definitions change.

## Provider Switching Tasks

1. Add a reconstruction result type that records:
   - `mode`: `provider_native` or `canonical_fallback`
   - provider family
   - model
   - degraded ranges
   - omitted provider-only item counts
2. Use provider-native reconstruction only when prior ledger items match the target provider family/request mode.
3. Use canonical fallback when switching providers.
4. Do not attempt to translate reasoning items between providers.
5. Log provider switches in a structured way so cache drops can be distinguished from bugs.

## Acceptance Criteria

- [ ] OpenAI calls record cached-token metrics where available.
- [ ] Same-provider reconstruction mode is visible in logs or call metadata.
- [ ] Provider-switch fallback is explicit and does not attempt reasoning translation.
- [ ] Anthropic cache-control policy is documented and tested at the request-shape level.
- [ ] Cache misses can be investigated without inspecting browser-visible transcript rows.

## Risks

| Risk | Mitigation |
|------|------------|
| Prompt cache key is too broad or too narrow | Document key granularity and add metrics by key/model/thread without logging sensitive content |
| Anthropic cache breakpoints move onto unstable content | Add request-shape tests and keep stable prefix guidance in docs |
| Provider switch looks like a reconstruction bug | Return/log explicit `canonical_fallback` mode with omitted provider-only item counts |
