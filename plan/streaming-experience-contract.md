# Plan: Shared streaming experience

Status: client implementation complete; interactive acceptance pending.
Baselines: main `e7fdbec`, mobile `d653710`.

## Context and objective

Source: [cross-client review](../review/streaming-behavior-comparison.md).
Delivery plans: [web](web-streaming-experience.md) and mobile repo
`plan/streaming-experience.md`.

Improve progress visibility and work disclosures using the existing client
architectures. This revision replaces the earlier five-phase lifecycle overhaul.
The reviews remain baseline findings, not additional implementation requirements.

## Required experience

- Show progress from send through active work, including gaps between tools and
  commentary. Suppress it while assistant commentary/final text is streaming.
- An empty message-start event alone must not hide progress. Use existing text
  streaming/completion signals and a short anti-flicker delay; reuse local delays
  unless testing shows a visible problem. Exact millisecond parity is not required.
- Render the current activity segment openly using existing tool/reasoning views
  and bounded output controls. Only already-exposed reasoning is in scope.
- Commentary collapses the preceding activity segment by default and stays visible
  while later work proceeds. Prior segments remain inspectable.
- Keep unfinished parallel tools discoverable even if their segment is collapsed;
  show an active indication/count and update results in place. Do not assume the
  last item is the only active one.
- Retain commentary until final completion, then collapse preceding work under
  Worked for {time}. Use existing execution/final completion signals and rendering
  lifecycle, including mobile's existing visual-commit mechanism. Preserve buffered
  final text; do not interpret any intermediate message_done as response completion.
- Opening Worked reveals commentary and collapsed activity segments. Opening a
  segment reveals useful content with optional raw/large-output controls. With no
  commentary, opening Worked reveals activity content directly, without redundant
  segment/item disclosure clicks. Text-only responses need no empty Worked row.
- Preserve deliberate expansion choices, selection and scroll position. Automatic
  defaults should not close details a user has deliberately opened.

## Explicit won't-dos for this implementation

These are scope boundaries, not prerequisite phases or deferred checkboxes inside
this task. Broader changes require a separately agreed scope.

| Won't do | What to do instead |
| --- | --- |
| Normalize invocation/turn identity across clients or replace grouping IDs | Keep web's existing identities and mobile's overlap-based grouping. Fix identity only if a focused test demonstrates incorrect grouping relevant to this UX. |
| Introduce a general lifecycle/state-machine replacement | Derive presentation from existing execution, waiting, text and completion state. Add only narrowly needed presentation state. |
| Build a renderer-acknowledgement framework | Reuse mobile visual commits and web's existing render lifecycle. A demonstrated completion bug may need a small local fix, not a new framework. |
| Add the proposed 750 ms text-stall detector | No token-inactivity timers, per-token progress tracking or new renderer telemetry. Missing-event recovery remains in existing recovery paths. |
| Unify duration calculation, fallback, formatting or historical outcome labels | Keep each client's current duration and outcome behavior. Record differences for a separate follow-up. |
| Regroup settled approvals/questions or change compaction boundaries | Preserve existing actionable surfaces, settled placement and chronological boundaries. Do not merge work across them. |
| Create shared/versioned fixture infrastructure or copy fixtures between repos | Use the small common scenario list below with native tests in each repo. |
| Audit every provider or add new canonical/SSE/history fields preemptively | Inspect the event paths actually needed. Investigate unknown-phase classification only if a trace/test confirms premature final treatment. |
| Redesign offline, queued, terminal-input or failure UX | Preserve existing waiting/error controls and use their states to avoid a misleading busy spinner. |
| Change backend, database, daemon, prompts, tool execution or permissions | This is client presentation work. Report any demonstrated external blocker and scope it separately. |
| Add compatibility flags, broad refactors or permanent debug logging | Make focused changes, remove superseded spinner conditions and use targeted tests. |

A confirmed bug directly blocking the required experience can receive a minimal
local fix with a regression test. A finding alone is not authorization to perform
one of the broader refactors above. Document unrelated findings without expanding
this implementation.

## Three implementation steps

### 1. Progress

- [x] Remove web's blanket spinner suppression whenever a live group exists.
- [x] Extend mobile progress beyond the first response, retaining send bookkeeping.
- [x] Derive visibility from existing active/waiting and assistant-text states.
- [x] Cover send, empty start, commentary completion and tool-result gaps. Stop
  busy progress on existing terminal/input-required/offline states as appropriate;
  preserve specific waiting/reconnect/compaction presentation without duplicate spinners.
- [x] Keep delay cancellation and thread switching safe using existing lifecycle hooks.

### 2. Grouping and inspection

- [x] Add activity segments to web; render mobile's existing segments as disclosures.
- [x] Keep commentary visible until final completion and current activity inspectable.
- [x] Implement direct no-commentary expansion and preserve manual disclosure choices.
- [x] Check parallel work and canonical text replacement without changing ID strategy.


### 3. Completion and regression checks

- [ ] Reuse existing completion/render signals; prevent premature collapse or lost text.
- [ ] Validate existing reconnect, foreground and history behavior with new presentation.
- [ ] Trace uncertain assistant classification if a test/repro reveals a problem;
  make the smallest correction without a wholesale classification rewrite.
- [ ] Verify the scenarios below on both clients; update affected specs/design docs.

## Common scenario checklist

Use native tests plus focused browser/iPhone checks, not a new cross-repo harness.

| Scenario | Assertions |
| --- | --- |
| Send → reasoning/tool → gap → commentary → tool → commentary → final | Progress in gaps, commentary retained, prior segments collapsed, one normal completed summary |
| Empty start; commentary completes before next action | Empty start does not suppress; progress returns after text completion |
| No commentary; text-only; empty commentary | Direct work reveal; no empty group or meaningless text boundary |
| Parallel tools finish out of order | Active work remains discoverable; results update once |
| Final streams then completes; canonical text arrives later | No text loss, premature collapse or duplication |
| Approval/question/terminal input, continuation, compaction | Existing controls and boundaries preserved; progress reflects existing waiting state |
| Stop/failure; tool failure followed by recovery | Spinner stops when execution ends; existing output/outcome presentation preserved |
| Reconnect/cold open/foreground; automated run without local send | Existing state reconstructs progress and grouping without a pending local send |
| Switch thread; prepend history; delayed prior-thread event | No stale spinner, cross-thread changes or reset disclosure choices |
| Scroll up, select text, expand old work; long outputs | No forced jump; bounded content; working file/web/terminal actions |

Include keyboard/VoiceOver, Dynamic Type where applicable, reduced motion and a
slow-rendering final in focused visual checks. Tests should prove behavior at the
rendered row level, not only an isolated spinner boolean. Recovery tests validate
the existing architecture; they are not a reason to replace it preemptively.

## Contracts and delivery

Existing authenticated viewer/thread scoping, SSE cursor handling, canonical
persistence, final-only side effects and eager terminal observation remain intact.
No API, schema or wire changes are planned. Client changes may ship independently
with temporary visual differences; mobile requires a rebuild. No new feature flag.
Update relevant client specs during implementation; keep historical plan records
and mark conflicting presentation guidance superseded. Implementation is client-only. Commits and deployment require separate authorization.

## Implementation and validation — September 9, 2026

Implemented progress eligibility, visible live commentary, activity disclosures,
direct no-commentary expansion and preserved deliberate inspection using existing
identities and lifecycle signals. Empty assistant text does not close activity or
suppress progress. No backend/daemon/schema changes or new completion framework.

Web: 206 unit tests and 12 render tests pass; production build/typecheck and
changed-file ESLint pass. Mobile: focused policy/projector/row tests pass; four
model-selection tests fail identically on unchanged baseline d653710 (13 assertions).
See mobile plan for its exact commands and checks.

The checklists above remain the acceptance matrix, not a claim of full device
coverage. Browser discovery returned no connected browser; mounted interaction,
scroll/selection, keyboard/accessibility, narrow layouts and cross-client live
scenarios still need hands-on validation. No phone installation or deployment
was performed. Duration/outcome differences and all explicit won't-dos remain.
