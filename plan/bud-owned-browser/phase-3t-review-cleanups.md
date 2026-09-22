# Phase 3t: Review cleanups (spec drift, lint, dead code)

Status: implemented locally, including the legacy `observe` removal (2026-09-22); only a prose-string formatting pass remains. Updated 2026-09-22.

## Context

- Source: [merge-readiness review](../../review/bud-owned-browser-branch-review.md),
  the "cheap cleanups" across all three tiers.
- Related specs: [daemon browser](../../bud/src/browser/browser.spec.md),
  [daemon source](../../bud/src/src.spec.md), [root](../../bud.spec.md),
  [service browser](../../service/src/browser/browser.spec.md),
  [service agent](../../service/src/agent/agent.spec.md),
  [service routes](../../service/src/routes/routes.spec.md),
  [web browser](../../web/src/features/browser/browser.spec.md),
  [web routes](../../web/src/routes/$budId/budId.spec.md),
  [wire protocol](../../docs/proto.md).

The browser branch was written phase by phase with append-only specs. Several
documents now contradict themselves or the code, a handful of lint warnings
were introduced, and two web code paths are unreachable. None of this changes
behaviour; all of it costs the next reader time.

## Objective

Every browser spec and the protocol doc describe the current code once, with
no contradicting earlier paragraph; the branch adds no clippy or ESLint
warnings; no dead browser code remains. AGENTS.md's Definition of Done
requires spec parity, so this closes the branch's documentation debt.

## Work items

### Spec and protocol drift

1. `bud/src/browser/browser.spec.md`: compact observation budget is 32 KiB, not
   8 KiB (`compact.mjs`); remove or implement "admitted close pauses
   authority" (not implemented; see Phase 3s if it should be). Note the
   `configured()` removal and the manifest-based readiness from Phase 3r if the
   Phase 1 paragraphs still describe env-var readiness.
2. `bud/src/src.spec.md`: resolve the two contradictory paragraphs on whether
   `main.rs` cancels browser cleanup on SIGINT/SIGTERM (Phase 3k made shutdown
   awaited; delete the older sentence).
3. `bud.spec.md`: the sentence saying profile persistence "remains a later
   phase" sits directly above the Phase 3k paragraph saying it is implemented.
4. `bud/src/doctor.rs`: gone with Phase 3r (was "ephemeral profile mode").
   Verify no other CLI text says ephemeral.
5. `service/src/routes/routes.spec.md`: add the browser route inventory
   (`/api/buds/:bud_id/browser*`, `/api/browser/*`, `/api/threads/:id/browser-*`
   and the two WebSocket upgrades) with their authorization rule, matching the
   entries in `service/src/browser/browser.spec.md`.
6. `service/src/browser/browser.spec.md` and `docs/proto.md`: the compact
   envelope guard is 36 KiB (`browser-tool-executor.ts`), not 12 KiB. The
   private viewer contract lists five control operations; later sections add
   four. Consolidate into one list.
7. `service/src/agent/agent.spec.md`: remove "provider image serialization
   remains deferred" (hydration exists since Phase 3d).
8. `docs/proto.md`: `browser_request_handoff` is advertised when the handoff
   capability is present; delete the "not advertised" sentence. Relay demand is
   sent as `target_id: null`, document it as nullable rather than optional.
   Note the media demand timeout applies in operation-driven mode as well.
9. `web/src/features/browser/browser.spec.md`: "Close browser and stop run" is
   now "Close this thread's tabs"; remove the paused-notice description and
   the "Replaces session-link" note (no such file ever existed); make the test
   summary cover all nine viewer tests.
10. `web/src/routes/$budId/budId.spec.md`: remove the paused-notice paragraph
    that a later paragraph already says was replaced by inline cards.

### Lint

11. Daemon: clear the eight clippy warnings in `manager.rs` and `media.rs`
    (six unnecessary `u64` casts, one 10-argument function, one collapsible
    `if`, one `match` that should be `if let`). The 10-argument function should
    take a small request struct rather than a lint allow.
12. Web: add `browserPane.notice` to the `useCallback` dependency list in
    `routes/$budId/$threadId.tsx` or memoize the notice function so the
    dependency is stable.

### Dead code

13. Web: delete the `takeoverPending` auto-acquire effect in `viewer.tsx`
    (`acquire` either transitions to `human_private` or throws, so the branch
    is unreachable) and the `pausedSessionId` state in `pane.tsx` with its
    three test assertions.
14. Service: delete the unused `BrowserHandoffContext.llmCallId`,
    `startedAt`, `remainingCalls` fields and the unused `_requestId` parameter
    in `control-repository.ts`; collapse the duplicate `Session` and
    `BrowserSession` row types into one.
15. Daemon: decide the legacy `Observation`/`Element` adapter in `adapter.rs`.
    The branch ships daemon and service together, so per the no-legacy-paths
    default it should be removed with its `agent.spec.md` "legacy observe"
    references, unless a current deployment needs it. Record the decision.

### Formatting

16. Service: add a Prettier config matching the repo's existing TypeScript
    style and format the browser and agent files added by the branch (35 lines
    over 200 characters, minified-style stretches in `invocation-repository.ts`
    and `routes.ts`). Keep it a formatting-only commit so review diff stays
    readable.

## Implementation notes (2026-09-21)

- Items 1–2, 5–10: done in place; `docs/proto.md` gained an appended
  "Corrections (Phase 3t)" section per its append-only convention. Item 3: the
  "remains a later phase" sentence did not exist in `bud.spec.md`; the stale
  "native mobile/workbench integration remains Phase 3" claim was corrected
  instead. Item 4: gone with Phase 3r.
- Item 11: all eight daemon clippy warnings cleared; the ten-argument media
  starter now takes a `MediaStart` struct. Item 12: `browserNotice` bound
  outside the callback. Item 13: `takeoverPending` effect/state and
  `pausedSessionId` (with the unused `control_state`/`runtime_status`
  inventory fields) removed; a vacuous negative-label assertion in
  `viewer.test.tsx` now asserts the current label.
- Item 14: unused handoff context fields and `_requestId` removed. `Session`
  and `BrowserSession` were **not** collapsed: `Session` is the raw
  `browser_session` row, `BrowserSession` is the session/resource join with
  different columns.
- Item 15, resolved 2026-09-22: **the legacy `observe` action is removed.**
  (Earlier decision, kept for the record: keep for now, remove in a follow-up.) The daemon uses `Browser::observe` internally at
  `PrepareReturn` to refresh the semantic snapshot, `Action::Observe` is used
  by manager tests, and service repository tests use `{action:"observe"}` as a
  generic command shape. The service never sends it to a current daemon
  (`semantic_observations` is always advertised), so it is not a shipping
  compatibility path. Follow-up: replace the internal use with `inspect`,
  delete `Action::Observe`, `Observation`/`Element`, and the service's
  non-semantic mapping in `broker.ts`, and require `semantic_observations` in
  the capability schema.
  Done: `PrepareReturn` refreshes through a compact `inspect` snapshot;
  `Action::Observe`, `Browser::observe`, `Observation`/`Element` and the
  per-handle observation counter are gone; live fixtures read structured
  `nodes` through a test-only `snapshot_nodes` helper; the service capability
  schema requires `semantic_observations:true`, the broker's non-semantic
  mapping is deleted, and repository/continuation fixtures send `inspect`.
  proto.md records the removal.
- Item 16: twenty mechanically splittable long lines were wrapped; no Prettier
  config was added. Remaining long lines are prose string literals
  (`browser-tools.ts` tool descriptions, the pause guidance in
  `browser-tool-executor.ts`, the handoff summary in
  `continuation-results.ts`) and need a wording decision, not a formatter.
- Verification: daemon lib tests 158 pass, clippy and fmt clean; service
  754 tests / 725 pass / 29 DB-gated skips, and the DB-gated continuation,
  repository, resource-repository and timing suites pass with
  `BUD_DATA_DB_TEST=1`; web 225 + 36 pass, browser ESLint clean.

## Spec Files to Update

All of the files listed under "Spec and protocol drift"; the code changes here
touch no other spec.

## Impacted Contracts

- [ ] WSS protocol: doc-only corrections, no wire change
- [ ] SSE events: none
- [ ] DB schema: none
- [ ] Agent tools: none
- [ ] Web UI: none visible

## Test Plan

- `cargo clippy --all-targets` shows no warnings in `bud/src/browser`.
- `pnpm lint` in `web/` reports no browser-related warnings; existing
  pre-branch errors are out of scope.
- `pnpm test` in `service/` and `web/` stay green after the dead-code removal;
  `pane.test.tsx` loses its three `pausedSessionId` assertions.
- `grep -rn "8 KiB\|12 KiB\|not advertised\|ephemeral" ` over the browser specs
  and proto.md returns only intentional historical mentions.

## Rollout

Documentation and lint only; no deployment step. Land as one or two commits
separate from Phase 3s so the behavioural fixes stay reviewable.
