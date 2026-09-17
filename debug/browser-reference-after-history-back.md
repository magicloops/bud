# Debug: unknown reference click after history Back

## Environment and reproduction

Local Chrome for Testing 152.0.7977.82; pinned Playwright Core 1.63.0 helper.
Reviewed owned thread `448a21ee-2a9e-4742-99f0-cd15d097bb49` read-only.
Failed call: `call_a5j2AtpaN4p8Mv0Ge0tHtir3`, request
`01M2M67EHQ9B07941JGWMD21MN`. No user browser was manipulated.

Isolated fixture: serve A with a link to B; observe A, navigate/observe B, navigate
back to a new A and observe, set an in-memory marker, navigate/observe B. Restore
A with CDP Page.navigateToHistoryEntry, verify the marker survives (BFCache),
invalidate the Bud snapshot as on handoff, observe again, click the new reference.
Playwright launch must omit its default --disable-back-forward-cache flag to
match Bud's browser, which allows BFCache.

## Observed

Historical click completed in roughly 60 ms with browser_outcome_unknown. Subsequent
page_info still showed HN; exact role/name click succeeded. The fresh snapshot
used f5-prefixed references also seen before the intervening navigation.

The isolated fixture reproduced:

```
cached retained
document "A" [ref=<new-observation>:root]
link "Next page" [ref=<new-observation>:f2e2]
locator.count: Invalid frame in aria-ref selector "aria-ref=f2e2"
```

The page remained A. This fails at reference lookup before handle.click, not while
waiting for navigation. The same fixture with Playwright defaults (BFCache disabled)
succeeded. An initial page.goBack wait timed out after 30 seconds waiting for load
although navigation had happened; using CDP history navigation plus the retained
marker avoids treating cached restoration as a new load.

## Diagnosis

Playwright retains element _ariaRef values on the cached DOM. Its frame selector
resolver interprets f<number> prefixes against current frame sequence numbers.
After cached restoration, freshly emitted snapshot references can still contain
the old frame prefix, which the current frame inventory cannot resolve.
Bud's outer observation identity is fresh but the underlying reference is invalid.
main.mjs maps this noncanonical Playwright exception to browser_outcome_unknown;
the daemon conservatively preserves that classification. The service receives no
raw helper error, so the exact historical exception was not retained. The fixture
establishes a matching mechanism, not retrospective raw-error proof.

## Implemented fix

Implemented in engine.mjs: retain the snapshot's iframe ancestry alongside each
reference and scope the aria-ref selector with :root inside that frame. This
queries the exact observed reference map without Playwright's first-selector
frame-prefix routing. Prefixes and DOM/private Playwright fields are not rewritten.
Scoped snapshots inherit their source frame. Sanitizer exclusions remain intact.
Observation identity, TTL, document and authority invalidation remain required;
no mutation retry or role/name fallback was added. Missing elements continue to
report browser_locator_not_found before dispatch; actual action exceptions retain
the conservative unknown outcome.

## Validation and rollout

All nine helper tests pass using Chrome for Testing, including the new BFCache
fixture (in-memory marker preserved, click count exactly one, old/invalidated
references rejected), iframe duplicate-name targeting and scoped iframe actions.
Existing compact payload, pagination, field exclusion and bounded-scroll coverage
also passes. BFCache remains enabled; no browser launch or protocol change.

The patch changes only the helper and works with the existing daemon/service
contract in either deployment order. Existing helper processes must restart to
load it (a daemon restart suffices in source development). User daemon and browser
sessions were not restarted during validation.
