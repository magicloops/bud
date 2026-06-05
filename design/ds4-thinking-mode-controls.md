# Design: ds4 Thinking Mode Controls

**Date:** 2026-06-04
**Status:** Implemented

Related docs:

- [../reference/ds4/server.md](../reference/ds4/server.md)
- [./local-ds4-llm-over-bud.md](./local-ds4-llm-over-bud.md)
- [./llm-model-catalog-and-reasoning-controls.md](./llm-model-catalog-and-reasoning-controls.md)
- [../service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [../service/src/llm/providers/providers.spec.md](../service/src/llm/providers/providers.spec.md)
- [../web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)

## Context

ds4 currently exposes three thinking modes:

| ds4 mode | Request semantics |
| --- | --- |
| `none` | Disable thinking. The request must explicitly send `reasoning.effort = "none"`. |
| normal thinking | Enabled by any non-`none` effort value. Omitting `reasoning` also enables this mode. |
| `max` | Enabled by `reasoning.effort = "max"`, but only when ds4 context is at least `393216` tokens. |

Bud currently starts ds4 with a 100,000 token context window, so `max` should not be exposed. The immediate product need is only to let users switch between no thinking and normal thinking.

`reference/ds4/server.md` confirms that `/v1/responses` is the preferred endpoint, accepts a `reasoning` field, streams reasoning in native Responses event shapes, and uses fixed sampling defaults in thinking mode.

## Current Implementation Findings

- `service/src/llm/model-catalog.ts` exposes `ds4-deepseek-v4-flash` with `reasoning.kind = "none"` and `levels = ["none"]`.
- `GET /api/models` returns those catalog reasoning levels, so the web composer hides the reasoning selector for ds4.
- `service/src/llm/reasoning-policy.ts` already validates `reasoning_effort` per model and converts `none` into `ReasoningConfig { enabled: false }`.
- `service/src/llm/providers/ds4.ts` only adds a `reasoning` request object when `modelConfig.reasoning.enabled` is true.
- That means Bud's current ds4 `none` selection omits `reasoning`, which ds4 interprets as normal thinking. The UI says "Fast", but the ds4 server can still think.
- The web already sends `reasoning_effort` from `/api/models` metadata. No new browser request field is needed.

## Goals

- Make ds4 thinking selectable through the existing model reasoning selector.
- Keep the public client contract as `reasoning_effort`.
- Explicitly send ds4 `reasoning.effort = "none"` for non-thinking turns.
- Send a non-`none` ds4 reasoning effort for normal thinking turns.
- Keep `max` unavailable while the effective ds4 context window is below `393216`.
- Avoid teaching the agent loop about ds4-specific thinking. Provider lowering should own the ds4 request shape.

## Non-Goals

- Implement `max` thinking in this pass.
- Add a new database field or protocol field.
- Add a separate ds4-only UI control.
- Change OpenAI or Anthropic reasoning behavior.
- Change ds4's provider-ledger reasoning replay or Responses stream parser.

## Proposed API Shape

Add a ds4-specific reasoning control kind to the catalog:

```typescript
type ReasoningControl =
  // existing kinds...
  | {
      kind: "ds4_responses_reasoning_effort";
      levels: readonly ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      requestField: "reasoning.effort";
      maxRequiresContextWindowTokens: number;
    };
```

For the current 100k context profile, the ds4 catalog entry should expose:

```typescript
reasoning: {
  kind: "ds4_responses_reasoning_effort",
  levels: ["none", "low"],
  defaultLevel: "none",
  requestField: "reasoning.effort",
  maxRequiresContextWindowTokens: 393_216,
}
```

`low` is a Bud-internal canonical value for normal ds4 thinking. It should be labeled as `Thinking` for ds4, not `Low`, because ds4 does not distinguish low/medium/high/xhigh normal thinking budgets.

Recommended labels:

| Value | ds4 label |
| --- | --- |
| `none` | `Fast` |
| `low` | `Thinking` |
| `max` | `Max thinking` |

The first pass should expose only `none` and `low`. If a future client or hidden test sends `medium`, `high`, or `xhigh`, those values are semantically normal thinking in ds4, but they do not need to be product-visible until we decide whether duplicate UI options are useful.

## Provider Lowering

`Ds4ResponsesProvider.buildRequest()` should lower the provider-agnostic `ReasoningConfig` as follows:

| Bud reasoning config | ds4 Responses body |
| --- | --- |
| `enabled: false` | `reasoning: { effort: "none" }` |
| `enabled: true`, `effort: "low"` | `reasoning: { effort: "low", summary: "auto" }` |
| `enabled: true`, `effort: "medium" / "high" / "xhigh"` | normal thinking; either pass the effort through or normalize to `"low"` |
| `enabled: true`, `effort: "max"` | only valid when the effective context window is at least `393216` |
| missing `modelConfig.reasoning` | preserve ds4 native behavior by omitting `reasoning`; agent calls should normally not hit this path |

Recommendation: for first-party catalog-exposed normal thinking, send the selected non-`none` effort explicitly instead of relying on omitted `reasoning`. Explicit requests are easier to inspect in context-drift artifacts and smoke logs.

For `none`, do not share OpenAI's behavior. OpenAI omits `reasoning` for `none`; ds4 must receive explicit `none`.

## Max Mode Gating

`max` should stay hidden for the current ds4 profile because:

```text
contextWindowTokens = 100000
maxRequiresContextWindowTokens = 393216
```

When we later support max, the gate should use the effective ds4 context window for the model source:

- Direct local-dev ds4: the configured direct context window, currently `DS4_DIRECT_CONTEXT_TOKENS`, or the catalog fallback.
- Bud-local ds4: the daemon-advertised `context_window_tokens`, or the catalog fallback.

The current `/api/models` implementation uses catalog reasoning metadata directly for both direct and Bud-local ds4 projections. That is enough for this first pass because `max` is not exposed. A future max implementation should add a small projection helper that derives ds4 reasoning levels from the effective context window before serializing `/api/models`.

## Web Behavior

The web should continue to treat `/api/models` as the source of truth:

- If ds4 returns `levels = ["none", "low"]`, the existing composer will show the reasoning selector.
- The existing `reasoning_effort` request field can carry either `none` or `low`.
- The selected thread preference can continue storing the selected `reasoning_effort`.

One nuance: the current web helper preserves the current reasoning value when switching models if the target model supports that value. Since GPT-5.5 defaults to `low`, switching from GPT-5.5 to ds4 would keep `low` and therefore select ds4 Thinking. That is defensible because a non-Fast user intent carries across providers, but if we want ds4 model switches to default to `none`, the web helper would need a separate change to reset when `reasoning.kind` changes.

Recommendation for this pass: keep the existing preservation behavior. Users can explicitly switch ds4 to `Fast`, and this avoids adding provider-specific UI state.

## Testing Plan

Service unit tests:

- Catalog exposes ds4 `reasoning.kind = "ds4_responses_reasoning_effort"`.
- Catalog exposes ds4 levels `["none", "low"]` and default `none`.
- `getReasoningLevelOptions()` labels ds4 `low` as `Thinking`.
- `/api/models` returns the ds4 reasoning selector for direct local-dev ds4 and Bud-local ds4.
- `POST /api/threads/:threadId/messages` accepts ds4 `reasoning_effort: "low"`.
- Existing invalid reasoning tests still reject unsupported ds4 `max` while context is 100k.

Provider request-shape tests:

- ds4 with `reasoning: { enabled: false }` sends `reasoning: { effort: "none" }`.
- ds4 with `reasoning: { enabled: true, effort: "low" }` sends a non-`none` reasoning effort.
- OpenAI still omits `reasoning` for `none`.
- Anthropic behavior is unchanged.

Manual smoke:

- Run a direct or Bud-local ds4 turn with `Fast`; confirm ds4 does not emit reasoning events and the captured request includes `reasoning.effort = "none"`.
- Run a ds4 turn with `Thinking`; confirm ds4 emits reasoning events and tool loops still replay through `/v1/responses`.
- Confirm `/api/models?bud_id=...` does not expose `max` with the current 100k ds4 context.

## Spec Files To Update During Implementation

- [../service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [../service/src/llm/providers/providers.spec.md](../service/src/llm/providers/providers.spec.md)
- [../service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
- [../web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)
- [../web/src/components/workbench/workbench.spec.md](../web/src/components/workbench/workbench.spec.md)
- [../web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)

## Open Questions

- Should normal ds4 thinking use `low` as the persisted canonical value, or should Bud add a new semantic `thinking` level? Recommendation: use `low` for lower code churn and label it as `Thinking` for ds4.
- Should hidden explicit `medium`, `high`, or `xhigh` submissions be accepted for ds4 and normalized to normal thinking, or should the catalog reject them because they are not exposed? Recommendation: reject for now unless a compatibility need appears.
- When `DS4_DIRECT_CONTEXT_TOKENS` or Bud-advertised context reaches `393216`, should `max` appear automatically in `/api/models`, or should it require an explicit feature flag because max thinking has higher latency and memory risk?

## Acceptance Criteria

- ds4 exposes a reasoning selector with `Fast` and `Thinking` while `max` is absent at 100k context.
- Selecting `Fast` sends explicit ds4 non-thinking request semantics.
- Selecting `Thinking` enables ds4 normal thinking without changing the agent loop.
- Existing OpenAI, Anthropic, model selection, and Bud-local availability behavior remain unchanged.
