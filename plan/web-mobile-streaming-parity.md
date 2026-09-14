# Plan: web streaming parity with validated mobile behavior

Status: implemented in the working tree on `feat/web-streaming-parity`, September 13,
2026. Automated checks pass; browser geometry, accessibility and performance
acceptance remain open. Checked implementation items below are not claims of
measured browser behavior.

## Context

The [current handoff](../reference/mobile-streaming-web-parity-handoff.md) defines
product behavior based on mobile main `58532ac`. It supersedes older serial-live
activity and idle-means-summary recommendations. This plan supersedes conflicting
presentation recommendations in `web-streaming-experience.md` and
`web-agent-work-collapse.md`; their completed work remains useful history.

Related specs and contracts:
- [Thread runtime](../web/src/features/threads/threads.spec.md).
- [Workbench components](../web/src/components/workbench/workbench.spec.md).
- [Message renderers](../web/src/components/message-renderers/message-renderers.spec.md).
- [Assistant output activity](../design/assistant-output-activity.md).
- [Protocol](../docs/proto.md).

## Objectives

1. Keep streaming work understandable without serial tool-row growth or collapse
   at every commentary boundary.
2. Keep commentary visible until a nonempty explicitly final answer completes;
   never infer finality from idle state or the last currently known message.
3. Make send → waiting → text and disclosure interactions visually stable.
4. Keep scrolling, typing and streaming responsive with expanded completed work.
5. Preserve loaded history, stable identity, permission placement and owner isolation.
6. Remove superseded rendering and scroll paths in the same change, rather than
   layer new behavior over them.

Match mobile semantics, not SwiftUI classes or exact native spacing. Continue using
React, existing tool renderers and Streamdown. Current main web source reviewed at
`bca9c09`; recheck implementation entry points before editing.

## Smallest architecture

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| Existing thread message hook/helpers | Loaded messages, canonical aliases, stream updates, page reconciliation and request lifecycle | Disclosure state or padding fixes |
| Existing projector | Ordered commentary/activity sections, stable identities and completed-final folding eligibility | Network fetches, raw scroll offsets or renderer readiness |
| Timeline/section/item components | Ephemeral disclosure choices; compact summaries; mount detail only when opened | A second canonical transcript or persistent run lifecycle |
| Existing output-activity gate | Progress eligibility from normalized thread/turn/call facts | Inferring text completion from timing or open draft rows |
| One timeline viewport owner | Follow/inspection intent, raw measurements, cancellable scroll scheduling and prepend placement | Publishing every offset into transcript React state |
| Message layout/renderer | Shared response-line sizing and incremental Markdown | Delaying text to wait for another row or changing keys on completion |

Unfolded presentation is separate from active execution. An interrupted run without
a final answer remains inspectable without showing an endless spinner. Derive
completion from existing normalized facts; do not add another durable state machine.

## Phase 0 — baseline and correctness inventory

- [x] Inventory existing/new-thread route wiring, stream completion handlers,
  output-activity recovery and all latest/older/approval/reconnect refresh callers.
- [x] Trace classification from service event to rendered message. The current
  hook's `applyAssistantMessageDone` retains `draft: true`; establish where explicit
  final classification arrives before selecting the minimal completion patch.
- [x] Cover stream-first content, loaded older pages and A → B → A responses with
  controlled tests before changing projection. Review turn-wide assistant draft
  cleanup: completion of one message must not remove another valid message.
- [x] Review initial-prop reset effects, effect-updated message refs and older-page
  requests. Distinguish actual new-thread reset from same-thread loader refresh.
  Hook observations identify risk surfaces, not confirmed end-to-end bugs.
- [ ] Record browser performance and geometry baseline using the workload below.

Exit: documented event/identity path, reproducible fixtures and baseline. If missing
service information blocks correct finality, scope that narrow contract separately;
never paper over it with a timeout or canonical-fetch dependency.

## Phase 1 — stable sections and completion

- [x] Keep consecutive tool/reasoning items in one section from the first item.
  Render its newest introduced item's friendly title/icon, unique count and useful
  aggregate status. Cpu reasoning icon; one title rather than generic duplicate labels.
- [x] Count distinct calls/messages, not events. Late results update their own item
  without changing the newest title. Preserve parallel active/error visibility.
- [x] Keep section identity and component structure through subsequent commentary.
  Empty text does not create a boundary. Unknown classification renders immediately
  in order; do not reparent/remount a streaming Markdown host to classify it.
- [x] Sections start collapsed; opening reveals compact item rows, whose full detail
  is separately expandable. Keep choices through updates and canonical aliases.
- [x] Keep work visible during final streaming. Fold only after explicit completed
  nonempty final classification; retain the final answer's DOM/Markdown identity.
- [x] First final fold defaults outer Worked for closed regardless of live inspection.
  Subsequent user choices persist. No-commentary reopening skips the redundant
  section wrapper but does not open full payloads by default.
- [x] Preserve questions, pending approvals, compaction and user boundaries. Use
  stable source-derived boundary identities where one turn spans multiple groups;
  ordinal suffixes must not transfer disclosure state after prepends/boundary changes.
- [x] Preserve duration semantics, file/proxy actions and error visibility. No
  additional privilege or final-answer side effects for commentary/reasoning.

Prefer a flat stable keyed live row sequence if necessary to avoid React reparenting.
A key alone cannot preserve a component when its parent changes. Final consolidation
may intentionally unmount work details, but must not remount the final answer.
Keep expansion state above those intentionally unmounted details.

Exit: projector and mounted component tests prove order, count, stable identity,
correct defaults and final transition. No empty work wrapper for final-only output.

## Phase 2 — response line and viewport intent

- [x] Reserve one response line in the same update as optimistic send. Retain the
  single 500 ms visual spinner grace; text before grace consumes that space too.
  Handle failed send/removal/retry and rapid successive sends without orphan slots.
- [x] Reuse normalized `working` / `text` / `awaiting_completion` policy and current
  explicit wait/compaction behavior. Reject stale call clears and stale snapshots.
- [x] Use typography-relative assistant minimum height and shared reservation, not
  spinner plus text height. Include row padding/margins in geometry tests. Clear
  transient reservation on termination, waits, thread changes and layout invalidation.
- [x] Remove spinner entrance-height animation and its dedicated follow loop. Keep
  ordinary spinner rotation/reduced-motion behavior; avoid broad styling changes.
- [x] Add transient manual inspection before disclosure mutation. Cancel pending
  scrolls and recheck intent on execution. Apply to nested Details/Show more,
  questions/compaction disclosures as well as outer work.
- [x] Unify existing structure, resize and prepend scroll writers behind one owner.
  Raw offsets live in refs; publish only UI thresholds/intent changes. Separate DOM
  reads and writes; coalesce pending follow into at most one frame callback.
- [x] Distinguish deliberate user scroll from programmatic scroll or resize/clamp.
  Include wheel/touch and keyboard scrolling. Passive near-bottom geometry cannot
  clear inspection; deliberate return, Jump to latest or new send can.
- [x] Expose Jump to latest when away while inspecting, even with no unseen updates.
  Composer focus, refresh and reconnect do not clear inspection. Preserve selection.
- [ ] Respect existing prepend positioning and native anchoring; do not compensate
  twice. Cancel stale placement on thread change or a new user gesture. Test final
  folding while inspecting a child that disappears; use the enclosing work anchor
  if native anchoring is insufficient. Add explicit offset restoration only then.
- [x] Hidden chat pane/model-view toggles must not interpret zero-size geometry as
  user intent. On reveal, restore meaningful measurements and the existing intent.

Exit: mounted browser geometry and interaction checks pass, including delayed
Markdown sizing. No absolute fixed-height assumption across fonts/zoom/pane widths.

## Phase 3 — history reconciliation closure

Audit before replacing existing algorithms. Keep code that already meets the
contract. Fix demonstrated violations through one page application policy:

- Latest/empty pages upsert coverage; omission never deletes loaded messages.
- Protect optimistic/live updates both predating and arriving during a fetch;
  canonical alias acknowledgement preserves row identity and chronology.
- Fence all async application, errors and cleanup by selection generation/request
  ownership, including A → B → A and abort/finally paths from obsolete requests.
- Keep older-page coverage distinct from latest refreshes. Duplicate/filtered-only
  pages can advance the server cursor; guard repeated cursor/no-progress loops.
- Treat explicit retirement separately from omission and prevent stale resurrection
  without making intentional retries impossible.
- Guard lifecycle/output-activity snapshots separately from message pages.

Do not claim general server freshness without message revisions. Arrival order,
created_at, text length and completed status cannot settle arbitrary conflicting
canonical edits. Document conservative precedence and remaining limits; any future
cross-client edit/tombstone contract is separate work. No new refresh scheduler,
second loaded collection or global cache. Never hide data loss with scroll padding.

Exit: regression tests for audited fetch/apply paths, preserving canonical tools,
permissions and final answers. If no violation is found, close this phase with
coverage and findings rather than a speculative rewrite.

## Edge-case acceptance matrix

| Scenario | Required result |
| --- | --- |
| Text-first/tool-first/reasoning-only/commentary-only/final-only | Immediate ordered content, no empty section, no false finality |
| Many sequential or parallel calls; late result/replay | One stable collapsed section, unique count, newest introduced title |
| Unknown → intermediate/final classification; delayed persistence | No missing tail, reordered text, remounted final or premature fold |
| Stop/failure/offline without final; empty final | Work stays inspectable; spinner follows execution, not presentation |
| Approval/question pause/resume and compaction | Decision stays visible; no enclosing fold across semantic boundary |
| Live section opened then final completes | Outer folds once; inner choices survive reopening |
| One-line/multiline text before or after grace | Single reserved line, no stacked empty space or completion shrink |
| Send fails/retries, new-thread creation, automation without local send | No stuck reservation; normal server-driven progress and stable identity |
| Bottom/middle disclosure, rapid toggles, selection | No automatic pull; legal native clamping only |
| Final fold or prepend while browsing; user scroll during older fetch | Preserve anchor/intent; no stale offset write |
| Resize, zoom, fonts, images/diagrams, composer growth | Follow late layout only when intended; no observer feedback loop |
| Scroll-only expanded completed history | No transcript-wide React updates from offset samples |
| Thread/account switch, hidden/revealed pane, reconnect | Old requests/frames cannot affect new view or revive stale approvals |
| Loaded 100+ rows, empty/stale latest page, overlapping older page | Retain history, correct pagination and canonical deduplication |

Test normalized fixtures representing OpenAI, Claude and local completion sequences;
no real-provider timing dependency in deterministic tests. Include keyboard focus,
aria-expanded/count/status, screen reader semantics and reduced motion. If focused
work unmounts on final fold, move focus to its work disclosure without scrolling.

## Performance acceptance and profiling

Performance is a deliverable, not an optional follow-up. Use the same browser,
machine, viewport, zoom, build mode and fixture before/after. Capture three runs
per scenario; separate first-use module/font loading from warmed interaction.
Do not use debugger-paused development runs as latency acceptance.

Workload:
1. A 100-message loaded thread with mixed Markdown, several work groups and a
   nine-item section; scroll collapsed, section-expanded, then with one large
   detail open for 20 seconds each using comparable gestures.
2. Repeat with 500 loaded messages to expose scaling. This is a stress case, not
   a new promise of unbounded history performance.
3. Replay deterministic commentary/tool/final events at a fixed cadence, including
   a 50-item collapsed section and a long final with code/table content. Type in
   the composer and browse earlier content during the replay.
4. Expand/collapse near bottom, resize chat beside a viewer, prepend a page, and
   exercise final folding while following and while inspecting.

Use production `pnpm --dir web build` + `pnpm --dir web preview` for browser
Performance recordings (main-thread work, frames, long tasks and DOM node count).
Use a separate profiling-enabled React run or temporary targeted counters to
attribute renders; remove counters afterward. Compare like builds, recording
fixture/browser/hardware and trace paths in a debug note. Existing render tests
are not proof of real browser layout or frame performance.

Required structural budgets:
- Appending 1 → 50 calls to a collapsed section retains one header and mounts **zero
  detail renderers**. Header bounds remain constant at fixed typography/width.
- Offset-only scrolling of completed work causes **zero message/section React
  rerenders attributable to raw offset publication**; threshold controls may update.
- Unrelated completed Markdown/tool detail does not reparse because another row
  receives a token. Memoization must see stable inputs/callbacks.
- At most one pending bottom-follow frame; no continuous idle polling or per-token
  full-payload formatting. Same-thread replay does not grow disclosure caches forever.
- Spinner reveal and one-line completion change the reserved region by at most
  1 CSS pixel for rounding, excluding intentional final folding/async rich content.

Timing targets on the recorded reference desktop, warm 100-row workload:
- Aim for p95 app scripting + layout per scrolling frame under one 60 Hz frame
  budget (16.7 ms), and disclosure input-to-next-paint under 100 ms.
- Investigate every repeatable app-attributable task over 50 ms during steady scroll
  or ordinary disclosure; a trace average must not hide an individual freeze.
- Do not regress matched warm scrolling/typing metrics by more than 10% across the
  three-run median without a documented explanation and explicit acceptance.
These are acceptance targets, not measured claims. Record misses and their causes;
third-party rich content outliers are reported separately, not silently excluded.
If the stress case fails, scope the smallest measured hotspot; virtualization is
not automatically required. Do not interpret fewer React renders as a percentage
improvement in overall frame rate.

## Technical debt removal and boundaries

Remove once replaced and reference-tested:
- Separate direct live-item loops and activity regrouping at commentary boundaries.
- Live-section expansion coupled to the outer work expansion.
- Idle/missing-classification finality shortcuts in presentation.
- Duplicate activity title/detail wrappers and eager hidden payload formatting.
- Spinner max-height entrance and its per-frame growth-follow loop.
- Uncancelled competing follow/prepend writers; obsolete current-item scroll tokens.
- Destructive page replacement or duplicate reconciliation guards proven obsolete.
- Tests/docs asserting retired behavior; unused fields only after checking consumers.

Keep useful existing role/tool renderers, duration helpers, identity helpers,
permission recovery and output-activity state. Avoid new dependency additions
unless existing test/runtime tools cannot establish a required behavior.

Explicit won't-dos: provider-specific presentation, visual-commit acknowledgements,
renderer readiness gates, inactivity finality, artificial text delays, new Markdown
engine, event-sourcing rewrite, persistent disclosure storage, global transcript
cache, broad virtualization/animation rewrite, additional feature flags, arbitrary
history eviction, unrelated terminal/proxy or permissions redesign. No new schema,
SSE or daemon work by default. No logging of message/credential payloads to profile.

## Ownership, validation and rollout

The authenticated viewer owns the selected thread. Continue using existing
owner-authorized REST/SSE routes and scoped message storage. Account/thread reset
must discard transient view/request state. No new endpoint, global read, owner
stamping or permission change is proposed.

Run relevant tests after each slice; then once at completion:
- `pnpm --dir web test`
- `pnpm --dir web test:render`
- `pnpm --dir web lint`
- `pnpm --dir web build`

Capture preexisting failures distinctly and fix new failures. Use mounted browser
checks for geometry/focus and manual Performance recordings for scrolling. Add a
small deterministic fixture harness only if existing tests cannot drive those
states; do not build a general telemetry/benchmark subsystem.

Specs/docs to update during implementation:
- [x] Thread runtime spec: projection, request ownership and any new helper files.
- [x] Workbench spec: disclosures, progress layout and viewport owner.
- [x] Message renderer spec if renderer API/ownership changes.
- [x] Existing web work-collapse/streaming design docs: supersession and final flow.
- [x] This plan with actual validation/performance results and remaining limitations.
- [x] Debug note for baseline, discovered bugs and measured fixes; PROGRESS.md.

Expected rollout: web build/deploy using current service output-activity and
classification events. No migration, mobile rebuild or daemon release. Keep
service/daemon mixed-version contracts untouched. Implementation is complete only
when behavior, data integrity, performance targets and cleanup are reviewed; do not
silently defer a measured performance regression. Commits, PRs and merges require
separate user direction; PR descriptions include code line changes excluding Markdown.

## Implementation report — September 13, 2026

Completed code scope: stable collapsed sections and distinct final eligibility;
message-done classification forwarding; one shared viewport hook; immediate send
reservation with grace; conservative history merging and request fences. Removed
serial live-body rendering, current-step projection fields, turn-wide draft deletion,
spinner entrance sizing/follow animation and independent prepend offset scheduling.
Initial overlays are now evaluated lazily rather than on every stream render.

The added dev-only React test renderer enables mounted identity/state/race tests
that the existing server-render harness could not express. It is deprecated upstream
and is deliberately confined to tests; it does not validate browser layout or add
runtime bundle weight. A future browser-backed suite may replace these fixtures.
No production diagnostics, provider-specific branches or service changes were added.

Validation: 209 pure tests and 18 render/mounted tests pass. Production typecheck/build
passes with existing large-chunk warnings. Changed-file ESLint passes. Full lint
still reports nine errors and one warning in unchanged files (listed in the
[debug note](../debug/web-streaming-parity.md)).

Structural coverage includes 50 calls with zero hidden details mounted, surviving
commentary/final React identity, persistent inner disclosure, source IDs across
prepends/splits, same-tick deltas, stale page/removal protection and A → B → A older
request fencing. Simulated viewport tests verify cancellation, send-resume,
passive-resize inspection and zero threshold-unchanged raw-scroll publications.

Remaining acceptance work: browser discovery returned no connected browser, so no
matched baseline/after trace or real DOM geometry result exists. Run the workloads
above at 100/500 rows, plus spinner handoff with fonts/zoom/Markdown, nested disclosure
near the bottom, final-fold focus/anchor behavior, selection, older-page placement
and hidden/revealed panes. Keep the ≤1px/16.7ms/100ms/10% targets open until measured.
Do not label this performance-accepted based on unit tests. If native anchoring
cannot preserve the selected work during final folding, add the narrowly scoped
anchor correction after observing it, as specified in Phase 2.

History limitation: there are no server message revisions. Canonical matching
acknowledgements settle local evidence, but conflicting edits to protected messages
conservatively keep local content for the current visit; arbitrary cross-client
edit/deletion arbitration remains outside this change. Snapshot responses overtaken
by newer requests or stream activity are discarded instead of rewinding the UI.
No commit, deployment, mobile rebuild or daemon upgrade performed.

## Web timing preference update

After testing instant progress, the chosen behavior is immediate space reservation
with a 500 ms visual spinner grace, using the same reservation approach as mobile. Explicit
compaction labels remain immediate. The stale-snapshot and admission-gap fixes
remain: grace changes visibility only, not execution eligibility. Text/final/wait
suppression and response sizing are unchanged.

Spinner reveal now bypasses the startup grace once accepted normalized output
activity has started. Text/wait/final eligibility still wins; without a signal,
the 500 ms fallback reveals progress in the immediately reserved row. See
[working-signal debug note](/debug/web-spinner-working-signal.md).

## Final local review — September 14, 2026
User testing accepted the web presentation and repeated disclosure-to-bottom
following successfully. Temporary scroll diagnostics were removed without a policy
change. Spinner reveal uses working activity or a 500 ms fallback; commentary omits
header chrome; expanded Worked for groups retain hover tint and 8px body padding.
Formal matched browser performance traces remain unrecorded; functional user
acceptance does not establish the numeric performance targets above.
