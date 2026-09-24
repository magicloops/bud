# Design: Align browser observations and click behavior

Status: proposed; no runtime changes. Updated 2026-09-23.

Recommended direction accepted for implementation planning:
[REPL Phase 7](../plan/bud-owned-browser/repl-phase-7-actionability.md).
The native default is selected; fixtures settle the smallest additional discovery
and positioning surface needed. Implementation has not started.

## Objective

Let the agent discover and interact with the controls a person can use, without
requiring it to reverse-engineer Bud's private click heuristics. Keep ownership
and private-control enforcement, but reduce the custom browser machinery we
maintain.

This proposal revisits the click-selection policy in
[Reliable browser clicks and observed link URLs](browser-click-targeting-and-link-urls.md).
Exact URL preservation and honest outcome reporting remain useful. Mandatory
randomized point selection and descendant exclusions need reconsideration.
The older design describes current behavior until this proposal is implemented.

Evidence: [f44 trace review](../review/browser-repl-f44-trace-review.md).
Implementation sources: [engine](../bud/browser-helper/engine.mjs),
[point selector](../bud/browser-helper/click-point.mjs),
[compaction](../bud/browser-helper/compact.mjs),
[REPL facade](../bud/browser-helper/repl-api.mjs), and
[helper spec](../bud/browser-helper/browser-helper.spec.md).

## What is broken today

The current pipeline performs three independent interpretations of the page:

1. Playwright produces an accessible snapshot with references and some interaction hints.
2. Bud sanitizes and sometimes compacts it, discarding some of those hints.
3. Bud's point selector applies another interpretation of which descendants may
   receive a click, before invoking Playwright's own checks.

These interpretations disagree. In the reviewed run, the raw snapshot had an
unnamed generic header with `cursor: "pointer"`. Bud retained its reference in
the full REPL snapshot but removed the cursor hint. The agent selected the named
article around that header. Our preparation returned `browser_click_blocked`
before invoking the click. The real page had a collapsed `details`/`summary`
control, visible as a plus in the screenshot.

The exact rejected hit was not recorded. The nested-summary exclusion is a
plausible explanation, not a proven reconstruction. Preserving the cursor hint
alone is not proven to make that particular reference clickable either.

There is a second loss path: compact serialization can remove unnamed generic
wrappers and strip references from passive roles. Fixing only the sanitizer
would therefore leave some observation modes inconsistent.

Current point selection also rejects transforms/zoom, excludes media inside
links even when the image is the intended link content, and treats every nested
`[tabindex]` element as another control. Finite point sampling can miss an exposed
area. These are our heuristics, not browser authorization rules.

## Separate the three responsibilities

| Responsibility | Owner | Required behavior |
| --- | --- | --- |
| Permission to observe or act | Bud service/daemon | Validate owner, workspace/tab, invocation authority, private control, cancellation and result delivery |
| Element identity and freshness | Bud reference map and scoped resolution | Resolve the requested target uniquely in its owned frame; reject stale identity rather than silently select another element |
| Physical interaction | Playwright/browser, with minimal Bud adaptation | Respect visibility, enabled state, stability and hit testing; perform input against the explicitly selected target |

The custom point selector is an interaction-quality mechanism. It is not a
security boundary, and it cannot infer the semantics of arbitrary page event
handlers. A pointer cursor does not prove clickability; a missing cursor does
not prove an element is passive. A reference means addressable, not guaranteed
actionable.

## Approaches considered

### A. Preserve hints and repair the existing point selector

Carry `cursor: "pointer"` through all observation formats, preserve hinted
references, and refine descendant rules for disclosures, labels and other
controls. Keep randomized sampling.

**Benefit:** smallest initial change; retains the layered-card behavior already
covered by fixtures.

**Cost:** Bud continues maintaining a second interaction model. Allowing a
summary descendant fixes one class but leaves nested labels, custom elements,
transforms, media links and delegated handlers. An exception list is likely to
grow. This is a possible tactical patch, not the preferred long-term model.

### B. Playwright-native clicks with faithful observations — preferred default

Resolve and freeze the requested element as today, recheck authority and
document identity, then invoke its normal Playwright click with a bounded
deadline. Remove mandatory point sampling and Bud's blanket descendant/media
exclusions from the default path. Preserve upstream interaction hints.

**Benefit:** one primary implementation of actionability, fewer false rejections
from Bud geometry rules, and behavior closer to the automation API the agent
expects. No automatic interpretation of an article as a disclosure or a link.

**Cost:** default point selection can still fail on a partially covered card;
clicking a broad container can activate one of its descendants. Playwright
does not know whether the agent wanted a post, image or profile. This needs
better target discovery and explicit precision when necessary, not a promise
that a generic click always achieves the intended outcome.

### C. Native clicks plus an explicit positioned click

Use B by default and add a small, deliberate escape hatch to the existing
element handle, for example `click({ position: { x, y } })`, with CSS coordinates
relative to that element's padding box. Keep Playwright's final checks active.

**Benefit:** a layered card's exposed region can be selected intentionally without
introducing a second automatic click policy. Also supports controls whose useful
part is not their default point.

**Cost:** coordinates must come from fresh geometry/visual evidence, not screenshot
pixels assumed to be CSS pixels. Observation geometry and frame handling must
be sufficient. Exposing this does not itself fix missing semantic controls.

This is the preferred bounded extension if fixtures show native clicks alone
cannot cover the existing layered-card workflow. It remains one click path
with an optional position, not a new tool or automatic fallback chain.

### D. Automatically choose a descendant or try alternate clicks

Find a summary/button/link under the requested container, or try native input
and then sampled points after a failure.

**Benefit:** can hide mistakes in the agent's target selection.

**Cost:** substitutes intent, becomes ambiguous with multiple controls, and can
duplicate effects after an uncertain failure. Matching URLs does not establish
equivalent click behavior. Reject this as the default. If a child is the right
target, expose it and let the agent request that child explicitly.

### E. Build a separate DOM actionability inventory

Walk the DOM/shadow tree, identify listeners/interactive styles/native controls,
and assign Bud-owned action references independently of the accessible tree.

**Benefit:** can cover controls absent from the accessibility representation.

**Cost:** another crawler, identity map, frame traversal and observation budget;
listener/style inference remains imperfect. Avoid a wholesale implementation.
A narrow, scoped DOM supplement is reasonable only for a demonstrated omission
that cannot be addressed using upstream references or a small locator surface.

### F. Force or JavaScript clicks

Use forced Playwright clicks, `element.click()` or event dispatch as automatic
recovery. These can bypass real pointer behavior and conceal obstruction.
Reject as a supported automatic fallback. Existing trusted REPL evaluation is
not a security sandbox, but the ordinary interaction API should not teach or
silently apply bypasses.

## Recommended scope

Adopt B as the target architecture, with C only as needed to preserve the
layered-card use case. Validate discovery and interaction together before
cutting over; removing the sampler alone is not a complete fix.

### 1. Preserve observed affordances without inventing them

- Retain the upstream pointer cursor hint as `cursor: "pointer"`. Keep the
  observed role/name unchanged; do not relabel every pointer node as a button
  or add `clickable: true` as a guarantee.
- Full, scoped, visible and compact observations must preserve the hint and its
  valid reference. Compaction must not erase an otherwise unnamed hinted node.
- Keep existing field-value exclusions, URLs, byte limits and snapshot identity.
  Do not add hidden bodies or broad attribute dumps to every observation.
- Test native and custom disclosure controls. If the upstream snapshot exposes
  the actual header, use that identity. If it omits the actionable node, choose
  the smallest explicit discovery extension after the fixture comparison:
  preferably scoped lookup of native `summary` beneath an observed container,
  rather than a global actionability crawler.
- A scoped lookup must stay inside the observed owned frame/container, require
  a unique match, bind identity, and reject stale handles. Do not silently turn
  an existing article reference into its summary. Any new reference must be
  registered under the same observation/document fences; never fabricate an
  upstream ARIA reference.

The precise disclosure extension is a fixture-gated decision, not permission
to ship only the cursor field and declare this resolved.

### 2. Simplify execution and explain what changed

Keep one execution path for reference and exact role/name clicks. Preserve
unique resolution and the resolved element handle. Use normal Playwright input,
with no `force`, hidden retargeting, URL navigation fallback or Bud mutation
replay. Bud still does not promise exactly one low-level pointer attempt:
Playwright can internally retry.

The prior request to randomize click locations is deliberately reconsidered
here. Mandatory randomness should not gate basic interaction. The proposal
removes it from the default; do not retain a parallel legacy click mode or add
a user-facing configuration flag. If randomness is needed later, scope it
separately after reliable targeting is established.

For an explicit position, validate finite bounded coordinates and define the
coordinate system in the facade, bridge and agent instructions. Retain normal
Playwright hit checks and the exact selected target. Do not allow a caller's
position to become an unrestricted page click or a click on a sibling.

### 3. Preserve honest errors and recovery

Known rejection before invoking input can report that no click was sent.
Preparation may already have scrolled the page. Once input execution begins,
retain uncertainty on failure unless there is reliable evidence otherwise.
Do not infer successful navigation or no input from an error substring.

Removing the sampler should also remove its geometry-specific error paths and
misleading recovery instructions. Keep a blocked code only where we can still
establish that meaning. Adapt existing canonical errors instead of introducing
an action-outcome state machine. A failed action must not tear down a healthy
browser session, media stream or REPL.

Agent guidance should prefer specific observed controls, retain unnamed hinted
controls when projecting a relevant subtree, and observe after interactions
whose outcome matters. It must distinguish successful input from accomplishing
the requested task. Prompt changes complement the API fix; they do not replace it.

### 4. Keep diagnostics small and useful

Use existing opt-in traces to correlate raw snapshot, exposed reference, requested
target and outcome. Include fixed preparation/invocation stage and bounded
failure category where available. In comparison fixtures, count page-side
pointer/click/disclosure events and the actual element receiving them.

Do not emit page text, URLs, HTML, coordinates tied to private page content or
raw exceptions into routine operational logs. Do not add automatic screenshot
or DOM dumps on every failed action.

## Validation before choosing the final implementation

Compare the existing sampler, native default and explicit position on the same
pinned Playwright/Chrome fixtures. This spike is implementation work to do next;
the following outcomes are acceptance criteria, not claims of tests already run.

| Fixture | Acceptance |
| --- | --- |
| Collapsed details with custom article role and nested profile link | Agent-visible observation exposes a usable header target; clicking it expands once without opening the profile |
| Unnamed pointer header, ordinary native summary, custom ARIA disclosure | Honest hints/state and stable references survive full/scoped/compact/visible paths; no fabricated roles |
| Image wrapped in a link, label with input, icon in button | Intended native interactions work without Bud's blanket descendant/media rejection |
| Layered card, image lightbox and covered same-URL title | Agent can explicitly open the post separately from the image; no silent sibling substitution; document whether an explicit position is required |
| Article containing multiple independent controls | Specific controls are discoverable; Bud does not guess which one to activate |
| Transforms, CSS zoom, clipping, multiline targets, shadow slots and frames | Native supported interactions are not rejected solely by Bud heuristics; ancestor overlays still block inappropriate input |
| Overlay/layout change during input | No forced click or automatic second Bud action; outcome uncertainty is preserved |
| Navigation, stale handle, cross-workspace reference, private takeover | Existing identity/authority fences still reject unauthorized or stale operations and prevent private result delivery |
| Output bounds and field privacy | Hints survive within existing limits; form values/descendants remain excluded; no global DOM expansion |

Keep behavioral regressions from the current tests. Replace assertions that
merely encode the old implementation, such as requiring every transform to fail.
Record wrong-target events as well as successful clicks and latency. A higher
click success rate alone is not acceptance.

## Ownership, affected components and rollout

The authenticated user owns the Bud; the thread owns its tab workspace and
observation references. Existing service admission resolves the acting user,
and the daemon enforces workspace ownership and private-control authority
before operations and result delivery. This design changes neither boundary.
No new browser-facing route, table, row-stamping path or human input behavior
is proposed. Web/mobile viewer coordinates remain user-selected.

Likely implementation touches:

- Helper `engine.mjs`, `compact.mjs`, `repl-api.mjs` and behavioral tests; retire
  `click-point.mjs` if no supported path needs it after cutover.
- Daemon semantic/repl validation and error mapping if optional positions or
  new scoped lookup fields cross the bridge.
- Service agent API instructions and any result/error validators that change.
- Helper, daemon, service browser and agent specs; `docs/proto.md` for changed
  wire fields/error semantics. Update the older click design to mark the
  superseded portions only when the replacement lands.

Use a coordinated service/daemon/helper update with no compatibility mode:
pause browser runs, update the affected service, rebuild the daemon, prepare
its matching browser add-on and restart. No database migration or native mobile
release is expected. This document does not authorize a deployment or restart.

## Implementation sequence and boundaries

1. Reproduce the mismatch on neutral fixtures and record the approach comparison.
2. Implement observation fidelity and the native click path, including the
   smallest discovery/position extension the fixtures prove necessary.
3. Remove unused selection code and obsolete assumptions, update contracts and
   instructions, then validate a real agent task on multiple page structures.

Do not bundle scrolling freshness, context thinning, new output budgets, a
comment extractor, new browser engines, anti-bot behavior, or a complete
Playwright/CDP surface into this change. Those are independent concerns.
