# Plan: Context popover — less prose, a real breakdown

Status: Implemented 2026-09-03. Deviations from the plan below:
- Runtime instructions only exist while the bud is offline (~100 tokens), so
  the idle snapshot does not replicate the environment machinery; the
  `runtime_instructions` category still reports them on active-turn snapshots.
- `compaction_count` is `null` on active-turn decision snapshots (no extra
  query per tool step); the idle and post-compaction snapshots count.
- Touch: the send button is the form submit, so a tap opens the popover only
  when the button is disabled (empty composer); focus and hover open it
  otherwise.

## Context
- Related spec files: `web/src/components/workbench/workbench.spec.md`
  (`context-send-button.tsx`, `context-budget-meter-state.ts`),
  `service/src/agent/agent.spec.md` (`context-budget-state.ts`,
  `context-budget-snapshot.ts`), `web/src/lib/api-types.ts`
- Related design docs: `design/conversation-context-budget-meter.md` (§9 UI),
  `design/context-window-output-reserve-correction.md` (the numbers the
  popover now shows)
- Render site: the send button's ring (`context-send-button.tsx`) with a
  hover tooltip whose lines come from `getContextBudgetMeterPresentation`.

### What it says today (GPT-5.6 Sol, idle thread)
```
gpt-5.6-sol: 44% of auto-compact limit
108k used of 245k.
137k remaining before auto-compaction.
Bud cap 272k, output reserve 128k.
Usable input window 272k.
Hard model window 1.1m.
Messages 106k, tool schemas 1.6k.
Basis backend estimate, medium confidence.
Source durable reconstruction (idle).
Already compacted earlier context.
```

Problems:
- Ten lines, most of them policy trivia ("Bud cap", "usable input window",
  "hard model window") that repeat each other now that the usable cap *is*
  the input window, and that no user acts on.
- Diagnostics leak into product copy ("Basis backend estimate, medium
  confidence", "Source durable reconstruction (idle)").
- The one useful decomposition is "Messages 106k, tool schemas 1.6k" — it
  lumps the system prompt, user text, assistant text, reasoning, tool calls
  and tool output into "messages". The question a user actually has —
  *what is eating my context?* — is unanswerable.
- Hover-only: on touch devices (mobile web, the composer is used there)
  the tooltip never opens.

## Objective
A compact, scannable popover that answers three questions in order:
1. **How full am I, and when does compaction hit?** (one headline)
2. **What is using the space?** (a segmented bar + a ranked category list
   with tokens and percent)
3. **How much can I trust this?** (one quiet footer line)

Acceptance:
- ≤ 4 lines above the breakdown; no policy numbers except the limit itself.
- Category breakdown sums to `estimated_input_tokens`; percents are of that
  total (so they read as "share of what's in context", not of the limit).
- Opens on hover *and* on click/tap; dismisses on outside click/Escape.
- No wire-shape break: fields are additive on `context_budget`; existing
  clients keep working.

## Design / Approach

### Mockup
```
GPT-5.6 Sol · 44% of auto-compact limit
108k of 245k · compacts at 90% of the 272k window

[████████████▓▓▓▓▒▒▒░░░░░░░░░░░░░░░░░░░░]

Tool output           61k   56%
Messages              22k   20%
System prompt         12k   11%
Tool calls             6k    6%
Reasoning              4k    4%
Compaction summary     3k    3%
Tool schemas         1.6k    1%

Estimated (~4 chars/token) · last request measured 104k in / 2.1k out
Compacted once · 128k reserved for the reply
```
- Bar segments use the category order/colors of the list (accent shades for
  "ours" — messages, system prompt — muted grays for tool output/calls; the
  compaction summary in the bud accent so it's visible that history was
  folded).
- The two footer lines are `text-muted-foreground` and shorter than they look
  here on a 288px popover; on narrow widths the "measured" clause drops.
- Nothing about "Bud cap", "usable input window", "hard model window",
  "basis", "source", or "phase" in product copy. Keep them behind a
  `Show diagnostics` disclosure only when `config.showSystemMessages`-style
  debug is on (reuse that flag; no new setting).

### Categories (computed once, on the service)
Derived from the same `CanonicalMessage[]` the estimate already walks, in
`context-budget-state.ts` (one pure function, `estimateContextBreakdown`),
so the meter, the compaction decision logs, and any future client share it:

| Category | Rule |
| --- | --- |
| `system_prompt` | First `system` message (`AGENT_SYSTEM_PROMPT`). |
| `runtime_instructions` | Any other `system` message (`applyRuntimeInstructions` output). Folded into "System prompt" in the UI unless debug is on. |
| `compaction_summary` | `user` text starting with `CHECKPOINT_SUMMARY_PREFIX`, plus the "Current terminal context at compaction time" message that follows it. |
| `user_messages` | Remaining `user` text blocks. |
| `assistant_text` | `assistant` text blocks. |
| `reasoning` | `reasoning` / `reasoning_redacted` blocks. |
| `tool_calls` | `tool_use` blocks (name + args). |
| `tool_output` | `tool_result` blocks. |
| `images` | `image` blocks (rare; hidden when 0). |
| `tool_schemas` | `AGENT_TOOL_SCHEMA_TOKENS` (already separate). |

Per-message/block overheads (`MESSAGE_TOKEN_OVERHEAD`,
`CONTENT_BLOCK_TOKEN_OVERHEAD`) are attributed to the category of the
block/message they belong to, so the categories sum exactly to
`message_estimated_tokens`; add `tool_schemas` and the total equals
`estimated_input_tokens`. Assert this in tests.

UI merges `user_messages` + `assistant_text` into **Messages** and
`system_prompt` + `runtime_instructions` into **System prompt**; the API keeps
them separate.

Nuance to fix while here: the idle (`durable_reconstruction`) snapshot is
built from the loader output *without* `applyRuntimeInstructions`, while the
active-turn decision includes it, so the idle number is slightly low. Apply
the same runtime instructions in `context-budget-snapshot.ts` (needs the
environment; if unavailable, the category simply reads 0 and the footer
says "estimated").

### Snapshot / API (additive)
```ts
// context_budget (status: "available") gains:
breakdown: Array<{
  kind: "system_prompt" | "runtime_instructions" | "compaction_summary" |
        "user_messages" | "assistant_text" | "reasoning" | "tool_calls" |
        "tool_output" | "images" | "tool_schemas";
  tokens: number;
  percent_of_estimated_input: number; // 0..1
}>;
compaction_count: number;            // completed checkpoints for the thread
```
- Emitted everywhere `context_budget` already is: `/agent/state`,
  `agent.compaction_done`, runtime state. Snake_case per AGENTS.md §7.
- `compaction_count` replaces the boolean-ish "Already compacted earlier
  context" (`latest_checkpoint_id` stays). Comes from
  `context-checkpoint-repository` (count completed rows); cheap, already
  indexed by thread.
- `provider_usage_estimate` already carries the last measured
  `input_tokens`/`output_tokens`; the footer's "measured" clause reads it. No
  new field.

### Web
- `context-budget-meter-state.ts`: `getContextBudgetMeterPresentation` returns
  a structured object (`headline`, `subline`, `segments[]`, `rows[]`,
  `footer[]`) instead of `detailLines: string[]`; `title`/`percent`/`tone`
  unchanged so the ring and aria-label don't move.
- `context-send-button.tsx`: render the popover from the structured
  presentation. Switch the surface from Radix Tooltip to **Radix Popover**
  (`@radix-ui/react-popover` is **not** installed today — only
  `react-tooltip` and `react-slot` are; add it, same Radix major as tooltip) with `openOnHover` behavior on pointer
  devices and click/tap everywhere. Keep `max-w-72`, mono, neo-brutalist
  chrome.
- Segmented bar: plain flex row of `div`s with widths from
  `percent_of_estimated_input`; no chart library. Minimum segment width 2px
  so tiny categories stay visible; categories under 0.5% collapse into the
  list's last row "Other".
- Tone thresholds (`normal / elevated / near / over`) unchanged.

### Copy rules
- Model display name (from `/api/models` `display_name`), not the id.
- One number format everywhere: `formatRoundedTokenCount` (existing).
- "compacts at 90% of the 272k window" only when compaction is enabled;
  otherwise "of the 272k window".
- Footer, exactly two lines max:
  - basis: `Estimated (~4 chars/token)` or `Measured by provider` (when
    `basis` is a provider count), with ` · last request measured Xk in / Yk out`
    when `provider_usage_estimate` exists.
  - `Compacted N×` (omitted when 0) ` · Xk reserved for the reply`.
- `stale`: append `Refreshing…` to the headline instead of a separate line.

## Spec Files to Update
- [ ] `service/src/agent/agent.spec.md` — `context-budget-state.ts`
      (breakdown), `context-budget-snapshot.ts` (runtime instructions parity,
      `compaction_count`)
- [ ] `docs/proto.md` — `context_budget` additive fields (SSE payload)
- [ ] `web/src/lib/api-types.ts` — `ApiContextBudgetAvailable.breakdown`,
      `compaction_count`
- [ ] `web/src/components/workbench/workbench.spec.md` — meter/popover
- [ ] `design/conversation-context-budget-meter.md` §9 — supersede the copy
      rules with this doc

## Impacted Contracts
- [ ] WSS protocol — none
- [x] SSE events — `agent.compaction_done.context_budget` gains additive fields
- [ ] DB schema — none
- [ ] Agent tools — none
- [x] Web UI — popover restructure; new dependency `@radix-ui/react-popover`

## Test Plan
- Service (`context-budget-state.test.ts`): synthetic conversation with one of
  each block type + a checkpoint summary → categories match expected tokens
  and sum to `estimated_input_tokens`; overhead attribution; empty
  conversation → all zeros. Snapshot test: `compaction_count` and
  `breakdown` present on `/agent/state` and on the post-compaction snapshot.
- Web (`context-budget-meter-state.test.ts`): rows sorted desc, merged
  categories, "Other" collapse, footer variants (estimated vs measured;
  compacted 0/1/N; compaction disabled), unknown/stale states.
- Manual: hover + click on desktop; tap on mobile Safari; long thread with
  heavy tool output shows tool output as the dominant segment.

## Rollout
- Service first (additive fields; old web ignores them), then web. No daemon
  involvement, no migration.
- Other clients reading `context_budget` (mobile handoff docs reference it)
  keep working; they can adopt `breakdown` later.

## Effort
- Service: breakdown function + tests + snapshot plumbing ≈ half a day.
- Web: presentation refactor + popover + tests ≈ half a day.
- Both land in one PR or two (service first) — either is fine since the
  fields are additive.
