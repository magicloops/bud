# Design: "Full" transcript mode — seeing (and later editing) what the model sees

Status: Approach B implemented 2026-09-03 (plan/model-view-transcript-mode.md); prompt overrides (§4.D step 2) deferred

Audience: Web, service (agent / routes), mobile (contract awareness)

Last updated: 2026-09-03

Related docs:

- [web-agent-work-collapse.md](./web-agent-work-collapse.md) — how the transcript groups intermediate work today
- [runtime-context-append-only-prompts.md](./runtime-context-append-only-prompts.md) — runtime (developer-style) messages and their replay level
- [context-compaction.md](./context-compaction.md) — checkpoint replacement history
- [prompt-management.md](./prompt-management.md) / [llm-prompt-files.md](./llm-prompt-files.md) — prompt files (Option 1 of prompt-management is what shipped: one markdown file)
- [plan/context-popover-breakdown.md](../plan/context-popover-breakdown.md) — the per-category token breakdown the full view can reuse per block

## 1. The ask

A toggle between the **standard** transcript and a **full** view that shows
everything the model is given: the system prompt at the top, any
system/developer messages in the middle (none persisted today, but runtime
instructions and compaction summaries are injected there), and every
intermediate assistant message, reasoning summary, tool call and tool result
expanded. Later: let users **modify** the system prompt.

## 2. Current architecture — the facts that constrain the design

### 2.1 What is durable, per thread (`message` table)

`service/src/db/schema.ts` — roles `user | assistant | tool | system | reasoning`,
free-form `metadata`. What the agent actually writes:

| Row | Written by | Notes |
| --- | --- | --- |
| `user` | messages route | `metadata.preferred_cwd` becomes a `[Preferred CWD: …]` suffix **only in the model view** (loader), not in the transcript. |
| `assistant` | agent loop | `metadata.segment_kind: "intermediate"` for commentary between tool calls; `turn_id`, `llm_call_id`. |
| `tool` | agent loop | Content is a JSON **directive** (`{ tool, call_id, command… }`) plus the result; the loader synthesizes a canonical `tool_use` block and a `tool_result` block from it. Retired tools (`terminal.run`) are remapped on replay. |
| `reasoning` | agent loop | `model_visible: false`; shown to the browser, **never replayed** to the model. |
| `system` | **nobody** | The enum allows it; no service code path inserts one. The web hides the role anyway unless `VITE_SHOW_SYSTEM_MESSAGES`. |

Beside the transcript: the **provider ledger** (`llm_call`, `llm_call_item`)
stores per-call *output* items and tool-result *input* items plus an
`input_fingerprint` — not a snapshot of the whole request. And
`agent_context_checkpoint` stores the **replacement history** a compaction
produced (summary as a `user` message with `CHECKPOINT_SUMMARY_PREFIX`,
recent real user messages, terminal context), with `system` rows excluded.

### 2.2 What the model sees that is *not* durable

Built at request time by `AgentConversationLoader.loadWithDiagnostics`
(`service/src/agent/conversation-loader.ts`) and `applyRuntimeInstructions`
(`agent-service.ts`):

1. **Base system prompt** — `service/src/agent/default-system-prompt.md`,
   31.7 KB (~8k tokens), read once at boot into `AGENT_SYSTEM_PROMPT`,
   prepended as the first `system` message of **every** thread. Identical
   across threads and users by construction — which is also why the provider
   prompt cache prefix is shared across threads.
2. **Runtime instructions** — a second `system` message inserted right after
   the base prompt, currently only when the bud is offline (~100 tokens;
   `environment.ts`). Not persisted. The append-only design recommends
   moving these to the tail; either way they are "developer messages in the
   middle" in spirit.
3. **Checkpoint replacement history** — after a compaction the loader emits
   `[system prompt] + replacement history + rows after the boundary`. The
   transcript keeps showing the whole visible history; the model sees a
   summary the user has never seen (the compaction *notice* deliberately
   omits it: "never includes raw checkpoint summaries").
4. **Tool schemas** — `AGENT_CANONICAL_TOOLS` descriptions/params, rendered
   into the prompt root by every provider; ~1.6k tokens.
5. **Provider-ledger replay** — for same-provider turns, assistant output is
   replayed from ledger items (reasoning items, phases) rather than transcript
   rows; the transcript shows the canonical fallback text.

So "what the model sees" is **deterministically reconstructible from durable
state** (the loader is the single source of truth), but it is **not stored**
anywhere as a document, and it diverges from the transcript in at least the
five ways above.

### 2.3 What the browser gets and renders

- `GET /api/threads/:id/messages` returns every stored row (all five roles),
  cursor-paginated, owner-scoped (`routes/threads/messages.ts`,
  `serializeMessage`).
- `chat-timeline.tsx` filters `system` unless the debug flag is on, then runs
  `projectTimeline` (`features/threads/agent-work-projection.ts`): rows with
  the same `turn_id` and role `reasoning`/`tool`, plus intermediate assistant
  text, fold into one collapsible **work group**; final assistant text, user
  rows, questions and compaction notices stay as message rows. Expansion is
  route-level state keyed by row/item id, never persisted
  (`expandedWork`, `expandedItems`).
- `/agent/state.context_budget` now carries a per-category token
  `breakdown` computed by `estimateCanonicalMessagesBreakdown` over the
  loader output — the same walk a full view would need per block.

### 2.4 Related, already-decided constraints

- Ownership: every browser read goes through `getAuthorizedThread`; `404` for
  non-owners (AGENTS.md §4.6).
- Mobile consumes the same messages contract and hides its own roles;
  anything that adds new row kinds to the transcript must be ignorable.
- Prompt-management design chose "prompt as a markdown file"; there is no
  prompt versioning, registry, or per-user/per-thread override today.

## 3. Requirements distilled

| # | Requirement | Standard view | Full view |
| --- | --- | --- | --- |
| R1 | System prompt visible at the top | no | yes |
| R2 | Mid-transcript system/developer messages visible (runtime instructions, checkpoint summary) | no | yes |
| R3 | All intermediate commentary / reasoning / tool calls expanded | collapsed groups | expanded |
| R4 | Toggle between the two, per thread, cheap to flip | — | — |
| R5 | Accurate: reflects what the *next* request will contain (post-compaction, offline mode, CWD suffix, retired-tool remaps) | n/a | should |
| R6 | Future: modify the system prompt (per thread and/or per user), and the full view reflects the edit | — | — |
| R7 | Owner-only; no new global reads; mobile unaffected | — | — |

R3 alone is a client-only change. R1/R2/R5 need data the browser cannot
get today. R6 needs a place to *store* an edit and a loader that honors it.

## 4. Approaches

### A. Client-only "expand everything" + a static prompt fetch

- Add a transcript toggle that (1) expands all work groups/items, (2) stops
  hiding `system` rows, (3) renders the base prompt from a new tiny
  `GET /api/agent/system-prompt` (static text, authenticated).
- Pros: an afternoon; no loader involvement; satisfies R1 (top) and R3.
- Cons: fails R2 and R5 — no runtime instructions, no checkpoint summary,
  no post-compaction truncation, no CWD suffix, no ledger-vs-transcript
  differences. It shows "the transcript plus a prompt", not "what the model
  sees", and would mislead exactly when users care most (after compaction).
  Offers nothing for R6.

### B. Server-side "model context" document (virtual, read-only)

New owner-scoped endpoint, e.g.
`GET /api/threads/:id/model-context`, that runs the **same** loader path the
agent uses (`loadWithDiagnostics` with the thread's provider/model/reasoning,
then `applyRuntimeInstructions` with the current environment) and returns
the canonical messages annotated with provenance:

```jsonc
{
  "model": "gpt-5.6-sol",
  "provider": "openai",
  "generated_at": "...",
  "compacted_through_message_id": "…" | null,
  "tools": [{ "name": "terminal_run", "description": "…", "parameters": {…} }],
  "messages": [
    { "index": 0, "role": "system", "source": { "kind": "system_prompt", "version": "<sha>" },
      "content": [{ "type": "text", "text": "…" }], "estimated_tokens": 7900 },
    { "index": 1, "role": "system", "source": { "kind": "runtime_instruction" }, … },
    { "index": 2, "role": "user", "source": { "kind": "checkpoint_summary", "checkpoint_id": "…" }, … },
    { "index": 3, "role": "user", "source": { "kind": "message", "message_id": "…", "client_id": "…" }, … },
    { "index": 4, "role": "assistant", "source": { "kind": "ledger", "llm_call_id": "…" }, … }
  ],
  "context_budget": { …same snapshot as /agent/state… }
}
```

- `estimated_tokens` per message comes from the existing breakdown
  estimator; the `source` field is the only new plumbing — the loader
  already knows where each message came from (row vs ledger vs checkpoint)
  but currently discards it; add an optional provenance side-channel to
  `LoadedConversation`.
- Web: a **Model view** rendering mode for the transcript pane (not a new
  pane): monospace, role-labelled blocks in exact order, no grouping, long
  tool results clamped with "show all", per-block token count, a banner
  when compaction has replaced history ("History before X was replaced by
  this summary"). Read-only. Refetch on `final`/compaction events; while a
  turn is active, show stale + refresh.
- Pros: **exactly R5** — one source of truth, always accurate, including
  future prompt edits (R6 falls out for free once the loader honors an
  override). No migration, no new rows for mobile to ignore, additive API.
  The transcript's own pipeline is untouched.
- Cons: a single document up to the compaction budget (~272k tokens,
  ~1 MB JSON for Sol) — needs lazy rendering / virtualization and probably
  server-side clamping of tool outputs (return `preview` + `bytes`, fetch a
  block on demand) rather than pagination, since the view is only meaningful
  as a whole. Also not "live" mid-turn (the standard view is).
- Product question to settle: this exposes the 32 KB system prompt verbatim
  to every signed-in user. That is the stated intent, but it is a decision.

### C. Persist prompt/developer messages as transcript rows

Write the base prompt (or a reference to a stored prompt version) and
runtime instructions into `message` as `system` rows with
`metadata.kind`, so the ordinary transcript pipeline carries them and "full
mode" is just un-hiding + expand-all.

- Pros: one pipeline; live via SSE like everything else; paginates with the
  rest; a natural home for per-thread edits (an edited prompt is a new
  version row).
- Cons (substantial):
  - **Duplication or indirection**: 32 KB per thread, or a
    `prompt_version` table plus a reference row that the loader must
    resolve; every loader/compaction/budget path learns a new row kind.
  - **Semantics change**: today all threads pick up a redeployed prompt
    immediately; persisted rows pin threads to the prompt they started with
    unless a "current version" pointer is followed anyway — at which point
    the row is decorative.
  - **Compaction & budget**: checkpoint replacement history excludes
    `system` on purpose; the boundary math, the checkpoint summary row, and
    the breakdown categories all need care so a stored prompt row is not
    replayed twice or counted twice.
  - **Still not R5**: the CWD suffix, retired-tool remaps, ledger replay and
    the post-compaction truncation are loader behaviors, not rows. The
    transcript would show more, but still not what the model sees.
  - Mobile and older web must ignore the new rows (they hide `system`
    today, so this is survivable, but it is a contract change).

### D. Hybrid (recommended): B for viewing, an override table for editing

1. Ship **B** as the full view. It is the only approach that meets R5, and
   it is additive.
2. For R6, add durable **prompt overrides** that the loader reads *before*
   falling back to the file:
   - `agent_prompt_override` — `override_id`, scope (`thread` | `user`),
     `thread_id?`, `user_id`, `system_prompt` (text), `base_version`
     (sha of the file it was derived from), `created_by_user_id`,
     `tenant_id`, timestamps; unique per scope target.
   - Loader precedence: thread override → user override → file.
   - `GET/PUT/DELETE /api/threads/:id/system-prompt` (and later
     `/api/me/system-prompt`), owner-scoped; `PUT` validates size (cap at,
     say, 64 KB) and stores `base_version` so the UI can show "edited from
     v<sha>, file has since changed".
   - The full view's `source.kind: "system_prompt"` gains
     `override: { scope, override_id }` so the UI can badge it and offer
     Reset. No transcript rows, no compaction interplay (system is already
     excluded from replacement history), no mobile impact.
   - Trade-off to state in the UI: a per-thread edit forfeits the
     cross-thread prompt-cache prefix for that thread (its prefix is now
     unique). That is fine; it just should not be a surprise.
3. Keep the tool schemas and the compaction prompt fixed (not editable) in
   this pass; they are shown read-only in the full view.

### Comparison

| | A client-only | B model-context doc | C persisted rows | D = B + overrides |
| --- | --- | --- | --- | --- |
| R1 prompt at top | yes (static) | yes | yes | yes |
| R2 mid-transcript system/dev | no | yes | partial | yes |
| R3 expand all | yes | yes (no grouping) | yes | yes |
| R5 accurate model view | no | **yes** | no | **yes** |
| R6 editing path | none | none by itself | natural but heavy | **clean** |
| Live mid-turn | yes | refresh on events | yes | refresh on events |
| Migration / schema | none | none | new row kinds (+ maybe table) | one small table, later |
| Mobile impact | none | none | must ignore rows | none |
| Effort | ~½ day | ~2 days (endpoint ½, web 1½) | ~4 days + risk | B + ~1½ days later |

## 5. UI sketch (for B / D)

- **Toggle**: a two-state control in the top bar next to the view tabs —
  `Chat | Model` — state per thread in session memory (not persisted; like
  expansion state). Also reachable from the context popover footer ("View
  what the model sees"), which is where users already look when they wonder
  about context.
- **Model view** replaces the transcript pane content (composer stays; the
  send button ring still works). Layout: one block per message in exact
  order, a left rail colored by the breakdown palette (system purple, user /
  assistant pink, tool calls orange, tool output cyan, reasoning green,
  checkpoint summary gray), a sticky mini-header with role + `source` badge
  + token count. Long tool outputs clamp at ~40 lines with "show all";
  images show as thumbnails. The tools list renders as a collapsed block at
  the top ("7 tools · 1.6k tokens").
- **Compaction banner** at the position of the checkpoint summary:
  "History before &lt;time&gt; was replaced by this summary (N messages)".
- **Freshness**: header shows "as of &lt;time&gt;"; while a turn is active a
  "Refreshing when the turn ends" note; the doc refetches on `final` and on
  `agent.compaction_done`.
- **Expand-all in Chat view** (the cheap part of R3) can ship independently
  as a small toggle on the transcript header; the full view does not need
  it.

## 6. Ownership & safety

- The endpoint resolves the thread via `getAuthorizedThread`; non-owners get
  `404`; no listing. Contents are already owner-visible (tool outputs) plus
  the base prompt (decision above).
- Overrides (D.2) are stamped `created_by_user_id`/`tenant_id`, resolved
  owner-only, and never merged across users. Add both paths to
  `plan/init-auth/validation-checklist.md`.
- The model-context response must never include provider secrets or raw
  provider request bodies — only canonical messages, which is what the
  loader produces anyway.

## 7. Rollout

- Service: additive endpoint (+ later, additive table + routes). Web:
  additive mode. Either deploy order works; the web can hide the toggle when
  the endpoint 404s. No daemon involvement.
- Mobile: nothing to do for B; can adopt the endpoint later.

## 8. Test plan (for B)

- Service: the endpoint returns exactly `loadWithDiagnostics(...)` +
  runtime instructions for a fixture thread (pre- and post-compaction);
  provenance kinds cover system prompt, runtime instruction, checkpoint
  summary, message, ledger; per-message tokens sum to the budget snapshot's
  `message_estimated_tokens`; non-owner → 404; size clamping of tool outputs.
- Web: renderer snapshot for each block kind; token/legend alignment with
  the popover palette; toggle state resets on thread switch; stale/refresh
  behavior on `final` and compaction events.

## 9. Open questions

1. Expose the base prompt verbatim to all users? (Intent says yes; confirm.)
2. Thread-scoped, user-scoped, or both for overrides in the first editing
   pass? Recommendation: thread first (smallest blast radius, easiest to
   reason about with compaction), user default second.
3. Should the model view include the exact provider rendering (chat
   template) for local models? Out of scope; canonical is enough.
4. Live mid-turn model view: worth it, or is "refresh at turn end" fine?
   Recommendation: refresh at turn end; the standard view is the live one.
