# Phase 8: ds4 Thinking Mode Controls

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Related Design**: [../../design/ds4-thinking-mode-controls.md](../../design/ds4-thinking-mode-controls.md)

---

## Objective

Expose ds4's current non-thinking versus normal-thinking modes through Bud's
existing model reasoning selector, while keeping `max` thinking hidden until
the effective ds4 context window is large enough to support it.

By the end of this phase:

- ds4 appears in `/api/models` with `Fast` and `Thinking` reasoning options
- `Fast` sends explicit ds4 non-thinking request semantics
- `Thinking` enables ds4 normal thinking through `/v1/responses`
- `max` is not exposed for the current 100k ds4 context profile
- OpenAI and Anthropic reasoning behavior remains unchanged
- no new browser request field, database column, or daemon protocol field is introduced

## Context

ds4 has three thinking modes today:

| ds4 mode | Request semantics |
| --- | --- |
| `none` | Disable thinking by explicitly sending `reasoning.effort = "none"` |
| normal thinking | Enabled by any non-`none` effort, and also by omitting `reasoning` |
| `max` | Enabled by `reasoning.effort = "max"` only when context is at least `393216` tokens |

Bud currently configures ds4 around a 100,000 token context window. That means
`max` is unavailable, but users should still be able to choose whether a ds4
turn thinks.

The important implementation delta from OpenAI is that omitting `reasoning`
does not mean `none` for ds4. The current ds4 provider omits `reasoning` when
Bud's canonical `ReasoningConfig.enabled` is false, so the UI can say `Fast`
while ds4 still runs normal thinking.

## Scope

### In Scope

- add a ds4-specific catalog reasoning control kind
- expose ds4 `none` and one normal-thinking value through `/api/models`
- label the normal-thinking value as `Thinking`
- lower ds4 `enabled: false` into explicit `reasoning.effort = "none"`
- keep ds4 `max` rejected or hidden while context is below `393216`
- update direct service-local and Bud-local ds4 model inventory tests
- update provider request-shape tests
- update impacted service/web specs

### Out Of Scope

- implementing `max` thinking
- exposing multiple ds4 normal-thinking levels that all do the same thing
- adding a ds4-only browser control
- changing OpenAI or Anthropic reasoning semantics
- adding dynamic runtime model metadata beyond the current Bud-local context and output projection
- changing provider-ledger reasoning replay or Responses stream parsing

## Proposed Decision

Use Bud's existing `reasoning_effort` contract and expose ds4 as:

```typescript
reasoning: {
  kind: "ds4_responses_reasoning_effort",
  levels: ["none", "low"],
  defaultLevel: "none",
  requestField: "reasoning.effort",
  maxRequiresContextWindowTokens: 393_216,
}
```

Treat `low` as the canonical internal value for normal ds4 thinking, but label
it as `Thinking` in `/api/models`.

Do not expose `medium`, `high`, or `xhigh` for ds4 in this phase. They are all
normal thinking from ds4's perspective, so showing them would imply a precision
that the local runner does not currently provide.

Do not expose `max` until the effective ds4 context window is at least
`393216` tokens.

## Design

### Catalog Metadata

Extend `ReasoningControl` with a ds4-specific kind:

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

Update `ds4-deepseek-v4-flash` from `kind: "none"` to the new ds4 kind with
levels `["none", "low"]`.

### Reasoning Labels

Keep generic labels for existing providers, but make ds4 labels semantic:

| Value | ds4 label |
| --- | --- |
| `none` | `Fast` |
| `low` | `Thinking` |
| `max` | `Max thinking` |

Preferred implementation: update `getReasoningLevelOptions(entry)` to consider
`entry.reasoning.kind`, instead of changing the global `formatReasoningLevel`
label for every provider.

### Provider Lowering

Update `Ds4ResponsesProvider.buildRequest(...)`:

| Bud `ReasoningConfig` | ds4 request body |
| --- | --- |
| `{ enabled: false }` | `reasoning: { effort: "none" }` |
| `{ enabled: true, effort: "low" }` | `reasoning: { effort: "low", summary: "auto" }` |
| `{ enabled: true, effort: "medium" / "high" / "xhigh" }` | normal thinking if ever accepted; pass through or normalize to `"low"` |
| `{ enabled: true, effort: "max" }` | future path only, gated by effective context window |
| missing `reasoning` | preserve ds4 native default by omitting `reasoning`; normal agent calls should not rely on this |

The key requirement is provider-specific handling for `none`. OpenAI's `none`
path omits `reasoning`; ds4's `none` path must send explicit `none`.

### Max Gating

For this phase, keep `max` out of `levels` because the catalog context window is
100k.

Future max support should derive visible ds4 reasoning levels from the effective
context window:

- direct service-local ds4: `DS4_DIRECT_CONTEXT_TOKENS` or catalog fallback
- Bud-local ds4: daemon-advertised `context_window_tokens` or catalog fallback

That future projection should happen before `/api/models` serializes
`reasoning.levels`. The provider should also defensively reject or fail clearly
if a `max` request reaches it while the effective context window is too small.

### Web Behavior

No new web request contract is needed.

The existing web model helpers already:

- read `reasoning.levels` from `/api/models`
- show the reasoning selector when more than one option is available
- submit `reasoning_effort` with thread creation and message sends
- normalize unsupported selections on model changes

One expected behavior: switching from a model with `low` selected to ds4 will
preserve `low`, so ds4 will start in `Thinking`. This is acceptable for the
first pass because it preserves the user's non-Fast intent across providers.
Users can switch ds4 to `Fast` explicitly.

## Implementation Tasks

### Task 1: Add ds4 catalog reasoning control

Update `service/src/llm/model-catalog.ts`:

- add `ds4_responses_reasoning_effort` to `ReasoningControl`
- update the ds4 catalog entry to expose `["none", "low"]`
- keep ds4 default reasoning at `none`
- add the `393216` max-context gate metadata

### Task 2: Add ds4-specific labels

Update `getReasoningLevelOptions(entry)` so ds4 `low` returns label
`Thinking` without changing labels for OpenAI, Anthropic, or Haiku.

### Task 3: Lower ds4 `none` explicitly

Update `service/src/llm/providers/ds4.ts` so:

- `modelConfig.reasoning?.enabled === false` sets `request.reasoning = { effort: "none" }`
- non-`none` reasoning still sends a normal Responses reasoning object
- OpenAI provider tests continue proving OpenAI omits `reasoning` for `none`

### Task 4: Update API and selection tests

Update or add tests for:

- catalog ds4 levels and labels
- `/api/models` direct local-dev ds4 reasoning metadata
- `/api/models?bud_id=...` Bud-local ds4 reasoning metadata
- thread/message selection accepts ds4 `reasoning_effort: "low"`
- ds4 `reasoning_effort: "max"` is still rejected at 100k context

### Task 5: Update provider request-shape tests

Update `service/src/llm/providers/providers.test.ts` for:

- ds4 Fast request sends `reasoning.effort = "none"`
- ds4 Thinking request sends a non-`none` reasoning effort
- existing ds4 reasoning replay and Responses parsing tests still pass

### Task 6: Update specs

Update:

- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md)
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md)
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md)
- [../../web/src/lib/lib.spec.md](../../web/src/lib/lib.spec.md)
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md)
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md)
- [ds4.spec.md](./ds4.spec.md)

## Implementation Notes

- `ds4-deepseek-v4-flash` now exposes a ds4-specific reasoning control kind
  with `none` (`Fast`) and `low` (`Thinking`) as the current visible levels.
- `max` remains absent because the active ds4 context profile is below the
  393,216 token requirement.
- `Ds4ResponsesProvider` lowers `ReasoningConfig { enabled: false }` to
  `reasoning: { effort: "none" }`, avoiding ds4's omitted-reasoning default of
  normal thinking.
- Direct service-local and Bud-local `/api/models` projection tests cover the
  ds4 reasoning metadata, output cap metadata, and lower Bud-advertised output
  cap preservation.
- Message selection tests reject explicit ds4 `max` before durable side
  effects.

## Test Plan

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/model-catalog.test.ts src/llm/reasoning-policy.test.ts`
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/routes/models.test.ts src/routes/threads/messages.test.ts src/routes/threads/core.test.ts`
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts`
- optional manual: run one ds4 `Fast` turn and confirm request snapshot includes `reasoning.effort = "none"`
- optional manual: run one ds4 `Thinking` turn and confirm ds4 emits Responses reasoning events

## Acceptance Criteria

- `/api/models` exposes ds4 reasoning options `Fast` and `Thinking`.
- The web composer shows ds4's reasoning selector without a ds4-specific UI branch.
- ds4 `Fast` requests explicitly send `reasoning.effort = "none"`.
- ds4 `Thinking` requests enable normal ds4 thinking.
- ds4 `max` does not appear for the current 100k context profile.
- Explicit ds4 `max` submissions fail clearly instead of reaching the provider.
- OpenAI and Anthropic request shapes are unchanged.

## Open Questions

- Should future ds4 max support appear automatically once context is at least
  `393216`, or should it require an explicit feature flag because of latency and
  memory risk?
- If a future ds4 version adds distinct low/medium/high budgets, should Bud
  expose those as normal `reasoning_effort` values or preserve the simpler
  `Fast` / `Thinking` control?
