# Plan: add the GPT-5.6 family (Sol, Terra, Luna) to the model catalog

## Context
- Related design: [design/llm-model-catalog-and-reasoning-controls.md](../design/llm-model-catalog-and-reasoning-controls.md)
  (the catalog this slots into), [design/ds4-thinking-mode-controls.md](../design/ds4-thinking-mode-controls.md).
- Related specs: `service/src/llm/llm.spec.md`, `service/src/llm/providers/providers.spec.md`,
  `service/src/agent/agent.spec.md`, `web/src/lib/lib.spec.md`.
- Scoped 2026-08-27; no code changed yet.

## The models (primary source: developers.openai.com model pages)

| product id | tier | ctx / max out | reasoning efforts | price in/out per 1M |
|---|---|---|---|---|
| `gpt-5.6-sol` | frontier | 1,050,000 / 128,000 | none, low, medium (OpenAI default), high, xhigh, max | $4 / $20 |
| `gpt-5.6-terra` | balanced | same | same | $2 / $12 |
| `gpt-5.6-luna` | fast | same | same | $0.20 / $1.20 |

- GA 2026-07-09; knowledge cutoff 2026-02-16; single undated snapshot each
  (`providerModel == id`); the bare `gpt-5.6` alias routes to Sol on
  OpenAI's side.
- **No API "pro/ultra" reasoning mode exists** — that is ChatGPT-side
  packaging; the six `reasoning.effort` values are the whole API surface.
- Pricing knee: prompts >272K input tokens bill at 2× input / 1.5× output
  for the whole request (all tiers).

## Key scoping findings

1. **No `ReasoningLevel` widening needed.** All six levels already exist in
   the union (`max` via Claude 4.6, `xhigh` via OpenAI); `formatReasoningLevel`,
   `config.REASONING_EFFORTS`, and both web copies already carry them. The
   only new artifact is a levels tuple:
   `OPENAI_GPT_5_6_REASONING_LEVELS = ["none","low","medium","high","xhigh","max"]`.
   This is also the first OpenAI model offering `max` — the OpenAI provider
   passes `reasoning.effort` through untyped, so no lowering change; add a
   request-shape test.
2. **The ids are guard-compatible.** `gpt-5.6-*` passes
   `supportsModel(startsWith("gpt-"))` and `isReasoningModel(startsWith("gpt-5"))`
   in `providers/openai.ts` — no prefix-gate changes needed (temperature
   suppression and reasoning inclusion behave correctly by accident of
   naming; note the fragility, do not fix here).
3. **Catalog-first routing means the blast radius is small.** Registration =
   3 service files + 6-ish test files + specs; `/api/models`, the web
   selector/reasoning dropdown, reasoning policy, context budget,
   compaction, ledger replay are all provider- or catalog-keyed and need
   nothing.
4. **Decisions required** (defaults are proposals, see §Decisions).
5. **Adjacent debt worth taking or explicitly skipping**: thread-title
   hardcode (`claude-haiku-4-5`) — Luna is the natural OpenAI
   fallback (TODO.md item); stale `DEFAULT_MODEL=claude-opus-4-5` in
   `.env.production`/`.env.staging` (id not in the catalog); the misnamed
   shared `OPENAI_GPT_5_4_REASONING_LEVELS` tuple; the triplicated
   `ReasoningLevel` union (service ×2 + web ×2) — no edit needed this time,
   but record it.

## Decisions (proposed defaults — confirm before implementing)

1. **Product ids**: `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`
   (= provider ids; no dated snapshots exist). Do NOT add a bare `gpt-5.6`
   alias — Bud's catalog wants one entry per selectable model; the alias
   would silently pin Sol. (`MODEL_ALIASES` stays untouched.)
2. **Default reasoning level** (DECIDED 2026-08-27): Sol/Terra `low`
   (matching existing Bud OpenAI entries); **Luna `high`** — Luna is the
   global default and gets the stronger default level.
3. **Global default model** (DECIDED 2026-08-27): **`gpt-5.6-luna`**;
   `globalDefault` flag moved off `gpt-5.5` atomically, `DEFAULT_MODEL`
   fallbacks and env files updated.
4. **Context policy** (DECIDED 2026-08-27): all three tiers cap
   `usableContextWindowTokens` at **272_000** (the pricing knee) with
   `reservedOutputTokens: 128_000` → usable input window 144,000 and
   auto-compaction around ~137K input. NOTE: this is deliberately tighter
   than gpt-5.5's 400K/128K policy (whose usable INPUT already landed
   exactly at 272K); if the family's threads compact too aggressively in
   practice, raising usable to 400K restores gpt-5.5-equivalent behavior
   in one field per entry.
5. **Tier/sort**: sol `frontier`, terra `balanced`, luna `fast`; sortOrder
   slots the family above gpt-5.5 within the OpenAI block (e.g. 110/120/130
   vs gpt-5.5's 140). `defaultForProvider` stays on the current holder
   unless (3) changes.
6. **Thread-title model** (DECIDED 2026-08-27, pulled into phase 1):
   `gpt-5.6-luna` with reasoning disabled (`none`) is the primary title
   model; `claude-haiku-4-5` remains the fallback when OpenAI is not
   registered — closes the "OpenAI-only deployments get no titles" TODO in
   both directions.

## Implementation plan

### Phase 1 — the family (one PR)
1. `service/src/llm/model-catalog.ts`
   - new tuple `OPENAI_GPT_5_6_REASONING_LEVELS` (all six levels);
   - three entries per the table + decisions above (vision/tools/streaming/
     structuredOutputs: true, matching the 5.5 entry).
2. `service/src/llm/providers/openai.ts` — append the three ids to
   `supportedModels`; extend `getFallbackModelLimits` with a
   `includes("gpt-5.6")` arm (1.05M/128K) so non-catalog resolution can't
   regress to 400K/32K.
3. Tests:
   - `llm/model-catalog.test.ts` — extend the exact ordered id list; level
     assertions for the family (incl. `max` present, `minimal` absent);
     Luna's 272K usable-context policy.
   - `routes/models.test.ts` — extend the exact `/api/models` list + fake
     provider fixtures; assert the family's reasoning block exposes all six
     levels with default `low`.
   - `llm/reasoning-policy.test.ts` — `max` accepted for `gpt-5.6-sol`,
     still rejected for `gpt-5.5`; invalid level → 400 path unchanged.
   - `llm/providers/providers.test.ts` — request shape: `reasoning.effort:
     "max"` passes through; `none` omits `reasoning`; temperature
     suppressed for the family.
4. Specs/docs: `llm.spec.md` product-model table + level lists;
   `providers.spec.md` supported-model table; `agent.spec.md` per-provider
   level lists; `routes.spec.md` example payloads only if they enumerate
   ids. Web: **no code changes** (selector and reasoning dropdown are
   `/api/models`-driven; both level unions already contain all six).
5. Env hygiene (same PR, small): fix stale
   `DEFAULT_MODEL=claude-opus-4-5` in `.env.production`/`.env.staging` to a
   catalog id (keep `gpt-5.5` until decision 3 flips).

### Phase 2 — follow-ups (separate, each trivially small)
- Flip `globalDefault` to the chosen 5.6 tier (+ the ~6 tests that pin
  `"gpt-5.5"` as default, env examples, README, spec mentions).
- Thread-title Luna fallback (decision 6).
- Optional cleanup: rename `OPENAI_GPT_5_4_REASONING_LEVELS` →
  `OPENAI_GPT_5_REASONING_LEVELS_NO_MAX` or per-family constants; note the
  triplicated `ReasoningLevel` union in TODO.md if we ever want codegen.

### Explicitly out of scope
- No "pro/ultra" modeling (not an API surface).
- No new `ReasoningControl` kind, no web type changes, no mobile compat
  work (`/api/models` is the contract per the iOS handoff; new models/levels
  flow through data).
- No per-model compaction tuning beyond decision 4; no prompt-cache-key work
  (existing TODO).

## Test plan (beyond unit)
- Live smoke (needs OPENAI_API_KEY): one thread per tier via the dev stack;
  verify `reasoning_effort: "max"` round-trips on Sol and `none` on Luna;
  confirm `/api/models` payload renders the six-option dropdown in web.

## Verification checklist
- [x] `pnpm test` (487/487; exact-list tests updated deliberately)
- [x] `/api/models` shows 3 new entries with correct ordering and defaults
      (asserted in `routes/models.test.ts`)
- [x] Existing threads pinned to old ids still resolve (`storedModelValid`
      self-heal untouched)

## Status
Implemented 2026-08-27 (phase 1 + the decided default flips in one change).
Notable deltas from the original scoping:
- The service-default path in `resolveEffectiveModelSelection` pinned the
  env-level default (`low`) instead of the default model's catalog
  `defaultLevel`; fixed so an unpinned service default follows the catalog
  (Luna → `high`), with `serviceDefaultReasoning` still able to override.
- The web new-thread composer's pre-load `'low'` seed stuck because the
  adopt-default effect only replaced `'none'`; it now follows the service
  default until the user explicitly picks a level.
- Live smoke against the real API: `gpt-5.6-luna` at `high` and
  `gpt-5.6-sol` at `max` both round-trip (`reasoning.effort` accepted,
  responses clean).
- Thread-title model is now `gpt-5.6-luna` (reasoning disabled) with
  `claude-haiku-4-5` as the Anthropic-only fallback — the "no titles
  without Anthropic" TODO is closed in both directions.
