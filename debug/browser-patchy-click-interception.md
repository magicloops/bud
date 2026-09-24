# Debug: Patchy click interception

## Environment

Investigated 2026-09-23 UTC, thread
`002ffbbd-52f9-4aa0-8c12-8857006cc033`, target
`94BFAFB508AF71D299FFADDFC1DB93BD`. System Chrome 153.0.8010.53,
Playwright Core 1.63.0, real agent. Read the saved tool transcript and performed
read-only DOM/hit-test inspection of the original Reddit tab. All experimental
clicks ran in disposable headless Chrome profiles against synthetic HTML; the
user's tab was not clicked, scrolled, or navigated.

Related: [viewer reconnection investigation](browser-action-viewer-reconnect.md),
[semantic helper spec](../bud/browser-helper/browser-helper.spec.md).

## Observed

The agent correctly identified Patchy as the tenth non-ad post. It clicked the
full-card reference `e1244` twice and the heading reference `e1276` once. All three
operations timed out at approximately three seconds with `intercepted=true`.
Page-info observations after the first two attempts still showed the Reddit
homepage and the same document. The subsequent screenshot still showed the feed,
not the post detail page. This does not establish whether any pointer events or
site handlers ran, but it does not show a completed same-tab post navigation.

The original tab remained on that homepage during investigation. Patchy has two
separate anchors with the same permalink:

- A full-card anchor, `slot="full-post-link"`, targeting `_self`.
- A heading anchor, `id="post-title-t3_1wkv0p9"`, `slot="title"`.

Read-only `elementsFromPoint` inspection found:

- At the full-card center, images sit above the anchor. Those images are not
  descendants of that anchor.
- At the heading center, the separate full-card anchor sits above the heading
  anchor. Both anchors have exactly the same destination, but neither contains
  the other.

These are concrete current-page blockers, consistent with the recorded failures.
They are not a recording of the exact hit-test stack during the historical clicks.

## What the diagnostic means

`failureDiagnostic` searches the entire accumulated Playwright exception message
for `intercepts pointer events`. It does not identify the blocker, final retry,
whether input dispatch began, or whether the intended outcome happened.

Playwright checks hit targets before input and checks its event interceptor after
dispatch. It can retry within one `handle.click` call, changing scroll alignment.
Bud does not retry the helper command, but that does not mean Playwright makes
only one attempt. Scrolling into view can visibly change the page even when no
click reaches the target. Conversely, successful input dispatch alone does not
prove the intended navigation completed.

## Disposable reproductions

Executed the actual `Engine.execute` snapshot/reference/click path with the same
three-second timeout, Chrome version, and a 637 × 639 CSS-pixel viewport.

| Fixture | Result | Page-side evidence |
| --- | --- | --- |
| Normal offscreen link | Success | pointerdown, mousedown, mouseup, click; fragment navigation |
| Offscreen link covered by an overlay | Timeout, intercepted | Page scrolled 1361px; no target input events |
| Overlay appears on mousemove | Timeout, intercepted | Dispatch began according to Playwright's log; no target down/up/click events |
| Overlay appears in pointerdown handler | Success | Handler ran, but no target click or navigation; dispatch success is not navigation success |
| Full-card link under image, heading under same-destination card link | Both semantic clicks timed out, intercepted | No page click events or navigation |
| Coordinate click at heading position in that same layered fixture | Success | The upper full-card link received the click and navigated |

The layered fixture uses a positioned article, an absolute full-card link at
z-index 2, a separate heading link beneath it, and a central image placeholder at
z-index 3. Both links point to `#patchy`. This reproduces the observed structural
conflict without Reddit, credentials, or a network dependency.

Local investigation scripts and outputs are in `/tmp/bud-click-investigation.mjs`,
`/tmp/bud-click-investigation-results.jsonl`, `/tmp/bud-layered-click.mjs`, and
`/tmp/bud-patchy-inspect.mjs`. They are temporary diagnostic artifacts, not product
code or a permanent test dependency.

## Conclusion and proposed next step

There is a reproducible mismatch between an accessible link identity and the
element actually receiving a human click. Interception is not sufficient evidence
that nothing happened, and our existing conservative `browser_outcome_unknown`
is appropriate. There is also no evidence in this run that Patchy's post opened
successfully and Bud merely failed to recognize that navigation.

Do not turn intercepted timeouts into success, force clicks, or blindly replay
them. Preserve the viewer independently of action uncertainty (already addressed
by the related service fix). A focused follow-up should expose an observed link's
destination so the agent can navigate to it when a semantic click is blocked,
and return bounded structural interception diagnostics rather than a generic
unknown alone. Navigation must still respect observed identity, ownership,
authority, and URL validation; equal hrefs alone do not prove equivalent handlers
on arbitrary sites. Re-observe after uncertain actions before selecting recovery.

No product behavior, service state, browser authority, or existing running
processes were changed during this investigation.

## Deeper investigation: exact page actionability and click position

Follow-up used Playwright's `trial: true` with `scroll: 'none'` on the original
page: actionability checks without performing a click or scrolling. URL and
scroll position were checked before/after and remained `https://www.reddit.com/`
and `(0, 5006)`. This is stronger evidence than the earlier geometric inference:

| Target and position | Actual Playwright result |
| --- | --- |
| Full-card link, default position | Intercepted by Patchy's own image in the `post-media-container` slot subtree |
| Heading link, default position | Intercepted by the separate anchor in the `full-post-link` slot subtree |
| Full-card link, position `(318, 46)` relative to its box | Trial passed, with normal visibility/stability/hit-target checks |

The full-card anchor's current box starts at `(0, 233.14)` and is approximately
`637 × 486.13` CSS pixels. Its exposed heading area is clickable even though its
default point is not. The heading's own anchor is underneath the card anchor.
This is intentional-looking card layering, not evidence of a transient CAPTCHA
or a stale reference. Historical reference identity cannot be recovered through
a fresh Playwright connection alone: `node /tmp/bud-patchy-ref-check.mjs` timed out
after 30 seconds resolving `aria-ref=e1244` without that connection's original
snapshot. The follow-up instead used the observed DOM IDs/slots. That diagnostic
timeout does not establish that the historical helper's references were stale;
its interception failures show it had resolved elements.

The disposable layered fixture was also retested using
`locator('#card').click({position:{x:318,y:46},timeout:3000})`, rather than a raw
coordinate click. It succeeded, generated exactly one click on the card anchor,
and navigated to `#patchy`, while the default semantic card/title clicks both
timed out without generating a click. No `force` or synthetic DOM click was used.
Script: `/tmp/bud-layered-click-position.mjs`. Original-page trials:
`/tmp/bud-patchy-trial.mjs` and `/tmp/bud-patchy-trial-points.mjs`.

### Why retries do not solve it

The helper invokes `handle.click({timeout:3000})` without a position. Playwright
selects the midpoint of a visible content quad. Its internal retries change scroll
alignment but do not search the target for an exposed point. Scrolling may alter
the chosen point, but it cannot make the covered title anchor become the topmost
element. On the card, repeatedly aiming into the image can keep failing even
though other parts of the same anchor are available. Increasing the deadline
does not address this structural issue.

### We also discard an existing recovery signal

A disposable raw `ariaSnapshotJSON({mode:'ai'})` result for a link included:

```json
{"role":"link","name":"Example","ref":"e2","cursor":"pointer","url":"https://example.org/post?q=1#section"}
```

Our `sanitize` allowlist drops `url`, and the compact text serializer has no URL
rendering. Therefore the agent loses link destinations that Playwright already
provides, including query strings and fragments. This is separate from the
click-point issue; recovering destinations need not require another DOM crawler.
Returning every URL on every snapshot would increase context, so a targeted or
explicitly requested representation is worth considering.

### Revised recommendation

There are two complementary improvements, rather than a need to replace semantic
clicks with navigation:

1. Before dispatch, allow a bounded search for an exposed point within the exact
   resolved element. Keep Playwright's final hit-target/actionability checks.
   Never silently switch to a sibling or assume equal URLs mean equal handlers.
   This can rescue the full-card link; it cannot rescue a fully covered heading.
2. Make a blocked target and its observed destination available to the agent so
   it can deliberately choose another observed target or navigate directly.

Candidate selection must happen before mutation, not as blind replay after an
unknown outcome. Dynamic overlays, clipped/iframe geometry, layout shifts and
fully covered targets need focused fixtures before implementing point selection.
These experiments establish a viable mechanism, not a completed general-purpose
algorithm. Diagnostics should distinguish pre-dispatch blocking from uncertain
post-dispatch outcomes when evidence supports that distinction; the current
`intercepted` boolean cannot do so.

## Implementation validation (2026-09-23)

Implemented [the approved design](../design/browser-click-targeting-and-link-urls.md)
with isolated fixtures; active user services and Chrome profiles were not restarted.

Failures found and resolved while developing:

- From `bud/browser-helper`,
  `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test click-point.test.mjs`
  initially failed a URL assertion expecting an absolute about:blank URL; the raw
  snapshot correctly supplied `#post?q=1`. Corrected the assertion to preserve
  precisely what was observed, not normalize it.
- The same environment with `npm test`, and then
  `node --test --test-name-pattern='bounded scrolling' engine.test.mjs`, failed
  `bounded scrolling and observation replacement...` with `browser_click_blocked`.
  A pending wheel update moved Story 3 above the viewport after preparation
  (its rect was y=-44..-24). Added the designed second bounded preparation pass;
  both share the three-second deadline, neither dispatches input clicks.
- The new narrow-strip fixture failed `browser_click_blocked`: its first grid
  center fell within subpixel hit-test rounding of the overlay boundary. Moved
  the synthetic overlay from y=20 to y=22 to test a genuinely exposed deterministic
  candidate. No unsafe hit-test bypass added. Thin areas outside our bounded
  samples remain a documented limitation.
- Invocation mistakes: `npm test` from the repository root reported
  `npm error Missing script: "test"`; reran from the helper package. Attempts to
  append `bud/browser-helper/click-point.test.mjs` from that package reported
  `zsh:1: no such file or directory`; reran using the package-relative filename.

Measured compact fixture impact with identical retained nodes/metadata, excluding
URL fields for the baseline: **6,266 → 7,358 bytes (+1,092)**, one page in both cases.
The deeper thirty-story fixture including link URLs is **16,604 bytes**, one page.
These are synthetic short-URL fixtures, not claims about Reddit's actual payload.
Long URLs count toward unchanged bounds; oversized individual nodes reject.

Broader daemon validation:
`BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --lib browser::manager::tests:: -- --test-threads=1`
(from `bud/`) passed 13/14, including the new blocked-click, cancellation,
private-control, reconnect and isolation fixtures. Existing
`live_disconnect_during_capture_drains_cdp_without_delivering_frame` failed at its
post-reconnect snapshot with `browser_target_not_found` (manager.rs:1934), before
any click is attempted. Rerunning only that test with the same executable and
`cargo test --lib live_disconnect_during_capture_drains_cdp_without_delivering_frame -- --nocapture`
passed. This is an unresolved intermittent capture/reconnect fixture/runtime issue;
it is not counted as a clean full-suite pass or changed speculatively in this scope.
`cargo build` passed and the produced embedded archive was checked against the
current click-point module and engine. No helper installation/runtime restart was
performed on the user's running daemon.
