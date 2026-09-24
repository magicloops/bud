# Design: Reliable browser clicks and observed link URLs

Status: implemented locally; real-agent/ngrok acceptance pending. Updated 2026-09-23.

Implementation and checks: [plan](../plan/bud-owned-browser/click-targeting-implementation.md).

## Objective and evidence

Improve the existing semantic browser click and observation paths without adding
another browser tool, a retry framework, or site-specific Reddit behavior.

The [Patchy investigation](../debug/browser-patchy-click-interception.md) found two
links to one post: an exposed full-card anchor whose center is covered by an
image, and a heading anchor covered by that card anchor. Playwright rejected both
default points. A trial at the exposed heading area of the **card anchor** passed;
the equivalent positioned click succeeded in a disposable fixture with normal
actionability checks enabled.

The user reports that a manual image click opens a fullscreen image/lightbox.
That is a different outcome from opening the post. Historical observations showed
the feed, but do not rule out an intervening lightbox or transient post view.
We must not turn that uncertainty into a claim that no input occurred.

Related specs: [helper](../bud/browser-helper/browser-helper.spec.md),
[daemon](../bud/src/browser/browser.spec.md),
[broker](../service/src/browser/browser.spec.md),
[agent](../service/src/agent/agent.spec.md), and
[protocol](../docs/proto.md).

## Product decisions

- Click the requested observed element at an exposed point, retaining its exact
  identity. A post link and its image viewer are distinct targets.
- Vary the selected point within verified clickable areas by default. Randomness
  never expands the permissible target area or substitutes another element.
- Preserve link URLs in normal snapshots and visible-DOM observations, including
  query strings and fragments. No extra observation mode is required.
- A completed click means the input operation completed, not that navigation or
  the user's task succeeded. The agent observes again to establish the outcome.
- A blocked or uncertain click does not interrupt a healthy browser/viewer,
  transfer control, navigate automatically, or trigger mutation replay.

## 1. Choose a point before clicking

Keep reference/role resolution, the snapshot TTL, document checks, and the daemon
page lock. Resolve one element handle for the whole operation; do not reselect a
different matching node after DOM changes.

Put bounded geometry and point selection in a small helper module, used only by
the semantic `click` branch. The execution flow is:

1. Validate current authority/document/reference and resolve the exact element.
2. Prepare it for interaction with bounded scrolling and visibility/stability
   checks. Scrolling or hovering may run page handlers; “no click dispatched”
   must not be described as “the page could not have changed.”
3. Obtain its visible geometry, clipped by viewport/scroll containers and frame
   boundaries. Sample candidate points and hit-test them against the live page.
4. Select a randomized, verified candidate belonging to this element. Convert to
   the element-relative position expected by Playwright, accounting for borders
   and frame coordinates rather than treating screenshot pixels as CSS pixels.
5. Revalidate identity/document and invoke one
   `handle.click({position, timeout: remainingBudget, scroll: 'none'})`, retaining
   Playwright's visibility, enabled, stability, and hit-target checks. Never use
   `force`, `HTMLElement.click()`, or `dispatchEvent` as fallback.
6. Return existing success semantics or an honest blocked/unknown result. After
   starting the actual click invocation, do not select another point and click
   again in Bud code.

Keep one overall three-second click budget, inside the existing eight-second
helper deadline. Do not give each candidate another three seconds. Bound
preparation to at most two geometry passes for a layout change before dispatch;
no continuous polling or background hit testing.

### Candidate validity

The topmost hit must be the target or an allowed non-interactive descendant in
its composed tree. Account for shadow roots and slots; a DOM `contains()` check
alone is insufficient. A sibling covering the requested target is invalid even
when it has the same label or URL.

When selecting a link's point, exclude regions belonging to a different nested
interactive control and media regions that could open an image/video viewer.
Ordinary text/span descendants can remain eligible. Explicitly targeting such a
control remains a separate action. Arbitrary JavaScript handlers cannot be fully
inferred from markup: this reduces unintended interactions but is not proof of
the site's eventual behavior.

For Patchy, the full-card link has eligible exposed points; its image region is
ineligible. The fully covered heading link remains blocked. Do not silently
retarget it to the full-card anchor. The agent can select that observed anchor
or use its observed URL explicitly.

Handle ordinary same-origin/cross-origin frames using the existing frame-owned
locator chain and available Playwright frame APIs. Points must also pass ancestor
frame hit testing. If transformed/clipped geometry cannot be mapped confidently,
return a bounded blocked result rather than guessing a top-level coordinate.

### Bounded randomness

Start with an inset 5 × 5 grid over the visible candidate geometry, with up to
25 randomized candidates and their 25 deterministic cell-center fallbacks per
pass. Deduplicate points for tiny targets. Batch hit tests to avoid one browser
round trip per sample. These are starting implementation bounds, to be validated
with narrow exposed strips, multiline links, and heavily clipped elements.

Select randomly among valid points, with a small inward margin where geometry
permits. Validate each jittered point itself: valid corners or a valid cell center
do not prove the intervening area is safe. If jitter fails, use a verified center;
if there is only one safe point, use it. Random sampling must not cause a failure
when the bounded deterministic candidates contain a valid point.

Inject the random source in helper tests for repeatability; production uses an
ordinary random source. No model argument, persisted seed, user setting, movement
simulation, artificial delay, or promise of anti-bot effectiveness. Candidate
sampling can miss an exceptionally small exposed area; report that limitation
instead of clicking through an overlay.

### Playwright retry boundary

One Bud helper invocation is not a guarantee of exactly one low-level attempt:
Playwright may internally retry actionability and intercepted pointer actions.
Tests must count actual page-side events, including an overlay appearing during
hover/down, and preserve unknown outcomes if side effects may have occurred.
Do not advertise exactly-once browser side effects or infer pre-dispatch rejection
from the error message's `intercepted` substring. Avoid patching Playwright or
building a custom input dispatcher in this scope.

## 2. Preserve URLs in the current observations

Playwright's `ariaSnapshotJSON` already returns `url` on links. Carry that field
through the existing sanitizer and compact serializer rather than running an
additional page crawl or collecting every attribute.

- `snapshot`: render a link's URL once alongside its name/reference, using escaped
  text, for example `link "Patchy" [ref] url="https://…/post?q=1#section"`.
- `visible_dom`: retain a `url` string on the existing link node with its box and
  reference. Do not duplicate a text snapshot alongside structured nodes.
- Preserve the complete value supplied by Playwright, including query strings,
  fragments, Unicode and encoding. Do not shorten tracking parameters, display
  an ellipsized URL as executable evidence, or invent URLs for script-only controls.
- URLs are untrusted page data. Observing a URL neither authorizes navigation nor
  relaxes existing scheme/ownership/action validation. Non-navigable schemes can
  remain observed text; the navigation tool must continue rejecting unsupported
  destinations rather than executing a `javascript:` URL.

Keep the 32 KiB helper / 36 KiB final tool budgets and existing continuation/scoping
model. URL bytes count toward those limits. Continuations retain the same captured
URLs; they must not mix current DOM values into a frozen observation. Oversized
individual nodes follow the existing explicit observation-limit behavior, never
silent URL truncation. Measure context impact with the existing news fixtures;
do not introduce URL dictionaries, handles, deduplication protocols, or a second
budget in this pass.

Include URLs by default, as requested. A separate opt-in links mode is unnecessary
unless measurements later show a concrete need. Treat both links with the same
URL as distinct interactive nodes; equal URLs do not imply equal click handlers.

## 3. Make failures and verification useful

Use a narrow new canonical rejection, `browser_click_blocked`, only when our
preparation finishes without invoking the actual click because no safe point was
found or geometry could not be validated. It means **no click was dispatched by
this operation**, not that scrolling/hovering had no effect. Existing stale,
missing, ambiguous, detached and timeout handling remains authoritative.

After the click invocation begins, retain `browser_outcome_unknown` on ambiguous
failure. Do not upgrade it to blocked or successful based on `intercepted=true`,
URL equality/change, a new screenshot, or a visible modal alone.

Carry the blocked code through helper → Rust → broker → tool summary and keep it
recoverable without runtime interruption. Use one short agent-facing explanation:
“The requested element has no verified clickable point. Observe again, select
another exposed target, or navigate to an observed link URL.” The retained
snapshot already supplies destination evidence; no duplicated DOM/error payload
or automatic fallback navigation is needed.

Update tool guidance to request a fresh relevant observation after a click when
the outcome matters, particularly after uncertain results. Distinguish a post
detail view, fullscreen image/lightbox, unchanged feed, SPA update, or popup using
current page/target/DOM evidence. An unchanged URL does not prove failure, and a
changed URL does not prove task success. Reuse existing page_info, snapshots,
screenshots and owned target inventory; add no automatic screenshot or generic
postcondition engine.

Record only bounded diagnostics: preparation/dispatch stage, candidate count,
selected normalized point, preparation duration and fixed failure category. Keep
URLs, page text, image bytes and raw Playwright exceptions out of operational logs.
Use test event counters/diagnostic traces on synthetic pages for detailed evidence.

## Ownership and scope

The Bud owns the browser resource; the thread owns its workspace and references.
Use the invocation's authenticated owner/Bud/thread/fence, existing admission,
daemon authority/page-lock checks, and authorization before delivering results.
Private control continues to block agent observations/actions across workspaces.
URLs receive exactly the same disclosure protection as current page text.

No new browser-facing route, viewer identity mechanism, table, row-stamping path,
SSE family, or web/mobile gesture behavior. Human viewer clicks remain the user's
chosen coordinates and must never be randomized by this helper change.

## Implementation boundaries and debt

Expected changes:

- Helper: one small point-selection module plus tests; `engine.mjs` composes it;
  `sanitize`/`compact.mjs` retain/render URLs; bounded diagnostics stay separate.
- Daemon: canonical blocked rejection classification and fixed diagnostic fields
  through `semantic.rs`/manager. Preserve unknown-outcome and lifecycle separation.
- Service/agent: propagate blocked results as recoverable; preserve URL fields in
  result validation/replay; update existing tool guidance and budget tests.
- Docs: helper/daemon/broker/agent specs, `docs/proto.md` for observation/error
  semantics, and this design's implementation/acceptance status.

Correct the helper spec's unqualified “No mutation is retried” statement to
distinguish Bud command replay from Playwright's internal action attempts. Keep
one implementation for reference clicks and exact role/name clicks. Do not add
Reddit selectors, automatically merge duplicate links, broaden snapshot scope,
or repurpose action errors as session-health failures.

## Validation and acceptance

| Case | Required evidence |
| --- | --- |
| Layered post card | Default center blocked; selected exposed card point opens post; image/lightbox event count remains zero |
| Fully covered title, same-URL sibling above it | Blocked without clicking sibling; both URLs retained for deliberate recovery |
| Nested buttons/media and shadow slots | Candidates do not activate a different control; ordinary target text remains usable |
| Tiny, multiline, clipped and partially exposed targets | Bounded selection; no random-only failures when a verified fallback exists |
| iframe, scroll container, zoom/HiDPI | Correct CSS/frame coordinates; overlay on ancestor frame blocks input |
| Layout shift or overlay between preparation and dispatch | Final Playwright checks remain active; no forced click or Bud mutation replay |
| Hover/down/click handlers and SPA/lightbox/popup outcomes | Count actual input events; retain honest uncertainty; observation establishes outcome |
| Stale reference, navigation, cancellation or private takeover | Existing authority/document checks prevent stale actions and disclosure |
| Randomized selection | Seeded tests cover point validity and several choices; no flaky statistical assertions |
| Link URLs | Queries/fragments/Unicode/escaping preserved; script-only controls have no invented URL; unsupported navigation remains rejected |
| Context bounds and replay | Complete URLs survive continuation and transcript replay inside current budgets; record news-fixture byte/page delta |
| Web/mobile viewer | Blocked and unknown clicks preserve healthy media; human clicks remain unchanged |

Manual acceptance uses the real agent on a layered feed after disposable fixtures
pass: open a requested post, verify its identity/content, intentionally open its
image as a separate action when supported, and distinguish that lightbox from the
post. Log what was actually observed without treating one successful run as proof
of all dynamic-site behavior. Recheck over ngrok; no transport changes are planned.

## Delivery

Implement URL preservation, point selection/randomness, and error/guidance changes
as reviewable parts of one focused change. Do not mark the design complete until
the layered-card and authority/uncertainty regressions pass.

This requires an updated daemon **and its prepared add-on helper**, plus the service
that recognizes the blocked error and preserves URL results. Pause browser runs,
deploy/build the coordinated versions, run `bud browser prepare`, restart the
daemon, then resume validation. The helper is not hot-reloaded by service changes.
No database migration or native mobile release is expected. Do not add a legacy
execution path/capability solely to support mixed versions during this controlled
development upgrade; existing capability checks otherwise remain unchanged.
