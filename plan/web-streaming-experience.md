# Plan: Web streaming experience

Status: implemented; automated validation passed, interactive validation pending.

## Context

- [Web review](../review/web-streaming-behavior.md)
- [Shared scope, explicit won't-dos and scenarios](streaming-experience-contract.md)
- Earlier scope: [web agent work collapse](web-agent-work-collapse.md)
- Relevant specs: `web/web.spec.md`, `web/src/features/threads/threads.spec.md`,
  `web/src/components/workbench/workbench.spec.md`, `web/src/routes/routes.spec.md`.

The shared simplified contract governs this plan. Earlier review recommendations
are not additional requirements. Preserve current grouping IDs, duration and outcome
semantics; focus on progress and disclosures.

## Step 1 — Progress

Targets: `assistant-activity-indicator-state.ts`, `chat-timeline.tsx`, thread route
handlers/timers and, only if necessary, `use-agent-stream.ts`.

- [x] Remove the timeline's blanket suppression when a live work group exists.
- [x] Include pending send and later tool/commentary gaps using existing activity
  state; suppress while assistant text streams, not merely on an empty start.
- [x] Reuse short anti-flicker delays and clean up timers on existing reset/switch
  paths. No inactivity timer or per-token renderer reporting.
- [x] Preserve existing human/terminal input, offline, reconnect and compaction
  states; avoid duplicate indicators or busy progress while awaiting human input.
- [ ] Test mounted timeline visibility as well as the gate logic.

## Step 2 — Grouping and inspection

Targets: `agent-work-projection.ts`, `agent-work-group.tsx`, `chat-timeline.tsx`.

- [x] Represent consecutive tools/reasoning as activity segments separated by
  commentary, using current message/turn identity and hard boundaries.
- [x] Keep live commentary visible through canonical reconciliation; collapse
  preceding activity by default when commentary appears.
- [x] Show useful current activity using existing detail views/output limits.
  Keep parallel active items discoverable even in collapsed segments.
- [x] Opening completed work shows commentary and segment summaries; opening a
  segment reveals useful bodies. No-commentary work reveals bodies directly.
- [x] Preserve explicit expansion choices and current file/web/terminal controls.


## Step 3 — Completion and regression checks

- [ ] Reuse existing final/execution and React rendering lifecycle for final
  collapse; verify buffered text is retained. Do not create a render-ack framework.
- [ ] Investigate provisional text classification only if focused event evidence
  confirms incorrect final treatment; fix locally with a regression test.
- [ ] Exercise the shared scenarios in native projection/activity/component tests,
  including reconnect, automated runs, parallel tools, approvals and thread switches.
- [ ] Run relevant package-local tests, typecheck/build and applicable lint checks.
- [ ] Browser checks at desktop/narrow widths: scroll anchoring, selection, keyboard,
  accessibility and final rendering. Compare behavior with mobile's same scenarios.
- [ ] Update affected folder specs and historical-plan supersession links; remove
  superseded spinner conditions and temporary diagnostics.

## Explicit won't-dos

- No invocation/turn identity normalization or broad reducer/state-machine rewrite.
- No new renderer acknowledgement system, token telemetry or 750 ms stall timer.
- No duration/formatter changes or historical failure/outcome reconciliation project.
- No regrouping settled approvals/questions or moving compaction/user boundaries.
- No shared fixture adapters/versioning or exhaustive provider audit prerequisite.
- No service fields, endpoints, schema, daemon, permissions or tool execution changes.
- No new offline/error UX, compatibility flags or unrelated refactoring.

Keep existing authorization, cursor replay, deduplication and final-only side effects.
Minimal local fixes are allowed for demonstrated blockers to the requested UI; broader
changes require separate scope. Implementation and release remain separate actions.

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
