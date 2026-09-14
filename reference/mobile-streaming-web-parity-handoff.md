# Web handoff: current mobile streaming and transcript behavior

Date: September 13, 2026. Status: implementation handoff; no web code changed.
Mobile baseline: `58532ac` on main, including history reconciliation PR #44 and
scroll performance PR #45. Web source reviewed at `bca9c09` in the main repository.

Implementation scope and acceptance criteria: [web parity plan](../plan/web-mobile-streaming-parity.md).

## Purpose and authority

Bring web to the **current** mobile interaction contract, using React and browser
layout primitives rather than translating SwiftUI infrastructure literally.
This document supersedes the presentation recommendations in
[the August handoff](mobile-agent-work-collapse-web-handoff.md). In particular,
serial live tool rows, disabled live disclosure, idle-means-summary, and missing
classification-means-final are not the target behavior anymore.

Mobile sources of truth:

- [Presentation flow](../../bud-mobile/design/mobile-presentation-flow.md).
- [Stable work sections](../../bud-mobile/plan/stable-in-progress-work-sections.md).
- [Disclosure and viewport intent](../../bud-mobile/plan/disclosure-viewport-intent.md).
- [History reconciliation and its limits](../../bud-mobile/plan/history-refresh-reconciliation.md).
- [Scroll measurement publication](../../bud-mobile/plan/scroll-measurement-publication.md).
- [Spinner/text layout findings](../../bud-mobile/debug/spinner-text-handoff-jitter.md).

Sibling-repo links assume `bud` and `bud-mobile` share a parent directory. The
mobile main commit above provides a reproducible baseline if checking out elsewhere.
Use [the shared output-activity design](../design/assistant-output-activity.md)
and [wire protocol](../docs/proto.md) for service event definitions.

## The experience to reproduce

During a run:

```text
User message
Assistant commentary (streams immediately)
[cpu/tool icon] Latest action title                 9  ▸
More assistant commentary (streams immediately)
[cpu/tool icon] Latest action title                 3  ▸
Final answer (streams; preceding work remains visible)
```

Each consecutive stretch of reasoning/tool calls occupies **one collapsed section
from its first item**. New items change its title/icon/count, not its height or
view type. Commentary closes that section's membership and starts a text row;
it does not suddenly collapse a stack of previously visible calls.

After the nonempty, explicitly classified final answer finishes streaming:

```text
User message
Worked for …                                       ▸
Final answer
```

Opening Worked for shows commentary interspersed with the same activity sections.
If there is no commentary, show the compact individual activity rows directly,
without a redundant section disclosure. Individual full details remain collapsed
unless the user opens them. No empty Worked for row for a final-only response.

### Disclosure and identity

- Sections show the most recently introduced item's friendly title and icon plus
  the total unique tool/reasoning count. Results/deltas/replay do not increment it.
- A late result from an earlier parallel call must not replace the latest title.
  Preserve aggregate active/error status; the latest item finishing is not proof
  that the whole section finished. Use `Cpu` for reasoning, not `Brain`.
- Use one concise title, stable icon/count space, truncation and accessible labels.
  Keep meaningful terminal summaries (command, input gesture, observation), not
  generic “Tool”/“Typed text” labels when structured inputs provide better context.
- Live sections are expandable. Expanded sections reveal compact individual rows;
  item detail is another explicit disclosure. Preserve choices through new items,
  commentary, canonical acknowledgement and metadata changes.
- Opening a live section must **not** pre-open the future Worked for disclosure.
  The first completed-final transition folds the outer work once. Later user
  choices survive refresh/replay; preserve inner choices when reopening it.
- Keep stable message/section/group keys across draft completion and pagination.
  Never key a section by its latest item, count, array position or text length.
- Questions, pending approvals and compaction keep their existing semantic
  boundaries. Do not hide a required decision or group across it just to create
  one enclosing work row. Completed approval tools may return to ordinary work
  according to their canonical semantics.
- Idle, stopped, failed, disconnected or missing-final work stays unfolded and
  inspectable. Unfolded does not mean running: it must not keep the spinner alive.
- Preserve existing duration calculation: included work excludes the final answer;
  overlapping authoritative intervals are not double-counted. Use “Worked” when
  no trustworthy duration exists. This is not a timing redesign.

## Spinner, final classification and layout

Keep a single response-progress indicator governed by normalized service facts,
independent of disclosure state or whether a renderer has painted.

| Situation | Behavior |
| --- | --- |
| Local optimistic send | Insert user message and reserve the response line together; reveal spinner after the existing 150 ms grace if still eligible |
| Active pending/leased/running work, `working` | Progress eligible, including gaps after commentary and between tools |
| `text` | Render arriving text immediately; hide spinner |
| `awaiting_completion` | Keep text visible, hide spinner while final/intermediate classification settles |
| Explicit human/terminal wait | Preserve the existing wait affordance; no generic thinking spinner |
| Completed final, stopped/failed inactive run | No response spinner; preserve answer/work and truthful status |

Use existing compaction-specific progress rather than adding a second indicator.
Scope activity to the correct thread/turn/model call, reject late clears and
snapshots overtaken by live events, and reset on lifecycle changes. Providers
(OpenAI, Claude, local) use the same normalized contract; no provider-name branches.
A completed message is not necessarily a final answer. Final folding requires
explicit final classification, completion and nonempty content; silence, the last
currently known row, an idle snapshot, or missing metadata cannot establish it.
Apply completion text and classification together without waiting for a later
REST refresh. Keep the final Markdown host/key through streaming and completion.

Reserve **one shared response line**, not spinner height plus text height. Let
arriving content consume the reservation; assistant text retains a one-line
minimum through completion. Prefer a CSS line-height-based minimum and a small
local layout owner. Match typography, zoom and wrapping; do not copy an iOS point
constant. Account for row margins/padding as well as line boxes. Clear transient
reservation on waits/end/reset and invalidating layout changes. No permanent blank
footer or new empty permission container. Existing accepted page/composer spacing
is not otherwise being redesigned.

Do not animate height from zero after the grace, remove the spinner's space before
text appears, or swap Markdown implementations on completion. Completed Markdown
inside a newly opened disclosure must have its content available at first layout,
not render empty and populate on a later effect. Async images/diagrams can still
resize; normal follow/inspection policy must handle that honestly.

## Scroll intent and performance

Separate physical proximity to bottom from the user's intent to follow.

1. Normal following keeps new text and late content resizing visible. Offset-only
   measurements do not themselves request a bottom scroll.
2. Before any manual disclosure changes height, enter transient inspection and
   cancel pending follow requests. Include outer work, activity sections, item
   details, Show more, and other transcript disclosures.
3. While inspecting, accept/render new data and measure geometry but suppress
   automatic bottom corrections, including those from ResizeObserver or queued
   animation frames. Recheck intent when deferred work actually executes.
4. Passive resize/native clamping near bottom does not resume following. A deliberate
   scroll ending near bottom, Jump to latest, a new send, or a new thread lifecycle
   does. Focus alone, refresh, reconnect and final completion do not end inspection.
5. Offer Jump to latest when inspecting away from bottom even without unseen output.
   Respect selection and manual scrolling. Reset/cancel old work on thread switch.
6. Preserve the inspected anchor when work folds or older history prepends; use the
   containing Worked for row if a folded child disappears. First test native browser
   anchoring with automatic corrections disabled. Add explicit anchor compensation
   only if that test demonstrates a remaining problem; do not run competing systems.

Keep raw offsets in refs/ordinary state and publish only changes needed by UI or
follow decisions. Do not send every scroll sample through transcript-wide React
state or changing context/callback values. Preserve every measurement needed for
idle decisions; this is not event dropping or a new throttle. Keep Markdown token
updates local and avoid formatting full hidden tool payloads just to display a title.

Mobile's device regressions passed and scrolling was accepted. Trace comparisons
showed a large reduction in conversation invalidations, **not** proof that every
hitch disappeared. Profile web independently with expanded completed work; do not
transfer native timing numbers into a browser performance claim.

## Concrete web gaps and implementation entry points

These findings are from the checked-out source, not a browser reproduction.

| Area | Current web behavior | Change / audit |
| --- | --- | --- |
| [agent-work-group.tsx](../web/src/components/workbench/agent-work-group.tsx) | Last live segment renders directly; shown items render full detail; older segments fold at text boundaries | One stable activity section from first item; compact latest title/count; explicit section and item disclosure |
| Same component | Opening a live segment can call the outer `onToggle`; uses Brain | Separate expansion ownership; Cpu reasoning icon; avoid duplicate headers |
| [agent-work-projection.ts](../web/src/features/threads/agent-work-projection.ts) | `liveTurnId` decides live/summary; canonical final helper accepts any nondraft non-intermediate assistant | Distinguish execution from unfolded/completed presentation; explicit completed-final predicate; stable activity sections |
| Same projector | Draft assistant can be a standalone row then move into work when classified | Keep text position/identity through classification; do not withhold unclassified streamed text |
| [assistant-activity-indicator-state.ts](../web/src/features/threads/assistant-activity-indicator-state.ts) | Already consumes output_activity with call scoping and explicit final recognition | Reuse it; audit caller snapshot freshness and optimistic-send timing, rather than inventing another activity machine |
| [thinking-indicator.tsx](../web/src/components/workbench/thinking-indicator.tsx) | 150 ms grace, then 200 ms height expansion; hidden returns null | Separate immediate reserved space from delayed visual spinner; shared text-line minimum |
| [chat-timeline.tsx](../web/src/components/workbench/chat-timeline.tsx) | Scroll listener updates stick ref; ResizeObserver pins while stuck; double-rAF follow has no execution-time intent recheck/cancellation | Add disclosure inspection intent, cancel/recheck queued follow, retain ordinary late-layout follow and expose jump recovery |
| Same timeline | Separate per-frame follow loop tracks indicator entrance animation | Remove when entrance-height animation is removed; avoid multiple follow owners |
| [use-thread-messages.ts](../web/src/features/threads/use-thread-messages.ts) and [thread-message-state.ts](../web/src/features/threads/thread-message-state.ts) | History/stream ownership is a separate audit surface | Verify all refresh entry points against the reconciliation contract below; no claim here that web has the same mobile data-loss bug |

Before editing, read relevant web feature, workbench and message-renderer specs.
Reuse the projector's existing memoization and identity helpers. Remove retired
`direct` live rendering, live-to-outer expansion coupling and current-item-only
scroll dependencies once consumers use sections. Remove fields only after tracing
all consumers. Update tests that assert old behavior rather than retaining a flag.

## History integrity: required guardrail, separate implementation slice

A latest page is a bounded window, not the whole loaded thread. Every refresh path
must preserve omitted loaded history and protect newer streamed/optimistic content.
Use client identity plus canonical aliases, request/selection generation fences,
explicit local removals, and separate older-page coverage. Empty or filtered-only
pages are not deletion or exhaustion proof. A-to-B-to-A must reject A's old reads.
Lifecycle snapshot freshness is separate from message merging.

Do not infer freshness from response arrival, longer text, creation timestamp or
completed status. Mobile's reconciliation is deliberately conservative and lacks
server message revisions; it does not solve arbitrary cross-client edits. Follow
its documented limits rather than promising a universal newest-wins merge. Avoid
masking data loss with padding, scroll compensation or delayed rendering.

Thread data remains owned by the authenticated viewer. Preserve authorized REST
and SSE routes, owner-filtered reads, account/thread reset boundaries and permission
semantics. No new global transcript cache or widened reads are needed.

## Suggested implementation slices

1. **Projection and disclosures.** Add behavior fixtures first, then stable sections,
   explicit final folding, compact item details, icon/title cleanup and expansion
   ownership. Keep existing data reducers and tool actions intact.
2. **Progress and viewport stability.** Immediate space + grace, same text host/minimum,
   inspection intent, pending-scroll cancellation, Jump to latest and resize behavior.
3. **History audit and closure.** Inventory latest/older/reconnect/approval/pending-send
   refreshes, test the shared retention/freshness contract and fix demonstrated gaps.
4. **Browser acceptance and cleanup.** Profile expanded work, validate the matrix,
   remove superseded paths and update web specs/design docs with actual results.

Slices can share a PR if cohesive; the handoff does not authorize implementation,
commits or deployment. Expected changes are web-only using current service events.
No DB migration, daemon upgrade or mobile rebuild is required for presentation
parity. Any newly discovered service contract gap needs separate explicit scope.

## Acceptance matrix

- Text-first, tool-first, reasoning-only, commentary-only, final-only and many mixed
  sequential/parallel calls; no blank sections, duplicate counts or late-result reorder.
- Several commentary/tool cycles: one stable collapsed row per activity stretch;
  all commentary remains visible until completed final classification.
- Slow final, delayed classification/persistence, replay and restored completed
  history; answer never vanishes/remounts or gets hidden in Worked for.
- Live inspection survives new items; first final completion folds outer work once;
  reopening preserves inner choices; no-commentary shortcut uses compact rows.
- Approve/deny, questions, terminal waits, compaction, stop, failure, offline/reconnect,
  consecutive automated runs and thread switches; no false final fold/spinner.
- Send: one geometry change for optimistic message plus response reservation; spinner
  reveals after grace without added height. Text before/after grace consumes space;
  single-line completion does not shrink and multiline text leaves no extra blank line.
- Open/close nested work at middle/bottom, scroll during output, select text, pane
  resize, composer growth, browser zoom and font changes; no automatic pull while
  inspecting. Jump/new send/deliberate bottom return resumes following.
- Older pagination and stale refresh during completion/approval; no loaded-row loss,
  duplicate acknowledgement, stale resurrection or cross-thread publication.
- Keyboard disclosure controls, accessible counts/status, focus surviving grouping,
  reduced motion, long labels, code/tables/links and async Markdown sizing.

Use existing projection/component/activity/history suites for deterministic cases.
Use mounted browser tests for keys, default expansion and layout; measure scroll
position/element bounds around transitions. Then manually profile a production web
build with long expanded work and matched gestures. Pure reducer tests cannot
establish smooth scrolling. Keep temporary tracing bounded and out of shipped UI.

## Explicit won't-dos

No visual-commit acknowledgements, renderer readiness gate, artificial text delay,
synthetic typing, inactivity-based finality, provider-specific UI or new service
state machine. No replacement Markdown engine, persistent expansion database,
second transcript cache, blanket virtualization/scroll rewrite, global measurement
publication, indefinite compatibility branch or unrelated tool/permission redesign.
Do not port SwiftUI classes merely to make the clients look architecturally alike.
