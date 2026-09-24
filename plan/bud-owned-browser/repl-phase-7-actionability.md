# Phase 7: Faithful interaction targets and native clicks

Status: implemented locally; automated and actual-agent fixture validation passed.
Supplementary live-product acceptance pending. 2026-09-24.

## Context and decision

Implement the recommended direction from
[browser actionability and targeting](../../design/browser-actionability-and-targeting.md).
Follow-up to the [f44 trace review](../../review/browser-repl-f44-trace-review.md)
and the [REPL implementation plan](repl-implementation.md).

Use normal Playwright clicks as the default, preserve observed interaction hints,
and provide explicit precision only where fixtures demonstrate it is needed.
Remove mandatory randomized point selection and Bud's blanket descendant/media
exclusions. Preserve ownership, private-control and reference-identity checks.
Do not add a legacy click mode or silently retarget a container to a child.

Implemented decision: existing upstream header references are sufficient, so no
new discovery API was added. Layered cards require explicit positions: element
`geometry()` and `click({position:{x,y}})` provide that precision on the same
observed element. The sampler and its error/diagnostic paths are removed.
See [implementation evidence](../../debug/browser-repl-phase7.md).

## Objective

An agent can discover a collapsed disclosure's actual control, activate it and
verify its contents without guessing container semantics or bypassing pointer
checks. Layered cards must remain usable without accidentally activating their
image viewer or another nested control.

Success requires correct target selection and effects, not just fewer errors.
Preserving `cursor` alone or deleting the sampler alone does not complete this phase.

## 1. Establish behavioral fixtures

- [x] Write a debug note with the current failure and reproduction commands.
- [x] Add neutral fixtures for native disclosures and a custom article-role
  disclosure with an unnamed header and nested profile link. Record upstream
  snapshot, sanitized/full/compact observations, references and page-side events.
- [x] Compare current sampling, native default clicks and explicit positions on
  those fixtures and the existing layered-card fixture using pinned Chrome and
  Playwright. Count wrong-target events as well as intended effects.
- [x] Record whether existing upstream references identify the usable header.
  If not, scope the smallest explicit lookup beneath an observed container,
  preferably native `summary` lookup. Define its facade and bridge shape before
  implementing it; no global DOM inventory or invented ARIA references.
- [x] Decide whether optional element-relative positioning is required to retain
  layered-card behavior. Record the decision and supporting fixture results.

## 2. Preserve useful observation information

- [x] Retain upstream `cursor: "pointer"` without inventing a button role or a
  `clickable: true` guarantee. Absence of a hint does not prohibit interaction.
- [x] Preserve hinted nodes and references through full, scoped, visible and
  compact observations, including unnamed generic nodes and reference stripping.
- [x] Keep field-value exclusions, hierarchy, exact URLs, snapshot identity and
  existing byte/retention limits. Measure added bytes on the existing fixtures.
- [x] If a scoped discovery extension is necessary, require owned frame/container
  scope, unique resolution, bound element identity and normal stale-reference
  invalidation. Expose the actual control separately; never reinterpret an
  article reference as its summary behind the caller's back.

## 3. Replace mandatory custom click preparation

- [x] Route reference and exact role/name clicks through the same native path:
  validate authority and observation, uniquely resolve an element, retain its
  handle, recheck identity, and invoke normal Playwright click with a bounded
  deadline. Preserve the existing three-second click budget.
- [x] Remove the mandatory randomized grid, custom transform/zoom rejection and
  blanket nested-control/media exclusions. Retain Playwright actionability checks.
- [x] If step 1 establishes the need, support
  `click({ position: { x, y } })` on the existing element handle. Specify finite,
  in-bounds CSS padding-box-relative coordinates, using current element geometry
  rather than assuming screenshot pixels equal CSS pixels. Validate the argument
  through the facade and daemon bridge; retain the exact target and normal hit
  checks. Include a bounded way to obtain the required geometry if current
  observations cannot supply it reliably, especially within frames.
- [x] Do not force input, dispatch JavaScript clicks, substitute siblings, navigate
  to a URL automatically, or retry a mutation with another point after failure.
  Playwright's internal retries remain distinct from Bud command replay.
- [x] Remove obsolete sampler modules/build references and diagnostics when no
  supported caller needs them. Preserve behavioral tests while replacing tests
  that only assert old restrictions, such as mandatory rejection of transforms.

## 4. Align outcomes and agent guidance

- [x] Keep pre-input rejection distinct from uncertain execution. Preserve a
  no-click claim only when known; scrolling can already have changed the page.
  Remove sampler-specific error mappings/instructions that no longer apply.
- [x] Preserve partial-effect semantics for whole REPL cells, durable receipts,
  and no automatic replay. An ordinary click failure must not reset Chrome,
  the REPL or a healthy viewer stream.
- [x] Update concise existing API guidance: choose the specific observed control,
  keep unnamed interaction hints when selecting relevant nodes, use explicit
  positions only with evidence, and verify the outcome. No site-specific advice
  or prompt-vocabulary assertions.
- [x] Reuse opt-in tracing and fixed failure-stage diagnostics. Record invocation
  boundaries and fixture event counts without routine page/HTML/URL dumps.

## Validation and acceptance

| Case | Required result |
| --- | --- |
| Native/custom collapsed disclosure with nested link | Discoverable target expands the disclosure; unrelated link receives no click |
| Unnamed pointer control | Hint and valid identity survive every supported observation format |
| Image link, label/input, icon/button | Intended native interaction works without custom blanket rejection |
| Layered card, lightbox and covered same-URL title | Explicit post versus media targeting works; no hidden sibling substitution |
| Multiple controls within a container | Independent targets remain distinguishable; Bud does not choose intent |
| Clipping, transforms, CSS zoom, slots, frames and ancestor overlays | Native supported interactions work; obstructing overlays do not get bypassed |
| DOM replacement/navigation and stale retained handles | Stale identity rejects rather than selecting a replacement |
| Hover/down effects and failure during execution | Event counts and uncertain outcome agree; no second Bud mutation |
| Cross-workspace access, cancellation and private takeover | Existing authority checks and private result-delivery fences hold |
| Viewer/REPL after action failure | Healthy session, media and bindings remain available |
| Bounds/privacy | Field values stay excluded; observation/output limits remain enforced |

- [x] Run focused helper/worker tests, affected Rust/service tests and builds.
  Run package scripts from their owning package directories. Record exact
  commands, versions, failures and skipped environment-dependent tests.
- [x] Run a small actual-agent task on neutral disclosure and layered-card pages
  after deterministic tests pass. Verify selected element, intended effects,
  post-action evidence, call count and duration. Do not require a prescribed
  JavaScript expression sequence or an arbitrary speedup percentage.
- [ ] Review one supplementary live task with traces. A live site passing once
  does not replace the deterministic regression cases.

## Ownership and impacted contracts

The authenticated user owns the Bud; the thread owns its workspace/references.
Existing service admission resolves owner/Bud/thread/invocation, and the daemon
checks authority before operations and result delivery. These boundaries remain.
No new browser-facing route, DB table, owner-stamping path or human input behavior.

Potentially affected contracts are the REPL element facade, private helper/daemon
arguments and canonical action errors. Define any optional position or scoped
lookup fields in `docs/proto.md` before implementation; use snake_case on Bud-owned
wire boundaries. No new SSE family or top-level browser tool is needed.

Specs/docs to update with implementation:

- [x] [Helper spec](../../bud/browser-helper/browser-helper.spec.md).
- [x] [Daemon browser spec](../../bud/src/browser/browser.spec.md).
- [x] [Service browser spec](../../service/src/browser/browser.spec.md) and
  [agent spec](../../service/src/agent/agent.spec.md) for affected contracts.
- [x] [Protocol](../../docs/proto.md), helper API/setup documentation and matching tests.
- [x] Mark the replaced portions of the
  [older click design](../../design/browser-click-targeting-and-link-urls.md)
  superseded; preserve its URL and outcome requirements.
- [x] Record results in `debug/browser-repl-phase7.md` and update this phase and
  parent plan from evidence, keeping earlier outstanding gates visible.

## Rollout and boundaries

This phase requires a rebuilt daemon and matching prepared add-on; update the
service if facade instructions or validated contracts change. Drain active browser
work, update the affected service, rebuild/prepare the matching daemon helper,
restart, then run the smoke checks. No migration or native mobile/web release is
expected. Do not add compatibility flags for this coordinated development change.
No restart, deployment, commit or PR update is authorized merely by this plan.

Keep scroll freshness, output-budget changes, context thinning, extraction APIs,
raw CDP, anti-bot behavior and broad locator/Playwright exposure out of scope.
Phase 4 lifecycle/catalog-cutover and Phase 6 efficiency gates remain independent.
