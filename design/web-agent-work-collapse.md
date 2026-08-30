# Design: Web Agent-Work Collapse

**Status:** Accepted — Option B (progressive collapse), live divergence from
mobile confirmed (web is a different interface with different expectations).
Scoped in [`plan/web-agent-work-collapse.md`](../plan/web-agent-work-collapse.md).
**Created:** 2026-08-30
**Related:**
- [`reference/mobile-agent-work-collapse-web-handoff.md`](../reference/mobile-agent-work-collapse-web-handoff.md) (mobile's approach, reviewed below)
- [`design/agent-message-work-duration-contract.md`](./agent-message-work-duration-contract.md) (timing metadata contract)
- [`design/reasoning-messages.md`](./reasoning-messages.md)

---

## Problem

The web timeline renders every message as a top-level row: reasoning at full
height, every tool call fully expanded. A turn with a dozen tool calls makes
it hard to scroll between user messages and assistant answers. We want:

- assistant messages at the top level;
- reasoning + tool calls + intermediate assistant text collapsed into
  expandable "Worked for Nm Ss" sections (matching mobile's label);
- during streaming, the **current step visible live** while prior steps are
  collapsed down — live progress without inundation.

That last requirement is where we deliberately diverge from mobile (§Review).

## Current web pipeline (facts)

- **State**: one `useState<ApiMessage[]>` in `useThreadMessages`; identity is
  `client_id` everywhere (`thread-message-state.ts:3`); ordering by
  `created_at` with re-sort on every upsert. Draft→canonical reconciliation
  already exists per role: assistant drafts are replaced by the canonical
  `agent.message` row, reasoning drafts by `reasoning_done`'s row, optimistic
  user rows swapped by `reconcileMessagePersistence`. **Web already has
  stable per-message identity across streaming and persistence** — mobile's
  handoff question 1 is a yes at the store level.
- **Grouping handle mobile lacks**: every agent-produced row (draft and
  canonical) carries `metadata.turn_id`. Mobile infers groups from
  chronology + overlap matching; we can group by `turn_id` directly.
- **Run liveness**: `/agent/state` snapshot (`active`, `turn_id`, `phase` ∈
  idle/starting/thinking/tool_running/waiting_for_user/waiting_for_terminal/
  streaming_message) plus the `final` SSE event. A `final` **without**
  `message_id`/`text` is the "run ended with no final answer" signal
  (supersession/cancel/failure); on reconnect, `/agent/state.active: false`
  is the authoritative fallback (proto §2243).
- **Timing metadata already exists**: the service stamps
  `{ turn_id, started_at, finished_at, duration_ms, duration_source:
  "service_wall_clock" }` into `metadata` on tool rows, reasoning rows, and
  both intermediate and final assistant rows (`transcript-writer.ts`). Web
  parses none of it today (the terminal chip's `duration_ms` is a tool
  payload field, unrelated). Legacy rows may omit timing — clients must not
  invent estimates (proto §2231).
- **`segment_kind`**: service stamps `"intermediate"` (assistant text in a
  step that also produced tool calls) or `"final"`; web reads it in exactly
  one place (`isFinalAssistantMessage`, indicator gating). Absence = final,
  for legacy rows.
- **Rendering**: flat `.map` keyed by `client_id` in `chat-timeline.tsx`; no
  virtualization; row/timeline/`MarkdownContent` are `memo`'d but streaming
  upserts recreate the array and the row object each delta, so memoization is
  defeated during streams. Bottom-follow is driven by a `scrollSyncKey`
  derived from list length + last item's content length. Reasoning rows use
  the same `MarkdownContent` as assistant rows (file-open affordances
  included). The only collapse affordance today is the per-row JSON payload
  toggle.

## Review of mobile's approach

### What we should adopt as-is

1. **Canonical/presentation split**: raw messages never rewritten; grouping
   is a pure projection; expansion state is ephemeral UI state keyed by
   stable IDs. This maps cleanly onto our existing store + a `useMemo`
   projection.
2. **Final assistant stays top-level**, `segment_kind !== "intermediate"`
   classification, intermediate text as visible section boundaries inside
   the group.
3. **Boundary rows stay top-level**: user, system, final assistant,
   user-question cards, compaction notices flush/terminate a group.
4. **Liveness is not derived from individual tool statuses** (the
   between-tool flicker rule).
5. **Side-effect boundaries are role-based, not layout-based** (previews,
   read receipts, link affordances).
6. **Summary-mode shape and label**: collapsed `Worked for <duration>` /
   `Worked` row, failure/cancel badges visible while collapsed, final answer
   immediately after.
7. **Shared JSON fixtures** for grouping conformance (their near-term
   recommendation #1).

### Holes and web-specific disagreements

1. **Mobile's live mode does not solve our stated problem.** Mobile renders
   *every* reasoning/tool item inline (as compact headers) until the final
   answer completes, then collapses once. During a long run the transcript
   is still a wall of rows — exactly the "inundated" complaint — and the
   end-of-run collapse is a large one-shot height reduction they themselves
   list as a cost ("can still be a substantial height reduction"). Our
   requirement — current step visible, prior steps already tucked away —
   is a different live treatment. We should align on the **summary** shape
   and knowingly diverge on the **live** shape.
2. **Overlap-matching identity is over-engineered for web.** Mobile
   reprojects and re-derives group IDs by comparing source-turn-set overlap
   because their groups are inferred from chronology. We have
   `metadata.turn_id` on every agent row: group ID = `agent-work:<turn_id>`
   is stable by construction — across history prepends (the two halves of a
   split turn merge under the same ID when the older page loads, which
   overlap matching handles only heuristically), across draft→canonical
   swaps (store-level `client_id` stability), and across live→summary. We
   only need a chronology fallback for legacy rows missing `turn_id`.
   Recommendation back to mobile: adopt `turn_id` grouping too; it deletes
   their hardest projector code, and it answers their own known limitation
   ("an explicit backend agent-run ID would be more robust" — it exists, in
   message metadata, today).
3. **Duration union undercounts perceived time.** Union-of-
   `service_wall_clock`-intervals excludes the gaps *between* messages —
   which are mostly provider calls (the model deciding the next step),
   often the majority of a run's wall time. A run the user watched for five
   minutes can label itself "Worked for 1m 40s". Mobile's warning against
   first-to-final wall time conflates two things: including the final
   answer's streaming (agreed, exclude it) and counting pauses (those
   pauses *are* work from the user's perspective). Options in
   §Duration below; whichever we pick, both clients should pick it
   together, and their own recommendation — a backend-owned turn duration —
   is the real fix (`started_at` of the first work message to `started_at`
   of the final message, stamped once by the service, no client math).
4. **"Client-side active-work display state" is a heuristic we don't
   need.** Web has an authoritative signal: the group for `turn_id` T is
   live iff `/agent/state.active && state.turn_id === T` (with the `final`
   event and reconnect-time `active: false` as the close signals). No
   gap-timer heuristics; conformance scenario 2 (no summary flicker between
   tools) is satisfied by construction.
5. **No expansion during live is a desktop regression.** Mobile forbids
   expanding items while the group is live. Web users today watch full tool
   output stream; taking that away with no opt-in is a step backward on a
   40-inch monitor. The live group (whatever option below) should be
   expandable while live — expansion just opts that group out of
   auto-collapse behavior until the run ends.
6. **Two-level completed disclosure is one level too many for desktop.**
   Group → "2 tool calls and 1 reasoning step" count row → items → item
   detail is four clicks to see one tool result. On web, expanding the
   group should directly show the chronological item headers (intermediate
   assistant text as separators, per mobile), with per-item expansion for
   detail. We keep mobile's outer contract (group id, source ids, sections)
   so fixtures for *grouping* stay shared; the nesting depth is
   presentation, and may legitimately differ per platform.
7. **Web-only concerns absent from the mobile doc** (expected — it's a
   mobile doc — but they gate our implementation):
   - **Find-in-page / text selection**: collapsed content is invisible to
     Ctrl+F. Acceptable (browsers have trained users via `<details>`), but
     we should render collapsed content as unmounted, not `display:none`,
     deliberately — and say so.
   - **Accessibility**: disclosure buttons need `aria-expanded`/
     `aria-controls`; the live region for streaming updates must not
     re-announce the whole group per delta.
   - **Bottom-follow key**: `scrollSyncKey` currently includes the last
     item's `content.length` — hidden detail growth inside a collapsed
     group must not count as a visible structural change (mobile's
     "structure token" point, which we endorse). The key must be derived
     from *visible* structure post-projection.
   - **Streaming perf is a prerequisite, not a side quest**: our row memo
     is already defeated on every delta. Collapsing groups shrinks the DOM
     but the projection must not recompute/re-render all rows per delta
     either — see §Performance.
   - **Reasoning markdown affordances**: mobile disables file-reference/
     web-proxy actions in reasoning and intermediate text; web's reasoning
     renderer currently reuses the assistant `MarkdownContent` with file
     affordances enabled. Align while we're here.
8. **Minor**: the handoff references `plan/agent-work-collapse-ui/phase-8…`
   which doesn't exist in this repo; the equivalent contract is
   `design/agent-message-work-duration-contract.md` and
   `plan/message-duration-metadata/`. Their fixture paths will need the
   same translation.

## Design options — live treatment

The summary (completed) state is the same in all options: one collapsed
`Worked for <duration>` row per turn, badges for failed/canceled, expanding
shows chronological items with intermediate assistant text as separators,
final answer top-level after the group. The options differ in what renders
**while the run is live**.

### Option A — Mobile parity

All reasoning/tool items render inline as compact headers, chronological, no
group chrome; one collapse when the final answer completes.

- Pros: maximum cross-client consistency (shared live fixtures too);
  single reflow; proven on iOS.
- Cons: does not address the live-inundation complaint; the end-of-run
  collapse is a large height change needing scroll anchoring; long runs
  still scroll poorly *while running*.

### Option B — Progressive collapse (matches the stated requirement)

The work group's chrome exists from the first work item of the turn. Its
header is live: `Working… · <elapsed> · <current step summary>` (e.g.
"Running terminal.send", "Thinking…"). Beneath the header, **only the
current step** renders live — streaming reasoning text, or the active tool
row with its status. When a step completes and the next begins, the finished
step folds into the (collapsed) group body; the current step replaces it.
When the run ends: header becomes `Worked for X`, the last step folds in,
and the final answer streams top-level below it.

- Pros: directly implements "show the current step before collapsing it
  down"; transcript height during a run is bounded (~header + one step);
  the end-of-run transition is tiny (one step folds), so scroll anchoring
  is nearly free; the final answer streams without a wall of tool rows
  above it.
- Cons: diverges from mobile's live treatment (shared fixtures cover
  grouping + summary only); per-step folding is exactly the repeated
  structural change mobile avoided for perf/steadiness — mitigated because
  each fold removes one *compact* row at the bottom of the viewport where
  bottom-follow absorbs it, not a mid-transcript reflow; users lose ambient
  visibility of what already happened unless they expand (chevron on the
  live header opens the full inline history, mobile-style, for that run).

### Option C — Compact trail

Like B, but completed steps remain visible as one-line compact headers under
the group header (newest N, e.g. 3, with `+k earlier steps` above them), and
the whole trail collapses once at the end.

- Pros: ambient progress history without expansion; still bounded height;
  closer to mobile's live spirit.
- Cons: two visual regimes to tune (trail cap + final collapse); the final
  collapse is mid-size (N rows + header) so anchoring matters again; more
  moving parts than B for marginal benefit over B-with-expansion.

**Recommendation: Option B**, with the live-expandable escape hatch from
review point 5 (expanding the live group shows the full inline history —
which is exactly Option A's view — until the run ends or the user
re-collapses). This gives the calm default the request asks for and the
power-user view for free, and it makes A's treatment a degenerate state of
B rather than a separate mode.

## Design options — duration label

1. **Mobile-parity union**: union of `service_wall_clock` intervals of
   included work messages (overlaps counted once, final answer excluded),
   with mobile's fallback ladder. Pros: identical numbers on both clients
   today. Cons: undercounts perceived time (review point 3); the ladder is
   the most intricate part of their spec.
2. **Work-span**: `min(started_at)` → `max(finished_at)` over included work
   messages (final answer still excluded). Pros: matches perceived elapsed
   time; trivial. Cons: diverges from mobile until they adopt it; counts
   waiting-for-user time inside a run (arguably correct — the label is
   "worked for", and terminal waits already count in both schemes).
3. **Backend-owned turn duration** (their recommendation #3, our
   endorsement): service stamps a turn-level work duration (first work
   message start → final answer start) on the final message's metadata or a
   turn record; both clients render it verbatim.

**Recommendation**: implement the computation behind one small pure function
(`lib/agent-work-duration.ts`) with fixtures; ship **option 1** for
cross-client consistency now; raise option 3 with backend + mobile as the
convergence point (it deletes both clients' math). Show `Worked` with no
number when no trustworthy metadata exists (legacy rows), never an
estimate.

## Projection contract (all options)

Pure function, `useMemo` over `(messages, agentState, finalEventInfo)`:

```text
projectTimeline(messages, liveTurn) -> TimelineRow[]
  TimelineRow =
    | { kind: "message", message }                    // user/system/final assistant/questions/compaction
    | { kind: "work", id: "agent-work:<turn_id>",
        turnId, sourceClientIds[],
        sections: (intermediateText | activityItem)[],
        live: boolean,                                 // liveTurn === turnId
        currentItem?: activityItem,                    // live only
        status: "ok" | "failed" | "canceled" | "no_final",
        durationMs?: number }
```

- Membership: rows whose `metadata.turn_id` matches, with roles
  reasoning/tool, plus assistant rows with `segment_kind === "intermediate"`.
  Legacy rows without `turn_id`: contiguous-chronology fallback (mobile's
  rule), applied only to pre-metadata history.
- `live` comes from `/agent/state.active && state.turn_id`, closed by
  `final` (any status) — no per-item heuristics.
- Expansion state: route-level maps keyed by the row/item IDs above
  (`workExpanded: Map<string, boolean>`, `itemExpanded: Set<client_id>`),
  pruned when IDs disappear, cleared on thread switch. Never persisted.
- Bottom-follow key: derived from projected *visible* structure (row IDs +
  live currentItem ID + streaming text length of visible rows only).

## Performance notes

- The projection must be incremental-friendly: memoize per-group section
  arrays on the underlying message object identities so an unrelated delta
  doesn't rebuild every group. Prerequisite fix: `upsertMessage` should
  preserve object identity for untouched messages and skip the re-sort when
  order can't change (it already can't for an in-place content append) —
  this is worth doing regardless of this feature, since it currently
  defeats every row memo during streams.
- Collapsed groups render only their header from the projection row;
  equality for the header ignores hidden detail (mobile's collapsed-row
  equality rule). Expanded detail mounts lazily (unmounted when collapsed,
  which also settles the find-in-page stance explicitly).
- The streaming surfaces (final assistant markdown; the live current step)
  keep their own narrow render paths so token deltas touch one row.
- Virtualization stays out of scope: collapse reduces DOM per turn from
  O(items) to O(1) collapsed / O(items) only when expanded, which is the
  cheaper 90% of virtualization's win.

## Side-effect audit (web)

Before shipping, verify these read raw roles/metadata, not rendered rows:
- thread list preview text (must ignore reasoning/intermediate);
- unread/attention markers (`attention_kind` on final rows);
- `scrollSyncKey` (must move to the projected structure token);
- copy button semantics per row (collapsed group header should copy nothing
  or the summary, not hidden content);
- reasoning/intermediate markdown: disable file-open/web-proxy affordances
  (align with mobile's action-semantics split);
- the thinking indicator: in Option B the live group header largely
  supersedes it — decide whether the indicator remains only for the
  pre-first-work gap (`starting`/`thinking` before any row exists).

## Conformance fixtures

Adopt mobile's scenario list (§Minimum Web Conformance Scenarios) with
these amendments: scenarios 2 and 6 are satisfied by the authoritative
live-turn signal rather than gap heuristics (test that instead); scenario 4
("final assistant streaming keeps all prior work inline") applies only to
Option A / the expanded-live state — under Option B the equivalent
assertion is "final assistant streaming does not disturb the collapsed
group"; scenario 10 (history prepend) should assert turn_id-merge, which is
stronger than ID reuse. Fixtures live in `web/src/features/threads/
__fixtures__/agent-work/` as language-neutral JSON so mobile can consume
them (their open question 5).

## Answers to mobile's questions for web

1. *Canonical identity across draft/persisted?* Yes — `client_id` at the
   store level, with existing reconciliation paths per role.
2. *Active-run signal during tool gaps?* `/agent/state.active + turn_id` and
   the `final` event; no heuristics needed.
3. *Scroll anchoring across the live→summary reduction?* Under Option B the
   reduction is one compact row; the existing prepend anchor-restore
   pattern covers the expanded-live case.
4. *Hidden-detail isolation?* Yes, via projection-row equality + lazy mount;
   requires the `upsertMessage` identity fix first.
5. *Fixture location?* `web/src/features/threads/__fixtures__/agent-work/`
   (JSON, platform-neutral).
6. *Any side effect based on rendered position?* One: `scrollSyncKey` uses
   the last rendered item's content length; it moves to the projected
   structure token as part of this work.

## Open questions (for Adam / mobile / backend)

1. Live treatment: confirm Option B (progressive, current-step-only) over
   mobile-parity A — this is the one deliberate cross-client divergence.
2. Duration: ship mobile-parity union now and pursue the backend-owned turn
   duration, or jump straight to work-span and ask mobile to follow?
3. Should expanding a *live* group be allowed (we say yes on web)?
4. Desktop summary nesting: flat items with text separators (we say yes) vs
   mobile's nested count-summary level?
5. Does the thinking indicator survive as the pre-work placeholder only?
