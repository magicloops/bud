# Phase 7g: REPL-only browser tools and legacy code removal

Status: implemented; automated validation passes. Matching-stack physical smoke
acceptance remains in Phase 8. 2026-09-24.
Parent: [REPL implementation](repl-implementation.md).
Next implementation phase after 7f; [Phase 8](repl-phase-8-workspace-lifecycle.md)
retains workspace admission/cleanup and final merge acceptance.
This makes the parent's Phase 4 catalog-removal work concrete; it is not a second
catalog cutover or a new browser API.

## Decision and current acceptance

Use the REPL-based agent path exclusively in every environment. Remove the old
executable browser tool family, its mode switch and code used only by that path.
No fallback catalog, legacy execution aliases or ongoing old/new comparison mode.

The user accepts desktop human scrolling as good enough in current browser tests.
Agent scrolling is accepted for the exercised page-navigation/Nth-item tasks;
this is product evidence, not proof of every scrolling or reading-coverage case.
Revisit mobile scrolling when work returns to mobile. These checks do not block
scoping or implementing this cleanup. Retain automated authority/scroll regressions
and the separate privacy, recovery and lifecycle gates.

## Starting-point findings (before this implementation)

- `service/src/agent/browser-tools.ts` still defines six executable names, legacy
  argument validators/help and `BROWSER_CANONICAL_TOOLS`. `browserReplEnabled()`
  explicitly disables REPL in production and reads `BUD_BROWSER_TOOL_MODE` elsewhere.
  The REPL catalog obtains handoff by looking it up in the legacy catalog.
- `service/src/browser/broker.ts` chooses between cells and old tool dispatch;
  maps old observations/actions to daemon commands, applies compact-observation
  behavior and a separate single-screenshot transfer path. REPL image transfers,
  receipts, lifecycle cleanup and output authorization also live here and survive.
- `service/src/agent/browser-tool-executor.ts` retains legacy observation summaries,
  guidance and the old compact-result envelope check alongside shared authorization.
- `continuation-results.ts` still instructs non-cell browser continuations to call
  `browser_observe` and `browser_open` after Return.
- Contracts, conversation loading, image references and web renderers mention old
  names for different reasons. Some execute tools; others read historical records.
  Classify usages before deleting them.
- `service/scripts/compare-browser-repl.ts` imports both catalogs and executes old
  calls. Several tests explicitly set the old mode or use old calls as fixtures.

Read complete affected files and their specs before implementation. This inventory
identifies starting points, not a claim that every old helper/daemon branch is dead.

## 1. One supported executable catalog

- [x] Expose only `browser_exec` and `browser_request_handoff` as browser tools.
  Define handoff independently; keep existing availability/authorization semantics.
- [x] Remove `BUD_BROWSER_TOOL_MODE`, the production exclusion, mode-selection
  helpers, old schemas and argument guidance, and obsolete configuration examples.
- [x] Require current REPL capability for agent execution. An unsupported daemon
  gets a clear unavailable/upgrade-required outcome, never the old tool family.
  Preserve meaningful existing capability negotiation rather than deleting it
  merely because two catalogs become one.
- [x] Remove legacy directive parsing/dispatch in contracts and execution paths.
  A fresh old-name call must reach normal unsupported-tool handling before browser
  allocation or dispatch. It must not become a REPL call by string substitution.
- [x] Update active prompt/help, Return/restart continuation and recovery messages
  to use the supported facade and fresh observation rules. No retired tool advice.

## 2. Delete code by actual callers

- [x] Trace service → daemon → helper callers and record a keep/remove map in a
  debug note. Remove legacy-only dispatch, result formatting, old pagination/output
  adapters and test fixtures when no supported caller remains.
- [x] Simplify broker/executor to cell admission, durable execution/receipts,
  authorized result delivery and handoff. Keep offline receipt lookup, model vision
  checks, multiple REPL image transfers and lifecycle cleanup.
- [x] Keep shared semantic snapshot/action/evaluation machinery, native Playwright
  actions, reference validation, screenshots, tab/profile recovery, viewer controls,
  private input/media, ownership fences and the REPL bridge that calls them.
  An internal command named open/inspect/close is not itself an obsolete tool.
- [x] Audit old compact output/continuation paths against REPL full local capture
  and `snapshot.format()`. Delete only legacy-only machinery; preserve local
  observation coverage, 8 KiB emitted budget, explicit expansion and artifacts.
- [x] Remove dead imports/exports/dependencies and corresponding package entries
  only when the caller inventory proves they are unused. Do not rewrite the
  browser engine, relax actionability or expose raw CDP as part of cleanup.
- [x] Check workspace close semantics: removing model-facing `browser_close` must
  leave existing authorized lifecycle cleanup available. `tab.close()` is not
  workspace disposal. Any agent-facing capacity policy belongs to Phase 8; do not
  add a legacy close alias to disguise that remaining decision.

## 3. No historical compatibility layer

The product is pre-launch and the user explicitly waived historical browser-result
compatibility. Remove old-name reconstruction, old observation image hydration and
the dedicated observation renderer. No database rewrite or deletion is necessary;
old records are unsupported, not translated into executable cells.

- [x] Remove historical-only adapters along with old dispatch.
- [x] Preserve authorization and image retention for current REPL results.
- [x] Keep truthful current handoff/continuation pairing and uncertain outcomes.
- [x] Discover/reveal REPL workspaces through inventory and live handoff events;
  retired open results cannot reveal a pane or confer authority.
- [ ] Drain active old invocations before coordinated rollout. Do not replay or
  translate stored old mutations; restart testing with current REPL calls.

## 4. Tests and developer tooling

- [x] Make the comparison harness REPL-only for prompt/budget/fixture comparisons,
  or remove its obsolete old-tools branch if no longer used. Preserve measured
  reports as historical evidence; Git history is the old executable baseline.
  Do not retain a hidden production or developer legacy backend for convenience.
- [x] Convert ownership, invocation parking, continuation, cancellation, recovery,
  image and context tests to real REPL scenarios while retaining their assertions.
  Delete tests whose sole purpose is removed argument schemas or mode selection.
- [x] Add explicit negative dispatch tests for all four retired names and catalog
  tests in both development and production, including obsolete env values.
- [x] Run focused agent/broker/continuation/catalog/provider tests, helper/daemon
  tests where shared code changes, relevant builds and current viewer tests.
- [ ] Smoke-test actual-agent navigation, observation, click/fill, scrolling,
  console/final-value output, screenshots, takeover/Return and retained variables.
  Include new and existing REPL threads. No special site logic.

## Ownership and impacted contracts

Existing owner/Bud/thread/invocation resolution remains before allocation,
dispatch, receipt lookup and result delivery. Private control remains Bud-wide;
held data does not confer current browser authority. Handoff waits, cancellation,
uncertain outcomes and no automatic replay remain hard contracts.

No new route, table, owner stamp, permission or migration is planned. If removing
an obsolete wire operation/capability is justified by the caller audit, change both
sides and `docs/proto.md` together. Do not remove viewer-used REST/control commands
just because similarly named model tools are retired. No native mobile bridge
change is intended; mobile gesture acceptance remains in its own track.

## Documentation and rollout

Update affected specs: service agent/browser/scripts and any changed LLM/runtime
folders; helper/daemon browser specs if branches are removed; web renderer/browser
specs if historical/live recognition changes. Update current README/config/setup
instructions, REPL parent plan, Phase 8 and protocol executable-tool catalog.
Historical review docs remain evidence, clearly distinguished from current setup.

Drain active browser invocations; identify parked old calls before restarting.
Use matching REPL-capable daemon/helper and service/shared web. Enabled managed
helpers update at daemon startup under Phase 7d; `browser prepare` remains opt-in.
Deploy/restart the coordinated stack and verify production exposes only REPL plus
handoff. No permanent mixed-version fallback. No new migration is expected for
7g; cumulative deployment still requires existing migrations, including Phase 7f
0042. Native mobile rebuild is needed only if implementation changes its contract.

Rollback, if necessary, uses the previous matched build rather than a runtime
catalog toggle. Do not replay uncertain cells or promise preserved REPL memory
across daemon/runtime replacement.

## Done

Exactly one agent browser execution path; no old-mode flag or production fallback;
old names reject before side effects; supported shared internals and privacy
regressions pass; current REPL continuations remain coherent; matching
stack smoke tests pass. Record deleted/retained paths and validation evidence.
Phase 8 still owns capacity cleanup and final merge readiness. No commit or deployment is part of this implementation.

## Implementation and validation

Removed old standalone daemon capture/click/focus/insert_text actions, the
compact_observations capability and helper continuation pagination. Internal
open/navigate/inspect remain because the guarded REPL bridge calls them. Full
structured snapshots remain local (2 MiB retained limit); model output still
uses the 8 KiB default with explicit expansion. REPL image upload validation,
viewer screenshots, native actions and privacy fences remain.

See [cutover debug record](../../debug/browser-repl-only-cutover.md) for commands,
results and rollout limitations. Phase 7g introduces no migration; the cumulative
branch still requires Phase 7f migration 0042.
