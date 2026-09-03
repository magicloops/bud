# Design: Context Window vs Output Reserve — Correcting the Compaction Budget

Status: Implemented 2026-09-02 (ratio 0.90; GPT-5.5 usable window set to 272,000)

Audience: Backend (agent / LLM), web meter owners

Last updated: 2026-09-02

Related docs:

- [Usable context window and output reserve](./usable-context-window-and-output-reserve.md) — the 2026-05-24 design this corrects
- [Context compaction](./context-compaction.md)
- [Conversation context budget meter](./conversation-context-budget-meter.md)
- [reference/TOKEN_LIMITS_AND_COMPACTION.md](../reference/TOKEN_LIMITS_AND_COMPACTION.md) — how Codex handles GPT-5.6 Sol
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)

## 1. Summary

For GPT-5.6 Sol we intend to follow Codex: a **272,000-token active context
window**, compaction at ~90% of it, and the model's full 128,000-token output
ceiling. Today we compact at **136,800 tokens** instead — about 44% of the
window we meant to use — because the budget resolver subtracts the output
reserve from the 272k usable window:

```text
today:   usable_input = 272,000 − 128,000 = 144,000
         threshold    = floor(144,000 × 0.95) = 136,800

intended: usable_input = 272,000
          threshold    = floor(272,000 × 0.90) = 244,800
```

Yes, the diagnosis in the request is right, with one refinement: we do already
carry both numbers (`contextWindowTokens` = the hard window, 1,050,000, and
`usableContextWindowTokens` = 272,000), and the meter/compaction use the usable
one — but the output reserve is applied against the **usable** window when it
should only ever be applied against the **hard** window. The fix is one line of
policy math plus tests, catalog comments, and a ratio decision.

## 2. How Codex does it (reference summary)

From `reference/TOKEN_LIMITS_AND_COMPACTION.md`, for GPT-5.6 Sol:

| Concept | Codex |
| --- | --- |
| `max_output_tokens` | Not set on requests; the model ceiling (128,000) applies. Includes reasoning + visible text. |
| Active context window | 272,000 tokens (`model_context_window`), i.e. the input-pricing knee, not the 1.05M hard window. |
| Compaction threshold | 90% of the active window unless `model_auto_compact_token_limit` lowers it (clamped to ≤ 90%): **244,800**. |
| What is compared | Tracked usage of the last request — input **and** generated output (reasoning, tool-call context), from real `usage` numbers. |
| When it is checked | At request boundaries, never mid-generation. |
| Overshoot | Input of 244,799 + a full 128,000 output = **372,799** total is possible post-response; Codex compacts before/while continuing. This is the theoretical overshoot, not the threshold. |
| Tool output | Separate 10,000-token default cap on stored tool/terminal output (`tool_output_token_limit`). |

The key property: **the 272k window is compared against usage directly. Output
tokens are not reserved out of it.** The output ceiling only matters against the
hard 1.05M window, and 372,799 ≪ 1,050,000, so it never binds.

## 3. Our implementation today

### 3.1 Catalog (`service/src/llm/model-catalog.ts`)

| Model | `contextWindowTokens` | `usableContextWindowTokens` | `maxOutputTokens` | `reservedOutputTokens` |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.6-sol / terra / luna | 1,050,000 | 272,000 (pricing knee) | 128,000 | 128,000 |
| gpt-5.5 | 1,050,000 | 400,000 | 128,000 | 128,000 |
| gpt-5.4 | 1,050,000 | — (defaults to hard) | 128,000 | — (defaults to max output) |
| gpt-5.4-mini / nano | 400,000 | — | 128,000 | — |
| claude-opus-4-6 / 4-7 | 1,000,000 | — | 128,000 | — |
| claude-sonnet-4-6 | 1,000,000 | — | 128,000 | — |
| claude-haiku-4-5 | 200,000 | — | 64,000 | — |
| ds4-deepseek-v4-flash | 100,000 (runtime-overridable) | — | 384,000 | 20,000 (explicit) |

So the two windows the request asks about do exist: the hard window and the
usable window are separate fields, the usable window defaults to the hard one,
and the output reserve defaults to `maxOutputTokens` unless overridden.

### 3.2 Policy resolver (`service/src/agent/context-budget.ts`)

```text
usable   = usableContextWindowTokens ?? contextWindowTokens
reserve  = reservedOutputTokens ?? maxOutputTokens
usable_input = usable − reserve                      ← the bug
threshold    = floor(usable_input × ratio)           ratio = AGENT_AUTO_COMPACTION_RATIO,
                                                     default 0.95, clamped to ≤ 0.95
```

`resolveContextBudget` returns `{ contextWindowTokens, usableContextWindowTokens,
reservedOutputTokens, usableInputWindowTokens, thresholdRatio, thresholdTokens,
effectiveInputBudgetTokens }`; `effectiveInputBudgetTokens` is the threshold for
`agent_turn` requests and the full `usableInputWindowTokens` for
`compaction_summary` requests.

### 3.3 Where the numbers are used

- **Compaction decision** (`agent-service.ts` `compactConversationIfNeeded`):
  `estimated_next_input ≥ thresholdTokens`, checked pre-turn, mid-turn (after
  tool results are appended), and forced on a provider context-window error.
  The estimate is `estimateCanonicalMessagesTokens(conversation)` (≈ chars/4
  plus per-message/block overheads) + a constant tool-schema estimate; basis
  `model_agnostic_estimate`.
- **Compaction summary request** (`context-compactor.ts`): trimmed to
  `effectiveInputBudgetTokens` for `compaction_summary` = `usableInputWindowTokens`
  (144k today), with `max_output_tokens = min(128k, 16k)`.
- **Request `max_output_tokens`** (`model-runner.ts` `resolveModelMaxOutputTokens`):
  `min(AGENT_MAX_OUTPUT_TOKENS = 128,000, catalog maxOutputTokens)` = 128,000,
  sent explicitly on every OpenAI request (Codex omits the field; same effect).
- **Context meter** (`/agent/state.context_budget`, web
  `context-budget-meter-state.ts`): percent of `effective_budget_tokens`
  (= threshold), tooltip shows `usable_input_window_tokens`.
- **`/api/models`**: exposes `usable_context_window_tokens`,
  `reserved_output_tokens`, `usable_input_window_tokens` from the same resolver.
- **Existing tests** (`context-budget.test.ts`) pin the current formula:
  GPT-5.5 → usable input 272,000, threshold 258,400; default 1.05M model →
  922,000; ds4 → 80,000.

### 3.4 Effective numbers today

| Model | usable_input today | threshold today (0.95) |
| --- | ---: | ---: |
| gpt-5.6-sol / terra / luna | 144,000 | **136,800** |
| gpt-5.5 | 272,000 | 258,400 |
| gpt-5.4 | 922,000 | 875,900 |
| gpt-5.4-mini / nano | 272,000 | 258,400 |
| claude-opus-4-6 / 4-7, sonnet-4-6 | 872,000 | 828,400 |
| claude-haiku-4-5 | 136,000 | 129,200 |
| ds4 (100k runtime) | 80,000 | 76,000 |

## 4. Root cause

The 2026-05-24 design was derived from GPT-5.5 before Sol existed. It observed
that "Codex-like operation appears to use ... the older 400,000 token window
and a 128,000 output reserve", set `usable = 400,000`, and subtracted the
reserve — which *happens to land on 272,000*, the number Codex actually uses as
Sol's active window. That coincidence made `usable − reserve` look right.

When Sol was added, `usableContextWindowTokens` was (correctly) set to the real
272k pricing knee, but the resolver kept subtracting the reserve, halving the
budget. The conceptual error: **Codex's "context window" is already the usage
cap; it is not a total from which output must be carved out.** An output
reserve only protects against the *hard* window (input + output ≤ hard), and
for 1M-class models that constraint never binds.

The reserve is still meaningful — and still correct — for models whose usable
window *is* the hard window (gpt-5.4-mini/nano's 400k, Claude's windows, ds4): there the
API rejects `input + max_tokens > window` (Anthropic caps `max_tokens` against
its limit in `anthropic.ts`), so input must leave room.

## 5. Proposed formula

Reserve output against the hard window only; the usable cap applies to input
directly:

```text
hard     = contextWindowTokens
usable   = usableContextWindowTokens ?? hard
reserve  = reservedOutputTokens ?? maxOutputTokens

usable_input = min(usable, hard − reserve)
threshold    = floor(usable_input × ratio)
```

Invariant (add as a test and a resolver assertion): `usable_input + reserve ≤ hard`
and `usable_input ≤ usable`. `invalid_context_policy` when `hard − reserve ≤ 0`
(unchanged semantics for the misconfigured case).

### 5.1 Effect per model

| Model | usable_input | threshold @0.90 | threshold @0.95 | change vs today |
| --- | ---: | ---: | ---: | --- |
| gpt-5.6-sol / terra / luna | min(272k, 922k) = **272,000** | **244,800** | 258,400 | fixed (was 136,800) |
| gpt-5.5 | min(400k, 922k) = 400,000 | 360,000 | 380,000 | ↑ from 258,400 — see decision D2 |
| gpt-5.4 | min(1.05M, 922k) = 922,000 | 829,800 | 875,900 | unchanged input window |
| gpt-5.4-mini / nano | min(400k, 272k) = 272,000 | 244,800 | 258,400 | unchanged input window |
| claude-opus / sonnet (1M) | min(1M, 872k) = 872,000 | 784,800 | 828,400 | unchanged |
| claude-haiku-4-5 | min(200k, 136k) = 136,000 | 122,400 | 129,200 | unchanged |
| ds4 (100k) | min(100k, 80k) = 80,000 | 72,000 | 76,000 | unchanged |

Theoretical overshoot for Sol at 0.90: `244,799 + 128,000 = 372,799`, matching
the reference and comfortably inside the 1,050,000 hard window. The next request
boundary (mid-turn after tool results, or pre-turn) then compacts.

## 6. Other differences from Codex (not bugs, but worth stating)

| Aspect | Codex | Bud today | Recommendation |
| --- | --- | --- | --- |
| Ratio | 0.90 max | 0.95 default and clamp | Adopt **0.90** as default and clamp (decision D1). |
| What is measured | Real `usage` totals of the last request (input + output) | chars/4 estimate of the *next* request's input (+ constant tool-schema estimate) | Keep for this change. Follow-up: prefer the last real `usage.input_tokens + output_tokens` when available (`provider_usage_estimate` already exists on the snapshot for the meter but does not drive the decision). The 0.90 ratio also buys headroom for estimate error — code tokenizes closer to 3 chars/token, so the estimate can run low. |
| Check points | Request boundaries | Pre-turn, mid-turn (after tool results), forced on provider context error | Equivalent. |
| `max_output_tokens` | Not sent (ceiling 128k) | Sent explicitly as `min(128k config, 128k catalog)` | Equivalent; keep. |
| Compaction request budget | n/a | Trimmed to `usableInputWindowTokens` (becomes 272k with the fix) | Fine; the one-off compaction request may exceed the pricing knee if the overshoot was large — it is trimmed, so bounded at 272k. |
| Tool output cap | 10,000 tokens per stored tool output | Byte caps live in the terminal tools, not a token cap in the agent | Out of scope here; note for a later pass. |

## 7. Changes required

Service only; no schema, no daemon, no wire-shape change (values change,
fields do not).

1. `service/src/agent/context-budget.ts` — `resolveModelContextPolicy`:
   `usableInputWindowTokens = min(usable, hard − reserve)`; keep
   `invalid_context_policy` when `hard − reserve ≤ 0`.
2. `service/src/config.ts` — `AGENT_AUTO_COMPACTION_RATIO` default and clamp
   `0.95 → 0.90` (D1); `context-budget.ts` `DEFAULT_AUTO_COMPACTION_RATIO`
   likewise.
3. `service/src/llm/model-catalog.ts` — update the Sol/Terra/Luna comment
   ("usable window capped at the 272K pricing knee; output is reserved against
   the hard window, not this cap"); resolve D2 for GPT-5.5.
4. Tests: `context-budget.test.ts` (Sol → 272,000 / 244,800; GPT-5.5 per D2;
   gpt-5.4 unchanged 272,000; Claude/ds4 unchanged; invariant test),
   `model-catalog.test.ts` if it asserts policy numbers, snapshot tests that
   embed thresholds.
5. Specs: `agent.spec.md` (`context-budget.ts` bullets), `llm.spec.md` if it
   documents the formula, and mark
   `design/usable-context-window-and-output-reserve.md` as corrected by this doc.
6. Web: no code change; the meter and `/api/models` reflect the new numbers.
   Verify the tooltip copy still reads sensibly ("usable input window 272k").

## 8. Decisions (resolved 2026-09-02: D1 = 0.90, D2 = 272,000; D3 deferred)

- **D1 — Ratio**: 0.90 (Codex parity, more headroom for our estimate) vs keep
  0.95. Recommendation: **0.90**.
- **D2 — GPT-5.5 usable window**: with the corrected formula, `usable 400k`
  yields a 360k–380k input threshold instead of today's 258,400. If 400k was
  only ever a device to reach 272k (likely, per the old doc's wording), set
  `usableContextWindowTokens: 272_000` for GPT-5.5 too. If Codex genuinely uses
  a 400k active window for 5.5, leave it. Recommendation: **272,000** unless
  someone can confirm 400k against Codex's model config; it is the
  conservative choice and matches the same pricing knee.
- **D3 — Estimate basis** (follow-up, not this change): drive the decision from
  real provider usage when a recent `llm_call` usage row exists, falling back to
  the char estimate.

## 9. Test plan

- Unit: the per-model table in §5.1 at both ratios; the `usable_input + reserve ≤ hard`
  invariant for every catalog entry; ds4 runtime-override path still yields 80k.
- Regression: a Sol thread with an estimated 250k next input does not compact;
  260k does (at 0.90: 244,800 line).
- Existing agent-service compaction tests (141+) unchanged in behavior except
  threshold constants.
- Manual: open a long Sol thread and confirm the meter reports "of 245k"
  (0.90) rather than "of 137k", and that `/api/models` shows
  `usable_input_window_tokens: 272000`.

## 10. Rollout

Service auto-deploys from `main`. Threads currently sitting between 136.8k and
244.8k estimated tokens simply stop compacting until they reach the new line;
nothing needs migrating. Compaction checkpoints already written remain valid.
