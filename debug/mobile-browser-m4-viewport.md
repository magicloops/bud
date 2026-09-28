# Debug: M4 request-driven browser viewport

## Environment and reproduction

macOS, local service/web checkout and native iOS simulator; real disposable Google
Chrome via BUD_BROWSER_EXECUTABLE. Physical device/ngrok acceptance remains open.
An agent starts a workspace before a phone viewer mounts. Previously mounting
mobile resized the wide agent layout and exposed the transition; two mounted
viewers also competed for sizing priority.

## Observed and expected

Requesting-client dimensions should reach the first browser observation. Passive
presence must not resize. Explicit Fit needs matching drawn pixels before reveal
or input, while maintaining decode/ACK credit and private authority.

## Implementation

Store bounded CSS dimensions in authenticated input metadata, resolve through the
current invocation's exact owned message, and send outside tool args. Authorized
REPL browser operations record one preference per invocation; target attachment
applies it before observations/actions. Public Fit rejects while the workspace cell
mutex is held. Any authorized live public viewer may explicitly Fit; private
controller requirements remain. Local layout scaling has no remote mutation.
Native measures key-window logical dimensions minus safe areas/inline chrome;
ambiguous scenes omit the hint. Hosted Fit avoids keyboard-reduced measurements.

## Validation and failures investigated

- Service/web TypeScript checks pass.
- Service control/media: 23 tests passed; isolated PostgreSQL repository/message
  admission: 9 passed, including ownership/fences and input metadata propagation.
- Initial real-Chrome viewport test passed. Moving preference recording from cell
  admission to the first authorized browser operation exposed an Open-without-hint
  marker bug. Command: `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml live_request_viewport -- --nocapture`.
  Exact assertion: left `["[1024,681]", "[1024,681]"]`, right
  `["[390,740]", "[390,740]"]`. Only hinted Open may establish that marker;
  ordinary Open must leave the subsequent hinted cell eligible.
- Web mounted test command: `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx`.
  Keyboard check initially failed four cases with `ReferenceError: window is not
  defined`; guard the optional browser environment as well as visualViewport.
- Native simulator build and 14 selected BrowserVisit/BrowserRequestViewport tests
  passed using `/tmp/bud-mobile-m2-build`, iPhone simulator
  BC8F97A1-47D7-416C-8682-4E4D7D342B9E; output `/tmp/bud-mobile-m4-test.log`.
- An early shell edit ran from the mobile checkout with main-repo relative paths
  and failed `FileNotFoundError: web/src/features/browser/media.ts`; rerunning from
  the main checkout applied the intended edits. No files were overwritten there.

## Remaining physical acceptance and rollout

Verify native logical points match WK's actual content surface (standard inline
navigation bar assumed 44 points), keyboard-visible sends, portrait/landscape,
first handoff, simultaneous phone/web presence, explicit Fit and private revocation.
Measure first drawn/revealed frame separately from first arrival. Keep M3 open.

Rebuild/restart M4 daemon, update service/shared web and reload every viewer, then
rebuild native. Strict old daemon envelopes reject the new field; old mounted
auto-fit viewers may undo intended geometry. No new migration or helper API.
No deployment/restart, commit or PR update was performed for this task.

## Final regression results

After the corrections, the real-Chrome request viewport regression passes, as does
`live_passive_fit_preserves_invocation_and_rejects_private_authority` with Chrome
enabled. The 14 mounted viewer tests and 3 native-Node geometry/media tests pass;
local idle resizing sends neither new frame credit nor remote mutations. Web
TypeScript passes. No fixed-cap/legacy sizing path or migration was introduced.
