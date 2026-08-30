# Plan: Web Agent-Work Collapse (Option B — progressive)

## Context
- Design (accepted): [`design/web-agent-work-collapse.md`](../design/web-agent-work-collapse.md)
- Mobile handoff: [`reference/mobile-agent-work-collapse-web-handoff.md`](../reference/mobile-agent-work-collapse-web-handoff.md)
- Related specs: `web/src/features/threads/threads.spec.md`,
  `web/src/components/workbench/workbench.spec.md`,
  `web/src/components/message-renderers/message-renderers.spec.md`,
  `web/src/lib/lib.spec.md`

## Objective

Assistant answers read top-level; each turn's reasoning, tool calls, and
intermediate assistant text live in one expandable work group. Live: the
group header shows `Working… · <elapsed> · <current step>` with only the
current step rendered beneath it; finished steps fold in as they complete.
Completed: the group collapses to `Worked for <duration>` (or `Worked`),
failure/cancel badges visible, expansion showing chronological items with
intermediate text as separators and per-item detail expansion.

Acceptance criteria:
- A completed thread shows: user → `Worked for X` → final answer, per turn.
- During a run the transcript height stays ~header + one step; the final
  answer streams with no wall of tool rows above it.
- Expanding a live group shows the full inline history (mobile-style view)
  until re-collapsed or the run ends.
- Raw messages are never mutated for presentation; expansion state is
  ephemeral, keyed by stable IDs, cleared on thread switch.
- No summary flicker between tool steps; exactly one fold per completed
  step; history prepend merges a split turn under the same group.
- Legacy rows (no `turn_id` / no timing) still group by contiguity and
  label `Worked` without a number.

Decisions locked (from design review):
- Live divergence from mobile: confirmed (Option B).
- Live groups are expandable.
- Desktop summary nesting is flat (items + intermediate-text separators; no
  nested count-summary level).
- Duration ships as mobile-parity interval union behind one pure function;
  backend-owned turn duration pursued separately as the convergence point.
- Thinking indicator survives only for the pre-first-work gap
  (`starting`/`thinking` with no work rows yet) and compaction.

## Design / Approach

Three PRs, each independently shippable; 1 and partially 2 are invisible.

### PR 1 — foundations: metadata, identity, projection (no visual change)

1. **Typed metadata accessors** — new `web/src/lib/agent-message-metadata.ts`:
   `getTurnId`, `getSegmentKind` (absent ⇒ `final`), `getMessageTiming`
   (`started_at`/`finished_at`/`duration_ms` only when
   `duration_source === "service_wall_clock"`), plus existing informal flags
   (`pending`, `draft`, `optimistic`) consolidated. Unit tests with real
   metadata shapes from `transcript-writer.ts`.
2. **Store identity fix** — `thread-message-state.ts`: `upsertMessage`
   preserves object identity for untouched messages and skips the re-sort
   when the upsert cannot change order (existing row, unchanged
   `created_at`). Extend `thread-message-state.test.ts` with identity
   assertions (unchanged rows are `===` across a delta).
3. **Projection** — new `web/src/features/threads/agent-work-projection.ts`:
   `projectTimeline(messages, liveTurnId) -> TimelineRow[]` per the design
   contract (`{kind:"message"}` | `{kind:"work", id:"agent-work:<turn_id>",
   sections, currentItem?, live, status, durationMs?}`).
   - Membership: `metadata.turn_id` match with roles reasoning/tool +
     intermediate assistant; contiguity fallback for rows without
     `turn_id` (legacy only).
   - `status`: ok | failed | canceled | no_final, derived from the final
     assistant row / final-event info the route already holds.
   - `currentItem`: the last work item of the live group when it is a
     draft/pending row (streaming reasoning, running tool); undefined once
     the run ends.
   - Per-group memoization on source-message object identities (depends on
     item 2).
4. **Duration** — new `web/src/lib/agent-work-duration.ts`: interval union
   over included work messages' `service_wall_clock` timings, legacy
   pure-tool sum fallback, else null (`Worked`). Pure, fixture-tested.
5. **Fixtures** — `web/src/features/threads/__fixtures__/agent-work/*.json`
   (platform-neutral): the adapted mobile conformance scenarios (design doc
   §Conformance), driven by a projection test that loads each fixture and
   asserts the projected shape. Shared with mobile later.

### PR 2 — rendering swap (the visible change)

1. **`AgentWorkGroup` component** — new
   `web/src/components/workbench/agent-work-group.tsx`:
   - Collapsed header: chevron, `Worked for X`/`Worked` or
     `Working… · <elapsed> · <step summary>`, failure/canceled badge.
     Elapsed ticker: 1 s interval mounted only while `live`.
   - Live body (collapsed): the `currentItem` rendered via the existing
     role/tool renderers (streaming reasoning markdown, tool row).
   - Expanded body: chronological sections — intermediate assistant
     markdown as separators, activity items as compact one-line headers
     (role icon, title/summary, status/duration chip) with per-item
     expansion mounting the existing full renderers lazily. Collapsed
     content is unmounted, not hidden.
   - Step summaries reuse the tool `summary` already present in tool
     payloads and first-line extraction for reasoning.
   - `aria-expanded`/`aria-controls` on both disclosure levels.
2. **Timeline integration** — `chat-timeline.tsx` renders
   `projectTimeline(...)` output: message rows unchanged (user, system,
   final assistant, question cards, compaction notices stay top-level);
   work rows render `AgentWorkGroup`. Keys: `client_id` for messages,
   `agent-work:<turn_id>` for groups.
3. **Expansion state** — route-level (`$threadId.tsx`): `workExpanded:
   Map<string, boolean>` + `itemExpanded: Set<string>`, pruned when IDs
   vanish, reset on thread change. Passed down as props.
4. **Structure token** — replace `scrollSyncKey` derivation with the
   projected visible structure: row IDs + live `currentItem` id + content
   length of *visible* streaming surfaces only. Hidden detail growth must
   not trigger bottom-follow.
5. **Live turn plumbing** — route passes `liveTurnId`
   (`agentState.active ? agentState.turn_id : null`, cleared by `final`).
6. **Thinking indicator** — shown only when the live turn has no work rows
   yet, or during compaction; the group header owns the rest.

### PR 3 — audit & polish

1. Reasoning/intermediate markdown: disable file-open/web-proxy affordances
   (new prop on `MarkdownContent`; final assistant unchanged).
2. Copy button on group rows copies nothing/summary only; per-item copy
   stays on expanded items.
3. Side-effect audit from the design doc: thread preview, attention
   markers, any reads of rendered rows — verify role/metadata based; fix
   stragglers.
4. Reduced-motion: fold/expand transitions honor `prefers-reduced-motion`.
5. Spec + docs updates (below), screenshots in PR description.

## Spec Files to Update
- [ ] `web/src/features/threads/threads.spec.md` (projection, fixtures,
      identity fix, structure token)
- [ ] `web/src/components/workbench/workbench.spec.md` (AgentWorkGroup,
      timeline integration, expansion state, indicator scope)
- [ ] `web/src/components/message-renderers/message-renderers.spec.md`
      (renderer reuse inside groups, markdown affordance split)
- [ ] `web/src/lib/lib.spec.md` (metadata accessors, duration function)
- [ ] `web/web.spec.md` (feature summary)

## Impacted Contracts
- [ ] WSS protocol — none
- [ ] SSE events — none (consumes existing events/metadata only)
- [ ] DB schema — none
- [ ] Agent tools — none
- [ ] Web UI — timeline presentation only; raw messages untouched

Cross-team notes (no dependency, fire-and-forget):
- Mobile: `turn_id` grouping recommendation + fixture location
  (`web/src/features/threads/__fixtures__/agent-work/`), and the live-mode
  divergence decision.
- Backend (future, separate design): turn-level work duration stamped by
  the service — both clients then delete their duration math.

## Test Plan
- Unit: metadata accessors; duration union (overlap, gap, legacy, absent);
  store identity preservation; projection over all JSON fixtures, including
  — no-flicker between tools (live turn held), one-fold-per-step, split-turn
  prepend merge, draft→canonical stability, run-without-final → `no_final`,
  legacy contiguity grouping, intermediate-text sectioning.
- Existing suites stay green (`assistant-activity-indicator-state`,
  `thread-message-state`, `thread-stream-timing`).
- Manual: live run on a real thread (codex-style multi-tool turn) checking
  header ticker, current-step swap, end-of-run fold, live expansion,
  bottom-follow through all transitions, history pagination across a turn
  boundary, thread switch clearing expansion.

## Rollout
- Web-only; ships with the normal Render deploy per PR merge. No daemon or
  service coordination (AGENTS.md §4.7 trivially satisfied).
- PR 1 is invisible; PR 2 is the UX change (screenshot/video in PR); PR 3
  closes the audit. No feature flag planned — PR 2 is revertable on its own
  if the treatment needs rework.
