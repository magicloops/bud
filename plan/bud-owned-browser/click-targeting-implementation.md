# Plan: Click targeting and observed URLs

Implements [design](../../design/browser-click-targeting-and-link-urls.md).
Evidence: [debug note](../../debug/browser-patchy-click-interception.md).

## Approach
- Preserve complete link URLs through sanitizer, compact rendering and replay.
- Add a bounded helper-local point selector, randomized only among verified
  points, retaining Playwright's final checks and document identity.
- Propagate pre-dispatch `browser_click_blocked` as recoverable; post-dispatch
  uncertainty keeps existing semantics. No new routes, schema or authority.

## Specs and contracts
- Helper, daemon browser, service browser and agent specs.
- Protocol: observed URL and blocked-error semantics; existing tool arguments.
- No database migration, SSE family or human-input change.

## Validation
Run helper unit/real-Chrome fixtures for layering, media, geometry, frames,
randomness, dynamic interception, URLs and budgets. Run daemon and service
classification/ownership/replay checks and compilation. Use isolated fixtures;
do not restart the user's active runtime during implementation.

## Rollout
Coordinated service and rebuilt daemon/prepared add-on. Manual real-agent and
web/mobile/ngrok acceptance follows local tests; no native mobile release needed.

## Implemented and verified

- Full observed URLs survive sanitizer, compact text/nodes, continuation and
  exact service replay. Budgets remain 32/36 KiB.
- The exact element gets up to two bounded preparation passes and one Playwright
  click invocation with final actionability checks. Randomized candidates cannot
  select sibling links, nested controls or a link's media region.
- A blocked preparation is recoverable in daemon/service; late ambiguity remains
  unknown. No human input or viewer lifecycle changes.
- Helper packaging includes the new module in both archive and rebuild watch list.
- Helper suite: 23 passing tests plus the additional passing pointerdown-side-effect
  fixture. Includes disposable system Chrome, cross-origin frames, frozen URL
  pagination, shadow slots, boundaries, fallback and post-dispatch interception.
- Service: 11 focused tests passed; local isolated-schema repository test passed;
  `pnpm build` passed.
- Daemon: base browser unit suite passed (51 tests; six opt-in headed tests ignored).
  The new opt-in live blocked-click test passed against disposable Chrome.
- News fixture URL cost: 6,266 → 7,358 serialized bytes, still one page. Nested
  thirty-story fixture: 16,604 bytes, one page. These are fixture measurements.

Failures and fixes are recorded in the linked debug note. Real-agent layered-feed
and web/mobile/ngrok acceptance remains pending. Unsupported transforms/zoom,
closed roots and exceptionally narrow exposed strips remain conservative limits;
no guarantee about arbitrary site handlers or exactly-once low-level input.

Final daemon check: `cargo build` passed and embedded helper contents match source.
The broader opt-in manager suite passed 13/14; its existing capture/disconnect test
returned `browser_target_not_found` once, then passed in isolation. See debug note;
this intermittent failure remains unresolved rather than reported as a clean suite.
